'use strict';
/**
 * probe-ext.js — 数据卡点击跳转网页详情 自检（electron probe-ext.js 跑）
 * 覆盖：① ext-guard 白名单单测 ② ↗ 角标注入（11 卡）
 *      ③ 点击卡片 → 正确 URL（真实 preload → ext:open 桩记录）
 *      ④ 交互控件点击不跳转 ⑤ 双击冷却 ⑥ 拒绝白名单外 URL
 *      ⑦ 真实输入拖拽滚屏后 click 被吞（防误触）
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { isAllowedExtUrl } = require('./ext-guard.js');
const { got } = require('./geo.js');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`ext-test ${name}: PASS`); }
  else { fail++; console.log(`ext-test ${name}: FAIL ${extra !== undefined ? JSON.stringify(extra) : ''}`); }
};

/* ① 白名单单测（纯函数，不进窗口） */
check('guard-windy', isAllowedExtUrl('https://www.windy.com/?uvindex,22.30,114.17,8,d:picker'));
check('guard-rainviewer', isAllowedExtUrl('https://www.rainviewer.com/?loc=22.30,114.17,8'));
check('guard-timeanddate', isAllowedExtUrl('https://www.timeanddate.com/moon/@22.30,114.17'));
check('guard-subdomain', isAllowedExtUrl('https://community.windy.com/topic/77'));
check('guard-reject-http', !isAllowedExtUrl('http://www.windy.com/?temp,22.3,114.1,8'));
check('guard-reject-evil', !isAllowedExtUrl('https://evil.com/'));
check('guard-reject-suffix-spoof', !isAllowedExtUrl('https://windy.com.evil.com/') && !isAllowedExtUrl('https://xwindy.com/'));
check('guard-reject-garbage', !isAllowedExtUrl('javascript:alert(1)') && !isAllowedExtUrl('not a url'));

/* 探针坐标（与 geo:iplocate 桩一致） */
const LAT = 22.307, LON = 114.171;
const c4 = n => Number(n).toFixed(4);

