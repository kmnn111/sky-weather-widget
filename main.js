'use strict';
/**
 * 云上晴雨 - 宫崎骏风格 Windows 桌面天气插件
 * Electron 主进程：无边框透明窗体 / 置顶 / 托盘 / 位置记忆 / 数据接口代理
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// --shot / --shot-globe 截图调试用独立 userData：不与正在运行的正式实例抢单实例锁
const SHOT_MODE = process.argv.includes('--shot') || process.argv.includes('--shot-globe') || process.argv.includes('--shot-update');
if (SHOT_MODE) {
  try { app.setPath('userData', app.getPath('userData') + '-shot'); } catch (e) { }
}

// 网络抓取（网络层故障自动重试）/ 地名解析 / 地点搜索（Nominatim + Open-Meteo 双源兜底）
const { got, parseNominatim, searchPlaces, friendlyNetError } = require('./geo.js');

/* ---------------- 设置持久化 ---------------- */
let win = null;
let tray = null;
let settings = {
  locations: [],        // {id,name,parent,detail,admin1,lat,lon,display,auto}
  activeId: null,
  autoLocate: true,
  refreshMinutes: 10,
  alwaysOnTop: true,
  autoLaunch: false,
  unit: 'c',
  winPos: null,
  winSize: null,
  edgeDock: true,       // 顶部吸附：拖到屏幕顶端自动收起为温度小窗
  docked: false,        // 当前是否处于吸顶收起状态
  dockX: null           // 吸顶小窗的 x 位置记忆
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch (e) { /* 首次运行 */ }
  // v1.0.11 一次性自愈：旧版存在「顶部吸附」被误关导致小窗丢失的反馈，重新启用一次；
  // 此后完全以用户在设置面板的选择为准（迁移标记 ver，只执行一次）
  if (settings.ver !== 3) {
    settings.ver = 3;
    if (settings.edgeDock === false) settings.edgeDock = true;
    persist();
  }
  migrateLocations();
}
function persist(patch = {}) {
  Object.assign(settings, patch);
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8'); } catch (e) { }
}
/* 地点层级自愈：旧版本解析有误（如"慈溪"存成了"宁波"、港澳台繁体层级错位），
   每次启动用 display 地址链重推导一遍（幂等，只在有变化时写盘） */
function migrateLocations() {
  if (!Array.isArray(settings.locations) || !settings.locations.length) return;
  let changed = false;
  const next = settings.locations.map(l => {
    if (!l || !l.display) return l;
    const fixed = parseNominatim({ display_name: l.display.split(' · ').join(', '), name: l.name, address: {} });
    const merged = Object.assign({}, l, {
      name: fixed.name || l.name,
      parent: fixed.parent,
      admin1: fixed.admin1,
      detail: fixed.detail
    });
    if (merged.name !== l.name || merged.parent !== (l.parent || '') ||
        merged.admin1 !== (l.admin1 || '') || merged.detail !== (l.detail || '')) changed = true;
    return merged;
  });
  if (changed) { settings.locations = next; persist(); }
}

/* ---------------- 地理解析：见 geo.js（parseNominatim）---------------- */

