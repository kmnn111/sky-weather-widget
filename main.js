'use strict';
/**
 * 云上晴雨 - 宫崎骏风格 Windows 桌面天气插件
 * Electron 主进程：无边框透明窗体 / 置顶 / 托盘 / 位置记忆 / 数据接口代理
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// --shot / --shot-globe 截图调试用独立 userData：不与正在运行的正式实例抢单实例锁
const SHOT_MODE = process.argv.includes('--shot') || process.argv.includes('--shot-globe') || process.argv.includes('--shot-update') || process.argv.includes('--shot-dock');
if (SHOT_MODE) {
  try { app.setPath('userData', app.getPath('userData') + '-shot'); } catch (e) { }
}

// 网络抓取（网络层故障自动重试）/ 地名解析 / 地点搜索（Nominatim + Open-Meteo 双源兜底）
const { got, clean, parseNominatim, searchPlaces, rankPlaces, locateByIp, reverseGeo, friendlyNetError } = require('./geo.js');
// 外链白名单（数据卡 → 网页详情跳转）
const { isAllowedExtUrl } = require('./ext-guard.js');

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
  winPos: null,
  winSize: null,
  edgeDock: true,       // 顶部吸附：拖到屏幕顶端自动收起为温度小窗
  docked: false,        // 当前是否处于吸顶收起状态
  dockX: null,          // 吸顶小窗的 x 位置记忆
  trayTemp: true,       // 托盘温度图标：托盘图标实时显示当前温度
  brief: true,          // 天气早晚报：8:00 / 20:00 系统通知播报当天概况
  weatherPush: true,    // 官方预警 / 天气突变主动推送（去重 + 仅升级触发）
  windUnit: 'level',    // 风速单位：level 蒲福级 / kmh / ms
  unit: 'c',            // 温度单位：c 摄氏 / f 华氏
  motion: 'on'          // 动效默认始终播放（v1.0.28 曾误设 system → 本机系统减动效让雷达整卡静止）；
                        // system=跟随系统（只关装饰）/ off=全部静止，用户显式选择优先
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  const f = settingsFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad shape');
    Object.assign(settings, parsed);
  } catch (e) {
    // 文件损坏（断电/写到一半崩溃）：先留现场 .broken，再尝试从上次原子写的 .bak 恢复；
    // 绝不能静默当「首次运行」并用默认值全量覆盖，否则用户的地点/设置不可恢复地丢失。
    try {
      if (fs.existsSync(f)) fs.copyFileSync(f, f + '.broken');
      if (fs.existsSync(f + '.bak')) Object.assign(settings, JSON.parse(fs.readFileSync(f + '.bak', 'utf8')));
    } catch (e2) { /* 备份也坏：保留默认值，但 .broken 现场仍在 */ }
  }
  // v1.0.11 一次性自愈：旧版存在「顶部吸附」被误关导致小窗丢失的反馈，重新启用一次；
  // 此后完全以用户在设置面板的选择为准（迁移标记 ver，只执行一次）
  if (settings.ver !== 3) {
    settings.ver = 3;
    if (settings.edgeDock === false) settings.edgeDock = true;
    persist();
  }
  migrateLocations();
  // v1.0.28 热修：曾误把动效默认设成「跟随系统」，本机系统减动效让雷达整卡静止。
  // 用户明确否决自动减少动效 → 旧落盘的 system 一次性归位为始终播放（写回后不再触发）。
  if (settings.motion === 'system') { settings.motion = 'on'; persist(); }
}
function persist(patch = {}) {
  Object.assign(settings, patch);
  const f = settingsFile(), tmp = f + '.tmp';
  const data = JSON.stringify(settings, null, 2);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch (e) { } // 上一份好文件留作恢复源
    try { fs.renameSync(tmp, f); } catch (e) { fs.writeFileSync(f, data, 'utf8'); } // 原子替换，异常兜底
  } catch (e) { /* 用户数据目录不可写时不能让主进程崩 */ }
  finally { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { } }
}
/* 地点层级自愈：旧版本解析有误（如"慈溪"存成了"宁波"、港澳台繁体层级错位），
   每次启动用 display 地址链重推导一遍（幂等，只在有变化时写盘） */
function migrateLocations() {
  if (!Array.isArray(settings.locations) || !settings.locations.length) return;
  try {
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
  } catch (e) { /* 坏数据只跳过迁移，绝不拖垮启动 */ }
}

/* ---------------- 地理解析：见 geo.js（parseNominatim）---------------- */

/* ---------------- 天气 / 空气质量 ----------------
   国内源优先合并（2026-11 换源）：实况/7 天/日出日落/空气 pm 走中国天气网 + itboy，
   逐时/分钟级/UV/花粉等国内无免密钥源的字段仍由 Open-Meteo 提供；
   国内源失败自动整体降级 Open-Meteo（返回结构里 sources 如实标注各段来源）。 */
const cnSrc = require('./cn-source.js');
let lastGoodWeather = null; // 全源失败时续用上一份好数据（带 stale 标记），避免界面整屏空白
/* OM 天气整体不可用时的最小同构骨架：国内源实况/7 天仍可单独出图。
   逐时/分钟级等国内无源字段留空数组（渲染层逐模块隔离，只留空那一块，不再整屏停摆）。 */
function cnFallbackWeather(cn) {
  const c = Object.assign({}, cn.current || {});
  if (!Number.isFinite(c.temperature_2m)) c.temperature_2m = 0;
  if (!Number.isFinite(c.apparent_temperature)) c.apparent_temperature = c.temperature_2m;
  ['relative_humidity_2m', 'wind_speed_10m', 'wind_direction_10m', 'pressure_msl', 'weather_code']
    .forEach(k => { if (!Number.isFinite(c[k])) c[k] = 0; });
  if (c.is_day == null) c.is_day = 1;
  return {
    current: c,
    daily: cn.daily || { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], sunrise: [], sunset: [] },
    hourly: {
      time: [], weather_code: [], temperature_2m: [], apparent_temperature: [],
      precipitation_probability: [], precipitation: [], is_day: [], uv_index: [],
      wind_speed_10m: [], wind_direction_10m: [], relative_humidity_2m: [], visibility: [],
      cloud_cover_low: [], cloud_cover_mid: [], cloud_cover_high: [], pressure_msl: []
    },
    minutely_15: null
  };
}
async function fetchWeather(lat, lon, name, code) {
  const f = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,` +
    `cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility` +
    `&hourly=temperature_2m,weather_code,precipitation_probability,precipitation,is_day,uv_index,` +
    `wind_speed_10m,wind_direction_10m,relative_humidity_2m,visibility,apparent_temperature,` +
    `cloud_cover_low,cloud_cover_mid,cloud_cover_high,pressure_msl` +
    `&minutely_15=precipitation,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,` +
    `sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max` +
    `&timezone=auto&forecast_days=7`;
  const a = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi,european_aqi` +
    `&hourly=alder_pollen,birch_pollen,grass_pollen,ragweed_pollen` +
    `&timezone=auto&forecast_days=3`;
  // 三路并行：OM 天气 + OM 空气 + 国内源（任一路失败都返回 null，不拖垮主流程）
  const [omPair, cn] = await Promise.all([
    Promise.all([got(f, 15000).catch(() => null), got(a, 15000).catch(() => null)]),
    (name || code) ? cnSrc.fetchCn(name, code).catch(() => null) : Promise.resolve(null)
  ]);
  const omOK = !!omPair[0];
  let [w, q] = omPair;
  // 反向降级：此前 OM 天气一挂 Promise.all 就整体 reject，国内源已成功的数据也全丢
  if (!w && cn && (cn.current || cn.daily)) {
    w = cnFallbackWeather(cn);
    if (!q && cn.air) q = { current: { pm2_5: cn.air.pm2_5, pm10: cn.air.pm10 }, hourly: { time: [] } };
  }
  // 所有源都失败：绝不能返回「成功形状 + weather:null」（UI 会整屏空掉）。
  // 有上一份好数据就带 stale 标记续用并保持原始 fetchedAt；首次启动则明确报错，交给失败退避。
  if (!w) {
    if (lastGoodWeather) return Object.assign({}, lastGoodWeather, { stale: true });
    throw new Error('天气数据源均不可用，请稍后重试');
  }
  const sources = cnSrc.mergeCn(w, q, cn);
  if (!omOK) {
    // 来源标注如实：没有 OM 就别把逐时/分钟级标成 Open-Meteo
    sources.hourly = '暂不可用'; sources.minutely = '暂不可用';
    if (!cn || !cn.current) sources.current = '暂不可用';
    if (!cn || !cn.daily) sources.daily = '暂不可用';
    if (!omPair[1]) sources.air = cn && cn.air ? 'itboy 聚合（仅 PM）' : '暂不可用';
  }
  const result = { weather: w, air: q, fetchedAt: Date.now(), sources, cnAlerts: cn ? cn.alerts : [], cnZs: cn ? cn.zs : null };
  lastGoodWeather = result;
  return result;
}

/* ---------------- 历史气候（open-meteo archive，24h 缓存） ----------------
   两路数据：hist=近10年「今天」均温（常年对比/去年今天），recent=近35天降水（周月统计） */
const archiveCache = new Map(); // key -> { ts, data }（按地点分桶，旧城迟到回包不再挤掉新城缓存）
async function fetchArchive(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = archiveCache.get(key);
  if (hit && Date.now() - hit.ts < 24 * 3600 * 1000 && hit.data) return hit.data;
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const y = now.getFullYear();
  const iso = d => d.toISOString().slice(0, 10);
  const histUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${y - 10}-${mm}-${dd}&end_date=${y - 1}-${mm}-${dd}` +
    `&daily=temperature_2m_mean&timezone=auto`;
  const recentUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${iso(new Date(now.getTime() - 35 * 864e5))}&end_date=${iso(new Date(now.getTime() - 6 * 864e5))}` +
    `&daily=precipitation_sum&timezone=auto`;
  const [hist, recent] = await Promise.all([got(histUrl, 20000), got(recentUrl, 20000).catch(() => null)]);
  const data = { hist, recent, fetchedAt: Date.now() };
  archiveCache.set(key, { ts: Date.now(), data });
  if (archiveCache.size > 12) archiveCache.delete(archiveCache.keys().next().value); // 常驻应用缓存不无限增长
  return data;
}

/* ---------------- 降水雷达帧索引（RainViewer，失败返回 null 优雅降级） ---------------- */
let radarCache = { ts: 0, data: null };
let radarInflight = null;
async function fetchRadarFrames() {
  // 成功与失败都在 TTL 内短路：服务挂掉期间不得每次重发（负缓存此前因要求 data 非空而完全失效）
  if (Date.now() - radarCache.ts < 5 * 60 * 1000) return radarCache.data;
  if (radarInflight) return radarInflight; // 并发请求共享一次回包
  radarInflight = (async () => {
    try {
      const meta = await got('https://api.rainviewer.com/public/weather-maps.json', 12000);
      const past = (meta.radar && meta.radar.past || []).slice(-8);
      const nowcast = (meta.radar && meta.radar.nowcast || []).slice(0, 3);
      radarCache = { ts: Date.now(), data: { host: meta.host || 'https://tilecache.rainviewer.com', past, nowcast } };
      return radarCache.data;
    } catch (e) {
      radarCache = { ts: Date.now(), data: null };
      return null;
    }
  })().finally(() => { radarInflight = null; });
  return radarInflight;
}

/* ---------------- 多城市轻量实况（分享/关注列表用） ----------------
   国内源优先：weather_index 实况（dataSK）为准，失败降级 Open-Meteo */