app.whenReady().then(async () => {
  /* —— IPC 桩：全量注册防 renderer init 断链（probe-motion 踩过）—— */
  const rec = []; // ext:open 收到的已放行 URL
  const settingsDb = {
    locations: [], activeId: null, autoLocate: true, refreshMinutes: 10,
    alwaysOnTop: true, autoLaunch: false, unit: 'c', winPos: null,
    edgeDock: false, trayTemp: true, brief: true, motion: 'on',
    modules: {}, modulesOrder: [], updateUrl: '', updSha512: ''
  };
  ipcMain.handle('settings:get', () => settingsDb);
  ipcMain.handle('settings:update', (_e, patch) => Object.assign(settingsDb, patch || {}));
  ipcMain.handle('weather:get', async (_e, p) => {
    // 与 main.js fetchWeather 同款真实数据（app.js/extra.js 全渲染路径要真字段）
    const lat = p.lat, lon = p.lon;
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
    try {
      const [w, q] = await Promise.all([got(f, 15000), got(a, 15000).catch(() => null)]);
      return { weather: w, air: q, fetchedAt: Date.now() };
    } catch (err) { return { error: String(err.message || err) }; }
  });
  ipcMain.handle('weather:archive', () => null);
  ipcMain.handle('radar:frames', () => null);
  ipcMain.handle('city:current', () => null);
  ipcMain.handle('png:save', () => null);
  ipcMain.handle('geo:search', () => []);
  ipcMain.handle('geo:reverse', () => ({ name: '油尖旺', parent: '香港', detail: '', admin1: '', lat: LAT, lon: LON }));
  ipcMain.handle('geo:iplocate', () => ({
    name: '油尖旺', parent: '香港', detail: '', admin1: '香港',
    lat: LAT, lon: LON, auto: true, display: '香港 · 油尖旺'
  }));
  ipcMain.handle('win:action', () => true);
  ipcMain.handle('app:version', () => '0.0.0-probe');
  ipcMain.handle('update:check', () => true);
  ipcMain.handle('update:download', () => true);
  ipcMain.handle('update:install', () => true);
  ipcMain.handle('update:state', () => null);
  // ext:open 桩：走真实白名单逻辑，只记录不打开浏览器
  ipcMain.handle('ext:open', (_e, url) => {
    if (!isAllowedExtUrl(url)) return false;
    rec.push(String(url));
    return true;
  });

  const win = new BrowserWindow({
    width: 520, height: 980, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  const w = win.webContents;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const js = code => w.executeJavaScript(code);

  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    // 等 renderAll 跑完（真实天气网络请求）
    let booted = false;
    for (let i = 0; i < 60; i++) {
      await wait(500);
      if (await js('!!window.__extraWeather')) { booted = true; break; }
    }
    check('boot-renderAll', booted);
    if (!booted) { console.log(`ext-test summary pass=${pass} fail=${fail}`); return app.exit(1); }

    /* ② ↗ 角标 + data-ext 注入 */
    const inj = await js(`({
      chips: document.querySelectorAll('.x-ext').length,
      cards: [...document.querySelectorAll('.xcard[data-ext]')].map(c => c.id).sort(),
      titled: [...document.querySelectorAll('.x-ext')].every(s => !!s.title)
    })`);
    const expectIds = ['modCarwash', 'modCold', 'modDress', 'modDry', 'modMoon', 'modPrecipstat', 'modPressure', 'modRadar', 'modUv', 'modVisib', 'modWind'].sort();
    check('inject-chips', inj.chips === 11, inj);
    check('inject-cards', JSON.stringify(inj.cards) === JSON.stringify(expectIds), inj.cards);
    check('inject-title', inj.titled);

    /* ③ 点击 → 正确 URL（顺序断言 recorder 尾部） */
    const clickAndLast = async (code, name, expect) => {
      const before = rec.length;
      await js(code);
      await wait(120);
      const grew = rec.length - before;
      const last = rec[rec.length - 1];
      check(name, grew === 1 && last === expect, { grew, last, expect });
      await wait(750); // 让过双击冷却，避免污染下一发
    };
    await clickAndLast(`document.querySelector('#modRadar .x-body').click()`,
      'click-radar', `https://www.rainviewer.com/?loc=${c4(LAT)},${c4(LON)},8`);
    await clickAndLast(`document.querySelector('#modUv .x-ext').click()`,
      'click-uv-chip', `https://www.windy.com/?uvindex,${c4(LAT)},${c4(LON)},8,d:picker`);
    await clickAndLast(`document.querySelector('#modMoon .x-head').click()`,
      'click-moon', `https://www.timeanddate.com/moon/@${c4(LAT)},${c4(LON)}`);
    await clickAndLast(`document.querySelector('#modVisib .x-body').click()`,
      'click-visib', `https://www.windy.com/?visibility,${c4(LAT)},${c4(LON)},8,d:picker`);
    await clickAndLast(`document.querySelector('#modPressure .x-body').click()`,
      'click-pressure', `https://www.windy.com/?pressure,${c4(LAT)},${c4(LON)},8,d:picker`);

    /* ⑤ 双击冷却：连点两下只开一发 */
    {
      const before = rec.length;
      await js(`document.querySelector('#modWind .x-body').click(); document.querySelector('#modWind .x-body').click();`);
      await wait(150);
      check('dblclick-cooldown', rec.length - before === 1, rec.slice(before));
      await wait(750);
    }

    /* ④ 交互控件点击不跳转（往可点卡里塞个 a 再点） */
    {
      const before = rec.length;
      await js(`(function(){
        const b = document.querySelector('#modUv .x-body');
        const a = document.createElement('a'); a.id = 'probeGuardLink'; a.textContent = 'x'; b.appendChild(a);
        a.click(); // 交互控件（a）上的点击不跳转
        const card = document.getElementById('modUv');
        card.removeAttribute('data-ext'); // data-ext 摘除后整卡不跳
        card.click();
        a.remove(); card.setAttribute('data-ext', '1');
      })()`);
      await wait(150);
      check('guard-child-no-open', rec.length - before === 0, rec.slice(before));
      await wait(750);
    }

    /* ⑥ 白名单外直呼 openExternal：拒绝且不记录 */
    {
      const before = rec.length;
      const evil = await js(`sky.openExternal('https://evil.com/')`);
      const spoof = await js(`sky.openExternal('https://windy.com.evil.com/x')`);
      check('reject-evil', evil === false && spoof === false, { evil, spoof });
      const good = await js(`sky.openExternal('https://www.windy.com/?temp,${c4(LAT)},${c4(LON)},8')`);
      check('accept-good', good === true && rec.length - before === 1, { good, added: rec.length - before });
    }

    /* ⑦ 真实输入：拖拽滚屏 → 松手产生的 click 必须被吞（防误触），后续点击恢复 */
    await js(`document.getElementById('modDry').scrollIntoView({ block: 'center' })`);
    await wait(300);
    const rect = await js(`(function(){ const r = document.getElementById('modDry').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const px = Math.round(rect.x), py = Math.round(rect.y);
    // 诊断埋点：capture（kill 之前）/ bubble（kill 之后）双计数 + 拖前 scrollTop + 输入事件计数 + 几何
    await js(`(function(){
      window.__clickLog = [];
      document.addEventListener('click', e => window.__clickLog.push('cap:' + (e.target.className || e.target.tagName)), true);
      document.addEventListener('click', e => window.__clickLog.push('bub:' + (e.target.className || e.target.tagName)));
      window.__st0 = document.getElementById('widget').scrollTop;
      window.__md = 0; window.__mv = 0; window.__mdBtn = null;
      document.addEventListener('mousedown', e => { window.__md++; window.__mdBtn = e.button; }, true);
      window.addEventListener('mousemove', () => window.__mv++);
      const el = document.getElementById('widget');
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      window.__geo = { left: r.left, top: r.top, cw: el.clientWidth, ch: el.clientHeight, bl: cs.borderLeftWidth, bt: cs.borderTopWidth, px: ${px}, py: ${py} };
    })()`);
    const beforeDrag = rec.length;
    // 单条 move（25px 下移）不回位：排除 move 合并干扰；松手落点仍在卡内
    // 输入事件在隐藏窗口下有节流延迟，间隔放宽到 300ms 保证按序落地
    w.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(300);
    const mdState = await js('({ md: window.__md, btn: window.__mdBtn, mv: window.__mv })');
    w.sendInputEvent({ type: 'mouseMove', x: px, y: py + 25, modifiers: ['isLeftButtonDown'] });
    await wait(300);
    const mvState = await js(`({ mv: window.__mv, st: document.getElementById('widget').scrollTop, cls: document.getElementById('widget').className, st0: window.__st0 })`);
    w.sendInputEvent({ type: 'mouseUp', x: px, y: py + 25, button: 'left', clickCount: 1 });
    await wait(300);
    const dragDiag = { geo: await js('window.__geo'), mdState, mvState, log: await js('window.__clickLog.slice()') };
    console.log('ext-test diag drag:', JSON.stringify(dragDiag));
    check('drag-release-swallowed', rec.length - beforeDrag === 0, { added: rec.length - beforeDrag, dragDiag });
    // 松手后单击：kill 已消费/过期，应打开 1 个
    const b1 = rec.length;
    w.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(200);
    w.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(250);
    check('click-after-drag', rec.length - b1 === 1, { added: rec.length - b1 });
    // 冷却期内第二发不弹；冷却过了再点恢复
    const b2 = rec.length;
    w.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(200);
    w.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(250);
    check('rapid-second-skipped', rec.length - b2 === 0, { added: rec.length - b2 });
    await wait(750);
    const b3 = rec.length;
    w.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(200);
    w.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(250);
    check('click-after-cooldown', rec.length - b3 === 1, { added: rec.length - b3 });
  } catch (e) {
    fail++;
    console.error('ext-test exception:', e);
  }
  console.log(`ext-test summary pass=${pass} fail=${fail}`);
  app.exit(fail ? 1 : 0);
});