/* ---------------- 天气 / 空气质量 ---------------- */
async function fetchWeather(lat, lon) {
  const f = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,` +
    `cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&hourly=temperature_2m,weather_code,precipitation_probability,precipitation,is_day,uv_index,` +
    `wind_speed_10m,wind_direction_10m,relative_humidity_2m,visibility,apparent_temperature` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,` +
    `sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max` +
    `&timezone=auto&forecast_days=7`;
  const a = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi,european_aqi` +
    `&timezone=auto`;
  const [w, q] = await Promise.all([got(f, 15000), got(a, 15000).catch(() => null)]);
  return { weather: w, air: q, fetchedAt: Date.now() };
}

/* ---------------- 顶部吸附温度小窗 ----------------
   架构：窗口尺寸永远不变，收起/展开只做 CSS 淡入淡出 +
   setShape 裁剪（形状外不渲染、不挡鼠标）。
   避免 Win11 透明窗 resize 造成的白底/直角/卡顿闪烁。 */
const PILL_W = 248, PILL_H = 64;      // 温度小窗尺寸（四角全圆）：图标 + 时间/日期/农历 + 状态 + 温度
const SNAP_IN = 26, SNAP_OUT = 90;    // 拖到距顶端 <=26px 吸附；拖离 >90px 解除
let dockExpanded = false;             // 吸顶后是否处于悬停展开态
let dockTimer = null;
let programmatic = 0;                 // 程序改 bounds 的时间戳，抑制吸附/位置记忆
let hoverPoll = null;
let hoverArmed = true;                // "离开再进入"才展开，避免刚放下小窗就弹开

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function setBoundsSafe(r) {
  if (!win || win.isDestroyed()) return;
  programmatic = Date.now();
  win.setBounds(r);
}
/* setShape：窗口只在小窗矩形内渲染/响应鼠标，其余区域完全穿透 */
function pillShapeRect() {
  const b = win.getBounds();
  return [{ x: Math.round((b.width - PILL_W) / 2), y: 0, width: PILL_W, height: PILL_H }];
}
function setShapePill() {
  if (!win || win.isDestroyed()) return;
  try { win.setShape(pillShapeRect()); } catch (e) { }
}
function setShapeFull() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  try { win.setShape([{ x: 0, y: 0, width: b.width, height: b.height }]); } catch (e) { }
}
function sendDockState() {
  if (win && !win.isDestroyed()) win.webContents.send('dock:state', { docked: !!settings.docked, expanded: dockExpanded });
}
/* 悬停检测：拖拽区不派发 DOM 鼠标事件，用主进程光标轮询兜底（渲染层 mouse 事件走同一入口） */
function handleDockHover(inside) {
  if (!win || win.isDestroyed() || !settings.docked || settings.edgeDock === false) return;
  if (SHOT_MODE) return; // 截图调试：冻结悬停自动收/展，避免抓不到大窗
  if (inside) {
    if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
    if (hoverArmed && !dockExpanded) expandDock();
  } else {
    hoverArmed = true; // 离开 → 重新武装，下次进入才展开
    // 已有待触发的收起定时器就不重建（轮询会反复进来，重建会永远不触发）
    if (dockExpanded && !dockTimer) {
      dockTimer = setTimeout(() => {
        dockTimer = null;
        if (win && !win.isDestroyed() && settings.docked && dockExpanded) collapseDock();
      }, 450);
    }
  }
}
function ensureHoverPoll() {
  if (hoverPoll) return;
  hoverPoll = setInterval(() => {
    if (!win || win.isDestroyed() || !settings.docked || settings.edgeDock === false) return;
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    // 收起态只认小窗矩形；展开态认整个窗口
    const z = dockExpanded ? b : (r => ({ x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height }))(pillShapeRect()[0]);
    const inZone = p.x >= z.x && p.x <= z.x + z.width && p.y >= z.y && p.y <= z.y + z.height;
    if (!dockExpanded && inZone && p.x < z.x + 46) return; // 收起态左侧抓手只用于拖拽，不触发展开
    handleDockHover(inZone);
  }, 260);
}
function stopHoverPoll() { clearInterval(hoverPoll); hoverPoll = null; if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; } }
function dockWindow() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  // 只移动、不改尺寸：小窗 x 为中心记忆位
  const px = clamp(Math.round(b.x + b.width / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  dockExpanded = false;
  hoverArmed = false; // 刚放下不展开，等光标离开后再进入才展开
  settings.docked = true; settings.dockX = px;
  persist({ docked: true, dockX: px });
  setBoundsSafe({ x: px - Math.round((b.width - PILL_W) / 2), y: wa.y, width: b.width, height: b.height });
  setShapePill();
  sendDockState();
  ensureHoverPoll();
}
function undockWindow() {
  if (!win || win.isDestroyed()) return;
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  dockExpanded = false;
  settings.docked = false;
  const b = win.getBounds();
  persist({ docked: false, winPos: { x: b.x, y: b.y } });
  setShapeFull();
  sendDockState();
  stopHoverPoll();
}
function expandDock() {
  if (!win || win.isDestroyed()) return;
  dockExpanded = true;
  setShapeFull();          // 先放开整个窗口，再由 CSS 淡入
  sendDockState();
  ensureHoverPoll();
}
function collapseDock() {
  if (!win || win.isDestroyed()) return;
  dockExpanded = false;
  hoverArmed = false;
  sendDockState();         // CSS 先淡出
  setTimeout(() => {       // 淡出完成后再裁剪形状，避免内容突然消失
    if (win && !win.isDestroyed() && settings.docked && !dockExpanded) setShapePill();
  }, 230);
  ensureHoverPoll();
}
/* 拖拽结束：距顶端够近 → 吸顶收起；吸顶态拖离 → 恢复完整插件 */
function checkSnap() {
  if (!win || win.isDestroyed()) return;
  if (Date.now() - programmatic < 600) return;
  if (settings.edgeDock === false) {
    if (settings.docked) undockWindow();
    return;
  }
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  if (!settings.docked) {
    if (b.y - wa.y <= SNAP_IN) dockWindow();
  } else if (b.y - wa.y > SNAP_OUT) {
    undockWindow();
  } else if (!dockExpanded) {
    dockWindow(); // 仍在顶部附近松手 → 回吸对齐
  }
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:update', (_e, patch) => {
    persist(patch);
    if (win) {
      if (typeof patch.alwaysOnTop === 'boolean') win.setAlwaysOnTop(patch.alwaysOnTop, 'floating');
      applyAutoLaunch(settings.autoLaunch);
    }
    if (patch.edgeDock === false && settings.docked) undockWindow(); // 关掉吸附 → 恢复完整插件
    return settings;
  });

  // 吸顶小窗悬停：进入 → 展开完整插件；离开 → 延时收起
  ipcMain.on('dock:hover', (_e, inside) => handleDockHover(!!inside));

  ipcMain.handle('weather:get', (_e, p) => fetchWeather(p.lat, p.lon).catch(err => ({ error: String(err.message || err) })));

  ipcMain.handle('geo:search', async (_e, q) => {
    // 双源兜底：Nominatim 故障/无结果 → Open-Meteo 地理编码；网络层故障 got() 自动重试
    try {
      return await searchPlaces(q);
    } catch (err) { return { error: friendlyNetError(err) }; }
  });

  ipcMain.handle('geo:reverse', async (_e, p) => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=zh&zoom=16&addressdetails=1&lat=${p.lat}&lon=${p.lon}`;
      const r = await got(url, 15000);
      const loc = parseNominatim(r);
      if (!loc.detail && p.fallbackName) loc.detail = p.fallbackName;
      return loc;
    } catch (err) { return { error: friendlyNetError(err) }; }
  });

  ipcMain.handle('geo:iplocate', async () => {
    // IP 定位 -> 坐标 -> 逆地理编码成中文地名（精确到区县/街道）
    let lat, lon, fallbackName = '';
    try {
      const r = await got('http://ip-api.com/json/?lang=zh-CN&fields=status,country,regionName,city,lat,lon', 10000);
      if (r.status === 'success') { lat = r.lat; lon = r.lon; fallbackName = r.city || r.regionName || ''; }
    } catch (e) { }
    if (!Number.isFinite(lat)) {
      try {
        const r = await got('https://ipwho.is/?lang=zh', 10000);
        if (r.success) { lat = r.latitude; lon = r.longitude; fallbackName = r.city || ''; }
      } catch (e) { }
    }
    if (!Number.isFinite(lat)) return { error: '无法获取网络定位' };
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=zh&zoom=16&addressdetails=1&lat=${lat}&lon=${lon}`;
      const r = await got(url, 15000);
      const parsed = parseNominatim(r);
      if (!parsed.detail && fallbackName) parsed.detail = fallbackName;
      parsed.auto = true;
      return parsed;
    } catch (err) {
      return { name: fallbackName || '当前位置', parent: '', detail: '', admin1: '', lat, lon, auto: true, display: fallbackName };
    }
  });

  ipcMain.handle('win:action', (_e, act) => {
    if (!win) return;
    if (act === 'close') win.hide();
    else if (act === 'quit') { win = null; app.quit(); }
    else if (act === 'hide') win.hide();
    else if (act === 'show') win.show();
    else if (act === 'pin') { const on = !win.isAlwaysOnTop(); win.setAlwaysOnTop(on, 'floating'); persist({ alwaysOnTop: on }); return on; }
  });

  ipcMain.handle('app:version', () => app.getVersion());

  // OTA 在线更新
  ipcMain.handle('update:check', () => { checkForUpdates(true); return true; });
  ipcMain.handle('update:download', () => { startUpdateDownload(); return true; });
  ipcMain.handle('update:install', () => { installUpdate(); return true; });
  ipcMain.handle('update:state', () => updateState);

  // 窗口手动拖拽兜底：Win11 透明无边框窗 + setShape 下 -webkit-app-region:drag 可能失效。
  // 失效时渲染进程发来鼠标屏幕坐标，这里移动窗口；原生拖拽生效时渲染进程收不到事件，不会冲突。
  let dragBase = null;
  ipcMain.on('win:drag', (_e, sx, sy) => {
    if (!win || win.isDestroyed()) return;
    if (!dragBase) {
      const p = win.getPosition();
      dragBase = { sx, sy, wx: p[0], wy: p[1] };   // 首帧只建基准，不动
      return;
    }
    win.setPosition(dragBase.wx + Math.round(sx - dragBase.sx), dragBase.wy + Math.round(sy - dragBase.sy));
  });
  ipcMain.on('win:drag-end', () => { dragBase = null; });
}

function applyAutoLaunch(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath });
  } catch (e) { }
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const size = settings.winSize || { w: 480, h: 920 };
  const startDocked = !!settings.docked && settings.edgeDock !== false;
  let x, y;
  if (startDocked) {
    // 上次退出时处于吸顶态：窗口尺寸不变，只把小窗对位到顶部
    const px = Number.isFinite(settings.dockX) ? settings.dockX : wa.x + wa.width - PILL_W - 36;
    x = px - Math.round((size.w - PILL_W) / 2);
    y = wa.y;
    x = clamp(x, wa.x, wa.x + wa.width - size.w);
  } else if (settings.winPos && Number.isFinite(settings.winPos.x)) { x = settings.winPos.x; y = settings.winPos.y; }
  else { x = wa.x + wa.width - size.w - 36; y = wa.y + wa.height - size.h - 24; }

  win = new BrowserWindow({
    x: Math.round(x), y: Math.round(y),
    width: Math.round(size.w), height: Math.round(size.h),
    frame: false,
    transparent: true,
    // 关掉 Win11 DWM 窗口边框/圆角（"框框"的来源），彻底无边框沉浸
    thickFrame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: !!settings.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: '云上晴雨',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => { sendDockState(); if (settings.docked) setShapePill(); });
  if (startDocked) { hoverArmed = true; ensureHoverPoll(); }
  // 启动自愈：窗口贴在屏幕顶端（比如上次拖到顶没吸附成功）→ 自动收起为温度小窗
  if (!SHOT_MODE && !startDocked) setTimeout(checkSnap, 1200);

  // 渲染进程报错输出到控制台，便于排查
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 || SHOT_MODE) console.log('[renderer]', message);
  });

  // --shot：启动后自动截图（开发调试用，输出 shot-1/2/3.png）
  if (process.argv.includes('--shot')) {
    const shoot = async (name) => {
      const img = await win.webContents.capturePage();
      const out = path.join(app.isPackaged ? process.cwd() : __dirname, name);
      fs.writeFileSync(out, img.toPNG());
      console.log('[shot] saved', out);
    };
    setTimeout(async () => {
      try {
        await shoot('shot-1.png');
        for (const [name, top] of [['shot-2.png', 640], ['shot-3.png', 999999], ['shot-4.png', 1250]]) {
          const real = await win.webContents.executeJavaScript(`(document.getElementById("widget").scrollTop = ${top}, document.getElementById("widget").scrollTop)`);
          await new Promise(r => setTimeout(r, 800));
          console.log('[shot]', name, 'scrollTop=', real);
          await shoot(name);
        }
        await win.webContents.executeJavaScript('document.getElementById("btnSettings").click()');
        await new Promise(r => setTimeout(r, 900));
        await shoot('shot-5.png');
        // 拖拽平移自检：对逐时预报派发 mousedown/move/up，验证 scrollLeft 跟手
        const dragRes = await win.webContents.executeJavaScript(`(() => {
          const el = document.getElementById('hourlyScroll');
          const before = el.scrollLeft;
          const opt = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: 300, button: 0 });
          el.dispatchEvent(new MouseEvent('mousedown', opt(300)));
          window.dispatchEvent(new MouseEvent('mousemove', opt(220)));
          window.dispatchEvent(new MouseEvent('mousemove', opt(140)));
          window.dispatchEvent(new MouseEvent('mouseup', opt(140)));
          return { before, after: el.scrollLeft, max: el.scrollWidth - el.clientWidth };
        })()`);
        console.log('[drag-test]', JSON.stringify(dragRes), dragRes.after > dragRes.before ? 'PASS' : 'FAIL');
        // shot-6/7/8：真实桌面视角验证吸顶小窗（收起 / 展开 / 再收起）
        const shootDesktop = async (name) => {
          const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 900 } });
          const out = path.join(app.isPackaged ? process.cwd() : __dirname, name);
          fs.writeFileSync(out, srcs[0].thumbnail.toPNG());
          console.log('[shot] saved', out);
        };
        await win.webContents.executeJavaScript('document.getElementById("closeSettings").click()');
        // shot-9：节假日详情验证（点击国庆节当天，查看「休」标注与放假区间）
        await win.webContents.executeJavaScript('document.getElementById("widget").scrollTop = 1150');
        await win.webContents.executeJavaScript('(document.querySelector(\'[data-ymd="2026-10-01"]\')||{click(){}}).click()');
        await new Promise(r => setTimeout(r, 400));
        await shoot('shot-9.png');
        await win.webContents.executeJavaScript('document.getElementById("widget").scrollTop = 0');
        await new Promise(r => setTimeout(r, 500));
        dockWindow();
        await new Promise(r => setTimeout(r, 800));
        await shootDesktop('shot-6.png');
        await shoot('shot-10.png'); // 原生分辨率抓取吸顶小窗（放大查贴边白线）
        expandDock();
        await new Promise(r => setTimeout(r, 800));
        await shootDesktop('shot-7.png');
        collapseDock();
        // 收起过渡态抓帧：验证外圈矩形描边与内容同步淡出、不残留（shot-11/12）
        await new Promise(r => setTimeout(r, 90));
        await shoot('shot-11.png');   // 淡出进行中（约90ms）
        await new Promise(r => setTimeout(r, 90));
        await shoot('shot-12.png');   // 淡出尾声（约180ms，裁剪前）
        await new Promise(r => setTimeout(r, 720));
        await shootDesktop('shot-8.png');
        // 截图调试不留存档状态
        settings.docked = false; persist({ docked: false });
      } catch (e) { console.error('[shot] failed', e); }
      app.exit(0);
    }, 11000);
  }

  // --shot-globe：昼夜地球交互自检（真实输入注入 sendInputEvent）
  // 合成 MouseEvent 绕过命中测试/指针捕获/按钮状态，正是「自检全过、真机拖不动」的盲区；
  // 这里走 webContents.sendInputEvent，与真实鼠标同一条输入管线，渲染层收到的是真 pointer 事件。
  if (process.argv.includes('--shot-globe')) {
    const shoot = async (name, rect) => {
      const img = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
      const out = path.join(app.isPackaged ? process.cwd() : __dirname, name);
      fs.writeFileSync(out, img.toPNG());
      console.log('[shot] saved', out);
    };
    // 真实输入一步：发事件 + 等渲染进程消化
    const tap = (ev, wait = 110) => new Promise(r => { win.webContents.sendInputEvent(ev); setTimeout(r, wait); });
    const read = js => win.webContents.executeJavaScript(`JSON.stringify(${js})`);
    const passes = [];
    const check = (name, ok, detail) => { passes.push(!!ok); console.log('[globe-test]', name, detail, ok ? 'PASS' : 'FAIL'); };
    setTimeout(async () => {
      try {
        // 0. 退出吸顶态（shot 模式悬停被冻结）：完整窗口 + 全形状，真实输入才够得着全部控件
        undockWindow();
        await new Promise(r => setTimeout(r, 500));
        // 滚到昼夜地球卡片，取卡片/球体/进度条矩形（CSS px = sendInputEvent 的 DIP）
        const geo0 = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const m = document.getElementById('globeMount');
          m.scrollIntoView({ block: 'center' });
          const sr = m.getBoundingClientRect();
          const st = document.getElementById('gStage').getBoundingClientRect();
          const bw = document.getElementById('gBarWrap').getBoundingClientRect();
          window.__probe = { down: 0, move: 0, up: 0 };
          window.addEventListener('pointerdown', () => window.__probe.down++);
          window.addEventListener('pointermove', () => window.__probe.move++);
          window.addEventListener('pointerup', () => window.__probe.up++);
          return JSON.stringify({
            card: { x: Math.max(0, Math.round(sr.x) - 8), y: Math.max(0, Math.round(sr.y) - 8), width: Math.round(sr.width) + 16, height: Math.round(sr.height) + 16 },
            stage: { x: st.x, y: st.y, w: st.width, h: st.height },
            bar: { x: bw.x, y: bw.y, w: bw.width, h: bw.height }
          });
        })()`));
        const rect = geo0.card;
        await new Promise(r => setTimeout(r, 700));
        await shoot('g-1-initial.png', rect);
        const s0 = JSON.parse(await read(`{ view: Globe._debug.getView(), night: document.getElementById('gNight').getAttribute('d'), fill: document.getElementById('gFill').style.width, pause: Globe._debug.getPause() }`));
        check('pause-clear', s0.pause.onScreen && !s0.pause.docked && !s0.pause.hidden && !s0.pause.scrolling && !s0.pause.suspended, JSON.stringify(s0.pause));

        // 1. 真实拖球 360°：视角变化 + 昼夜覆盖随动 + 松手后拖拽状态归零
        const cx = Math.round(geo0.stage.x + geo0.stage.w / 2), cy = Math.round(geo0.stage.y + geo0.stage.h / 2);
        await tap({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
        const mid = JSON.parse(await read(`Globe._debug.isDragActive()`));
        for (const [dx, dy] of [[60, 0], [130, -30], [170, -50]]) {
          await tap({ type: 'mouseMove', x: cx + dx, y: cy + dy, modifiers: ['isLeftButtonDown'] });
        }
        await tap({ type: 'mouseUp', x: cx + 170, y: cy - 50, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 350));
        const s1 = JSON.parse(await read(`{ view: Globe._debug.getView(), night: document.getElementById('gNight').getAttribute('d'), drag: Globe._debug.isDragActive(), probe: window.__probe }`));
        await shoot('g-2-dragged.png', rect);
        const dLon = Math.abs(s1.view.lon - s0.view.lon);
        check('drag-rotate', dLon > 30 && s1.night !== s0.night && mid && !s1.drag && s1.probe.down >= 1 && s1.probe.up >= 1,
          'dLon=' + dLon.toFixed(1) + ' nightChanged=' + (s1.night !== s0.night) + ' midDrag=' + mid + ' released=' + !s1.drag + ' probe=' + JSON.stringify(s1.probe));

        // 1b. 真实双击复位视角（clickCount 1→2）
        await tap({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 }, 70);
        await tap({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 }, 70);
        await tap({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 2 }, 70);
        await tap({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 2 });
        await new Promise(r => setTimeout(r, 350));
        const s2 = JSON.parse(await read(`Globe._debug.getView()`));
        const back = Math.abs(s2.lat - s0.view.lat) < 0.01 && Math.abs(s2.lon - s0.view.lon) < 0.01;
        check('dblclick-reset', back, 'view=' + JSON.stringify(s2));

        // 2. 真实拖动进度条：填充宽度 1:1 跟手（无过渡），松手后 scrub 状态归零
        const bx = Math.round(geo0.bar.x + geo0.bar.w * 0.85), by = Math.round(geo0.bar.y + geo0.bar.h / 2);
        const tx = Math.round(geo0.bar.x + geo0.bar.w * 0.2);
        await tap({ type: 'mouseDown', x: bx, y: by, button: 'left', clickCount: 1 });
        await tap({ type: 'mouseMove', x: tx, y: by, modifiers: ['isLeftButtonDown'] });
        await tap({ type: 'mouseUp', x: tx, y: by, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 350));
        const s3 = JSON.parse(await read(`{ fill: document.getElementById('gFill').style.width, drag: Globe._debug.isDragActive() }`));
        await shoot('g-3-scrub.png', rect);
        const pct = parseFloat(s3.fill);
        check('scrub-follow', Math.abs(pct - 20) <= 3 && !s3.drag, 'fill=' + s3.fill + ' released=' + !s3.drag);

        // 3. 演示模式弄脏状态（真实拖球+真实拨条）→ 点「真实自转」一键全复位
        await win.webContents.executeJavaScript(`(() => { if (Globe._debug.getSpeed() === 1) document.getElementById('globeMode').click(); })()`);
        await tap({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
        await tap({ type: 'mouseMove', x: cx + 100, y: cy - 40, modifiers: ['isLeftButtonDown'] });
        await tap({ type: 'mouseUp', x: cx + 100, y: cy - 40, button: 'left', clickCount: 1 });
        await tap({ type: 'mouseDown', x: Math.round(geo0.bar.x + geo0.bar.w * 0.92), y: by, button: 'left', clickCount: 1 });
        await tap({ type: 'mouseUp', x: Math.round(geo0.bar.x + geo0.bar.w * 0.92), y: by, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 500));
        await shoot('g-4-demo-dirty.png', rect);
        const dirty = JSON.parse(await read(`{ view: Globe._debug.getView(), speed: Globe._debug.getSpeed(), fill: document.getElementById('gFill').style.width }`));
        await win.webContents.executeJavaScript(`document.getElementById('globeMode').click()`);
        await new Promise(r => setTimeout(r, 500));
        const reset = JSON.parse(await read(`{ view: Globe._debug.getView(), speed: Globe._debug.getSpeed(), fill: document.getElementById('gFill').style.width, lab: document.getElementById('gNowLab').textContent, btn: document.getElementById('globeMode').textContent, drag: Globe._debug.isDragActive() }`));
        await shoot('g-5-reset.png', rect);
        const nowD = new Date();
        const expectLab = '现在 ' + String(nowD.getHours()).padStart(2, '0') + ':' + String(nowD.getMinutes()).padStart(2, '0');
        const viewOk = Math.abs(reset.view.lat - s0.view.lat) < 0.01 && Math.abs(reset.view.lon - s0.view.lon) < 0.01;
        const timeOk = reset.lab === expectLab || reset.lab === '现在 ' + nowD.getHours() + ':' + String(nowD.getMinutes()).padStart(2, '0');
        check('demo-reset', reset.speed === 1 && viewOk && timeOk && reset.btn === '真实自转' && !reset.drag,
          JSON.stringify(reset) + ' dirtyWas=' + JSON.stringify(dirty));

        // 4. 演示自转连拍两帧：肉眼核对夜区平滑无长条/抖动
        await win.webContents.executeJavaScript(`(() => { if (Globe._debug.getSpeed() === 1) document.getElementById('globeMode').click(); })()`);
        await new Promise(r => setTimeout(r, 1200));
        await shoot('g-6-demo-a.png', rect);
        await new Promise(r => setTimeout(r, 1200));
        await shoot('g-7-demo-b.png', rect);
        console.log('[globe-test] DONE', passes.every(Boolean) ? 'PASS' : 'FAIL', '(' + passes.filter(Boolean).length + '/' + passes.length + ')');
      } catch (e) { console.error('[shot] failed', e); }
      app.exit(0);
    }, 8000);
  }

  // --shot-update：OTA 更新链路自检（需配合 --update-url=http://127.0.0.1:port 假更新源）
  // 验证：发现新版本横幅 → 点「立即更新」后台下载 → 「重启安装」提示 → 「稍后」收起横幅；不真正安装
  // 不带 --update-url= 时走「内置默认源」模式：点「检查更新」应得到真实结果而非「未配置」
  if (process.argv.includes('--shot-update')) {
    const shoot = async (name) => {
      const img = await win.webContents.capturePage();
      const out = path.join(app.isPackaged ? process.cwd() : __dirname, name);
      fs.writeFileSync(out, img.toPNG());
      console.log('[shot] saved', out);
    };
    setTimeout(async () => {
      try {
        if (!process.argv.find(a => a.startsWith('--update-url='))) {
          // 内置默认源模式：手动检查更新，状态必须落到实结果（非「未配置」）
          await win.webContents.executeJavaScript(`document.getElementById("btnSettings").click()`);
          await new Promise(r => setTimeout(r, 500));
          await win.webContents.executeJavaScript(`document.getElementById("btnCheckUpdate").click()`);
          const t0 = Date.now();
          let st = '';
          while (Date.now() - t0 < 20000) {
            await new Promise(r => setTimeout(r, 800));
            st = await win.webContents.executeJavaScript(`document.getElementById("updateStatus").textContent`);
            if (st && st !== '正在检查更新…') break;
          }
          await shoot('u-d-status.png');
          const ok = st && st !== '未配置更新服务器地址' && st !== '正在检查更新…';
          console.log('[ota-shot] default source status:', JSON.stringify(st), ok ? 'PASS' : 'FAIL');
          console.log('[ota-shot] DONE', ok ? 'PASS' : 'FAIL');
          app.exit(0);
          return;
        }
        await shoot('u-1-available.png');   // 横幅应显示「发现新版本 v…（当前 v…）」
        console.log('[ota-shot] state after check:', JSON.stringify(updateState));
        // 横幅内容自检：文本非空 + 主按钮可见
        const b1 = await win.webContents.executeJavaScript(`(() => {
          const b = document.getElementById('updateBanner');
          const cs = getComputedStyle(b);
          return JSON.stringify({
            visible: cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.5,
            text: document.getElementById('ubText').textContent.trim().length,
            primary: !document.getElementById('ubPrimary').hidden
          });
        })()`);
        console.log('[ota-shot] banner content', b1, (JSON.parse(b1).visible && JSON.parse(b1).text > 0 && JSON.parse(b1).primary) ? 'PASS' : 'FAIL');
        await win.webContents.executeJavaScript(`(document.getElementById('ubPrimary')||{click(){}}).click()`);
        // 等下载完成（假更新源在本机，86MB 一般 10~30 秒）
        const t0 = Date.now();
        while (updateState.type !== 'downloaded' && updateState.type !== 'error' && Date.now() - t0 < 90000) {
          await new Promise(r => setTimeout(r, 1000));
          if (Math.round((Date.now() - t0) / 1000) % 5 === 0) console.log('[ota-shot] downloading', JSON.stringify(updateState));
        }
        console.log('[ota-shot] final state:', JSON.stringify(updateState));
        await shoot('u-2-downloaded.png');  // 横幅应显示「更新已就绪，重启完成安装」
        // 「稍后」自检：点后横幅应真正收起（且写入记忆不再弹）
        await win.webContents.executeJavaScript(`(document.getElementById('ubLater')||{click(){}}).click()`);
        await new Promise(r => setTimeout(r, 500));
        const memKey = 'updDismiss_downloaded_' + String((updateState && updateState.version) || '');
        const b2 = await win.webContents.executeJavaScript(`(() => {
          const cs = getComputedStyle(document.getElementById('updateBanner'));
          return JSON.stringify({ hidden: cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1,
            remembered: !!localStorage.getItem(${JSON.stringify(memKey)}) });
        })()`);
        await shoot('u-2b-dismissed.png');
        console.log('[ota-shot] dismiss later', b2, (JSON.parse(b2).hidden && JSON.parse(b2).remembered) ? 'PASS' : 'FAIL');
        await win.webContents.executeJavaScript('document.getElementById("btnSettings").click()');
        await new Promise(r => setTimeout(r, 600));
        await shoot('u-3-settings.png');    // 设置页「软件更新」区块
        console.log('[ota-shot] DONE', updateState.type === 'downloaded' ? 'PASS' : 'FAIL');
      } catch (e) { console.error('[shot] failed', e); }
      app.exit(0);
    }, 8000);
  }

  let saveTimer = null;
  const saveGeom = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      // 吸顶小窗 / 程序改位 / 非正常尺寸时不覆盖位置记忆
      if (settings.docked || b.height < 200 || Date.now() - programmatic < 600) return;
      persist({ winPos: { x: b.x, y: b.y }, winSize: { w: b.width, h: b.height } });
    }, 400);
  };
  win.on('move', saveGeom);
  win.on('resize', saveGeom);
  // 拖拽结束（debounce，兼容 Windows 无 moved 事件的情况）→ 吸附 / 解除吸附
  let snapTimer = null;
  const scheduleSnap = () => {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(checkSnap, 350);
  };
  win.on('move', scheduleSnap);
  win.on('moved', scheduleSnap);
  win.on('closed', () => { win = null; });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('云上晴雨 · 桌面天气');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示天气', click: () => win && win.show() },
      { label: '窗口置顶', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (m) => { persist({ alwaysOnTop: m.checked }); win && win.setAlwaysOnTop(m.checked, 'floating'); } },
      { type: 'separator' },
      { label: '退出', click: () => { win = null; app.quit(); } }
    ]));
    tray.on('double-click', () => win && win.show());
  } catch (e) { }
}