async function fetchCityCurrent(lat, lon, name, code) {
  if (name || code) {
    try {
      const cd = code || await cnSrc.searchCityCode(name);
      const idx = cd ? await cnSrc.fetchIndex(cd) : null;
      const wmo = idx && idx.sk ? cnSrc.wmoFromCn(idx.sk.weathercode, idx.sk.weather) : null;
      const t = idx && idx.sk ? parseFloat(idx.sk.temp) : null;
      if (wmo && Number.isFinite(t)) {
        return {
          current: { temperature_2m: t, weather_code: wmo.wmo, is_day: wmo.isDay },
          source: 'cn'
        };
      }
    } catch (e) { /* 降级 OM */ }
  }
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code,is_day&timezone=auto&forecast_days=1`;
  return got(u, 12000);
}

/* ---------------- 分享卡片存图 ---------------- */
async function savePng(dataURL) {
  const { dialog } = require('electron');
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataURL || ''));
  if (!m) return null;
  const r = await dialog.showSaveDialog(win, {
    title: '保存天气卡片', defaultPath: `天气卡片-${new Date().toISOString().slice(0, 10)}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(m[1], 'base64'));
  return r.filePath;
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
const DESIGN_W = 480, DESIGN_H = 920; // 窗口设计尺寸（固定，resizable:false）：一切几何纠偏的唯一锚点
let baseSize = { w: DESIGN_W, h: DESIGN_H }; // 基准尺寸 = 设计常量（落盘 winSize 只当回执，绝不当基准）

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function setBoundsSafe(r) {
  if (!win || win.isDestroyed()) return;
  programmatic = Date.now();
  win.setBounds(r);
}
/* setShape：窗口只在小窗矩形内渲染/响应鼠标，其余区域完全穿透 */
function pillShapeRect() {
  return [{ x: Math.round((baseSize.w - PILL_W) / 2), y: 0, width: PILL_W, height: PILL_H }];
}
function setShapePill() {
  if (!win || win.isDestroyed()) return;
  try { win.setShape(pillShapeRect()); } catch (e) { }
}
function setShapeFull() {
  if (!win || win.isDestroyed()) return;
  try { win.setShape([{ x: 0, y: 0, width: baseSize.w, height: baseSize.h }]); } catch (e) { }
}
/* #70 真相（探针实锤）：explorer「显示桌面」（Win+D / 任务栏右下角小竖条）对 skipTaskbar 工具窗
   既不最小化也不发 minimize 事件，而是把全屏壁纸 WorkerW 从 z 序底部跃升到普通窗口带顶端——
   非 topmost 的小窗必被壁纸盖住（窗口仍「健康」：visible/on-screen/printwin 完好，但用户看不见）。
   ── 桌面部件语义（置顶关时）：小窗钉在「壁纸层」正上方——平时贴 z 序底部（所有程序窗口之下），
   「显示桌面」壁纸跃升时跟着浮到最上（壁纸之上），全程不挡任何程序（用户实测反馈：不许压浏览器）。
   交互手感保留：小窗被点聚焦 / 展开时允许自然置前，失焦/收起即归位；壁纸可见（桌面态）时强制钉住。
   ── 置顶开时：topmost('screen-saver') 带天然免疫壁纸跃升，浮最上层即用户所愿。
   大窗态一律按用户置顶偏好走（保持系统正常行为）。 */
let glueTimer = null, glueU32 = null;
function glueInit() {
  if (glueU32) return glueU32;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    glueU32 = {
      getDesktop: u.func('void *GetDesktopWindow()'),
      getWindow: u.func('void *GetWindow(void *h, uint cmd)'),
      getClassName: u.func('int GetClassNameW(void *h, uint16 *buf, int max)'),
      getRect: u.func('bool GetWindowRect(void *h, void *rect)'),
      isVisible: u.func('bool IsWindowVisible(void *h)'),
      findChild: u.func('void *FindWindowExW(void *p, void *after, str16 cls, str16 name)'),
      setPos: u.func('bool SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint flags)'),
      isWindow: u.func('bool IsWindow(void *h)')
    };
  } catch (e) { glueU32 = null; }
  return glueU32;
}
/* 壁纸层定位：全屏 WorkerW（唯一恒定特征：class=WorkerW、w>1200、h>700）。
   实测（probe-setpos Win+D diff）：该窗常态沉在 z 序底（无 DefView、不可见）；explorer Toggle Desktop
   （Win+D / 任务栏小竖条）把它「带 SHELLDLL_DefView」跃升到普通窗口带顶端盖一切——注意跃升后它「有」
   DefView（图标层搬进去了），按无 DefView 过滤会永远找不到跃升层（v1.0.26 前的坑）！
   每 tick 重扫、不缓存句柄（跃升=换位+变形，缓存必失手）；自顶向下扫描、上限 2000（本机实测顶层窗口
   1145 个，旧「自底向上 n<300」在跃升态根本扫不到目标）。可见者取最靠上（跃升态）；全不可见取最靠下（常态）。 */
