'use strict';
/**
 * 云上晴雨 · 界面主逻辑
 */
(() => {
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const DEFAULT_LOC = {
    name: '慈溪', parent: '宁波', admin1: '浙江', detail: '',
    lat: 30.173, lon: 121.262, display: '浙江省 · 宁波市 · 慈溪市'
  };

  const state = {
    settings: null,
    loc: null,
    data: null,          // {weather, air}
    aqi: null,
    selDate: new Date(),
    calY: 0, calM: 0,
    catKey: 'jiaqu',
    refreshTimer: null,
    lastDate: '',
    fetchedAt: null        // 天气数据最近一次成功更新时间
  };

  /* ================= 时钟 & 天空 ================= */
  function tickClock() {
    const now = new Date();
    const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const ss = pad(now.getSeconds());
    $('clockHM').textContent = hm;
    $('clockSec').textContent = ss;
    const pt = $('pillTime');
    if (pt) pt.textContent = hm;
    const ps = $('pillSec');
    if (ps) ps.textContent = ss;
    const dateKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    if (dateKey !== state.lastDate) {
      state.lastDate = dateKey;
      renderDateLine(now);
      renderPill(); // 跨天时刷新小窗的年月日 / 农历
    }
    if (now.getSeconds() === 0) checkBrief(); // 整分检查早晚报（8:00 / 20:00 一发即去重）
  }

  function renderDateLine(now) {
    const info = Almanac.dayInfo(now);
    $('dateLine').textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${info.week}`;
    const bits = [`农历${info.lunarMonth}${info.lunarDay}`, `${info.yearGanZhi}（${info.zodiac}年）`];
    let extra = '';
    const hol = Almanac.holidaySpan(info.ymd);
    if (hol && !hol.isWork) extra += `<span class="hol rest">休</span> `;
    else if (hol && hol.isWork) extra += `<span class="hol work">班</span> `;
    if (info.jieQi) extra += `<span class="jq">◆ ${esc(info.jieQi)}</span> `;
    info.festivals.slice(0, 2).forEach(f => extra += `<span class="warn">◆ ${esc(f)}</span> `);
    $('lunarLine').innerHTML = `${bits.map(esc).join(' · ')} ${extra}`;
  }

  /* 昼夜判定：以「今日日出/日落的精确时刻」为准（数据为当地本地时间）。
     is_day 标志只作兜底——它随数据刷新才翻转，时机不准 */
  function computeIsDay(w, now) {
    if (w && w.daily && w.daily.sunrise && w.daily.sunrise[0] && w.daily.sunset && w.daily.sunset[0]) {
      const sr = new Date(w.daily.sunrise[0]).getTime();
      const ss = new Date(w.daily.sunset[0]).getTime();
      if (Number.isFinite(sr) && Number.isFinite(ss) && ss > sr) {
        return now.getTime() >= sr && now.getTime() < ss;
      }
    }
    return w ? !!w.current.is_day : (now.getHours() > 6 && now.getHours() < 19);
  }

  let flipTimer = null;
  function updateSky() {
    const now = new Date();
    const w = state.data && state.data.weather;
    const isDay = computeIsDay(w, now);
    const group = w ? Weather.codeInfo(w.current.weather_code, isDay).group : 'clear';
    // setMode 统一设置 night 并重绘天空，paintSky 不再按钟点猜昼夜
    FX.setMode(group, isDay, now);
    if (w) {
      FX.placeCelestial(w.daily.sunrise[0], w.daily.sunset[0]);
    }
    // 日落后整个界面切换到星空/黑夜暗色调（body.night 覆盖主题变量，纯 CSS 过渡）
    document.body.classList.toggle('night', !isDay);
    updateTrayTemp(); // 昼夜翻转 → 托盘温度图标配色跟着换（fingerprint 保证不重复发 IPC）
    // 精确在日出/日落时刻翻转主题（不必等 60s 轮询或数据刷新）
    clearTimeout(flipTimer);
    if (w && w.daily && w.daily.sunrise && w.daily.sunrise[0] && w.daily.sunset && w.daily.sunset[0]) {
      const nexts = [w.daily.sunrise[0], w.daily.sunset[0]]
        .map(s => new Date(s).getTime())
        .filter(t => Number.isFinite(t) && t > now.getTime());
      if (nexts.length) {
        const delay = Math.min.apply(null, nexts) - now.getTime() + 1500;
        flipTimer = setTimeout(updateSky, Math.min(delay, 2147483647));
      }
    }
  }

  /* ================= 天气渲染 ================= */
  function locLine(loc) {
    const parts = [loc.admin1, loc.parent, loc.name].filter(Boolean);
    const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
    return uniq.join(' · ') || loc.name || '未知地点';
  }

  function renderHero() {
    const w = state.data.weather;
    const c = w.current, d = w.daily;
    const info = Weather.codeInfo(c.weather_code, computeIsDay(w, new Date()));
    $('tempNow').textContent = Math.round(c.temperature_2m);
    $('nowIcon').innerHTML = `<span class="big-icon">${Icons.svg(info.icon, 58)}</span>`;
    $('condText').textContent = info.text;
    $('tempRange').textContent = `今日 ${Math.round(d.temperature_2m_max[0])}° / ${Math.round(d.temperature_2m_min[0])}°`;

    const chips = [
      ['体感', `${Math.round(c.apparent_temperature)}°`],
      ['湿度', `${c.relative_humidity_2m}%`],
      ['风', `${Weather.windDir(c.wind_speed_10m ? c.wind_direction_10m : 0)} ${Weather.windLevel(c.wind_speed_10m)}级`],
      ['气压', `${Math.round(c.pressure_msl)}hPa`],
      ['日出', (d.sunrise[0] || '').slice(11)],
      ['日落', (d.sunset[0] || '').slice(11)]
    ];
    // 朝晚霞概率：取「下一次」日出/日落所在小时的低/中/高云量推算（不新增栏目，融进 chips）
    const glow = computeGlow(w, new Date());
    if (glow.dawn) chips.push(['朝霞', glow.dawn.label]);
    if (glow.dusk) chips.push(['晚霞', glow.dusk.label]);
    $('statRow').innerHTML = chips.map(([k, v]) => `<span class="chip">${k} <b>${esc(v)}</b></span>`).join('');

    const alerts = Weather.buildAlerts(d, w.hourly);
    $('alertWrap').innerHTML = alerts.map(a =>
      `<div class="alert ${a.tone}"><span class="dot"></span><span>${esc(a.text)}</span></div>`).join('');

    // 标题主打区县名（如「慈溪」），完整地址链（含街道）放到下方 detail 行
    $('locText').textContent = state.loc.name || locLine(state.loc);
    // detail 通常已包含在 display 的地址链里，先去重再拼接，避免"慈溪市 · 慈溪市 · …"
    const disp = state.loc.display || '';
    const dt = state.loc.detail || '';
    $('locDetail').textContent = dt && disp.indexOf(dt) === -1
      ? `${dt} · ${disp}`
      : (disp || dt);
    $('locDetail').title = state.loc.display || '';

    // 更新时间 + 数据来源
    const fu = state.fetchedAt || new Date();
    $('srcLine').innerHTML = `数据更新 ${pad(fu.getHours())}:${pad(fu.getMinutes())}:${pad(fu.getSeconds())} · 来源 Open-Meteo`;
  }

  function renderHourly() {
    const w = state.data.weather;
    const now = new Date();
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
    let idx = w.hourly.time.indexOf(nowStr);
    if (idx < 0) idx = w.hourly.time.findIndex(t => t >= nowStr);
    if (idx < 0) idx = 0;

    let html = '';
    for (let i = idx; i < Math.min(idx + 24, w.hourly.time.length); i++) {
      const t = w.hourly.time[i];
      const info = Weather.codeInfo(w.hourly.weather_code[i], w.hourly.is_day[i]);
      const pop = w.hourly.precipitation_probability[i];
      html += `<div class="h-item ${i === idx ? 'now' : ''}">
        <div class="h-time">${i === idx ? '现在' : t.slice(11, 13) + '时'}</div>
        <div class="h-icon">${Icons.svg(info.icon, 32)}</div>
        <div class="h-temp">${Math.round(w.hourly.temperature_2m[i])}°</div>
        <div class="h-pop">${pop > 0 ? '☂' + pop + '%' : ''}</div>
      </div>`;
    }
    $('hourlyScroll').innerHTML = html;
    renderTrend(idx); // 24h 趋势曲线：同一份逐时数据的图形概览，嵌在本卡内
    const fu = state.fetchedAt || now;
    $('hourlySub').textContent = `未来24小时 · 更新于 ${pad(fu.getHours())}:${pad(fu.getMinutes())}:${pad(fu.getSeconds())}`;
  }

  /* ---------- 24h 温度/降水趋势曲线（整合进逐时预报卡，只在数据刷新时重建路径） ---------- */
  function renderTrend(idx) {
    const el = $('trendWrap');
    if (!el) return;
    const w = state.data.weather;
    const h = w.hourly;
    const n = Math.min(24, h.time.length - idx);
    if (n < 4) { el.innerHTML = ''; return; }
    const temps = [], pops = [];
    for (let i = 0; i < n; i++) {
      temps.push(Number(h.temperature_2m[idx + i]) || 0);
      pops.push(Number(h.precipitation_probability[idx + i]) || 0);
    }
    const VW = 424, VH = 86, padT = 14, padB = 16;
    const tMin = Math.min(...temps), tMax = Math.max(...temps);
    const span = Math.max(1, tMax - tMin);
    const x = i => (i / (n - 1)) * VW;
    const y = t => padT + (1 - (t - tMin) / span) * (VH - padT - padB);
    // 平滑温度曲线（相邻点中点二次贝塞尔）
    let dpath = `M${x(0).toFixed(1)},${y(temps[0]).toFixed(1)}`;
    for (let i = 1; i < n - 1; i++) {
      const cx = (x(i) + x(i + 1)) / 2, cy = (y(temps[i]) + y(temps[i + 1])) / 2;
      dpath += ` Q${x(i).toFixed(1)},${y(temps[i]).toFixed(1)} ${cx.toFixed(1)},${cy.toFixed(1)}`;
    }
    dpath += ` T${x(n - 1).toFixed(1)},${y(temps[n - 1]).toFixed(1)}`;
    // 降水概率底柱（0-100% → 12px 底部条带）
    let bars = '';
    const bw = Math.max(3, VW / n - 4);
    for (let i = 0; i < n; i++) {
      const ph = Math.round((pops[i] / 100) * 12);
      if (ph > 0) bars += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(VH - padB + 3 - ph).toFixed(1)}" width="${bw.toFixed(1)}" height="${ph}" rx="1.5" class="tr-pop"/>`;
    }
    // 端点温度标注（只标首/尾/最高/最低，避免文字堆叠）
    const marks = [[0, temps[0], 'start'], [n - 1, temps[n - 1], 'end']];
    let minI = 0, maxI = 0;
    temps.forEach((t, i) => { if (t < temps[minI]) minI = i; if (t > temps[maxI]) maxI = i; });
    if (minI > 0 && minI < n - 1) marks.push([minI, temps[minI], 'mid']);
    if (maxI > 0 && maxI < n - 1 && maxI !== minI) marks.push([maxI, temps[maxI], 'mid']);
    const dots = marks.map(([i, t, kind]) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(t).toFixed(1)}" r="2.6" class="tr-dot"/>` +
      (kind === 'mid' ? `<text x="${x(i).toFixed(1)}" y="${(y(t) - 7).toFixed(1)}" class="tr-lab">${Math.round(t)}°</text>` : '')
    ).join('');
    el.innerHTML = `<svg viewBox="0 0 ${VW} ${VH}" width="100%" height="${VH}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${dpath}" class="tr-line"/>${bars}${dots}</svg>`;
  }

  /* ---------- 分钟级降水条（hero 内紧凑单条：8 柱 × 15 分钟 + 智能摘要） ---------- */
  function renderMinutely() {
    const el = $('mmWrap');
    if (!el) return;
    const w = state.data && state.data.weather;
    const m = w && w.minutely_15;
    if (!m || !m.time || !m.time.length || !m.precipitation) { el.innerHTML = ''; return; }
    const now = new Date();
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(Math.floor(now.getMinutes() / 15) * 15)}`;
    let idx = m.time.indexOf(nowStr);
    if (idx < 0) idx = m.time.findIndex(t => t >= nowStr);
    if (idx < 0) idx = 0;
    const slots = [];
    for (let i = idx; i < Math.min(idx + 8, m.time.length); i++) {
      slots.push({ p: Number(m.precipitation[i]) || 0, code: Number(m.weather_code[i]) || 0 });
    }
    if (!slots.length) { el.innerHTML = ''; return; }
    const maxP = Math.max(0.8, ...slots.map(s => s.p));
    // 未来降水的措辞：看第一个降水槽的天气码（70-77/85/86 为雪）
    const isSnowCode = c => (c >= 70 && c <= 77) || c === 85 || c === 86;
    let summary;
    const firstWet = slots.findIndex(s => s.p > 0.05);
    if (firstWet === -1) {
      summary = '未来 2 小时无雨';
    } else {
      const word = isSnowCode(slots[firstWet].code) ? '雪' : '雨';
      if (firstWet === 0) {
        // 正在下：找第一个停的槽位
        const stop = slots.findIndex((s, i) => i > 0 && s.p <= 0.05);
        summary = stop === -1 ? `${word}将持续 2 小时以上` : `${word}约 ${stop * 15} 分钟后停`;
      } else {
        summary = `约 ${firstWet * 15} 分钟后开始下${word}`;
      }
    }
    const bars = slots.map((s, i) => {
      const h = s.p <= 0.05 ? 2 : Math.max(4, Math.round((s.p / maxP) * 30));
      return `<i class="mm-bar ${s.p > 0.05 ? (isSnowCode(s.code) ? 'snow' : 'rain') : 'dry'}" style="height:${h}px" title="${i * 15}分钟后 ${s.p.toFixed(1)}mm"></i>`;
    }).join('');
    el.innerHTML = `<div class="mm-head"><span class="mm-title">未来2小时降水</span><span class="mm-sum">${esc(summary)}</span></div>
      <div class="mm-bars">${bars}</div>
      <div class="mm-axis"><span>现在</span><span>1小时后</span><span>2小时后</span></div>`;
  }

  /* ---------- 朝晚霞概率（低云惩罚 / 中高云卷云加分，四档评价） ---------- */
  function glowScore(low, mid, high) {
    // 低云遮日：重罚；高云卷云 20-80%：霞光染色加分；全覆盖高云反而不佳
    let s = 70;
    if (low >= 80) s -= 55;
    else if (low >= 50) s -= 32;
    else if (low >= 20) s -= 12;
    if (high >= 20 && high <= 80) s += 18;
    else if (high > 80) s -= 8;
    if (mid >= 20 && mid <= 60) s += 8;
    else if (mid > 80) s -= 15;
    return Math.max(0, Math.min(100, Math.round(s)));
  }
  function computeGlow(w, now) {
    const out = {};
    const d = w.daily, h = w.hourly;
    if (!d || !h || !h.cloud_cover_low) return out;
    const pick = (iso) => {
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return null;
      // 取日出/日落时刻所在小时的云量
      const hourStr = iso.slice(0, 13) + ':00';
      let i = h.time.indexOf(hourStr);
      if (i < 0) i = h.time.findIndex(x => x >= iso);
      if (i < 0) return null;
      const s = glowScore(h.cloud_cover_low[i] || 0, (h.cloud_cover_mid || [])[i] || 0, (h.cloud_cover_high || [])[i] || 0);
      return { score: s, label: s >= 75 ? '绝佳' : s >= 55 ? '不错' : s >= 35 ? '一般' : '难见' };
    };
    // 取「下一次」日出/日落（还没到的那次）
    for (let i = 0; i < Math.min(2, d.sunrise.length); i++) {
      if (new Date(d.sunrise[i]).getTime() > now.getTime()) { out.dawn = pick(d.sunrise[i]); break; }
    }
    for (let i = 0; i < Math.min(2, d.sunset.length); i++) {
      if (new Date(d.sunset[i]).getTime() > now.getTime()) { out.dusk = pick(d.sunset[i]); break; }
    }
    return out;
  }

  /* ---------- 托盘温度图标（canvas 画数字 → dataURL → 主进程 tray） ---------- */
  let trayKey = '';
  function trayDataURL(t, isDay) {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const g = cv.getContext('2d');
    // 昼夜配色：圆角方块底 + 描边数字（任意任务栏主题都可读）
    g.fillStyle = isDay ? '#f8f2df' : '#1d2740';
    g.strokeStyle = isDay ? 'rgba(90,70,40,0.55)' : 'rgba(160,190,255,0.5)';
    g.lineWidth = 3;
    const r = 14;
    g.beginPath();
    g.moveTo(r + 2, 2); g.arcTo(62, 2, 62, 62, r); g.arcTo(62, 62, 2, 62, r);
    g.arcTo(2, 62, 2, 2, r); g.arcTo(2, 2, 62, 2, r); g.closePath();
    g.fill(); g.stroke();
    g.font = '700 34px "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = isDay ? '#4a3a22' : '#dfe9ff';
    const label = Math.abs(t) >= 100 ? String(t) : t + '°';
    g.fillText(label, 32, 33);
    return cv.toDataURL('image/png');
  }
  function updateTrayTemp() {
    const w = state.data && state.data.weather;
    if (!w || !state.settings || state.settings.trayTemp === false) return;
    const t = Math.round(w.current.temperature_2m);
    const isDay = computeIsDay(w, new Date());
    const key = t + '|' + (isDay ? 'd' : 'n');
    if (key === trayKey) return; // 温度整数与昼夜都没变 → 不重绘不发 IPC
    trayKey = key;
    try { sky.trayTemp(trayDataURL(t, isDay)); } catch (e) { }
  }

  /* ---------- 天气早晚报（每天 8:00 / 20:00 系统通知，localStorage 按日期去重） ---------- */
  function briefText(slot) {
    const w = state.data && state.data.weather;
    if (!w) return null;
    const d = w.daily;
    const i = slot === 'am' ? 0 : 1; // 早报讲今天，晚报讲明天
    const info = Weather.summarizeDaily(w, i);
    const pop = Math.max(0, Math.round((d.precipitation_probability_max || [0])[i] || 0));
    const title = (slot === 'am' ? '早安 · ' : '晚安 · ') + (state.loc.name || '天气');
    const body = `${i === 0 ? '今天' : '明天'}${info.text}，${Math.round(d.temperature_2m_min[i])}~${Math.round(d.temperature_2m_max[i])}°` +
      (pop >= 30 ? `，降水概率 ${pop}%记得带伞` : '');
    return { title, body };
  }
  function checkBrief() {
    if (!state.settings || state.settings.brief === false) return;
    const now = new Date();
    const h = now.getHours();
    const slot = (h === 8 || h === 20) ? (h === 8 ? 'am' : 'pm') : null;
    if (!slot) return;
    const key = `brief_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${slot}`;
    try { if (localStorage.getItem(key)) return; } catch (e) { }
    const b = briefText(slot);
    if (!b) return; // 数据还没来不标记，下次 tick 重试
    try { localStorage.setItem(key, '1'); } catch (e) { }
    if (sky.notify) sky.notify(b.title, b.body);
  }

  // 只读自检钩子（--shot 探针用，不暴露写能力）
  window.__selftest = { briefText, trayDataURL, computeGlow: () => computeGlow(state.data && state.data.weather, new Date()) };

  function renderDaily() {
    const w = state.data.weather;
    const d = w.daily;
    const mins = d.temperature_2m_min.slice(0, 7), maxs = d.temperature_2m_max.slice(0, 7);
    const weekMin = Math.min(...mins), weekMax = Math.max(...maxs);
    const span = Math.max(1, weekMax - weekMin);
    const todayKey = `${state.selDate.getFullYear()}-${pad(state.selDate.getMonth() + 1)}-${pad(state.selDate.getDate())}`;

    let html = '';
    for (let i = 0; i < 7; i++) {
      const date = new Date(d.time[i] + 'T00:00:00');
      const info = Weather.summarizeDaily(w, i);
      const label = i === 0 ? '今天' : i === 1 ? '明天' : Almanac.WEEK[date.getDay()].replace('星期', '周');
      const sub = `${date.getMonth() + 1}/${date.getDate()}`;
      const hol = Almanac.holiday(d.time[i]);
      const holTag = hol ? `<i class="ht ${hol.isWork ? 'work' : 'rest'}">${hol.isWork ? '班' : '休'}</i>` : '';
      const left = (mins[i] - weekMin) / span * 100;
      const width = Math.max(12, (maxs[i] - mins[i]) / span * 100);
      html += `<div class="d-row">
        <div class="d-label">${label}<small>${sub}${holTag}</small></div>
        <div class="d-icon">${Icons.svg(info.icon, 30)}</div>
        <div class="d-text">${esc(info.text)}</div>
        <div class="d-temp">
          <span class="d-low">${Math.round(mins[i])}°</span>
          <span class="d-bar"><i style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></i></span>
          <span class="d-high">${Math.round(maxs[i])}°</span>
        </div>
      </div>`;
    }
    $('dailyList').innerHTML = html;
  }

  function renderAQI() {
    const aq = Weather.calcAQI(state.data.air);
    state.aqi = aq;
    if (!aq) {
      $('aqiNum').textContent = '--';
      $('aqiLevel').textContent = '暂无数据';
      $('aqiGrid').innerHTML = '';
      return;
    }
    $('aqiNum').textContent = aq.aqi;
    const lv = $('aqiLevel');
    lv.textContent = aq.level;
    lv.className = 'aqi-level ' + (aq.tone === 'great' ? '' : aq.tone);
    $('aqiPrimary').innerHTML = aq.aqi <= 50 ? '空气清新，放心呼吸' : `首要污染物 <b>${esc(aq.primary)}</b>`;

    const piecewise = v => {
      const seg = [[0, 50, 0, 15], [50, 100, 15, 32], [100, 150, 32, 48], [150, 200, 48, 64], [200, 300, 64, 82], [300, 500, 82, 98]];
      for (const [a, b, la, lb] of seg) {
        if (v <= b) return la + (lb - la) * (v - a) / (b - a);
      }
      return 98;
    };
    $('aqiBarFill').style.left = piecewise(aq.aqi) + '%';

    const order = ['pm25', 'pm10', 'o3', 'no2', 'so2', 'co'];
    $('aqiGrid').innerHTML = order.map(k => {
      const s = aq.sub[k];
      if (!s) return '';
      const val = k === 'co' ? s.value.toFixed(2) : Math.round(s.value);
      return `<div class="aqi-cell"><span>${s.name}</span><b>${val}</b></div>`;
    }).join('') + `<div class="aqi-cell" style="grid-column:1/3;opacity:.6"><span>单位 μg/m³（CO 为 mg/m³）</span></div>`;
  }

  const TONE_BAD = ['不宜', '极强', '严寒', '寒冷', '重度污染', '严重污染'];
  const TONE_WARN = ['较不宜', '不太适宜', '很强', '强', '热', '炎热', '冷', '易发', '较易发', '轻度污染', '中度污染'];
  function toneOf(lv) {
    if (TONE_BAD.some(t => lv.includes(t))) return 'bad';
    if (TONE_WARN.some(t => lv.includes(t))) return 'warn';
    return '';
  }

  function renderLife() {
    const w = state.data.weather;
    const c = w.current, d = w.daily;
    const group = Weather.codeInfo(c.weather_code, c.is_day).group;
    const feels = c.apparent_temperature;
    const wind = c.wind_speed_10m;
    const vis = w.hourly.visibility && w.hourly.visibility.length ? w.hourly.visibility[0] : null;

    const precipProb24 = Math.max(...(d.precipitation_probability_max || [0]).slice(0, 2));
    const dayNightDiff = Math.abs(d.temperature_2m_max[0] - d.temperature_2m_min[0]);

    const dress = Weather.clothing(feels, group === 'rain' || group === 'thunder' || group === 'snow');
    const trip = Weather.travel(group, wind, vis, feels);
    const uvI = Weather.uv(d.uv_index_max[0]);
    const wash = Weather.carWash(precipProb24, group);
    const sportI = Weather.sport(group, feels, wind);
    const coldI = Weather.cold(dayNightDiff, feels);

    const items = [
      ['shirt', '穿衣', dress.lv, dress.tip],
      ['car', '出行', trip[0].includes('适宜') ? '顺畅' : '留意', trip.join('；')],
      ['sun', '紫外线', uvI.lv, uvI.tip],
      ['drop', '洗车', wash.lv, wash.tip],
      ['run', '运动', sportI.lv, sportI.tip],
      ['mask', '感冒', coldI.lv, coldI.tip]
    ];
    $('lifeList').innerHTML = items.map(([e, name, lv, tip]) => `
      <div class="life-item">
        <div class="life-icon">${Icons.ui(e, 17)}</div>
        <div>
          <div class="life-title">${name}<span class="life-lv ${toneOf(lv)}">${esc(lv)}</span></div>
          <div class="life-tip">${esc(tip)}</div>
        </div>
      </div>`).join('');
  }

  /* ================= 吸顶温度小窗 ================= */
  function renderPill() {
    const now = new Date();
    const pt = $('pillTime');
    if (pt) pt.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const inf = Almanac.dayInfo(now);
    $('pillDate').textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${inf.week.replace('星期', '周')}`;
    const lunar = `农历${inf.lunarMonth}${inf.lunarDay}`;
    const w = state.data && state.data.weather;
    if (!w) { $('pillSub').textContent = lunar; return; }
    const c = w.current;
    const info = Weather.codeInfo(c.weather_code, computeIsDay(w, new Date()));
    $('pillTemp').textContent = Math.round(c.temperature_2m);
    $('pillIcon').innerHTML = Icons.svg(info.icon, 30); // 内置光芒旋转/雨滴下落/云朵浮动动画
    $('pillSub').textContent = `${lunar} · ${info.text}`;
  }
  function applyDockState(s) {
    document.body.classList.toggle('docked', !!s.docked);
    document.body.classList.toggle('expanded', !!s.expanded);
    if (s.docked && !s.expanded) renderPill();
    FX.setSuspended(!!s.docked && !s.expanded); // 收起为小窗时粒子画布隐藏 → 暂停动画循环
    if (window.Globe) Globe.setSuspended(!!s.docked && !s.expanded); // 昼夜地球同步暂停
  }

  function renderAll() {
    try {
      renderHero(); renderMinutely(); renderHourly(); renderDaily(); renderAQI(); renderLife(); renderPill();
      updateSky();
      updateTrayTemp();
      if (window.Globe) Globe.update(state.loc, state.data && state.data.weather ? state.data.weather.daily : null);
    } catch (e) { console.error('render error', e); }
  }

  /* ================= 万年历 ================= */
  function renderCalendar() {
    const { calY, calM } = state;
    $('monthLabel').textContent = `${calY}年${calM}月`;
    const cells = Almanac.monthGrid(calY, calM);
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const selKey = `${state.selDate.getFullYear()}-${pad(state.selDate.getMonth() + 1)}-${pad(state.selDate.getDate())}`;

    $('almGrid').innerHTML = cells.map(cell => {
      if (!cell) return `<div class="alm-cell empty"></div>`;
      const cls = ['alm-cell'];
      if (cell.ymd === todayKey) cls.push('today');
      if (cell.ymd === selKey) cls.push('sel');
      if (cell.lucky) cls.push('lucky');
      if (cell.hol) cls.push(cell.hol.isWork ? 'work' : 'rest');
      return `<div class="${cls.join(' ')}" data-ymd="${cell.ymd}">
        <div class="d">${cell.day}</div>
        <div class="l ${cell.jieQi ? 'jq' : ''}">${esc(cell.lunarLabel)}</div>
        ${cell.hol ? `<i class="ht ${cell.hol.isWork ? 'work' : 'rest'}">${cell.hol.isWork ? '班' : '休'}</i>` : ''}
      </div>`;
    }).join('');

    $('almGrid').querySelectorAll('[data-ymd]').forEach(el => {
      el.addEventListener('click', () => {
        const [y, m, d] = el.dataset.ymd.split('-').map(Number);
        state.selDate = new Date(y, m - 1, d);
        renderCalendar();
        renderAlmanacDetail();
        renderHours();
      });
    });
  }

  function renderAlmanacDetail() {
    const info = Almanac.dayInfo(state.selDate);
    let badges = '';
    const span = Almanac.holidaySpan(info.ymd);
    if (span && !span.isWork) badges += `<span class="hol rest">休 · ${esc(span.name)}${span.span ? '（' + esc(span.span) + '）' : ''}</span>`;
    else if (span && span.isWork) badges += `<span class="hol work">班 · ${esc(span.name)}调休上班</span>`;
    info.festivals.slice(0, 3).forEach(f => badges += `<span class="fes">${esc(f)}</span>`);
    if (info.jieQi) badges += `<span class="jqd">${esc(info.jieQi)}</span>`;

    const meta = [
      ['值神', `<i>${esc(info.tianShen)}</i> <span class="${info.tianShenLuck === '吉' ? 'luck-good' : 'luck-bad'}">${esc(info.tianShenLuck || '')}</span>`],
      ['建除', `<i>${esc(info.zhiXing)}</i>`],
      ['冲煞', `<i>${esc(info.chong)}</i> 煞${esc(info.sha)}`],
      ['吉神', esc((info.jiShen || []).slice(0, 4).join('、'))],
      ['凶神', esc((info.xiongSha || []).slice(0, 4).join('、'))],
      ['物候', `<i>${esc(info.wuHou)}</i> · 月相 ${esc(info.yueXiang)}`],
      ['喜神', `<i>${esc(info.posXi)}</i> · 福神 ${esc(info.posFu)}`],
      ['财神', `<i>${esc(info.posCai)}</i> · 禄 ${esc(info.lu)}`]
    ];

    $('almDetail').innerHTML = `
      <div class="alm-date-line">${info.year}年${info.month}月${info.day}日 ${esc(info.week)}</div>
      <div class="alm-sub-line">${badges}农历${esc(info.yearGanZhi)}${esc(info.lunarText.replace('农历', ''))} · 属${esc(info.zodiac)} · ${esc(info.constellation)}座 · ${esc(info.dayGanZhi)}</div>
      <div class="yj-row"><div class="yj-tag yi">宜</div>
        <div class="chips-wrap">${info.yi.slice(0, 12).map(y => `<span class="chip-y">${esc(y)}</span>`).join('') || '<span class="chip-y">诸事不宜</span>'}</div></div>
      <div class="yj-row"><div class="yj-tag ji">忌</div>
        <div class="chips-wrap">${info.ji.slice(0, 12).map(y => `<span class="chip-j">${esc(y)}</span>`).join('') || '<span class="chip-j">诸事皆宜</span>'}</div></div>
      <div class="alm-meta">${meta.map(([k, v]) => `<div>${k}：${v}</div>`).join('')}</div>`;
  }

  function renderHours() {
    const table = Almanac.hourTable(state.selDate);
    const now = new Date();
    const isToday = state.selDate.toDateString() === now.toDateString();
    const curZhi = Math.floor(((now.getHours() + 1) % 24) / 2);

    $('almHours').innerHTML = table.map((h, i) => {
      const good = h.luck === '吉';
      return `<div class="hr-item ${isToday && i === curZhi ? 'now' : ''}">
        <div class="hr-zhi">${h.zhi}时</div>
        <div class="hr-range">${h.range}时 · ${esc(h.tianShen)}</div>
        <span class="hr-luck ${good ? '' : 'bad'}">${esc(h.luck)}</span>
      </div>`;
    }).join('');
  }

  function renderLucky() {
    $('catChips').innerHTML = Almanac.CATEGORIES.map(c =>
      `<button class="cat-chip ${c.key === state.catKey ? 'on' : ''}" data-cat="${c.key}">${c.label}</button>`).join('');
    $('catChips').querySelectorAll('[data-cat]').forEach(b => {
      b.addEventListener('click', () => { state.catKey = b.dataset.cat; renderLucky(); });
    });

    const cat = Almanac.CATEGORIES.find(c => c.key === state.catKey);
    const list = Almanac.auspiciousDays(state.calY, state.calM, state.catKey);
    if (!list.length) {
      $('luckyList').innerHTML = `<div class="lucky-empty">本月暂无「${cat.label}」吉日，可看看其他类别～</div>`;
      return;
    }
    $('luckyList').innerHTML = list.slice(0, 10).map(info => {
      const hit = info.yi.filter(y => cat.match.includes(y)).slice(0, 4);
      return `<div class="lucky-item">
        <div class="lucky-date">${info.month}月${info.day}日 ${esc(info.week.replace('星期', '周'))}
          <small>农历${esc(info.lunarMonth)}${esc(info.lunarDay)}${info.jieQi ? ' · ' + esc(info.jieQi) : ''}</small></div>
        <div class="lucky-yi">${hit.map(y => `<span class="chip-y">${esc(y)}</span>`).join('')}</div>
      </div>`;
    }).join('') + (list.length > 10 ? `<div class="lucky-empty">还有 ${list.length - 10} 个吉日…</div>` : '');
  }

  function renderAlmanac() {
    renderCalendar();
    renderAlmanacDetail();
    renderHours();
    renderLucky();
  }

  /* ================= 数据加载 ================= */
  let loadSeq = 0;   // 请求序号：丢弃过期响应（快速切换地点时旧地点数据不得覆盖新地点）
  async function loadWeather() {
    if (!state.loc) return;
    const seq = ++loadSeq;
    const res = await sky.fetchWeather(state.loc.lat, state.loc.lon);
    if (seq !== loadSeq) return; // 已有更新的请求在途/完成，本次响应过期作废
    if (res && res.error) {
      $('condText').textContent = '网络异常';
      $('hourlySub').textContent = '点击右上角刷新重试';
      return;
    }
    state.data = res;
    state.fetchedAt = new Date();
    renderAll();
  }

  /* ================= 设置面板 ================= */
  function openPanel() {
    $('settingsPanel').classList.add('open');
    renderLocList();
  }
  function closePanel() { $('settingsPanel').classList.remove('open'); }

  function renderLocList() {
    const locs = state.settings.locations || [];
    $('locList').innerHTML = locs.length ? locs.map(l => `
      <div class="loc-item ${l.id === state.settings.activeId ? 'active' : ''}" data-id="${l.id}">
        <span class="nm-ico">${Icons.ui('pin', 13)}</span>
        <div class="nm">${esc(locLine(l))}<small>${esc(l.detail || l.display || '')}</small></div>
        <span class="del" data-del="${l.id}" title="删除">✕</span>
      </div>`).join('') : '<div class="lucky-empty">还没有保存的地点</div>';

    $('locList').querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', async e => {
        if (e.target.dataset.del) return;
        await switchLocation(el.dataset.id);
      });
    });
    $('locList').querySelectorAll('[data-del]').forEach(el => {
      el.addEventListener('click', async e => {
        e.stopPropagation();
        const locs = state.settings.locations.filter(l => l.id !== el.dataset.del);
        const patch = { locations: locs };
        if (state.settings.activeId === el.dataset.del) patch.activeId = locs.length ? locs[0].id : null;
        state.settings = await sky.updateSettings(patch);
        if (patch.activeId) await switchLocation(patch.activeId);
        renderLocList();
      });
    });
  }

  async function switchLocation(id) {
    const loc = (state.settings.locations || []).find(l => l.id === id);
    if (!loc) return;
    state.settings = await sky.updateSettings({ activeId: id });
    state.loc = loc;
    await loadWeather();
    renderLocList();
    closePanel();
  }

  async function addLocation(loc, isAuto) {
    const id = 'loc_' + Date.now();
    const entry = Object.assign({ id }, loc, { auto: !!isAuto });
    let locs = state.settings.locations || [];
    if (isAuto) locs = locs.filter(l => !l.auto);   // 自动定位只保留一个
    locs.push(entry);
    state.settings = await sky.updateSettings({ locations: locs, activeId: id });
    state.loc = entry;
    await loadWeather();
    renderLocList();
    closePanel();
  }

  /* ================= 软件更新（OTA） ================= */
  let manualCheck = false;
  let lastUpdateState = null;

  function setUpdateStatus(t) { const el = $('updateStatus'); if (el) el.textContent = t; }
  // 横幅显隐走 .show 类（CSS 过渡动画）：hidden 属性会被 .update-banner 的 display:flex 覆盖而失效，弃用
  function hideUpdateBanner() { const b = $('updateBanner'); if (b) b.classList.remove('show'); }
  // 「稍后」按 版本+状态 记忆：同一版本的同一提醒只弹一次（跨启动、跨后台检查不复发）
  function dismissedKey(type, ver) { return 'updDismiss_' + type + '_' + ver; }
  function dismissUpdateBanner() {
    const s = lastUpdateState || {};
    if ((s.type === 'available' || s.type === 'downloaded') && s.version) {
      try { localStorage.setItem(dismissedKey(s.type, s.version), '1'); } catch (e) { }
    }
    hideUpdateBanner();
  }

  function showUpdateBanner(html, primaryLabel, showPrimary) {
    const b = $('updateBanner'); if (!b) return;
    $('ubText').innerHTML = html;
    const p = $('ubPrimary');
    p.hidden = !showPrimary;
    if (showPrimary) { p.textContent = primaryLabel; p.disabled = false; }
    b.classList.add('show');
  }

  // 设置页更新动作按钮：发现新版本→「立即更新」（下载）；下载完成→「立即重启」（安装）
  function setDoUpdate(label) {
    const b = $('btnDoUpdate');
    if (!b) return;
    if (label) { b.hidden = false; b.textContent = label; b.disabled = false; }
    else b.hidden = true;
  }

  function onUpdateState(s) {
    if (!s || !s.type) return;
    lastUpdateState = s;
    const cur = s.current ? 'v' + esc(s.current) : '';
    switch (s.type) {
      case 'available':
        manualCheck = false;
        setUpdateStatus(`发现新版本 v${esc(s.version)}`);
        setDoUpdate('立即更新');
        if (!localStorage.getItem(dismissedKey('available', s.version))) {
          showUpdateBanner(`发现新版本 <span class="nb"><b>v${esc(s.version)}</b>（当前 ${cur}）</span>`, '立即更新', true);
        }
        break;
      case 'downloading':
        $('updateBanner').classList.add('show');
        $('ubText').innerHTML = `正在下载更新… <b>${s.percent || 0}%</b>`;
        $('ubPrimary').hidden = true;
        setUpdateStatus(`正在下载 ${s.percent || 0}%`);
        setDoUpdate(null);
        break;
      case 'downloaded':
        setUpdateStatus('更新已就绪，重启后安装');
        setDoUpdate('立即重启');
        if (!localStorage.getItem(dismissedKey('downloaded', s.version))) {
          showUpdateBanner(`<span class="nb">新版本 <b>v${esc(s.version)}</b></span> 已就绪，<span class="nb">重启后完成安装</span>`, '立即重启', true);
        }
        break;
      case 'up-to-date':
        if (manualCheck) setUpdateStatus(`已是最新版本（${cur}）`);
        manualCheck = false;
        setDoUpdate(null);
        break;
      case 'unconfigured':
        if (manualCheck) setUpdateStatus('未配置更新服务器地址');
        manualCheck = false;
        setDoUpdate(null);
        break;
      case 'error':
        if (manualCheck) setUpdateStatus('检查失败：' + esc(s.message || '未知错误'));
        manualCheck = false;
        setDoUpdate(null);
        break;
    }
  }

  /* ================= 事件绑定 ================= */
  function paintUiIcons() {
    document.querySelectorAll('[data-ui]').forEach(el => {
      el.innerHTML = Icons.ui(el.dataset.ui);
    });
  }

  function bindEvents() {
    $('btnSettings').addEventListener('click', openPanel);
    $('btnSwitchLoc').addEventListener('click', openPanel);
    $('closeSettings').addEventListener('click', closePanel);
    $('btnClose').addEventListener('click', () => sky.winAction('hide'));
    $('btnQuit').addEventListener('click', () => sky.winAction('quit'));

    $('btnPin').addEventListener('click', async () => {
      const on = await sky.winAction('pin');
      $('btnPin').style.opacity = on ? '1' : '0.45';
    });

    $('btnRefresh').addEventListener('click', async () => {
      const btn = $('btnRefresh');
      btn.classList.remove('spin-once');
      void btn.offsetWidth;
      btn.classList.add('spin-once');
      await loadWeather();
    });

    $('btnSearch').addEventListener('click', doSearch);
    // IME 守卫：中文输入法确认候选词的 Enter（isComposing/keyCode 229）不能触发搜索，
    // 否则会拿未完成的拼音提前搜索（搜「ci」而不是「慈溪」）导致"搜不出区县市"
    $('searchInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) doSearch();
    });

    $('btnAutoLocate').addEventListener('click', async () => {
      $('btnAutoLocate').textContent = '正在定位…';
      const loc = await sky.ipLocate();
      $('btnAutoLocate').innerHTML = Icons.ui('pin', 14) + '使用当前位置（自动定位）';
      if (loc && !loc.error && Number.isFinite(loc.lat)) {
        await addLocation(loc, true);
      } else {
        $('searchResults').innerHTML = `<div class="s-item">定位失败：${esc((loc && loc.error) || '请手动搜索地点')}</div>`;
      }
    });

    $('refreshSelect').addEventListener('change', async e => {
      const v = Number(e.target.value);
      state.settings = await sky.updateSettings({ refreshMinutes: v });
      startRefreshTimer();
    });
    $('chkTop').addEventListener('change', async e => {
      state.settings = await sky.updateSettings({ alwaysOnTop: e.target.checked });
    });
    $('chkAuto').addEventListener('change', async e => {
      state.settings = await sky.updateSettings({ autoLaunch: e.target.checked });
    });
    $('chkEdgeDock').addEventListener('change', async e => {
      state.settings = await sky.updateSettings({ edgeDock: e.target.checked });
      if (!e.target.checked) applyDockState({ docked: false, expanded: false });
    });
    $('chkTrayTemp').addEventListener('change', async e => {
      state.settings = await sky.updateSettings({ trayTemp: e.target.checked });
      if (e.target.checked) { trayKey = ''; updateTrayTemp(); } // 重新开启 → 立即推一次图标
    });
    $('chkBrief').addEventListener('change', async e => {
      state.settings = await sky.updateSettings({ brief: e.target.checked });
    });

    // 软件更新
    $('btnCheckUpdate').addEventListener('click', () => {
      manualCheck = true;
      setUpdateStatus('正在检查更新…');
      sky.updateCheck();
    });
    $('btnSaveUpdateUrl').addEventListener('click', async () => {
      const v = $('updateUrlInput').value.trim();
      state.settings = await sky.updateSettings({ updateUrl: v });
      setUpdateStatus(v ? '更新服务器地址已保存' : '已清除更新服务器地址');
    });
    $('ubPrimary').addEventListener('click', () => {
      const s = lastUpdateState || {};
      if (s.type === 'available') sky.updateDownload();
      else if (s.type === 'downloaded') sky.updateInstall();
    });
    // 设置页的更新动作按钮与横幅主按钮同逻辑（点击后立即禁用，防连点重复触发下载）
    $('btnDoUpdate').addEventListener('click', () => {
      const s = lastUpdateState || {};
      if (s.type === 'available') { $('btnDoUpdate').disabled = true; sky.updateDownload(); }
      else if (s.type === 'downloaded') sky.updateInstall();
    });
    $('ubLater').addEventListener('click', dismissUpdateBanner);
    if (sky.onUpdateState) sky.onUpdateState(onUpdateState);

    $('prevMonth').addEventListener('click', () => {
      state.calM--; if (state.calM < 1) { state.calM = 12; state.calY--; }
      renderCalendar(); renderLucky();
    });
    $('nextMonth').addEventListener('click', () => {
      state.calM++; if (state.calM > 12) { state.calM = 1; state.calY++; }
      renderCalendar(); renderLucky();
    });
    $('todayBtn').addEventListener('click', () => {
      const now = new Date();
      state.selDate = now;
      state.calY = now.getFullYear(); state.calM = now.getMonth() + 1;
      renderAlmanac();
    });
  }

  async function doSearch() {
    const q = $('searchInput').value.trim();
    if (!q) return;
    $('searchResults').innerHTML = '<div class="s-item">搜索中…</div>';
    const res = await sky.geoSearch(q);
    if (res && res.error) {
      $('searchResults').innerHTML = `<div class="s-item">搜索失败：${esc(res.error)}</div>`;
      return;
    }
    if (!res || !res.length) {
      $('searchResults').innerHTML = '<div class="s-item">没找到这个地点，换个关键词试试</div>';
      return;
    }
    $('searchResults').innerHTML = res.map((r, i) => `
      <div class="s-item" data-i="${i}">
        ${esc(locLine(r))}
        <small>${esc(r.display || '')}</small>
      </div>`).join('');
    $('searchResults').querySelectorAll('[data-i]').forEach(el => {
      el.addEventListener('click', () => {
        addLocation(res[Number(el.dataset.i)], false);
        $('searchResults').innerHTML = '';
        $('searchInput').value = '';
      });
    });
  }

  function startRefreshTimer() {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    if (document.hidden) return; // 隐藏到托盘时不空转网络请求（显示恢复时再补）
    const mins = Number(state.settings && state.settings.refreshMinutes) || 10;
    state.refreshTimer = setInterval(loadWeather, mins * 60 * 1000);
  }
  // 隐藏（收起到托盘）→ 暂停定时刷新；重新显示 → 恢复定时 + 数据过期立即补一刷
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
      return;
    }
    startRefreshTimer();
    const mins = Number(state.settings && state.settings.refreshMinutes) || 10;
    if (state.loc && (!state.fetchedAt || Date.now() - state.fetchedAt.getTime() > mins * 60 * 1000)) loadWeather();
  });

  /* ================= iOS 式惯性滚动 =================
     原生 Windows 滚轮是一格一格跳的，观感生硬；
     这里拦截 wheel 累积目标位置、rAF 指数插值追目标，得到 iOS 式平滑减速。
     滚动期间给容器加 .scrolling：临时关掉卡片 backdrop-filter——
     透明窗上每帧重采样桌面是掉帧 + 频闪的主因，停下后自动恢复玻璃效果。 */
  function markScrolling(el) {
    if (!el.classList.contains('scrolling')) el.classList.add('scrolling');
    clearTimeout(el._scrollEndTimer);
    el._scrollEndTimer = setTimeout(() => el.classList.remove('scrolling'), 180);
  }

  function initSmoothScroll(el) {
    if (!el) return;
    let target = el.scrollTop, animating = false, raf = 0;
    const EASE = 0.18;
    const maxTop = () => Math.max(0, el.scrollHeight - el.clientHeight);

    function step() {
      raf = 0;
      if (target > maxTop()) target = maxTop();   // content-visibility 让 scrollHeight 动态变化，逐帧钳制
      const cur = el.scrollTop;
      const next = cur + (target - cur) * EASE;
      if (Math.abs(target - cur) < 0.6) {
        el.scrollTop = target;
        animating = false;
        return;
      }
      el.scrollTop = next;
      markScrolling(el);
      raf = requestAnimationFrame(step);
    }

    el.addEventListener('wheel', e => {
      if (e.ctrlKey) return;                        // Ctrl+滚轮缩放交还原生
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 横向手势（逐时横滑）不拦截
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      if (!animating) target = el.scrollTop;
      target = Math.min(maxTop(), Math.max(0, target + e.deltaY * unit));
      markScrolling(el);
      if (!animating) { animating = true; raf = requestAnimationFrame(step); }
    }, { passive: false });

    // 外部滚动（滚动条拖动 / 键盘 / 查找定位）→ 同步惯性目标，避免两套滚动打架
    el.addEventListener('scroll', () => {
      if (!animating) target = el.scrollTop;
      markScrolling(el);
    }, { passive: true });
  }

  /* ================= 鼠标拖拽平移（逐时预报 / 时辰吉凶横滑列表） =================
     按住左键直接左右拖内容（iOS 平移手感），松手按速度惯性滑行一小段；
     拖动后紧随的 click 会被吞掉，避免误触；拖动中禁文本/图片原生拖拽。 */
  function initDragScroll(el) {
    if (!el) return;
    let down = false, startX = 0, startLeft = 0, lastX = 0, lastT = 0, vel = 0, raf = 0, moved = false;

    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      down = true; moved = false;
      startX = lastX = e.clientX; startLeft = el.scrollLeft;
      lastT = performance.now(); vel = 0;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      el.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
      if (!down) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      el.scrollLeft = startLeft - dx;
      const now = performance.now(), dt = now - lastT;
      if (dt > 0) { vel = (e.clientX - lastX) / dt; lastX = e.clientX; lastT = now; }
    });
    window.addEventListener('mouseup', () => {
      if (!down) return;
      down = false;
      el.classList.remove('dragging');
      if (moved) {
        // 拖动结束吞掉一次 click，避免松手处的项目被误点
        const kill = ev => { ev.stopPropagation(); ev.preventDefault(); };
        el.addEventListener('click', kill, { capture: true, once: true });
        setTimeout(() => el.removeEventListener('click', kill, true), 400);
      }
      // 惯性滑行：按松手速度指数衰减（px/ms → 每帧位移）
      if (Math.abs(vel) > 0.12) {
        const step = () => {
          vel *= 0.94;
          el.scrollLeft -= vel * 16;
          const edge = el.scrollLeft <= 0 || el.scrollLeft >= el.scrollWidth - el.clientWidth - 1;
          if (Math.abs(vel) > 0.02 && !edge) raf = requestAnimationFrame(step);
          else raf = 0;
        };
        raf = requestAnimationFrame(step);
      }
    });
    el.addEventListener('dragstart', e => e.preventDefault()); // 内容不触发原生拖拽
  }

  /* ================= 窗口 JS 手动拖拽兜底 =================
     .drag 区域（顶栏/小窗抓手）原生走 -webkit-app-region:drag；
     Win11 透明窗 + setShape 下原生可能失效（收不到系统拖拽），
     失效时这些区域能收到鼠标事件 → 转发屏幕坐标让主进程移动窗口；
     原生拖拽生效时事件不会到达渲染进程，两套机制互不冲突。 */
  function initDragMove() {
    if (!sky.winDrag) return;
    let dragging = false;
    const end = () => {
      if (!dragging) return;
      dragging = false;
      sky.winDragEnd();
    };
    document.querySelectorAll('.drag').forEach(el => {
      el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        dragging = true;
        e.preventDefault();               // 避免拖动时选中文字
        sky.winDrag(e.screenX, e.screenY); // 建立拖拽基准点
      });
    });
    window.addEventListener('mousemove', e => {
      if (dragging) sky.winDrag(e.screenX, e.screenY);
    });
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);  // 失焦兜底，防止拖拽状态卡住
  }

  /* ================= 启动 ================= */
  async function init() {
    tickClock();
    setInterval(tickClock, 1000);
    setInterval(updateSky, 60 * 1000);

    state.settings = await sky.getSettings();
    $('refreshSelect').value = String(state.settings.refreshMinutes || 10);
    $('chkTop').checked = !!state.settings.alwaysOnTop;
    $('chkAuto').checked = !!state.settings.autoLaunch;
    $('chkEdgeDock').checked = state.settings.edgeDock !== false;
    $('chkTrayTemp').checked = state.settings.trayTemp !== false;
    $('chkBrief').checked = state.settings.brief !== false;
    $('updateUrlInput').value = state.settings.updateUrl || '';

    // 吸顶温度小窗：状态同步 + 悬停展开/收起
    applyDockState({ docked: !!state.settings.docked, expanded: false });
    if (sky.onDockState) sky.onDockState(applyDockState);
    document.addEventListener('mouseenter', () => {
      if (document.body.classList.contains('docked')) sky.dockHover(true);
    });
    document.addEventListener('mouseleave', () => {
      if (document.body.classList.contains('docked')) sky.dockHover(false);
    });
    // 展开后窗口尺寸变化可能误触发 leave，用节流的 mousemove 保持展开
    let hoverTick = 0;
    document.addEventListener('mousemove', () => {
      if (!document.body.classList.contains('docked')) return;
      const now = Date.now();
      if (now - hoverTick > 300) { hoverTick = now; sky.dockHover(true); }
    });
    // 按住鼠标拖拽期间（拖球/拖进度条/横滑）也算「正在使用」：
    // 按住不动（尤其停在窗口边缘）不该触发悬停收起，否则拖拽中途整窗缩回小窗
    let holdTick = 0;
    const endHold = () => { clearInterval(holdTick); holdTick = 0; };
    document.addEventListener('pointerdown', () => {
      if (!document.body.classList.contains('docked') || holdTick) return;
      holdTick = setInterval(() => sky.dockHover(true), 250);
    });
    document.addEventListener('pointerup', endHold);
    document.addEventListener('pointercancel', endHold);
    window.addEventListener('blur', endHold);
    try {
      const ver = await sky.version();
      $('panelVersion').textContent = 'v' + ver;
      setUpdateStatus('当前版本 v' + ver);
    } catch (e) { }

    // 选中地点
    const locs = state.settings.locations || [];
    if (locs.length) {
      state.loc = locs.find(l => l.id === state.settings.activeId) || locs[0];
    } else {
      $('locText').textContent = '正在自动定位…';
      let loc = null;
      if (state.settings.autoLocate !== false) {
        const r = await sky.ipLocate();
        if (r && !r.error && Number.isFinite(r.lat)) loc = r;
      }
      if (!loc) loc = DEFAULT_LOC;
      const id = 'loc_' + Date.now();
      const entry = Object.assign({ id }, loc);
      state.settings = await sky.updateSettings({ locations: [entry], activeId: id });
      state.loc = entry;
    }

    // 万年历初始化
    const now = new Date();
    state.calY = now.getFullYear(); state.calM = now.getMonth() + 1;
    state.selDate = now;
    renderAlmanac();
    paintUiIcons();
    bindEvents();
    initDragMove();
    initSmoothScroll($('widget'));
    initSmoothScroll(document.querySelector('.panel-body'));
    initDragScroll($('hourlyScroll'));
    initDragScroll($('almHours'));

    // 昼夜地球（地点确定后初始化，数据回来后 renderAll 里持续更新）
    if (window.Globe) { Globe.init('globeMount'); Globe.update(state.loc); }

    // 天气
    await loadWeather();
    startRefreshTimer();
  }

  // 天空动画先跑起来（数据回来前也有氛围）
  FX.start(document.getElementById('fx'));
  updateSky();

  init().catch(e => {
    console.error(e);
    $('locText').textContent = '初始化失败，请重启插件';
  });
})();