/* ---------------- OTA 在线更新 ----------------
   generic 更新源：把 dist 里的 latest.yml + 安装包 + .blockmap 上传到任意
   HTTP(S) 静态服务器，在设置页填地址（或发布前替换 DEFAULT_UPDATE_URL）。
   流程：启动/每 4 小时后台检查 → 发现新版本弹横幅提醒 → 用户点「立即更新」
   后台下载（带进度）→ 下载完成提示重启安装。 */
const DEFAULT_UPDATE_URL = 'https://github.com/kmnn111/sky-weather-widget/releases/latest/download';
let autoUpdater = null;
let updateState = { type: 'idle' };
let updateTimer = null;

function otaLog(...args) {
  console.log('[ota]', ...args);
  const logPath = process.argv.find(a => a.startsWith('--ota-log='));
  if (logPath || process.argv.includes('--ota-test')) {
    try {
      const p = logPath ? logPath.slice('--ota-log='.length) : path.join(app.getPath('userData'), 'ota-test.log');
      fs.appendFileSync(p, new Date().toISOString() + ' ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
    } catch (e) { }
  }
}

function effectiveUpdateUrl() {
  const cli = process.argv.find(a => a.startsWith('--update-url='));
  const url = cli ? cli.slice('--update-url='.length) : (settings.updateUrl || DEFAULT_UPDATE_URL);
  return String(url || '').trim().replace(/\/+$/, '');
}

function sendUpdateState(s) {
  updateState = s;
  if (win && !win.isDestroyed()) win.webContents.send('update:state', s);
}

function setupAutoUpdate() {
  try {
    const { autoUpdater: au } = require('electron-updater');
    autoUpdater = au;
    autoUpdater.autoDownload = false;        // 下载需用户点「立即更新」
    autoUpdater.autoInstallOnAppQuit = false; // 安装需用户确认重启
    autoUpdater.on('checking-for-update', () => otaLog('checking'));
    autoUpdater.on('update-available', (info) => {
      otaLog('available', info.version);
      sendUpdateState({ type: 'available', version: info.version, current: app.getVersion() });
    });
    autoUpdater.on('update-not-available', () => {
      otaLog('not-available');
      sendUpdateState({ type: 'up-to-date', current: app.getVersion() });
    });
    autoUpdater.on('download-progress', (p) => sendUpdateState({ type: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      otaLog('downloaded', info.version);
      sendUpdateState({ type: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (err) => {
      const msg = String((err && err.message) || err);
      otaLog('error', msg);
      sendUpdateState({ type: 'error', message: msg });
    });
    otaLog('autoUpdater ready');
  } catch (e) { otaLog('autoUpdater init failed', String(e)); }
}

function checkForUpdates(manual) {
  const cli = process.argv.find(a => a.startsWith('--update-url='));
  const url = effectiveUpdateUrl();
  if (!autoUpdater) { if (manual) sendUpdateState({ type: 'error', message: '更新组件未就绪' }); return; }
  if (!app.isPackaged && !cli) { if (manual) sendUpdateState({ type: 'error', message: '开发模式不支持在线更新' }); return; }
  if (!url) {
    otaLog('skip check: update url not configured');
    if (manual) sendUpdateState({ type: 'unconfigured' });
    return;
  }
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url });
    otaLog('checking', url);
    const p = autoUpdater.checkForUpdates();
    if (p && p.catch) p.catch(err => { const msg = String((err && err.message) || err); otaLog('check error', msg); if (manual) sendUpdateState({ type: 'error', message: msg }); });
  } catch (e) {
    const msg = String((e && e.message) || e);
    otaLog('check threw', msg);
    if (manual) sendUpdateState({ type: 'error', message: msg });
  }
}

function startUpdateDownload() {
  if (!autoUpdater) return;
  otaLog('download start');
  sendUpdateState({ type: 'downloading', percent: 0 });
  const p = autoUpdater.downloadUpdate();
  if (p && p.catch) p.catch(err => { const msg = String((err && err.message) || err); otaLog('download error', msg); sendUpdateState({ type: 'error', message: msg }); });
}

function installUpdate() {
  if (!autoUpdater) return;
  otaLog('quitAndInstall');
  try { autoUpdater.quitAndInstall(false, true); } catch (e) { otaLog('install error', String(e)); }
}

function scheduleUpdateChecks() {
  const cli = process.argv.find(a => a.startsWith('--update-url='));
  setTimeout(() => checkForUpdates(false), cli ? 3000 : 30000); // 启动后首检（测试模式 3 秒）
  updateTimer = setInterval(() => checkForUpdates(false), 4 * 3600 * 1000); // 每 4 小时
}

/* ---------------- 启动 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    loadSettings();
    registerIpc();
    createWindow();
    createTray();
    applyAutoLaunch(settings.autoLaunch);
    setupAutoUpdate();
    scheduleUpdateChecks();
  });
  app.on('window-all-closed', () => app.quit());
}