function glueWallpaper() {
  const A = glueInit(); if (!A) return null;
  let p = A.getWindow(A.getDesktop(), 5), n = 0; // GW_CHILD：自顶向下
  const seen = new Set();
  const nameBuf = Buffer.alloc(256);
  let visBest = null, hidBest = null;
  while (p && p !== 0n && n < 2000) {
    const s = String(p); if (seen.has(s)) break; seen.add(s);
    const len = A.getClassName(p, nameBuf, 128);
    if (nameBuf.subarray(0, len * 2).toString('utf16le') === 'WorkerW') {
      const r = Buffer.alloc(16); A.getRect(p, r);
      const w = r.readInt32LE(8) - r.readInt32LE(0), h = r.readInt32LE(12) - r.readInt32LE(4);
      if (w > 1200 && h > 700) {
        if (A.isVisible(p)) { if (!visBest) visBest = p; } // 第一个可见 = 最靠上（跃升壁纸层）
        else hidBest = p;                                  // 最后写入 = 最靠下（常态壁纸层）
      }
    }
    p = A.getWindow(p, 2); n++; // GW_HWNDNEXT 向 z 序下方
  }
  return visBest || hidBest;
}
function glueTick() {
  const A = glueInit(); if (!A || !win || win.isDestroyed()) return;
  const W = glueWallpaper(); if (!W) return; // 找不到壁纸层（异形系统）→ 退回自然 z 序，不硬抬
  const wallUp = A.isVisible(W);
  // 常态下交互放行（聚焦/展开允许自然置前，v1.0.24 手感）；壁纸可见=桌面态必须钉住（#70）
  if (!wallUp && (win.isFocused() || dockExpanded)) return;
  const hw = win.getNativeWindowHandle().readBigUInt64LE(0);
  // 目标态：小窗紧贴壁纸层「上方」（其下邻=壁纸层）。
  // SetWindowPos(A, B) 是把 A 插到 B【下方】（probe-setpos 实锤）——要插壁纸层上方须用「壁纸层的上邻」做锚；
  // W 已是链顶时上邻为 NULL(=HWND_TOP)，仍在 W 上方。旧代码直接以 W 为锚+检查上邻，方向全反（小窗被钉壁纸之下）。
  if (A.getWindow(hw, 2) !== W) {
    const anchor = A.getWindow(W, 3) || 0n;
    A.setPos(hw, anchor, 0, 0, 0, 0, 0x1B); // SWP_NOSIZE|NOMOVE|NOSENDCHANGING|NOACTIVATE
  }
}
function setGlue(on) {
  if (on) {
    if (!glueTimer) glueTimer = setInterval(glueTick, 100);
    glueTick();
  } else if (glueTimer) {
    clearInterval(glueTimer); glueTimer = null;
  }
}
function applyTopmost() {
  if (!win || win.isDestroyed()) return;
  try {
    if (settings.docked && settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'screen-saver'); // 置顶用户：浮最上层，「显示桌面」天然免疫
      setGlue(false);
    } else {
      win.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating');
      setGlue(!!settings.docked && !settings.alwaysOnTop); // 桌面部件：钉壁纸层上沿
    }
  } catch (e) { }
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
    if (!win || win.isDestroyed()) { stopHoverPoll(); return; } // 窗口销毁后不许残留 interval
    if (!settings.docked || settings.edgeDock === false) return;
    if (!win.isVisible()) { stopHoverPoll(); return; } // 隐藏到托盘时不空转光标轮询
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
  // 只移动、不改尺寸（一律按基准尺寸算，异常宽度不会被带进吸附位）：小窗 x 为中心记忆位
  const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  dockExpanded = false;
  hoverArmed = false; // 刚放下不展开，等光标离开后再进入才展开
  settings.docked = true; settings.dockX = px;
  persist({ docked: true, dockX: px });
  setBoundsSafe({ x: px - Math.round((baseSize.w - PILL_W) / 2), y: wa.y, width: baseSize.w, height: baseSize.h });
  setShapePill();
  applyTopmost(); // 吸顶小窗恒 topmost：「显示桌面」壁纸跃升盖不住（#70）
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
  applyTopmost(); // 脱离吸顶 → 回归用户置顶偏好（大窗态系统行为不变）
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
  sendDockState();         // CSS 先淡出 + 天空层形变收进小窗
  setTimeout(() => {       // 淡出/形变（~240ms）完成后再裁剪形状，避免内容突然消失
    if (!win || win.isDestroyed() || !settings.docked || dockExpanded) return;
    // 小窗按大窗平移后的位置对位：x 跟随大窗中心、y 贴回顶边（吸顶归位），并固化位置记忆
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
    const nx = px - Math.round((baseSize.w - PILL_W) / 2);
    if (nx !== b.x || b.y !== wa.y) setBoundsSafe({ x: nx, y: wa.y, width: baseSize.w, height: baseSize.h });
    if (px !== settings.dockX) { settings.dockX = px; persist({ dockX: px }); }
    setShapePill();
  }, 260);
  ensureHoverPoll();
}
/* 拖拽结束：距顶端够近 → 吸顶收起；吸顶态拖离 → 恢复完整插件 */
function checkSnap() {
  if (!win || win.isDestroyed()) return;
  // 最小化时窗口飞到屏外 (-32000)，b.y - wa.y 恒「贴顶」会把最小化误判成吸顶反手 dock
  if (win.isMinimized()) return;
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
  // 设置写入白名单：渲染层只允许改这几个键（防任意键注入/原型污染/updateUrl 被劫持到恶意更新源）
  const SETTINGS_KEYS = new Set(['locations', 'activeId', 'autoLocate', 'refreshMinutes', 'alwaysOnTop', 'autoLaunch', 'unit', 'windUnit', 'edgeDock', 'updateUrl', 'trayTemp', 'brief', 'weatherPush', 'modules', 'modulesOrder', 'cities', 'alerts', 'motion']);
  const MODULE_KEYS = new Set(['globe', 'hourly', 'daily', 'aqi', 'life', 'almanac',
    'uv', 'pollen', 'wind', 'visib', 'dress', 'carwash', 'dry', 'cold',
    'moon', 'history', 'precipstat', 'pressure', 'cities', 'radar', 'alerts', 'share']);
  const MODULE_ORDER = new Set(['globe', 'hourly', 'daily', 'duo', 'real', 'life4', 'climate', 'play', 'almanac']);
  const DEFAULT_ORDER = ['globe', 'hourly', 'daily', 'duo', 'real', 'life4', 'climate', 'play', 'almanac'];
  ipcMain.handle('settings:update', (_e, patch) => {
    const safe = {};
    if (patch && typeof patch === 'object') {
      for (const k of Object.keys(patch)) {
        if (!SETTINGS_KEYS.has(k)) continue;
        const v = patch[k];
        if (k === 'updateUrl') {
          const u = String(v == null ? '' : v).trim().slice(0, 500);
          if (!u) { safe.updateUrl = ''; continue; }
          let parsed = null;
          try { parsed = new URL(u); } catch (e) { /* 非法 URL */ }
          // 更新源决定安装包与 sha512：只收 https；本地调试源放行明文 localhost。
          // 同时拒绝 userinfo（防 https://evil@good.com 之类解析差异）。
          const local = parsed && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(parsed.hostname);
          if (!parsed || parsed.username || parsed.password ||
              (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) continue;
          safe.updateUrl = parsed.href.replace(/\/+$/, '');
        } else if (k === 'unit') {
          if (v === 'c' || v === 'f') safe.unit = v;      // 字符串键必须显式分支，否则静默丢弃
        } else if (k === 'windUnit') {
          if (v === 'level' || v === 'kmh' || v === 'ms') safe.windUnit = v;
        } else if (k === 'refreshMinutes') {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1 && n <= 1440) safe.refreshMinutes = n;
        } else if (k === 'locations') {
          // 地点数组：逐项白名单 + 数值化 + 上限，别把任意大对象原样落盘（照 cities/alerts 的清洗范式）
          if (Array.isArray(v)) {
            safe.locations = v.slice(0, 30).map((l, i) => ({
              id: String((l && l.id) || 'loc_' + i).slice(0, 80),
              name: String((l && l.name) || '').slice(0, 60),
              parent: String((l && l.parent) || '').slice(0, 60),
              detail: String((l && l.detail) || '').slice(0, 120),
              admin1: String((l && l.admin1) || '').slice(0, 60),
              display: String((l && l.display) || '').slice(0, 160),
              type: String((l && l.type) || '').slice(0, 40),
              code: String((l && l.code) || '').slice(0, 40),
              lat: Number(l && l.lat), lon: Number(l && l.lon),
              auto: !!(l && l.auto)
            })).filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lon));
          }
        } else if (k === 'activeId') {
          safe.activeId = v == null ? null : String(v).slice(0, 80);
        } else if (k === 'modules') {
          // 显式白名单：对象值不能走下面的 typeof v === 'boolean' 分支（曾静默丢弃导致开关不生效）
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const m = Object.assign({}, settings.modules);
            for (const mk of Object.keys(v)) {
              if (MODULE_KEYS.has(mk) && typeof v[mk] === 'boolean') m[mk] = v[mk];
            }
            safe.modules = m;
          }
        } else if (k === 'modulesOrder') {
          // 排序数组：只收合法键去重，缺项按默认序补尾（同 modules 的显式分支教训）
          if (Array.isArray(v)) {
            const seen = new Set();
            const arr = [];
            for (const item of v) {
              const s = String(item);
              if (MODULE_ORDER.has(s) && !seen.has(s)) { seen.add(s); arr.push(s); }
            }
            for (const s of DEFAULT_ORDER) if (!seen.has(s)) arr.push(s);
            safe.modulesOrder = arr;
          }
        } else if (k === 'cities') {
          // 多城市关注：数组白名单（每项只收合法字段，上限 12 个）
          if (Array.isArray(v)) {
            safe.cities = v.slice(0, 12).map((c, i) => ({
              id: String(c && c.id || 'c' + i).slice(0, 40),
              name: String(c && c.name || '').slice(0, 40),
              lat: Number(c && c.lat), lon: Number(c && c.lon),
              parent: String(c && c.parent || '').slice(0, 60)
            })).filter(c => c.name && Number.isFinite(c.lat) && Number.isFinite(c.lon));
          }
        } else if (k === 'alerts') {
          // 自定义提醒规则：数组白名单（type 枚举 + 阈值数值化，上限 24 条）
          const TYPES = new Set(['rain', 'tempAbove', 'tempBelow', 'uv', 'wind', 'cold']);
          if (Array.isArray(v)) {
            safe.alerts = v.slice(0, 24).map((a2, i) => ({
              id: String(a2 && a2.id || 'a' + i).slice(0, 40),
              type: TYPES.has(a2 && a2.type) ? a2.type : 'rain',
              threshold: Number(a2 && a2.threshold),
              lead: Number(a2 && a2.lead) || 0,
              enabled: a2 ? a2.enabled !== false : true,
              label: String(a2 && a2.label || '').slice(0, 60)
            }));
          }
        } else if (k === 'motion') {
          // 动效模式：枚举白名单（字符串键必须显式分支，否则被 typeof boolean 分支静默丢弃）
          if (v === 'on' || v === 'off') safe.motion = v; // system 档已废弃：自动减少动效被用户否决
        } else if (typeof v === 'boolean' || k === 'autoLocate') {
          safe[k] = v;
        }
      }
    }
    persist(safe);
    // 地点/置顶变化同步重建托盘菜单（切城市子菜单的 radio 勾选态）
    if (Object.prototype.hasOwnProperty.call(safe, 'locations') ||
        Object.prototype.hasOwnProperty.call(safe, 'activeId') ||
        Object.prototype.hasOwnProperty.call(safe, 'alwaysOnTop')) refreshTrayMenu();
    if (win) {
      if (typeof safe.alwaysOnTop === 'boolean') applyTopmost();
      applyAutoLaunch(settings.autoLaunch);
    }
    if (safe.edgeDock === false && settings.docked) undockWindow(); // 关掉吸附 → 恢复完整插件
    if (Object.prototype.hasOwnProperty.call(safe, 'trayTemp') && tray) {
      if (!safe.trayTemp) {
        try { tray.setImage(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))); } catch (e) { }
      }
      // 开启时等渲染层下一次推温度图标（renderAll 会主动推）
    }
    return settings;
  });

  // 托盘温度图标：渲染层 canvas 画温度数字 → dataURL → nativeImage（仅接受图片 dataURL，超长拒绝）
  ipcMain.on('tray:temp', (_e, dataURL) => {
    if (!tray || settings.trayTemp === false) return;
    try {
      const s = String(dataURL || '');
      if (s.slice(0, 11) !== 'data:image/') return;
      if (s.length > 200000) return;
      const img = nativeImage.createFromDataURL(s);
      if (!img.isEmpty()) tray.setImage(img);
    } catch (e) { }
  });

  // 天气早晚报：渲染层组装文案（本地去重），主进程发系统通知
  ipcMain.on('notify', (_e, p) => {
    if (!p || typeof p !== 'object') return;
    const title = String(p.title == null ? '' : p.title).slice(0, 60);
    const body = String(p.body == null ? '' : p.body).slice(0, 300);
    if (title) pushNotify(title, body);
  });

  // 吸顶小窗悬停：进入 → 展开完整插件；离开 → 延时收起
  ipcMain.on('dock:hover', (_e, inside) => handleDockHover(!!inside));

  let weatherInflight = null; // { key, promise }：同地点并发刷新共享一次网络请求
  ipcMain.handle('weather:get', (_e, p) => {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return Promise.resolve({ error: '坐标无效' });
    const key = [p.lat, p.lon, p.name || '', p.code || ''].join('|');
    if (weatherInflight && weatherInflight.key === key) return weatherInflight.promise;
    const promise = (async () => {
      // 全源瞬时失败（限流/抖动）：整体重试一次，短退避，不放大单源重试
      let lastErr;
      for (let i = 0; i < 2; i++) {
        try { return await fetchWeather(p.lat, p.lon, p.name, p.code); }
        catch (e) { lastErr = e; if (i === 0) await new Promise(r => setTimeout(r, 900)); }
      }
      throw lastErr;
    })().catch(err => ({ error: String(err.message || err) }));
    weatherInflight = { key, promise };
    promise.finally(() => { if (weatherInflight && weatherInflight.promise === promise) weatherInflight = null; });
    return promise;
  });

  ipcMain.handle('weather:archive', (_e, p) => {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return Promise.resolve(null);
    return fetchArchive(p.lat, p.lon).catch(() => null); // 历史气候失败不拖垮主流程
  });
  ipcMain.handle('radar:frames', () => fetchRadarFrames());
  ipcMain.handle('city:current', (_e, p) => {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return Promise.resolve(null);
    return fetchCityCurrent(p.lat, p.lon, p.name, p.code).catch(() => null);
  });
  ipcMain.handle('png:save', (_e, dataURL) => savePng(dataURL).catch(() => null));
  // 分享卡一键复制到剪贴板（粘贴到聊天窗口最快的路径）
  ipcMain.handle('png:copy', (_e, dataURL) => {
    const s = String(dataURL || '');
    if (!/^data:image\/png;base64,/.test(s) || s.length > 12 * 1024 * 1024) return false;
    try { clipboard.writeImage(nativeImage.createFromDataURL(s)); return true; } catch (e) { return false; }
  });
  // 托盘动态信息：悬停即见「温度 · 天气 · 城市 · 更新时间」，并顺带重建右键菜单
  ipcMain.on('tray:info', (_e, text) => refreshTrayMenu(String(text == null ? '' : text)));

  ipcMain.handle('geo:search', async (_e, q) => {
    // 双源并行合并 + 智能排序（geo.searchPlaces）；toy1（中国天气网地名库）元数据作校验信号：
    // 返回里没有「对得上省/名」的结果时（如「慈溪」只搜出安徽/广东同名小村），
    // 用 toy1 的拼音做二次召回——Open-Meteo 库以拼音为名，查 "Cixi" 才能召回真正的慈溪市。
    const kw = String(q == null ? '' : q).trim().slice(0, 80);
    if (!kw) return [];
    try {
      const [list, meta] = await Promise.all([
        searchPlaces(kw),
        cnSrc.searchCityMeta(kw).catch(() => null)
      ]);
      if (meta && meta.pinyin) {
        const hit = list.find(x => (clean(x.name) || '') === (clean(meta.name) || '')
          && (!meta.province || !x.admin1
            || x.admin1.includes(clean(meta.province)) || clean(meta.province).includes(x.admin1)));
        if (!hit) {
          const extra = await searchPlaces(kw, { pinyin: meta.pinyin, hint: meta }).catch(() => []);
          return rankPlaces([...list, ...extra], kw, { hint: meta });
        }
      }
      return list;
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
    // IP 定位：三源投票（ip-api + pconline 国内库 + ipwho.is）聚合出最深名字链，
    // 坐标先用名字检索精化到正确区县（IP 库坐标常偏到运营商枢纽、移动宽带常只到地级市），
    // 再逆地理补街道级地址链，最后附中国天气网城市码（保证国内天气数据按对的城市取）。
    const ip = await locateByIp().catch(() => null);
    if (!ip || !Number.isFinite(ip.lat)) return { error: '无法获取网络定位' };
    let loc;
    try {
      loc = await reverseGeo(ip.lat, ip.lon);
      // 反查结果过粗（主名只到地级市/省份）→ 用 IP 的区县名精化主名，别停在「宁波」级
      const nm = clean(loc.name), coarse = !nm || nm === clean(ip.city) || nm === clean(ip.province);
      if (coarse && ip.district) {
        loc.name = clean(ip.district);
        if (!loc.parent && ip.city) loc.parent = clean(ip.city);
      }
      if (!loc.detail && ip.district) loc.detail = '';
    } catch (err) {
      // 反查失败：用 IP 投票出的 省/市/区县 名字链兜底
      loc = {
        name: clean(ip.name) || '当前位置',
        parent: ip.parent || (clean(ip.city) !== clean(ip.name) ? clean(ip.city) : ''),
        detail: '', admin1: clean(ip.province) || ip.admin1 || '',
        lat: ip.lat, lon: ip.lon,
        display: ip.display || [ip.province, ip.city, ip.district].filter(Boolean).join(' · ')
      };
    }
    loc.auto = true;
    try {
      const meta = await cnSrc.searchCityMeta(loc.name);
      if (meta) loc.code = meta.code;
    } catch (e) { /* toy1 限流不阻塞定位 */ }
    return loc;
  });

  ipcMain.handle('win:action', (_e, act) => {
    if (!win) return;
    if (act === 'close') { stopHoverPoll(); win.hide(); }
    else if (act === 'quit') { stopHoverPoll(); win = null; app.quit(); }
    else if (act === 'hide') { stopHoverPoll(); win.hide(); }
    else if (act === 'show') win.show();
    else if (act === 'pin') { const on = !settings.alwaysOnTop; persist({ alwaysOnTop: on }); applyTopmost(); return on; }
  });

  ipcMain.handle('app:version', () => app.getVersion());

  // 外链跳转（数据卡 → 网页详情）：白名单校验通过才交给系统默认浏览器，
  // 且必须打开「规范化后的 URL」——校验 WHATWG 解析、打开原始串会留下解析差异面
  ipcMain.handle('ext:open', (_e, url) => {
    if (!isAllowedExtUrl(url)) return false;
    try { shell.openExternal(new URL(String(url)).href).catch(() => { }); } catch (e) { return false; }
    return true;
  });

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
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return; // NaN/Infinity 不进 setPosition
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
/* 尺寸采纳：基准=设计常量。落盘 winSize 只当「回执」不当「基准」——旧版的宽范围校验
   （380-1280x560-2200）会放过 900x920 这类坏值（旧版拖拽拉伸固化进 settings.json），
   被采纳成 baseSize 后 saveGeom/setShape/自愈全部「纠回」坏尺寸；卸载不清 userData，
   重装也救不回（2026-11-01 用户实报）。任何非设计值一律采纳设计尺寸并清写落盘，
   老机器升级启动即痊愈。 */
function adoptWinSize() {
  const s = settings.winSize;
  if (!s || Math.round(s.w) !== DESIGN_W || Math.round(s.h) !== DESIGN_H) {
    persist({ winSize: { w: DESIGN_W, h: DESIGN_H } }); // 清洗历史坏数据
  }
  return { w: DESIGN_W, h: DESIGN_H };
}
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const size = adoptWinSize();
  baseSize = size;
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
  // 位置自愈：落盘位置已完全离开所有屏幕（拔显示器/换分辨率残留的坏数据）→ 回退默认位
  const onScreen = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return x < a.x + a.width && x + size.w > a.x && y < a.y + a.height && y + size.h > a.y;
  });
  if (!onScreen) { x = wa.x + wa.width - size.w - 36; y = wa.y + wa.height - size.h - 24; }

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
  // 导航防护（Electron 安全基线）：单页本地应用不需要任何导航/新窗口，
  // 渲染层即使被注入也不许外跳或开窗
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  applyTopmost();
  /* 吸顶小窗常驻桌面（用户反馈：点「显示桌面」小窗被一起最小化带走）。
     系统级最小化（Win+D / Win+M / 任务栏「显示桌面」）是唯一能让本窗最小化的入口
     （skipTaskbar+无边框，没有最小化按钮），故 docked 态拦截 minimize 原地恢复即可；
     大窗态保持系统正常行为（该最小化就最小化）。恢复用 showInactive 不抢焦点，
     用户仍停留在桌面；置顶层级/形状在恢复后重申一次（最小化可能掉档）。 */
  const undoMinimize = () => {
    if (!win || win.isDestroyed() || !settings.docked) return;
    if (!win.isMinimized()) return;
    try { win.showInactive(); } catch (e) { try { win.restore(); } catch (e2) { } }
    try { win.moveTop(); } catch (e3) { }
    try { applyTopmost(); } catch (e4) { }
    if (settings.docked && !dockExpanded) setShapePill();
  };
  win.on('minimize', () => {
    if (!settings.docked) return;
    setImmediate(undoMinimize);        // 最小化事件后立即拉回
    setTimeout(undoMinimize, 40);      // 系统最小化动画期间再兜一次（事件时序竞争）
    setTimeout(undoMinimize, 250);
  });
  win.on('closed', () => { stopHoverPoll(); setGlue(false); });
  // 隐藏到托盘时停掉 260ms 光标轮询，重新显示时再起（避免后台无效唤醒）
  win.on('hide', stopHoverPoll);
  win.on('show', () => { if (settings.docked && settings.edgeDock !== false) ensureHoverPoll(); });
  // shot 自检：加载前清一次 HTTP 缓存，防止 file:// 的 styles.css 等被磁盘缓存住（改动看似不生效）
  if (SHOT_MODE) { try { win.webContents.session.clearCache().catch(() => { }); } catch (e) { } }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    sendDockState(); if (settings.docked) setShapePill();
    // 更新自检要求横幅每次都真弹：清掉历史运行残留的「稍后」记忆，保证可复现
    if (process.argv.includes('--shot-update')) {
      win.webContents.executeJavaScript('Object.keys(localStorage).filter(k => k.indexOf("updDismiss_") === 0).forEach(k => localStorage.removeItem(k))').catch(() => { });
    }
  });
  if (startDocked) { hoverArmed = true; ensureHoverPoll(); }
  // 启动自愈：窗口贴在屏幕顶端（比如上次拖到顶没吸附成功）→ 自动收起为温度小窗
  if (!SHOT_MODE && !startDocked) setTimeout(checkSnap, 1200);

  // 渲染进程报错输出到控制台，便于排查。
  // Electron 33 起 console-message 改为事件对象携带 level/message（旧位置参数已弃用），
  // 双签名兼容：两种形态都取到等级与文本，warning/error 恒不丢
  win.webContents.on('console-message', (e, level, message) => {
    const lv = level != null ? level : (e && e.level);
    const msg = message != null ? message : String((e && e.message) || '');
    const sev = typeof lv === 'number' ? lv
      : ({ verbose: 0, info: 1, warning: 2, error: 3 })[String(lv)] != null ? ({ verbose: 0, info: 1, warning: 2, error: 3 })[String(lv)] : 0;
    if (sev >= 2 || SHOT_MODE) console.log('[renderer]', msg);
  });

  // 渲染进程崩溃自愈：白屏挂死比崩溃更糟，记录后原地 reload（限次防崩溃循环）
  let goneCount = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (!details || details.reason === 'clean-exit') return;
    console.error('[main] renderer gone:', details.reason);
    if (goneCount++ >= 2) return;
    try { win.webContents.reload(); } catch (err) { }
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
        // 四联扩展卡取景（跟元素定位自适应）：real/life4/climate 各一帧，目检 16 卡渲染
        for (const [name, anchor] of [['shot-q1-quads.png', 'modQuadReal'], ['shot-q-life4-quads.png', 'modQuadLife4'], ['shot-q2-quads.png', 'modQuadClimate']]) {
          await win.webContents.executeJavaScript(`(() => { const w = document.getElementById("widget"), t = document.getElementById("${anchor}"); w.scrollTop += t.getBoundingClientRect().top - w.getBoundingClientRect().top - 16; })()`);
          await new Promise(r => setTimeout(r, 700));
          await shoot(name);
        }
        await win.webContents.executeJavaScript('document.getElementById("widget").scrollTop = 0');
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
        // 纵向拖拽滚屏自检（v1.0.20 沉浸式滚动）：竖拖内容跟手 + 侧边滑块已隐藏
        const dragY = await win.webContents.executeJavaScript(`(() => {
          const w = document.getElementById('widget');
          w.scrollTop = 0;
          const opt = (y) => ({ bubbles: true, cancelable: true, clientX: 200, clientY: y, button: 0 });
          w.dispatchEvent(new MouseEvent('mousedown', opt(500)));
          window.dispatchEvent(new MouseEvent('mousemove', opt(400)));
          window.dispatchEvent(new MouseEvent('mousemove', opt(300)));
          window.dispatchEvent(new MouseEvent('mouseup', opt(300)));
          return { top: w.scrollTop, sb: getComputedStyle(w).scrollbarWidth };
        })()`);
        const dragYOk = dragY.top > 100 && dragY.sb === 'none';
        console.log('[dragY-test] vertical-drag + hidden-scrollbar', JSON.stringify(dragY), dragYOk ? 'PASS' : 'FAIL');
        // 滚轮单格步长自检：经典一格 deltaY=120 → 映射 ~66px（旧 120px 大跳已废），等惯性收尾再量
        const wheelRes = await win.webContents.executeJavaScript(`(() => {
          const w = document.getElementById('widget');
          w.scrollTop = 0;
          w.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
          return new Promise(r => setTimeout(() => r({ top: Math.round(w.scrollTop) }), 900));
        })()`);
        const wheelOk = wheelRes.top > 40 && wheelRes.top < 90;
        console.log('[wheel-test] one-notch ~66px', JSON.stringify(wheelRes), wheelOk ? 'PASS' : 'FAIL');
        // ---- v1.0.15 新增自检：夜色主题 / IME 搜索守卫 / 设置页更新按钮 ----
        // 夜色主题：白天跑 --shot 也能验证夜间版式（强制 body.night 抓帧后还原）
        await win.webContents.executeJavaScript('document.body.classList.add("night")');
        await new Promise(r => setTimeout(r, 1500));
        await shoot('shot-13-night.png');
        await win.webContents.executeJavaScript('document.getElementById("widget").scrollTop = 999999');
        await new Promise(r => setTimeout(r, 800));
        await shoot('shot-14-night-bottom.png');
        // 强制白天版式抓趋势图：先关设置面板（534 起一直开着），0%/mm 数值浅色配色目检（与 shot-2 自然主题互补）。
        // 取景跟 trendWrap 走（写死 scrollTop 会随内容高度漂移裁掉曲线）
        await win.webContents.executeJavaScript('document.getElementById("closeSettings").click()');
        await new Promise(r => setTimeout(r, 400));
        await win.webContents.executeJavaScript('document.body.classList.remove("night"); (() => { const w = document.getElementById("widget"), t = document.getElementById("trendWrap"); w.scrollTop += t.getBoundingClientRect().top - w.getBoundingClientRect().top - 130; })()');
        await new Promise(r => setTimeout(r, 500));
        await shoot('shot-14b-day-trend.png');
        await win.webContents.executeJavaScript('document.getElementById("widget").scrollTop = 0');
        await new Promise(r => setTimeout(r, 300));
        // IME 守卫：中文输入法确认候选词的 Enter（isComposing）不得触发搜索；普通 Enter 必须触发
        const imeRes = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const inp = document.getElementById('searchInput');
          const box = document.getElementById('searchResults');
          box.innerHTML = ''; inp.value = '慈溪';
          inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
          return new Promise(r => setTimeout(() => {
            const guarded = box.innerHTML.trim() === '';
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            setTimeout(() => r(JSON.stringify({ guarded, started: box.innerHTML.indexOf('搜索中') !== -1 || box.innerHTML.indexOf('s-item') !== -1 })), 150);
          }, 500));
        })()`));
        console.log('[ime-test] composing-Enter ignored:', imeRes.guarded, imeRes.guarded ? 'PASS' : 'FAIL');
        console.log('[ime-test] real-Enter fired search:', imeRes.started, imeRes.started ? 'PASS' : 'FAIL');
        // shot-6/7/8：真实桌面视角验证吸顶小窗（收起 / 展开 / 再收起）
        const shootDesktop = async (name) => {
          // desktopCapturer 只在截图自检里用：懒加载，正式运行不占屏幕采集能力面
          const { desktopCapturer } = require('electron');
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
        // ---- v1.0.16 自检：夜色大小窗形变（天空层连续收进/长出，不再瞬间硬切） ----
        await win.webContents.executeJavaScript('document.body.classList.add("night")');
        expandDock();
        await new Promise(r => setTimeout(r, 600));
        await shoot('shot-15-night-full.png');            // 夜色完整窗
        // 夜色趋势图目检镜头：0%/横轴刻度的夜色样式（与 shot-14b 白天同取景，防夜色回归）
        await win.webContents.executeJavaScript('(() => { const w = document.getElementById("widget"), t = document.getElementById("trendWrap"); w.scrollTop += t.getBoundingClientRect().top - w.getBoundingClientRect().top - 130; })()');
        await new Promise(r => setTimeout(r, 500));
        await shoot('shot-15b-night-trend.png');
        await win.webContents.executeJavaScript('document.getElementById("widget").scrollTop = 0');
        await new Promise(r => setTimeout(r, 300));
        collapseDock();
        // 形变真值探针（v1.0.16）：逐帧采样 #sky 宽度——收起必须是插值形变而非瞬间硬切。
        // capturePage 抓不到可靠中间帧，用页面内 rAF 采样做断言。
        const morph = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const sky = document.getElementById('sky');
          return new Promise(r => {
            const s = [];
            const t0 = performance.now();
            const push = () => {
              const t = performance.now() - t0;
              if (t < 1100) s.push([Math.round(t), getComputedStyle(sky).clipPath]);
            };
            const tick = () => { push(); if (performance.now() - t0 < 1100) requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
            const iv = setInterval(push, 50); // rAF 被长任务饿死时的兜底采样，保证帧密度
            setTimeout(() => { clearInterval(iv); r(JSON.stringify(s)); }, 1150);
          });
        })()`));
        const distinct = new Set(morph.map(x => x[1])).size;
        // 收尾值单独读一次：采样窗口可能被长任务挤压；再等一拍让过渡真正落定（曾偶发误报 FAIL）
        await new Promise(r => setTimeout(r, 350));
        const last = String(await win.webContents.executeJavaScript(
          `getComputedStyle(document.getElementById('sky')).clipPath`)).replace(/^"|"$/g, '');
        const settled = /856px|100% - 64px/.test(last);
        console.log('[morph-test] collapse #sky clipPath', JSON.stringify(morph.filter((_, i) => i % 3 === 0)), 'frames=' + morph.length, (distinct >= 3 && settled) ? 'PASS' : 'FAIL');
        await shoot('shot-16-night-collapse-mid.png');    // 收起过程抓帧（近尾声）
        await new Promise(r => setTimeout(r, 900));
        await shoot('shot-17-night-pill.png');            // 收起完成的夜色小窗
        expandDock();
        await new Promise(r => setTimeout(r, 120));
        await shoot('shot-18-night-expand-mid.png');      // 展开形变进行中
        await new Promise(r => setTimeout(r, 700));
        await win.webContents.executeJavaScript('document.body.classList.remove("night")');
        // ---- v1.0.16 自检：窗口尺寸自愈（系统擅改尺寸后自动纠回基准，坏尺寸不落盘） ----
        const b0 = win.getBounds();
        win.setBounds({ x: b0.x, y: b0.y, width: 1600, height: 900 }); // 模拟 DPI/吸附异常改写
        await new Promise(r => setTimeout(r, 1300));
        const b1 = win.getBounds();
        // 对照设计常量而非 baseSize：baseSize 本身若被坏数据带偏，跟它比会假绿
        const healOk = b1.width === DESIGN_W && b1.height === DESIGN_H;
        console.log('[size-test] rogue-resize self-heal', JSON.stringify({ base: baseSize, after: { w: b1.width, h: b1.height } }), healOk ? 'PASS' : 'FAIL');
        // ---- v1.0.20 自检：坏落盘尺寸清洗（旧版拉伸尺寸固化进 winSize、重装不恢复的实报 bug）----
        // 毒化 winSize 后走采纳逻辑：必须回设计尺寸并清写落盘
        persist({ winSize: { w: 900, h: 920 } });
        const adopted = adoptWinSize();
        const purgeOk = adopted.w === DESIGN_W && adopted.h === DESIGN_H &&
          settings.winSize.w === DESIGN_W && settings.winSize.h === DESIGN_H;
        console.log('[size-test] poisoned-winSize purge', JSON.stringify({ adopted, disk: settings.winSize }), purgeOk ? 'PASS' : 'FAIL');
        const anchorOk = baseSize.w === DESIGN_W && baseSize.h === DESIGN_H;
        console.log('[size-test] base-anchor', JSON.stringify(baseSize), anchorOk ? 'PASS' : 'FAIL');
        // ---- v1.0.17 自检：settings:update 白名单（合法键放行 / 注入键与非法 updateUrl 拒收） ----
        const wl = JSON.parse(await win.webContents.executeJavaScript(`(async () => {
          const r1 = await sky.updateSettings({ refreshMinutes: 10, hacked: 'x', updateUrl: 'javascript:alert(1)' });
          return JSON.stringify({
            hackedGone: !('hacked' in r1),
            badUrlRejected: r1.updateUrl !== 'javascript:alert(1)',
            refreshOk: r1.refreshMinutes === 10
          });
        })()`));
        const wlOk = wl.hackedGone && wl.badUrlRejected && wl.refreshOk;
        console.log('[settings-test] whitelist', JSON.stringify(wl), wlOk ? 'PASS' : 'FAIL');
        // ---- v1.0.17 新功能自检：分钟级降水 / 24h 趋势 / 朝晚霞 / 托盘温度 / 早晚报 ----
        const nf = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const mm = document.getElementById('mmWrap');
          const bars = mm ? mm.querySelectorAll('.mm-bar, .mm-sprout') : []; // 槽位=柱或草芽（俏皮彩蛋后无雨槽是草芽）
          const sum = mm ? (mm.querySelector('.mm-sum') || {}).textContent || '' : '';
          const trend = document.getElementById('trendWrap');
          const path = trend ? trend.querySelector('path.tr-line') : null;
          const chips = (document.getElementById('statRow') || {}).textContent || '';
          const st = window.__selftest || {};
          const glow = st.computeGlow ? st.computeGlow() : {};
          const tray = st.trayDataURL ? st.trayDataURL(23, true) : '';
          const brief = st.briefText ? st.briefText('am') : null;
          return JSON.stringify({
            mmBars: bars.length, mmSum: sum,
            trendLen: path ? (path.getAttribute('d') || '').length : 0,
            trendPops: trend ? trend.querySelectorAll('rect.tr-pop').length + trend.querySelectorAll('text.tr-zero').length : 0, // 概率柱+0%标注=完整槽位覆盖
            glowDawn: glow.dawn ? glow.dawn.label : '', glowDusk: glow.dusk ? glow.dusk.label : '',
            chipsHasGlow: chips.indexOf('朝霞') !== -1 && chips.indexOf('晚霞') !== -1,
            trayOk: tray.indexOf('data:image/png') === 0 && tray.length > 500,
            briefOk: !!(brief && brief.title && brief.body && brief.body.indexOf('°') !== -1)
          });
        })()`));
        const nfOk = nf.mmBars === 8 && !!nf.mmSum && nf.trendLen > 30 && nf.chipsHasGlow && nf.trayOk && nf.briefOk;
        console.log('[mm-test] 8bars+summary', nf.mmBars, JSON.stringify(nf.mmSum), (nf.mmBars === 8 && !!nf.mmSum) ? 'PASS' : 'FAIL');
        console.log('[chart-test] trend path/pops', nf.trendLen, nf.trendPops, (nf.trendLen > 30 && nf.trendPops > 0) ? 'PASS' : 'FAIL');
        console.log('[glow-test] dawn/dusk', JSON.stringify(nf.glowDawn), JSON.stringify(nf.glowDusk), nf.chipsHasGlow ? 'PASS' : 'FAIL');
        console.log('[tray-test] dataURL', nf.trayOk ? 'PASS' : 'FAIL');
        console.log('[brief-test] text', nf.briefOk ? 'PASS' : 'FAIL');
        console.log('[newfeat-test] DONE', nfOk ? 'PASS' : 'FAIL');
        // ---- 论坛反馈修复自检：趋势横轴时间刻度 / 模块开关链路 ----
        const tt = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const t = document.getElementById('trendWrap');
          return JSON.stringify({
            ticks: t ? t.querySelectorAll('text.tr-tick').length : 0,
            grids: t ? t.querySelectorAll('line.tr-grid').length : 0
          });
        })()`));
        console.log('[trend-test] time ticks', JSON.stringify(tt), (tt.ticks >= 3 && tt.grids >= 2) ? 'PASS' : 'FAIL');
        // 0 值标注自检：趋势图每时刻非「概率柱」即「0%」标注覆盖完整；草芽图形必须为 0（已移除：与温度曲线重叠）；
        // 分钟级 8 槽为柱或草芽、每槽有 mm 数值（0mm 直给不靠猜）
        const spr = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const t = document.getElementById('trendWrap');
          return JSON.stringify({
            pops: t ? t.querySelectorAll('.tr-pop').length : 0,
            sprouts: t ? t.querySelectorAll('.tr-sprouts > g').length : 0,
            zeros: t ? t.querySelectorAll('text.tr-zero').length : 0,
            mm: document.querySelectorAll('#mmWrap .mm-bar, #mmWrap .mm-sprout').length,
            mmVals: document.querySelectorAll('#mmWrap .mm-val').length
          });
        })()`));
        console.log('[sprout-test] zero-witty', JSON.stringify(spr), (spr.sprouts === 0 && spr.pops + spr.zeros >= 20 && spr.mm === 8 && spr.mmVals === 8) ? 'PASS' : 'FAIL');
        // ---- v1.0.23 自检：雷达卡 vivo 式时间轴（sendInputEvent 真实拖动 + 播放/暂停 + 雨情文案） ----
        // 放在模块开关/排序测试之前：applyModules 重建会清掉 content-visibility:auto 的记住尺寸，
        // scrollHeight 缩水会让页底卡片够不着（一次性大跳滚动会被占位尺寸 clamp）。
        // 取景直接对准时间轴轨道中心（交互目标）；rect.height=0（区块未渲染）按 700px 步进下探逼它渲染。
        let prevSt = -1, jumps = 0;
        for (let i = 0; i < 14; i++) {
          const j = JSON.parse(await win.webContents.executeJavaScript(`(() => {
            const w = document.getElementById("widget");
            const t = document.querySelector('#modRadar [data-rscrub] .x-r-track');
            const r = t.getBoundingClientRect(), wr = w.getBoundingClientRect();
            if (!r.height) { w.scrollTop += 700; return JSON.stringify({ d: 9999, st: Math.round(w.scrollTop) }); }
            const delta = Math.round((r.top + r.height / 2) - (wr.top + wr.height / 2));
            if (Math.abs(delta) > 2) w.scrollTop += delta;
            return JSON.stringify({ d: delta, st: Math.round(w.scrollTop) });
          })()`));
          jumps++;
          // 到位退出 / 已到滚动极限退出（目标中心偶尔落在 maxTop 之外，|d|<=2 永远够不着）
          if (Math.abs(j.d) <= 2 || j.st === prevSt) break;
          prevSt = j.st;
          await new Promise(r => setTimeout(r, 400));
        }
        console.log('[radar-test] frame-jump', jumps, 'jumps');
        await new Promise(r => setTimeout(r, 500));
        await shoot('shot-q3-radar.png');
        const rt0 = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const el = document.getElementById('modRadar');
          return JSON.stringify({
            label: (el.querySelector('.x-r-now') || {}).textContent || '',
            ticks: el.querySelectorAll('.x-r-tick').length,
            labs: el.querySelectorAll('.x-r-tick b').length,
            knob: !!el.querySelector('.x-r-knob'),
            tip: (el.querySelector('.x-r-tip') || {}).textContent || ''
          });
        })()`));
        console.log('[radar-test] timeline-shape', JSON.stringify(rt0), (rt0.ticks >= 2 && rt0.labs >= 2 && rt0.knob) ? 'PASS' : 'FAIL');
        console.log('[radar-test] rain-tip', JSON.stringify(rt0.tip), rt0.tip ? 'PASS' : 'FAIL');
        // 真实拖动时间轴到最左（首帧）：起点/落点都留在 track 容器内（落点出容器 pointerup 不冒泡会假绿）
        const tl = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const t = document.querySelector('#modRadar [data-rscrub] .x-r-track').getBoundingClientRect();
          return JSON.stringify({ left: Math.round(t.left + 4), right: Math.round(t.right - 4), midY: Math.round(t.top + t.height / 2) });
        })()`));
        const viewH = await win.webContents.executeJavaScript('window.innerHeight');
        console.log('[radar-test] scrub-coords', JSON.stringify({ tl, viewH }), (tl.right - tl.left > 40 && tl.midY > 10 && tl.midY < viewH - 10) ? 'IN-VIEW' : 'OUT-OF-VIEW');
        await win.webContents.sendInputEvent({ type: 'mouseMove', x: tl.right, y: tl.midY });
        await win.webContents.sendInputEvent({ type: 'mouseDown', x: tl.right, y: tl.midY, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 5; i++) {
          await win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(tl.right + (tl.left - tl.right) * i / 5), y: tl.midY });
          await new Promise(r => setTimeout(r, 80));
        }
        await win.webContents.sendInputEvent({ type: 'mouseUp', x: tl.left, y: tl.midY, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 400));
        const rt1 = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const el = document.getElementById('modRadar');
          const b = el.querySelector('.x-r-tick b.first');
          return JSON.stringify({
            label: (el.querySelector('.x-r-now') || {}).textContent || '',
            play: (el.querySelector('[data-rplay]') || {}).textContent || '',
            firstLab: b ? b.textContent : ''
          });
        })()`));
        const scrubOk = rt1.firstLab !== '' && rt1.label.indexOf(rt1.firstLab) === 0 && rt1.play === '▶';
        console.log('[radar-test] scrub-to-first', JSON.stringify({ before: rt0.label, after: rt1.label, firstLab: rt1.firstLab, play: rt1.play }), scrubOk ? 'PASS' : 'FAIL');
        await shoot('shot-q3-radar-scrubbed.png');
        // 复位默认播放态（拖动即暂停 → 点回播放）
        await win.webContents.executeJavaScript(`document.querySelector('#modRadar [data-rplay]').click()`);
        await new Promise(r => setTimeout(r, 300));
        const rt2 = await win.webContents.executeJavaScript(`document.querySelector('#modRadar [data-rplay]').textContent`);
        console.log('[radar-test] play-restore', rt2, rt2 === '❚❚' ? 'PASS' : 'FAIL');
        // 动效回归（v1.0.28 热修，用户口谕「我让你优化，又没让你减少动态效果」）：
        // 本机 matchMedia reduce=true 也不能自动加 motion-quiet；只有用户显式「关闭」才静止。
        const sysReduce = await win.webContents.executeJavaScript(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
        const autoQuiet = await win.webContents.executeJavaScript(`document.body.classList.contains('motion-quiet')`);
        console.log('[motion-test] no-auto-quiet', JSON.stringify({ sysReduce, autoQuiet }), !autoQuiet ? 'PASS' : 'FAIL');
        const frameState = `(() => {
          const el = document.getElementById('modRadar');
          const k = el.querySelector('.x-r-knob');
          return JSON.stringify({ lab: (el.querySelector('.x-r-now') || {}).textContent || '',
            kx: k ? k.style.transform : '' });
        })()`;
        const defaultSweep = await win.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('#modRadar .x-radar-sweep')).animationName`);
        console.log('[radar-test] default-sweep', defaultSweep, defaultSweep === 'x-spin' ? 'PASS' : 'FAIL');
        // 帧循环必须真的推进：旧自检只查形状/按钮文字，才让「整卡静止」溜过发版
        const fA = await win.webContents.executeJavaScript(frameState);
        await new Promise(r => setTimeout(r, 1500));
        const fB = await win.webContents.executeJavaScript(frameState);
        console.log('[radar-test] frame-advance', JSON.stringify({ a: fA, b: fB }), fA !== fB ? 'PASS' : 'FAIL');
        // 用户显式「关闭动效」：扫掠静止 + 帧轮播停（这是唯一允许静止的入口）
        await win.webContents.executeJavaScript(`document.body.classList.add('motion-quiet'); document.body.classList.add('motion-off');`);
        await new Promise(r => setTimeout(r, 150));
        const sweepOff = await win.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('#modRadar .x-radar-sweep')).animationName`);
        console.log('[radar-test] user-off-sweep', sweepOff, sweepOff === 'none' ? 'PASS' : 'FAIL');
        const oA = await win.webContents.executeJavaScript(frameState);
        await new Promise(r => setTimeout(r, 1600));
        const oB = await win.webContents.executeJavaScript(frameState);
        console.log('[radar-test] user-off-frame', JSON.stringify({ a: oA, b: oB }), oA === oB ? 'PASS' : 'FAIL');
        // 状态复位后帧循环要能自己恢复；后续模块开关/形变断言不能带临时类跑
        await win.webContents.executeJavaScript(`document.body.classList.remove('motion-off'); document.body.classList.remove('motion-quiet');`);
        await new Promise(r => setTimeout(r, 250));
        const zA = await win.webContents.executeJavaScript(frameState);
        await new Promise(r => setTimeout(r, 1500));
        const zB = await win.webContents.executeJavaScript(frameState);
        console.log('[radar-test] resume-frame', JSON.stringify({ a: zA, b: zB }), zA !== zB ? 'PASS' : 'FAIL');
        // 模块开关：真实走设置面板勾选链路（change → updateSettings → applyModules），测完还原
        await win.webContents.executeJavaScript(`document.getElementById("btnSettings").click()`);
        await new Promise(r => setTimeout(r, 500));
        await win.webContents.executeJavaScript(`(() => {
          const c = document.getElementById('chkModAlmanac');
          c.checked = false; c.dispatchEvent(new Event('change'));
        })()`);
        await new Promise(r => setTimeout(r, 600));
        const modOff = await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('modAlmanac')).display === 'none'`);
        await win.webContents.executeJavaScript(`(() => {
          const c = document.getElementById('chkModAlmanac');
          c.checked = true; c.dispatchEvent(new Event('change'));
        })()`);
        await new Promise(r => setTimeout(r, 600));
        const modOn = await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('modAlmanac')).display !== 'none'`);
        // 模块排序：真实拖动 ≡ 手柄把「万年历」拖到列表首行手柄上（sendInputEvent 真实鼠标链路），验证持久化 + 主界面重排。
        // 必须与初始顺序无关：shot profile 跨运行保留 modulesOrder，若上次已把万年历拖到顶，
        // 「拖到 globe 位置」会变成向下拖一行（实测翻车）；拖到「首行手柄」在任意初始顺序下语义一致（已在顶则无操作）。
        // 落点必须留在列表内：合成输入下 setPointerCapture 不生效时，列表外松手的 pointerup 不冒泡到 #modSort（现已有 window 兜底，双保险）。
        await win.webContents.executeJavaScript(`document.getElementById('modSort').scrollIntoView({ block: 'center' })`);
        await new Promise(r => setTimeout(r, 400));
        const hd = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const a = document.querySelector('.mod-row[data-mod="almanac"] .mod-handle').getBoundingClientRect();
          const f = document.querySelector('#modSort .mod-row .mod-handle').getBoundingClientRect();
          return JSON.stringify({ ax: Math.round(a.x + a.width / 2), ay: Math.round(a.y + a.height / 2), fy: Math.round(f.y + f.height / 2) });
        })()`));
        await win.webContents.sendInputEvent({ type: 'mouseMove', x: hd.ax, y: hd.ay });
        await win.webContents.sendInputEvent({ type: 'mouseDown', x: hd.ax, y: hd.ay, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 6; i++) {
          await win.webContents.sendInputEvent({ type: 'mouseMove', x: hd.ax, y: Math.round(hd.ay + (hd.fy - hd.ay) * i / 6) });
          await new Promise(r => setTimeout(r, 80));
        }
        await win.webContents.sendInputEvent({ type: 'mouseUp', x: hd.ax, y: hd.fy, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 700));
        const mo = JSON.parse(await win.webContents.executeJavaScript(`(async () => {
          const kids = [...document.getElementById('widget').children].filter(e => /^mod(Globe|Hourly|Daily|Duo|Almanac)$/.test(e.id)).map(e => e.id);
          const s = await sky.getSettings();
          return JSON.stringify({ first: kids[0] || '', ord: (s.modulesOrder || []).join(',') });
        })()`));
        const moOk = mo.first === 'modAlmanac' && mo.ord.startsWith('almanac');
        console.log('[modorder-test] drag-to-top', JSON.stringify(mo), moOk ? 'PASS' : 'FAIL');
        // 复位默认顺序：shot profile 落盘状态不残留到下次运行（启动 init 会按落盘顺序应用）
        await win.webContents.executeJavaScript(`sky.updateSettings({ modulesOrder: ['globe','hourly','daily','duo','almanac'] })`);
        await win.webContents.executeJavaScript(`document.getElementById("closeSettings").click()`);
        console.log('[mod-test] toggle', JSON.stringify({ modOff, modOn }), (modOff && modOn) ? 'PASS' : 'FAIL');
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
        // 5. 地平线裁剪回归（2026-10-29 全绿 bug）：多视角像素级 + 几何双重断言
        // 旧 polyD 把背面顶点压到球沿后仍连直线 → 背面顶点连成大楔形把圆盘填成陆地绿。
        // 断言一（几何指纹）：各陆地多边形投影面积（鞋带公式）< 整盘 40%（正确时单洲 ≤20%，
        // 楔形 bug 时会顶到接近 100%）；断言二：正午整面皆昼时陆地绿像素占比 < 42%。
        const greenShare = async r => {
          const img = await win.webContents.capturePage(r);
          const bmp = img.toBitmap();
          let green = 0, total = 0;
          for (let i = 0; i < bmp.length; i += 4) {
            if (bmp[i + 3] < 128) continue;
            total++;
            const b = bmp[i], g = bmp[i + 1], rr = bmp[i + 2];
            if (g > rr + 18 && g > b + 18) green++;
          }
          return total ? green / total : 0;
        };
        const stageRect = { x: Math.round(geo0.stage.x), y: Math.round(geo0.stage.y), width: Math.round(geo0.stage.w), height: Math.round(geo0.stage.h) };
        const noonUTC = lon => Date.UTC(2026, 9, 29, 12, 0, 0) - lon * 4 * 60000;
        for (const [name, lat, lon, assert] of [
          ['photo', -5, -60, true], ['americas', 30, -60, true], ['pacific', 10, -160, true],
          ['atlantic', 20, -35, true], ['asia', 30, 121, false], ['south', -60, 0, false]
        ]) {
          await win.webContents.executeJavaScript(`Globe._debug.setSimTime(${noonUTC(lon)}); Globe._debug.setView(${lat}, ${lon})`);
          await new Promise(r => setTimeout(r, 250));
          const areas = JSON.parse(await win.webContents.executeJavaScript(`(() => {
            const R = +document.querySelector('#gDisc circle').getAttribute('r'), disc = Math.PI * R * R;
            return JSON.stringify([...document.querySelectorAll('#gLands path')].map(p => {
              const nums = (p.getAttribute('d') || '').match(/-?[\\d.]+/g) || [];
              const n = nums.length / 2;
              let a = 0;
              for (let k = 0; k < n; k++) {
                a += (+nums[2 * k]) * (+nums[2 * ((k + 1) % n) + 1]) - (+nums[2 * ((k + 1) % n)]) * (+nums[2 * k + 1]);
              }
              return Math.abs(a / 2) / disc;
            }));
          })()`));
          const maxArea = Math.max(...areas);
          const share = await greenShare(stageRect);
          await shoot('g-8-clip-' + name + '.png', stageRect);
          const detail = 'greenShare=' + (share * 100).toFixed(1) + '% maxPolyArea=' + (maxArea * 100).toFixed(1) + '%';
          if (assert) check('horizon-clip-' + name, share < 0.42 && maxArea < 0.40, detail);
          else console.log('[globe-test] horizon-clip-' + name, detail, '(目检)');
        }
        // 5b. 全角度洪水扫描（回归常备）：每 10° 一个相机，鞋带面积找「陆地填满圆盘」。
        // 楔形/整圆 bug 时单洲面积 83~100%；欧亚居中正对相机的真实最大面积约 38%，
        // 阈值 0.45 留足双向余量——命中即为地平线裁剪回归。
        const scan = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const R = +document.querySelector('#gDisc circle').getAttribute('r'), disc = Math.PI * R * R;
          const names = ['africa','eurasia','namerica','samerica','australia','greenland','madagascar','japan','uk','ireland','nz','tasmania','srilanka','cuba','sumatra','java','borneo','newguinea','philippines','antarctica'];
          const worst = [];
          for (let lat = -80; lat <= 80; lat += 10) {
            for (let lon = -180; lon < 180; lon += 10) {
              Globe._debug.setView(lat, lon);
              let mx = 0, who = '';
              document.querySelectorAll('#gLands path').forEach((p, i) => {
                const nums = (p.getAttribute('d') || '').match(/-?[\\d.]+/g) || [];
                const n = nums.length / 2;
                let a = 0;
                for (let k = 0; k < n; k++) {
                  a += (+nums[2 * k]) * (+nums[2 * ((k + 1) % n) + 1]) - (+nums[2 * ((k + 1) % n)]) * (+nums[2 * k + 1]);
                }
                const s = Math.abs(a / 2) / disc;
                if (s > mx) { mx = s; who = names[i] || i; }
              });
              if (mx > 0.45) worst.push([lat, lon, who, +(mx * 100).toFixed(1)]);
            }
          }
          return JSON.stringify({ hits: worst.length, worst: worst.slice(0, 30) });
        })()`));
        console.log('[globe-test] flood-scan', JSON.stringify(scan));
        check('flood-scan-clean', scan.hits === 0, JSON.stringify(scan));
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
        await shoot('u-3-settings.png');    // 设置页「软件更新」区块（应含「立即重启」动作按钮）
        // 设置页更新动作按钮自检：downloaded 态应可见且文案为「立即重启」
        const du = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          const b = document.getElementById('btnDoUpdate');
          return JSON.stringify({ hidden: b.hidden, text: b.textContent.trim() });
        })()`));
        const duOk = !du.hidden && du.text === '立即重启';
        console.log('[ota-shot] settings update button', JSON.stringify(du), duOk ? 'PASS' : 'FAIL');
        const flowOk = updateState.type === 'downloaded' && duOk;
        // 消费标记防回环自检：模拟「已确认安装」（本次安装包 sha512 落盘）后，
        // 同一 offer 再来必须被守卫按「已装即已拥有」静默跳过（up-to-date 且横幅不再弹）
        let guardOk = false;
        try {
          if (pendingUpdateSha) {
            persist({ updSha512: pendingUpdateSha });
            updateState = { type: 'checking' };
            autoUpdater.checkForUpdates();
            const t1 = Date.now();
            while (updateState.type !== 'up-to-date' && updateState.type !== 'available' && Date.now() - t1 < 15000) {
              await new Promise(r => setTimeout(r, 500));
            }
            await new Promise(r => setTimeout(r, 400));
            const b3 = await win.webContents.executeJavaScript(`(() => {
              const cs = getComputedStyle(document.getElementById('updateBanner'));
              return JSON.stringify({ hidden: cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1 });
            })()`);
            guardOk = updateState.type === 'up-to-date' && JSON.parse(b3).hidden;
          }
        } catch (e) { guardOk = false; }
        console.log('[ota-shot] consumed-sha guard', JSON.stringify({ sha: String(pendingUpdateSha).slice(0, 12), state: updateState.type }), guardOk ? 'PASS' : 'FAIL');
        console.log('[ota-shot] DONE', (flowOk && guardOk) ? 'PASS' : 'FAIL');
      } catch (e) { console.error('[shot] failed', e); }
      app.exit(0);
    }, 8000);
  }

  // --shot-dock：吸顶小窗位置链路自检（真实拖拽链路平移大窗 → 收起小窗跟随 / 位置记忆固化 / 拖拽基准不回跳）
  if (process.argv.includes('--shot-dock')) {
    setTimeout(async () => {
      const passes = [];
      const check = (name, ok, detail) => { passes.push(!!ok); console.log('[dock-test]', name, detail, ok ? 'PASS' : 'FAIL'); };
      const saved = { winPos: settings.winPos ? JSON.parse(JSON.stringify(settings.winPos)) : null, dockX: settings.dockX, docked: settings.docked, alwaysOnTop: settings.alwaysOnTop };
      try {
        // #70 用户真实配置：置顶关 → 吸顶小窗走「桌面部件贴附」路径（压程序窗口后、显示桌面浮出）
        settings.alwaysOnTop = false; applyTopmost();
        const pillXOf = (b) => b.x + Math.round((baseSize.w - PILL_W) / 2); // 小窗屏幕 x（形状相对窗口，随窗口平移）
        // 0. 退出吸顶 → 定位到已知坐标 → 拖到顶部吸附（真实业务入口 dockWindow）
        undockWindow();
        await new Promise(r => setTimeout(r, 400));
        setBoundsSafe({ x: 240, y: 320, width: baseSize.w, height: baseSize.h });
        await new Promise(r => setTimeout(r, 600));
        dockWindow();
        await new Promise(r => setTimeout(r, 600));
        const b1 = win.getBounds();
        const pill1 = pillXOf(b1);
        check('snap-align', pill1 === 240 + Math.round((baseSize.w - PILL_W) / 2) && b1.y === screen.getDisplayMatching(b1).workArea.y, `pill1=${pill1}`);
        // 1. 展开 + 真实拖拽链路（renderer winDrag → IPC → setPosition）把大窗右移 432px
        expandDock();
        await new Promise(r => setTimeout(r, 400));
        await win.webContents.executeJavaScript(`sky.winDrag(100, 500); sky.winDrag(532, 500); sky.winDragEnd();`);
        await new Promise(r => setTimeout(r, 1000)); // 过吸附防抖(350ms)+程序改位抑制窗(600ms)
        const b2 = win.getBounds();
        check('pan-moved', b2.x - b1.x === 432, `dx=${b2.x - b1.x}`);
        // 2. 收起 → 小窗必须出现在大窗平移后的位置（x 跟随大窗中心）
        collapseDock();
        await new Promise(r => setTimeout(r, 900));
        const b3 = win.getBounds();
        const pill3 = pillXOf(b3);
        check('collapse-follow', pill3 - pill1 === 432, `pill1=${pill1} pill3=${pill3}`);
        // 3. 位置记忆固化：重启 startDocked 按 dockX 还原，必须等于当前小窗 x（否则重启后小窗回旧位）
        check('dockX-fresh', settings.dockX === pill3, `dockX=${settings.dockX} pill3=${pill3}`);
        // 4. 拖拽基准重置：旧拖拽没发 drag-end 就开新拖拽，窗口必须按新基准走、不得按旧基准回跳
        await win.webContents.executeJavaScript(`sky.winDrag(100, 500); sky.winDrag(300, 500);`); // 旧拖拽（无结束）+200
        await new Promise(r => setTimeout(r, 800));
        const bx = win.getBounds().x;
        await win.webContents.executeJavaScript(`(() => {
          const el = document.querySelector('.pill-grip') || document.querySelector('.hero-top');
          const opt = (x) => ({ bubbles: true, cancelable: true, button: 0, screenX: x, screenY: 500 });
          el.dispatchEvent(new MouseEvent('mousedown', opt(600)));
          window.dispatchEvent(new MouseEvent('mousemove', opt(900)));
          window.dispatchEvent(new MouseEvent('mouseup', opt(900)));
        })()`);
        await new Promise(r => setTimeout(r, 800));
        const bx2 = win.getBounds().x;
        check('drag-base-reset', bx2 - bx === 300, `dx=${bx2 - bx}`);
        // 5. 显示桌面保活：docked 态被系统最小化（Win+D 同链路 win.minimize）→ 必须自动恢复常驻
        win.minimize();
        await new Promise(r => setTimeout(r, 800)); // 等 undoMinimize 三连兜底跑完
        const b5 = win.getBounds();
        check('minimize-keep-docked', !win.isMinimized() && b5.x > -2000 && b5.y > -2000,
          `docked=${settings.docked} minimized=${win.isMinimized()} bounds=${b5.x},${b5.y}`);
        // 5b. 真实「显示桌面」链路复现：Shell.Application.MinimizeAll 与任务栏右下角按钮同路径，
        //     计数 minimize 事件（若为 0 = 系统路径根本不走该事件，须换机制）
        const { execSync, exec } = require('child_process');
        let minEvents = 0;
        const cnt = () => { minEvents++; };
        win.on('minimize', cnt);
        execSync('powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).MinimizeAll()"');
        await new Promise(r => setTimeout(r, 1500));
        win.removeListener('minimize', cnt);
        const bs = win.getBounds();
        check('show-desktop-keep-docked', !win.isMinimized() && bs.x > -2000 && bs.y > -2000,
          `minimized=${win.isMinimized()} bounds=${bs.x},${bs.y} minEvents=${minEvents}`);
        execSync('powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).UndoMinimizeAll()"');
        await new Promise(r => setTimeout(r, 400));
        // 5c. 真实「显示桌面」按钮：模拟点击任务栏最右下角小竖条（与用户手势同一条 explorer Toggle Desktop 路径）。
        //     正对照：helper 常规窗必须被最小化（证明手势真触发），桌面截图留证。
        const psRun = (script) => execSync('powershell -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64'), { timeout: 8000 });
        // 窗口操作类脚本必须异步跑：execSync 会堵死主进程消息泵，跨进程
        // SetParent/SetWindowPos 需要与目标窗口线程同步 → 互相等死（ETIMEDOUT）
        const psRunAsync = (script) => new Promise((resolve) => {
          exec('powershell -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64'),
            { timeout: 15000 }, (err, stdout) => resolve(String(stdout || '').trim() + (err ? ` [ps-err ${err.code || err.message}]` : '')));
        });
        // 显式传真实 HWND（Get-Process MainWindowHandle 在有 helper 窗口时有歧义）
        const HWNDS = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
        const CLICK_SHOWDESK = `Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);}'
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[M]::SetCursorPos($b.Width-2,$b.Height-2)
Start-Sleep -Milliseconds 250
[M]::mouse_event(0x02,0,0,0,[UIntPtr]::Zero)
[M]::mouse_event(0x04,0,0,0,[UIntPtr]::Zero)`;
        const helper = new BrowserWindow({ width: 300, height: 200, x: 80, y: 220, show: true });
        try { helper.loadURL('about:blank'); } catch (e) { }
        await new Promise(r => setTimeout(r, 800));
        const tmp = require('os').tmpdir();
        const shotDesk = (name) => psRun(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
$bmp.Save('${path.join(tmp, name).replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose()`).toString();
        await shotDesk('desk-before.png');
        // 「显示桌面」类手势本质是 toggle：方向取决于当前桌面态。5b 的 UndoMinimizeAll 落地时机
        // 可能让首次点击落在「还原」一侧，helper 就保持可见 → 正对照假 FAIL（实测偶发）。
        // 统一策略：每次触发前保证 helper 可见，触发后只观察「可见 → 最小化」这一确定翻转；
        // 若落在还原侧，桌面态已翻回常态，下一次触发必然进入显示桌面态。最多 4 次仍不中才判真失败。
        const fireDesktopToggle = async (gesture) => {
          let tries = 0, ok = false, evts = 0;
          for (let i = 0; i < 4 && !ok; i++) {
            if (helper.isMinimized()) { helper.restore(); await new Promise(r => setTimeout(r, 400)); }
            tries++;
            minEvents = 0; win.on('minimize', cnt);
            psRun(gesture);
            await new Promise(r => setTimeout(r, 1400));
            win.removeListener('minimize', cnt);
            evts = minEvents;
            ok = helper.isMinimized();
          }
          return { ok, tries, evts };
        };
        const gClick = await fireDesktopToggle(CLICK_SHOWDESK);
        const bc = win.getBounds();
        check('show-desktop-click-gesture', gClick.ok,
          `helperMin=${helper.isMinimized()} tries=${gClick.tries}（正对照：手势必须真触发）`);
        check('show-desktop-click-keep', !win.isMinimized() && bc.x > -2000 && bc.y > -2000,
          `minimized=${win.isMinimized()} bounds=${bc.x},${bc.y} minEvents=${gClick.evts}`);
        await shotDesk('desk-after-click.png');
        psRun(CLICK_SHOWDESK); // 再点一次还原其他窗口
        await new Promise(r => setTimeout(r, 600));
        // 5d. 真实 Win+D 键盘路径（SendInput），同样带正对照
        const WIN_D = `Add-Type 'using System;using System.Runtime.InteropServices;public class K{[DllImport("user32.dll")]public static extern void keybd_event(byte b,byte s,uint f,UIntPtr e);}'
[K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event(0x44,0,0,[UIntPtr]::Zero)
[K]::keybd_event(0x44,0,2,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`;
        // helper 的复位/翻转去抖统一交给 fireDesktopToggle，不再用一次裸 Win+D 猜方向
        // 5e. 像素级可见性断言（#70 真相：被壁纸盖住时窗口「健康」但用户看不见，光查 bounds/isMinimized 会假绿）。
        //     全部取样在「显示桌面」态内完成：常态下工作区窗口可能正好盖住小窗区 → 基准被污染（实测假 FAIL）；
        //     显示桌面态屏幕 = 壁纸 + 小窗，干净。DPI 感知截屏 + 小窗裁片比对（详见下方采样流程）。
        const SCALE = screen.getPrimaryDisplay().scaleFactor || 1;
        const shotDpi = (name) => psRun(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type 'using System.Runtime.InteropServices;public class D{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
[D]::SetProcessDPIAware() | Out-Null
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
$bmp.Save('${path.join(tmp, name).replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose()`);
        const cropBuf = (name) => {
          const img = nativeImage.createFromPath(path.join(tmp, name));
          const bb = win.getBounds();
          const px = bb.x + Math.round((baseSize.w - PILL_W) / 2);
          return img.crop({ x: Math.round(px * SCALE), y: 0, width: Math.round(PILL_W * SCALE), height: Math.round(PILL_H * SCALE) }).toBitmap();
        };
        const mmd = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]); return s / n; };
        const gWinD = await fireDesktopToggle(WIN_D);
        const bd = win.getBounds();
        check('win-d-gesture', gWinD.ok,
          `helperMin=${helper.isMinimized()} tries=${gWinD.tries}（正对照：手势必须真触发）`);
        check('win-d-keep-docked', !win.isMinimized() && bd.x > -2000 && bd.y > -2000,
          `minimized=${win.isMinimized()} bounds=${bd.x},${bd.y} minEvents=${gWinD.evts}`);
        // 5e 采样：post = 显示桌面态带小窗裁片；wall = 同态下隐藏小窗后的纯壁纸裁片（基准在态内自取，免疫遮挡环境）
        shotDpi('pix-desktop.png'); const postPix = cropBuf('pix-desktop.png');
        win.hide(); await new Promise(r => setTimeout(r, 300));
        shotDpi('pix-wall.png'); const wallPix = cropBuf('pix-wall.png');
        win.showInactive(); applyTopmost(); await new Promise(r => setTimeout(r, 300));
        const dWall = mmd(postPix, wallPix);
        check('pixel-pill-on-desktop', dWall > 8, `dWall=${dWall.toFixed(2)}（显示桌面后小窗像素必须真出现在壁纸上）`);
        // 判别力正对照：同态下在小窗位置放一个实心洋红窗，裁片必须分辨出来（证明裁片管线看的正是这个位置、不是壁纸自然差异）。
        // 正对照必须 topmost：显示桌面时壁纸层在普通窗之上，普通窗会被盖住（实测 pix-ctrl==pix-wall 的教训）。
        const pillX0 = win.getBounds().x + Math.round((baseSize.w - PILL_W) / 2);
        const ctrl = new BrowserWindow({ x: pillX0, y: 0, width: PILL_W, height: PILL_H, show: true, frame: false, backgroundColor: '#ff00ff', resizable: false, focusable: false });
        ctrl.loadURL('about:blank');
        ctrl.setAlwaysOnTop(true, 'screen-saver');
        await new Promise(r => setTimeout(r, 400));
        shotDpi('pix-ctrl.png'); const ctrlPix = cropBuf('pix-ctrl.png');
        try { ctrl.destroy(); } catch (e) { }
        check('pixel-discriminator', mmd(ctrlPix, wallPix) > 8, `dCtrl=${mmd(ctrlPix, wallPix).toFixed(2)}（正对照洋红窗必须可分辨）`);
        await shotDesk('desk-after-wind.png');
        psRun(WIN_D); // 再按一次还原其他窗口
        await new Promise(r => setTimeout(r, 500));
        try { helper.destroy(); } catch (e) { }
        // 5f. z 序语义断言（置顶关吸顶 = 桌面部件）：普通程序窗口必须压在小窗前面。
        //     koffi z 链遍历直接读序（红窗截图会被工作区窗口遮挡污染，z 序断言免疫环境）。
        const pillHwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
        const pillScreenX = win.getBounds().x + Math.round((baseSize.w - PILL_W) / 2);
        const cover = new BrowserWindow({ x: pillScreenX, y: 0, width: PILL_W, height: PILL_H, show: true, frame: false, backgroundColor: '#ff0000', resizable: false, focusable: false });
        await new Promise(r => setTimeout(r, 600)); // 贴附定时器稳定：小窗钉壁纸层上沿，红窗必须在其上
        shotDpi('pix-cover.png'); // 取证留档
        let pillIdx = -1, coverIdx = -1;
        const AG = glueInit();
        if (AG) {
          const coverHwnd = cover.getNativeWindowHandle().readBigUInt64LE(0);
          const seenH = new Set();
          let p2 = AG.getWindow(AG.getDesktop(), 5), i2 = 0; // GW_CHILD：z 序自顶向下
          while (p2 && p2 !== 0n && i2 < 2000) {
            const hs = String(p2); if (seenH.has(hs)) break; seenH.add(hs);
            if (hs === String(pillHwnd)) pillIdx = i2;
            if (hs === String(coverHwnd)) coverIdx = i2;
            p2 = AG.getWindow(p2, 2); i2++; // GW_HWNDNEXT 向 z 序下方
          }
          if (pillIdx < 0 || coverIdx < 0) console.log('[dock-test][diag] z链长=', i2, 'pillH=', String(pillHwnd), 'coverH=', String(coverHwnd), '链首=', String(AG.getWindow(AG.getDesktop(), 5)));
        }
        check('z-behind-windows', pillIdx >= 0 && coverIdx >= 0 && coverIdx < pillIdx,
          `pillIdx=${pillIdx} coverIdx=${coverIdx}（红窗 idx 必须小于小窗 idx = 红窗压在小窗上面）`);
        try { cover.destroy(); } catch (e) { }
        await new Promise(r => setTimeout(r, 200));
        // 6. 大窗态保持系统正常行为：非 docked 态最小化必须保持最小化（不被误拉回）
        undockWindow();
        await new Promise(r => setTimeout(r, 400));
        win.minimize();
        await new Promise(r => setTimeout(r, 800));
        check('minimize-normal-undocked', win.isMinimized(), `docked=${settings.docked} minimized=${win.isMinimized()}`);
        win.restore(); // 复位，别把最小化态留在屏幕上
      } catch (e) { console.error('[dock-test] failed', e); check('exception', false, String((e && e.message) || e)); }
      // 还原设置（不污染用户的位置记忆）
      try { settings.docked = saved.docked; settings.dockX = saved.dockX; settings.winPos = saved.winPos; persist({ docked: saved.docked, dockX: saved.dockX, winPos: saved.winPos, alwaysOnTop: saved.alwaysOnTop }); applyTopmost(); } catch (e) { }
      console.log('[dock-test] DONE', (passes.length === 15 && passes.every(Boolean)) ? 'PASS' : 'FAIL');
      app.exit(0);
    }, 1500);
  }

  let saveTimer = null;
  const saveGeom = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      if (Date.now() - programmatic < 600) return;
      // 最小化时 bounds 是 -32000 垃圾值：不能落盘（重启后窗飞出屏）也不能纠尺寸（会把窗口拉回屏上）
      if (win.isMinimized()) return;
      const b = win.getBounds();
      // 系统（DPI 切换 / 吸附 / 休眠恢复等）可能擅改窗口尺寸：
      // 立即纠回基准尺寸（只保位置），坏尺寸绝不落盘固化
      if (b.width !== baseSize.w || b.height !== baseSize.h) {
        setBoundsSafe({ x: b.x, y: b.y, width: baseSize.w, height: baseSize.h });
        return;
      }
      if (settings.docked) {
        // 吸顶态不覆盖 winPos，但小窗位置记忆必须跟上大窗平移（展开态拖动/程序移位），
        // 否则重启/开机自启后小窗按旧 dockX 还原 = 「小窗位置没变」
        const wa = screen.getDisplayMatching(b).workArea;
        const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
        if (px !== settings.dockX) { settings.dockX = px; persist({ dockX: px }); }
        return;
      }
      persist({ winPos: { x: b.x, y: b.y }, winSize: { w: baseSize.w, h: baseSize.h } });
    }, 400);
  };
  // 固定尺寸窗口：任何交互/系统触发的 resize 都是异常，直接拒绝（程序改位不受影响）
  win.on('will-resize', (e) => {
    if (Date.now() - programmatic >= 600) e.preventDefault();
  });
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

let trayInfoText = '云上晴雨 · 桌面天气';
/* 托盘右键菜单：刷新 / 切城市直达；tooltip 随天气刷新动态更新。
   菜单每次重建（频率=刷新周期），保证地点列表与「窗口置顶」勾选态始终是最新的。 */
function refreshTrayMenu(text) {
  if (!tray) return;
  if (text) trayInfoText = String(text).slice(0, 120) || trayInfoText;
  try { tray.setToolTip(trayInfoText); } catch (e) { }
  const locs = Array.isArray(settings.locations) ? settings.locations.slice(0, 12) : [];
  const citySub = locs.length ? locs.map(l => ({
    label: String((l && l.name) || '未知地点').slice(0, 24),
    type: 'radio',
    checked: l.id === settings.activeId,
    click: () => { if (win && !win.isDestroyed()) win.webContents.send('tray:action', { type: 'switch', id: l.id }); }
  })) : [{ label: '（暂无保存的地点）', enabled: false }];
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: trayInfoText, enabled: false },
      { type: 'separator' },
      { label: '显示天气', click: () => win && win.show() },
      { label: '立即刷新', click: () => { if (win && !win.isDestroyed()) win.webContents.send('tray:action', { type: 'refresh' }); } },
      { label: '切换城市', submenu: citySub },
      { label: '窗口置顶', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (m) => { persist({ alwaysOnTop: m.checked }); win && applyTopmost(); refreshTrayMenu(); } },
      { type: 'separator' },
      { label: '退出', click: () => { win = null; app.quit(); } }
    ]));
  } catch (e) { }
}
function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    refreshTrayMenu();
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
let checkWatchdog = null; // 检查看门狗：网络异常时更新请求可能永远挂起不回调，超时收场别让界面一直转圈
let pendingUpdateSha = ''; // 本次下载完成的安装包 sha512；用户确认安装时落盘为消费标记（防同版本热修重推循环）

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

// 系统推送通知：吸顶小窗看不到更新横幅，发现新版本/更新就绪时发系统通知（每版本每类型只推一次）
const notifiedUpdate = { available: '', downloaded: '' };
function pushNotify(title, body) {
  try {
    if (SHOT_MODE || !Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => {
      if (win && !win.isDestroyed()) {
        win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    n.show();
  } catch (e) { otaLog('notify failed', String(e)); }
}

function sendUpdateState(s) {
  if (checkWatchdog) { clearTimeout(checkWatchdog); checkWatchdog = null; } // 有任何状态推进 = 请求活着
  updateState = s;
  if (s && s.type === 'available' && s.version && notifiedUpdate.available !== s.version) {
    notifiedUpdate.available = s.version;
    pushNotify('云上晴雨有新版本 v' + s.version, '当前 v' + (s.current || app.getVersion()) + '，点击打开并更新');
  } else if (s && s.type === 'downloaded' && s.version && notifiedUpdate.downloaded !== s.version) {
    notifiedUpdate.downloaded = s.version;
    pushNotify('新版本 v' + s.version + ' 已就绪', '点击打开，重启后完成安装');
  }
  if (win && !win.isDestroyed()) win.webContents.send('update:state', s);
}

function setupAutoUpdate() {
  try {
    const { autoUpdater: au } = require('electron-updater');
    autoUpdater = au;
    // electron-updater 6.x 未打包时 checkForUpdates 静默 resolve(null)（无事件、无请求）：
    // 开发/自检态强制启用，让 --shot-update 假源链路真实跑通（打包版不受影响）
    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoDownload = false;        // 下载需用户点「立即更新」
    autoUpdater.autoInstallOnAppQuit = false; // 安装需用户确认重启
    autoUpdater.on('checking-for-update', () => otaLog('checking'));
    autoUpdater.on('update-available', (info) => {
      // 同版本热修重推防回环（消费标记法）：热修 latest.yml 触发号恒大于本版（否则过不了 semver 闸），
      // 装没装过就看安装包字节——上次「立即重启」安装时记录的 sha512 与本次 offer 相同 = 已装即已拥有，
      // 按「已是最新」收场，不弹横幅不循环下载；热修复换了新安装包（sha512 不同）→ 正常弹出安装。
      // 旧规则「安装包名 == 本版本名即跳过」已废弃：热修包名必然=本版本名，会把热修 offer 永远静默吞掉。
      const sha = String((info && info.files && info.files[0] && info.files[0].sha512) || '');
      if (sha && sha === String(settings.updSha512 || '')) {
        otaLog('skip consumed repush offer', sha.slice(0, 12));
        sendUpdateState({ type: 'up-to-date', current: app.getVersion() });
        return;
      }
      otaLog('available', info.version);
      sendUpdateState({ type: 'available', version: info.version, current: app.getVersion() });
    });
    autoUpdater.on('update-not-available', () => {
      otaLog('not-available');
      sendUpdateState({ type: 'up-to-date', current: app.getVersion() });
    });
    autoUpdater.on('download-progress', (p) => sendUpdateState({ type: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      pendingUpdateSha = String((info && info.files && info.files[0] && info.files[0].sha512) || '');
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
  const testing = !!cli || process.argv.includes('--shot-update'); // 自检模式：开发态也真跑更新链路
  const url = effectiveUpdateUrl();
  if (!autoUpdater) { if (manual) sendUpdateState({ type: 'error', message: '更新组件未就绪' }); return; }
  if (!app.isPackaged && !testing) { if (manual) sendUpdateState({ type: 'error', message: '开发模式不支持在线更新' }); return; }
  if (!url) {
    otaLog('skip check: update url not configured');
    if (manual) sendUpdateState({ type: 'unconfigured' });
    return;
  }
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url });
    otaLog('checking', url);
    // 看门狗：更新请求可能被坏代理/网络挂死（不回调、不报错），25 秒无状态推进按超时收场
    if (checkWatchdog) clearTimeout(checkWatchdog);
    checkWatchdog = setTimeout(() => {
      checkWatchdog = null;
      otaLog('check timeout');
      sendUpdateState({ type: 'error', message: '检查超时，请检查网络后重试' });
    }, 25000);
    const p = autoUpdater.checkForUpdates();
    if (p && p.catch) p.catch(err => {
      const msg = String((err && err.message) || err);
      otaLog('check error', msg);
      if (checkWatchdog) { clearTimeout(checkWatchdog); checkWatchdog = null; }
      if (manual) sendUpdateState({ type: 'error', message: msg });
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    otaLog('check threw', msg);
    if (checkWatchdog) { clearTimeout(checkWatchdog); checkWatchdog = null; }
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
  // 消费标记落盘：本次安装的安装包 sha512 → 重启后同 offer 按「已装」跳过（防循环弹窗）。
  // 必须在「确认安装」这一刻记录而不是下载完成时——下载后点「稍后」并未拥有，offer 应继续弹。
  if (pendingUpdateSha) { try { persist({ updSha512: pendingUpdateSha }); } catch (e) { } }
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
    // 截图自检环境常报「减少动态效果」；自检要验证形变插值本身，强制走 on 档，
    // 只影响 shot profile 内存态，不写盘、不影响正式实例。
    if (SHOT_MODE) settings.motion = 'on';
    registerIpc();
    createWindow();
    createTray();
    applyAutoLaunch(settings.autoLaunch);
    setupAutoUpdate();
    scheduleUpdateChecks();
  });
  app.on('window-all-closed', () => app.quit());
}
