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
    fetchedAt: null,      // 天气数据最近一次成功更新时间
    failCount: 0,         // 连续失败次数（指数退避用）
    lastFetchTry: 0       // 最近一次发起刷新的时刻（防双触发）
  };

  /* ================= 单位换算中枢 =================
     显示单位与存储阈值严格隔离：数据字段、提醒规则阈值一律按 °C / km·h⁻¹ / m·s⁻¹ 原值存储，
     只在渲染出口换算，避免切换单位后规则语义漂移（例如 °F 下把 35 当成高温阈值）。 */
  const SkyUnits = {
    isF() { return !!(state.settings && state.settings.unit === 'f'); },
    mode() { return (state.settings && state.settings.windUnit) || 'level'; },
    num(c) { const v = Number(c); return Number.isFinite(v) ? (this.isF() ? v * 9 / 5 + 32 : v) : 0; },
    temp(c) { return Math.round(this.num(c)) + '°'; },
    delta(c) { const v = Number(c) || 0; return Math.round(this.isF() ? v * 9 / 5 : v) + '°'; }, // 温差只缩放、不加 32
    windParts(kmh) {
      const v = Number(kmh) || 0, u = this.mode();
      if (u === 'ms') return { num: (v / 3.6).toFixed(1), unit: 'm/s' };
      if (u === 'kmh') return { num: String(Math.round(v)), unit: 'km/h' };
      return { num: String(window.Weather ? Weather.windLevel(v) : 0), unit: '级' };
    },
    windText(kmh) {
      const p = this.windParts(kmh);
      return p.unit === '级' ? p.num + '级' : p.num + ' ' + p.unit;
    },
    windFromMs(ms) { return this.windText((Number(ms) || 0) * 3.6); } // 提醒规则阈值以 m/s 存储
  };
  window.SkyUnits = SkyUnits;

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
    // 睡眠唤醒 / 定时器被系统冻结后按「数据年龄」补刷：60s 粒度，且不与定时刷新双触发
    const ms = Date.now();
    if (ms - lastStaleCheck > 60000) {
      lastStaleCheck = ms;
      if (state.loc && state.settings && !document.hidden) {
        const mins = Number(state.settings.refreshMinutes) || 10;
        if (!state.fetchedAt || ms - state.fetchedAt.getTime() > mins * 60 * 1000) loadWeather();
      }
    }
  }
  let lastStaleCheck = 0;

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
    return w && w.current ? !!w.current.is_day : (now.getHours() > 6 && now.getHours() < 19);
  }

  let flipTimer = null;
  function updateSky() {
    const now = new Date();
    const w = state.data && state.data.weather;
    const isDay = computeIsDay(w, now);
    const group = w && w.current ? Weather.codeInfo(Number(w.current.weather_code) || 0, isDay).group : 'clear';
    // setMode 统一设置 night 并重绘天空，paintSky 不再按钟点猜昼夜
    FX.setMode(group, isDay, now);
    // 降级/合并源可能只回部分分段：日月定位与翻转定时器都必须逐段判空
    const sr = w && w.daily && w.daily.sunrise && w.daily.sunrise[0];
    const ss = w && w.daily && w.daily.sunset && w.daily.sunset[0];
    if (sr && ss) FX.placeCelestial(sr, ss);
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
    $('tempNow').textContent = Math.round(SkyUnits.num(c.temperature_2m));
    $('nowIcon').innerHTML = `<span class="big-icon">${Icons.svg(info.icon, 58)}</span>`;
    $('condText').textContent = info.text;
    $('tempRange').textContent = `今日 ${SkyUnits.temp(d.temperature_2m_max[0])} / ${SkyUnits.temp(d.temperature_2m_min[0])}`;

    const chips = [
      ['体感', SkyUnits.temp(c.apparent_temperature)],
      ['湿度', `${c.relative_humidity_2m}%`],
      ['风', `${Weather.windDir(c.wind_speed_10m ? c.wind_direction_10m : 0)} ${SkyUnits.windText(c.wind_speed_10m)}`],
      ['气压', `${Math.round(c.pressure_msl)}hPa`],
      ['日出', (d.sunrise[0] || '').slice(11)],
      ['日落', (d.sunset[0] || '').slice(11)]
    ];
    // 朝晚霞概率：取「下一次」日出/日落所在小时的低/中/高云量推算（不新增栏目，融进 chips）
    const glow = computeGlow(w, new Date());
    if (glow.dawn) chips.push(['朝霞', glow.dawn.label]);
    if (glow.dusk) chips.push(['晚霞', glow.dusk.label]);
    $('statRow').innerHTML = chips.map(([k, v]) => `<span class="chip">${k} <b>${esc(v)}</b></span>`).join('');

    // 提示条：官方预警（中国天气网 alarmDZ，气象台发布）置顶 + 自算提示（温差/风/UV 等）补充
    const official = (state.data && state.data.cnAlerts) || [];
    const lvlTone = l => /红/.test(l || '') ? 'red' : /橙/.test(l || '') ? 'orange'
      : /黄/.test(l || '') ? 'yellow' : /蓝/.test(l || '') ? 'blue' : 'green';
    const offHtml = official.slice(0, 2).map(a => {
      const title = a.type
        ? `${a.type}${a.level ? '·' + a.level : ''}预警`
        : (a.level ? a.level + '预警' : '官方预警');
      return `<div class="alert ${lvlTone(a.level)}"><span class="dot"></span><span><b>${esc(title)}</b> ${esc(a.text || '')}</span></div>`;
    });
    const alerts = Weather.buildAlerts(d, w.hourly);
    $('alertWrap').innerHTML = offHtml.concat(alerts.map(a =>
      `<div class="alert ${a.tone}"><span class="dot"></span><span>${esc(a.text)}</span></div>`)).slice(0, 4).join('');

    // 标题主打区县名（如「慈溪」），完整地址链（含街道）放到下方 detail 行
    $('locText').textContent = state.loc.name || locLine(state.loc);
    // detail 通常已包含在 display 的地址链里，先去重再拼接，避免"慈溪市 · 慈溪市 · …"
    const disp = state.loc.display || '';
    const dt = state.loc.detail || '';
    $('locDetail').textContent = dt && disp.indexOf(dt) === -1
      ? `${dt} · ${disp}`
      : (disp || dt);
    $('locDetail').title = state.loc.display || '';

    // 更新时间 + 数据来源（分段如实标注：国内源合并了哪段就标哪段，明细挂 title）
    const fu = state.fetchedAt || new Date();
    const s = (state.data && state.data.sources) || null;
    let srcSum = 'Open-Meteo', srcTip = '';
    if (s) {
      const segs = [
        ['实况', s.current], ['7天', s.daily], ['空气', s.air],
        ['逐时', s.hourly], ['分钟级', s.minutely], ['预警', s.alerts]
      ].filter(([, v]) => v);
      const uniq = [];
      for (const [, v] of segs) {
        for (const part of String(v).split(' + ')) if (part && !uniq.includes(part)) uniq.push(part);
      }
      if (uniq.length) srcSum = uniq.join(' + ');
      srcTip = segs.map(([k, v]) => `${k}：${v}`).join('\n');
    }
    const ageMin = state.fetchedAt ? (Date.now() - state.fetchedAt.getTime()) / 60000 : 0;
    const stale = ageMin > (Number(state.settings && state.settings.refreshMinutes) || 10) * 2;
    $('srcLine').innerHTML = `数据更新 ${pad(fu.getHours())}:${pad(fu.getMinutes())}:${pad(fu.getSeconds())} · 来源 ${srcSum}` +
      (stale ? ' · <span class="stale-tag">数据已过期，正在重试</span>' : '');
    $('srcLine').title = srcTip;
    // 页脚署名与 srcLine 同步消费 sources：曾硬编码「天气数据 Open-Meteo」，
    // 国内源合并后与 srcLine 自相矛盾（1.0.27 排查发现，同类显示 bug）
    if ($('footText')) $('footText').textContent = `天气数据 ${srcSum} · 地名 OpenStreetMap + Open-Meteo · 老黄历 lunar-javascript`;
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
        <div class="h-temp">${SkyUnits.temp(w.hourly.temperature_2m[i])}</div>
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
    const VW = 424, VH = 108, padT = 14, padB = 26;
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
    // 降水概率底柱（0-100% → 12px 底部条带）；取整为 0 的时刻标「0%」数值直给。
    // 草芽图形已移除：会与温度曲线低位重叠（2026-10-30 用户反馈），0% 小字保留
    let bars = '', zeros = '';
    const bw = Math.max(3, VW / n - 4);
    for (let i = 0; i < n; i++) {
      if (Math.round(pops[i]) > 0) {
        const ph = Math.max(1.5, (pops[i] / 100) * 12);
        bars += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(VH - padB + 3 - ph).toFixed(1)}" width="${bw.toFixed(1)}" height="${ph.toFixed(1)}" rx="1.5" class="tr-pop"/>`;
      } else {
        // 端点用 start/end 锚定贴边，不钳位防挤字
        const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
        const lx = i === 0 ? 1 : (i === n - 1 ? VW - 1 : x(i));
        zeros += `<text x="${lx.toFixed(1)}" y="${VH - 13}" class="tr-zero" text-anchor="${anchor}">0%</text>`;
      }
    }
    // 横轴时间刻度：「现在」+ 每 6 小时整点，配浅色参考线（曲线点可对到钟点，和下方卡片时间对得上）
    let ticks = '', grid = '';
    for (let i = 1; i < n; i++) {
      const hh = h.time[idx + i].slice(11, 13);
      if (hh !== '00' && hh !== '06' && hh !== '12' && hh !== '18') continue;
      const tx = Math.min(VW - 1, x(i));
      if (tx < 34) continue; // 离「现在」太近的整点不标，避免刻度文字重叠（起点恰在整点前时会挤在一起）
      grid += `<line x1="${tx.toFixed(1)}" y1="${padT - 4}" x2="${tx.toFixed(1)}" y2="${VH - padB + 3}" class="tr-grid"/>`;
      ticks += `<text x="${tx.toFixed(1)}" y="${VH - 1}" class="tr-tick" text-anchor="${i >= n - 2 ? 'end' : 'middle'}">${Number(hh)}时</text>`;
    }
    ticks = `<text x="1" y="${VH - 1}" class="tr-tick" text-anchor="start">现在</text>` + ticks;
    // 端点温度标注（只标首/尾/最高/最低，避免文字堆叠）
    const marks = [[0, temps[0], 'start'], [n - 1, temps[n - 1], 'end']];
    let minI = 0, maxI = 0;
    temps.forEach((t, i) => { if (t < temps[minI]) minI = i; if (t > temps[maxI]) maxI = i; });
    if (minI > 0 && minI < n - 1) marks.push([minI, temps[minI], 'mid']);
    if (maxI > 0 && maxI < n - 1 && maxI !== minI) marks.push([maxI, temps[maxI], 'mid']);
    const dots = marks.map(([i, t, kind]) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(t).toFixed(1)}" r="2.6" class="tr-dot"/>` +
      (kind === 'mid' ? `<text x="${x(i).toFixed(1)}" y="${(y(t) - 7).toFixed(1)}" class="tr-lab">${SkyUnits.temp(t)}</text>` : '')
    ).join('');
    el.innerHTML = `<svg viewBox="0 0 ${VW} ${VH}" width="100%" height="${VH}" preserveAspectRatio="none" aria-hidden="true">
      ${grid}<path d="${dpath}" class="tr-line"/>${bars}<g class="tr-zeros">${zeros}</g>${dots}${ticks}</svg>`;
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
      slots.push({ p: Number(m.precipitation[i]) || 0, code: Number((m.weather_code || [])[i]) || 0 });
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
    const sproutSVG = '<svg width="10" height="11" viewBox="0 0 10 11" aria-hidden="true"><g transform="translate(5,10)"><path d="M0,0 C0,-2 0,-3 0,-4.2" class="sprout-stem"/><path d="M-0.2,-2.2 C-1.4,-1.9 -2.6,-2.6 -3.1,-4 C-1.7,-4.3 -0.6,-3.5 -0.2,-2.2 Z" class="sprout-leaf"/><path d="M0.2,-3.4 C1.1,-3.6 2,-4.3 2.3,-5.6 C1.1,-5.5 0.4,-4.6 0.2,-3.4 Z" class="sprout-leaf"/></g></svg>';
    const bars = slots.map((s, i) => {
      const t0 = `${i * 15}分钟后`;
      if (s.p <= 0.05) return `<i class="mm-slot"><b class="mm-val zero">0mm</b><i class="mm-sprout" title="${t0} 无降水">${sproutSVG}</i></i>`; // 无降水槽位长草芽 + 0mm 直给
      const h = Math.max(4, Math.round((s.p / maxP) * 30));
      const snow = isSnowCode(s.code);
      return `<i class="mm-slot"><b class="mm-val ${snow ? 'snow' : 'rain'}">${s.p.toFixed(1)}mm</b><i class="mm-bar ${snow ? 'snow' : 'rain'}" style="height:${h}px" title="${t0} ${s.p.toFixed(1)}mm"></i></i>`;
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
    const tv = SkyUnits.num(t);
    g.font = '700 ' + (Math.abs(tv) >= 100 ? 26 : 34) + 'px "Segoe UI", sans-serif'; // °F 三位数自动缩字
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = isDay ? '#4a3a22' : '#dfe9ff';
    const label = Math.abs(tv) >= 100 ? String(Math.round(tv)) : Math.round(tv) + '°';
    g.fillText(label, 32, 33);
    return cv.toDataURL('image/png');
  }
  function updateTrayTemp() {
    const w = state.data && state.data.weather;
    if (!w || !state.settings || state.settings.trayTemp === false) return;
    const t = Math.round(SkyUnits.num(w.current.temperature_2m));
    const isDay = computeIsDay(w, new Date());
    const key = t + '|' + (isDay ? 'd' : 'n') + '|' + (SkyUnits.isF() ? 'f' : 'c');
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
    const body = `${i === 0 ? '今天' : '明天'}${info.text}，${SkyUnits.temp(d.temperature_2m_min[i])}~${SkyUnits.temp(d.temperature_2m_max[i])}` +
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
    const d = w && w.daily;
    // 降级源可能不足 7 天或温度段缺失：按实际长度渲染，非有限值不进入比例计算
    if (!d || !Array.isArray(d.time) || !d.time.length) { $('dailyList').innerHTML = ''; return; }
    const days = Math.min(7, d.time.length);
    const rawMin = Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min : [];
    const rawMax = Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max : [];
    const goodMin = [], goodMax = [];
    for (let i = 0; i < days; i++) {
      const a = Number(rawMin[i]), b = Number(rawMax[i]);
      if (Number.isFinite(a)) goodMin.push(a);
      if (Number.isFinite(b)) goodMax.push(b);
    }
    const weekMin = goodMin.length ? Math.min(...goodMin) : 0;
    const weekMax = goodMax.length ? Math.max(...goodMax) : weekMin + 1;
    const span = Math.max(1, weekMax - weekMin);
    const mins = [], maxs = [];
    for (let i = 0; i < days; i++) {
      const a = Number(rawMin[i]), b = Number(rawMax[i]);
      mins[i] = Number.isFinite(a) ? a : weekMin;
      maxs[i] = Number.isFinite(b) ? b : mins[i];
    }
    const todayKey = `${state.selDate.getFullYear()}-${pad(state.selDate.getMonth() + 1)}-${pad(state.selDate.getDate())}`;

    let html = '';
    for (let i = 0; i < days; i++) {
      const date = new Date(d.time[i] + 'T00:00:00');
      if (!Number.isFinite(date.getTime())) continue;
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
          <span class="d-low">${SkyUnits.temp(mins[i])}</span>
          <span class="d-bar"><i style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></i></span>
          <span class="d-high">${SkyUnits.temp(maxs[i])}</span>
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
    const fill = $('aqiBarFill');
    const trackW = (fill.parentElement && fill.parentElement.clientWidth) || 240;
    fill.style.transform = `translateX(${(trackW * piecewise(aq.aqi) / 100).toFixed(1)}px)`;

    const order = ['pm25', 'pm10', 'o3', 'no2', 'so2', 'co'];
    $('aqiGrid').innerHTML = order.map(k => {
      const s = aq.sub[k];
      if (!s) return '';
      const val = k === 'co' ? s.value.toFixed(2) : Math.round(s.value);
      return `<div class="aqi-cell"><span>${s.name}</span><b>${val}</b></div>`;
    }).join('') + `<div class="aqi-cell" style="grid-column:1/3;opacity:.6"><span>单位 μg/m³（CO 为 mg/m³）</span></div>`;
  }

  /* ---------- 模块显隐（设置面板「显示模块」；隐藏即 display:none，零渲染开销） ---------- */
  const MOD_KEYS = ['globe', 'hourly', 'daily', 'aqi', 'life', 'almanac',
    'uv', 'pollen', 'wind', 'visib', 'dress', 'carwash', 'dry', 'cold',
    'moon', 'history', 'precipstat', 'pressure', 'cities', 'radar', 'alerts', 'share'];
  const MOD_TARGET = {
    globe: 'modGlobe', hourly: 'modHourly', daily: 'modDaily', aqi: 'modAqi', life: 'modLife', almanac: 'modAlmanac',
    uv: 'modUv', pollen: 'modPollen', wind: 'modWind', visib: 'modVisib',
    dress: 'modDress', carwash: 'modCarwash', dry: 'modDry', cold: 'modCold',
    moon: 'modMoon', history: 'modHistory', precipstat: 'modPrecipstat', pressure: 'modPressure',
    cities: 'modCities', radar: 'modRadar', alerts: 'modAlerts', share: 'modShare'
  };
  /* 动效开关：默认始终播放，系统「减少动态效果」一律不介入。
     v1.0.28 曾误把默认改成「跟随系统」并让系统偏好自动全静止 → 本机 reduce=true 使雷达整卡不转。
     用户明确否决（「我让你优化，又没让你减少动态效果」）：现在只有设置里显式选「关闭」才静止。 */
  function applyMotion() {
    const off = !!(state.settings && state.settings.motion === 'off');
    document.body.classList.toggle('motion-quiet', off);
    document.body.classList.toggle('motion-off', off);
    document.body.classList.add('motion-override'); // 系统偏好永不介入（兼容历史 CSS 规则的开关）
    syncAnimationSuspend(); // 用户显式关闭时，canvas 粒子 / 地球 rAF 也一起停
  }
  // 收起为小窗或全静止档：统一挂起两套逐帧循环（隐藏态 FX/Globe 各自还看 document.hidden）
  function syncAnimationSuspend() {
    const idle = document.body.classList.contains('motion-quiet') ||
      (document.body.classList.contains('docked') && !document.body.classList.contains('expanded'));
    if (window.FX && FX.setSuspended) FX.setSuspended(idle);
    if (window.Globe && Globe.setSuspended) Globe.setSuspended(idle);
  }
  // 不再监听 matchMedia 变化：系统偏好不该改变本插件的动效（用户口谕）
  function applyModules() {
    const m = (state.settings && state.settings.modules) || {};
    for (const k of MOD_KEYS) {
      const el = $(MOD_TARGET[k]);
      if (el) el.classList.toggle('mod-off', m[k] === false);
    }
    // 空气质量/生活指南同排：只关一个时另一个占满整行
    const duo = document.querySelector('.duo');
    if (duo) duo.classList.toggle('single', (m.aqi === false) !== (m.life === false));
    // 四联组：组内 4 卡全关时整组隐藏（组仍参与排序，只是不显示）
    const quads = [
      ['modQuadReal', ['uv', 'pollen', 'wind', 'visib']],
      ['modQuadLife4', ['dress', 'carwash', 'dry', 'cold']],
      ['modQuadClimate', ['moon', 'history', 'precipstat', 'pressure']],
      ['modQuadPlay', ['cities', 'radar', 'alerts', 'share']]
    ];
    for (const [qid, keys] of quads) {
      const q = $(qid);
      if (q) q.classList.toggle('mod-off', keys.every(k => m[k] === false));
    }
  }

  /* ---------- 模块排序（设置「显示模块」≡ 手柄拖动换位，顺序记忆；duo 整体参与） ---------- */
  const MOD_ORDER_DEFAULT = ['globe', 'hourly', 'daily', 'duo', 'real', 'life4', 'climate', 'play', 'almanac'];
  const MOD_NODE = {
    globe: 'modGlobe', hourly: 'modHourly', daily: 'modDaily', duo: 'modDuo',
    real: 'modQuadReal', life4: 'modQuadLife4', climate: 'modQuadClimate', play: 'modQuadPlay', almanac: 'modAlmanac'
  };
  function modOrder() {
    const ord = state.settings && state.settings.modulesOrder;
    if (!Array.isArray(ord)) return MOD_ORDER_DEFAULT;
    const out = ord.filter((k, i) => MOD_ORDER_DEFAULT.includes(k) && ord.indexOf(k) === i);
    for (const k of MOD_ORDER_DEFAULT) if (!out.includes(k)) out.push(k);
    return out;
  }
  /* content-visibility:auto「0 高卡死」自愈（2026-11-03）：跳过渲染区块的「记住尺寸」被清零后
     （吸顶收起/展开把 #widget 整体 visibility:hidden 期间实测会把跳过区块记住 0 高），
     0 高盒子永不再触发 reveal（空矩形不与视口相交）→ 页尾区块滚动永远够不着、页面像被截断。
     发现「有内容却 0 高」的区块就永久放开 content-visibility（强制真实布局），一次修复不再复发。 */
  function repairZeroSections() {
    for (const sec of document.querySelectorAll('#widget > section, #widget > .foot')) {
      if (sec.firstElementChild && sec.getBoundingClientRect().height === 0) {
        sec.style.contentVisibility = 'visible';
      }
    }
  }
  function applyOrder() {
    const parent = $('modGlobe') && $('modGlobe').parentElement;
    if (!parent) return;
    // 必须插在页尾脚注之前：直接 appendChild 会把 9 个模块甩到 .foot 之后，
    // 脚注跑到模块上方（2026-11-03 实测布局 dump 抓到 foot 在模块前）
    const sentinel = parent.querySelector(':scope > .foot') || null;
    for (const k of modOrder()) {
      const el = $(MOD_NODE[k]);
      if (el) parent.insertBefore(el, sentinel); // 按序 insert 即重排，9 个节点开销可忽略
    }
    repairZeroSections();
  }
  function initModSort() {
    const list = $('modSort');
    if (!list) return;
    const syncListOrder = () => {
      for (const k of modOrder()) {
        const row = list.querySelector(`.mod-row[data-mod="${k}"]`);
        if (row) list.appendChild(row);
      }
    };
    syncListOrder();
    let drag = null;
    const finish = () => {
      if (!drag) return;
      const d = drag; drag = null;
      list.classList.remove('sorting');
      d.row.classList.remove('dragging');
      d.rows.forEach(r => { r.style.transform = ''; });
      if (d.target !== d.from) {
        const ord = modOrder();
        const [moved] = ord.splice(d.from, 1);
        ord.splice(d.target, 0, moved);
        state.settings = Object.assign({}, state.settings, { modulesOrder: ord });
        sky.updateSettings({ modulesOrder: ord }).then(s => { if (s) state.settings = s; });
        syncListOrder();
        applyOrder();
      }
    };
    list.addEventListener('pointerdown', e => {
      const handle = e.target.closest && e.target.closest('.mod-handle');
      if (!handle || drag) return;
      const row = handle.closest('.mod-row');
      if (!row) return;
      e.preventDefault();
      const rows = [...list.querySelectorAll('.mod-row')];
      drag = { row, rows, startY: e.clientY, from: rows.indexOf(row), target: rows.indexOf(row), h: row.offsetHeight + 6 };
      try { handle.setPointerCapture(e.pointerId); } catch (err) { } // 捕获失败走 blur/lostpointercapture 兜底
      list.classList.add('sorting'); // 全部行禁过渡，挤位才跟手
      row.classList.add('dragging');
    });
    list.addEventListener('pointermove', e => {
      if (!drag) return;
      const dy = e.clientY - drag.startY;
      drag.row.style.transform = `translateY(${dy}px) translateX(8px)`;
      const target = Math.max(0, Math.min(drag.rows.length - 1, drag.from + Math.round(dy / drag.h)));
      if (target === drag.target) return;
      drag.target = target;
      drag.rows.forEach((r, i) => { // 挤开空位：目标区间内的行反向平移一格
        if (r === drag.row) return;
        let off = 0;
        if (target > drag.from && i > drag.from && i <= target) off = -drag.h;
        else if (target < drag.from && i >= target && i < drag.from) off = drag.h;
        r.style.transform = off ? `translateY(${off}px)` : '';
      });
    });
    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', finish);
    list.addEventListener('lostpointercapture', finish);
    // 兜底：指针捕获失效（合成输入/个别设备）或拖出列表外松手时，pointerup 不冒泡到 list，
    // 没有 window 级收尾会卡死在拖动态（行悬空跟随）——window 上收一次，finish 内 drag 判空天然防重入
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
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

    // 洗车概率：未来两天取概率最高的一天，并带上日期口径（和提示条一致）
    const pops2 = d.precipitation_probability_max || [];
    let popDay = 0, precipProb24 = 0;
    for (let i = 0; i < Math.min(2, pops2.length); i++) {
      const v = Math.round(pops2[i] || 0);
      if (v > precipProb24) { precipProb24 = v; popDay = i; }
    }
    const dayNightDiff = Math.abs(d.temperature_2m_max[0] - d.temperature_2m_min[0]);

    const dress = Weather.clothing(feels, group === 'rain' || group === 'thunder' || group === 'snow');
    const trip = Weather.travel(group, wind, vis, feels);
    const uvI = Weather.uv(d.uv_index_max[0]);
    const wash = Weather.carWash(precipProb24, group, popDay);
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
    $('pillTemp').textContent = Math.round(SkyUnits.num(c.temperature_2m));
    $('pillIcon').innerHTML = Icons.svg(info.icon, 30); // 内置光芒旋转/雨滴下落/云朵浮动动画
    $('pillSub').textContent = `${lunar} · ${info.text}`;
  }
  function applyDockState(s) {
    document.body.classList.toggle('docked', !!s.docked);
    document.body.classList.toggle('expanded', !!s.expanded);
    if (s.docked && !s.expanded) renderPill();
    syncAnimationSuspend(); // 收起为小窗：粒子画布 + 昼夜地球逐帧循环一起挂起
    syncUiTimers();         // 收起态不看大窗，时钟/天空定时器同步停
    repairZeroSections(); // 收起/展开是「记住尺寸」清零的实测触发点，状态一变就自检
  }

  // 单个模块渲染失败不得连累整屏：逐模块隔离，坏数据只留空那一块
  function safeRender(name, fn) {
    try { fn(); } catch (e) { console.warn('[render] ' + name + ' 渲染失败，已隔离', e); }
  }
  function renderAll() {
    const d = state.data || {};
    safeRender('hero', renderHero);
    safeRender('minutely', renderMinutely);
    safeRender('hourly', renderHourly);
    safeRender('daily', renderDaily);
    safeRender('aqi', renderAQI);
    safeRender('life', renderLife);
    safeRender('pill', renderPill);
    safeRender('extra', () => { if (window.Extra) window.Extra.renderAll(d, state.settings, state.loc); });
    safeRender('sky', updateSky);
    safeRender('tray', updateTrayTemp);
    safeRender('globe', () => {
      if (window.Globe) Globe.update(state.loc, d.weather ? d.weather.daily : null);
    });
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

  /* ================= 主动推送（官方预警 + 天气突变） =================
     铁律：只在「新增 / 升级」时推、按签名+日期去重、每类每日限额，绝不刷屏。 */
  const LS = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  };
  const dayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const sigOf = s => { let h = 5381; s = String(s || ''); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h >>> 0); };
  const quota = (bucket, max) => {
    const k = 'pushQuota_' + bucket + '_' + dayKey();
    const n = Number(LS.get(k, 0)) || 0;
    if (n >= max) return false;
    LS.set(k, n + 1); return true;
  };
  const lvlNum = l => /红/.test(l || '') ? 4 : /橙/.test(l || '') ? 3 : /黄/.test(l || '') ? 2 : /蓝/.test(l || '') ? 1 : 0;
  function checkWeatherPush(data) {
    if (!state.settings || state.settings.weatherPush === false || !data || !data.weather) return;
    const w = data.weather, c = w.current || {};
    // ① 官方预警：以「类型+正文」为身份，只有新增或等级升级才推（降级/重复静默）
    const seenKey = 'offAlert_' + dayKey(), seen = LS.get(seenKey, {});
    let dirty = false;
    (Array.isArray(data.cnAlerts) ? data.cnAlerts : []).slice(0, 4).forEach(a => {
      const id = sigOf((a.type || '') + '|' + String(a.text || '').slice(0, 40));
      const lv = lvlNum(a.level);
      if (lv > (Number(seen[id]) || 0)) {
        if (quota('official', 3)) {
          const title = `云上晴雨 · ${a.type || '气象'}${a.level || ''}预警`;
          sky.notify(title.slice(0, 60), String(a.text || '请留意最新天气预警').slice(0, 300));
        }
        seen[id] = lv; dirty = true;
      } else if (lv < (Number(seen[id]) || 0)) {
        seen[id] = lv; dirty = true; // 降级记下来，将来再升级才会再推
      }
    });
    if (dirty) LS.set(seenKey, seen);
    // ② 天气突变：晴→雨雪雷 / 相邻两次刷新温差 ≥5°C；首次与换城只记快照不推
    const grp = Weather.codeInfo(Number(c.weather_code) || 0, computeIsDay(w, new Date())).group;
    const temp = Number(c.temperature_2m);
    const locKey = state.loc ? state.loc.lat + ',' + state.loc.lon : '';
    const prev = LS.get('wxSnapshot', null);
    LS.set('wxSnapshot', { locKey, grp, temp: Number.isFinite(temp) ? temp : null, ts: Date.now() });
    if (!prev || prev.locKey !== locKey || !Number.isFinite(temp)) return;
    const wet = grp === 'rain' || grp === 'snow' || grp === 'thunder';
    const wasWet = prev.grp === 'rain' || prev.grp === 'snow' || prev.grp === 'thunder';
    const city = (state.loc && state.loc.name) || '当前地点';
    if (wet && !wasWet && quota('change', 2)) {
      sky.notify('云上晴雨 · 天气突变', `${city}开始出现${grp === 'snow' ? '降雪' : grp === 'thunder' ? '雷雨' : '降雨'}，出门记得带伞`);
    } else if (Number.isFinite(prev.temp) && Math.abs(temp - prev.temp) >= 5 && quota('change', 2)) {
      sky.notify('云上晴雨 · 气温跳变', `${city}气温${temp > prev.temp ? '上升' : '下降'} ${Math.round(Math.abs(temp - prev.temp))}°C，注意增减衣物`);
    }
  }
  function updateTrayInfo() {
    if (!state.data || !state.data.weather || !state.data.weather.current) return;
    const w = state.data.weather, c = w.current;
    const info = Weather.codeInfo(Number(c.weather_code) || 0, computeIsDay(w, new Date()));
    const fu = state.fetchedAt || new Date();
    const text = `${SkyUnits.temp(c.temperature_2m)} ${info.text} · ${(state.loc && state.loc.name) || '天气'} · 更新 ${pad(fu.getHours())}:${pad(fu.getMinutes())}`;
    try { sky.trayInfo(text); } catch (e) { }
  }

  /* ================= 数据加载 ================= */
  let loadSeq = 0;   // 请求序号：丢弃过期响应（快速切换地点时旧地点数据不得覆盖新地点）
  async function loadWeather(force) {
    if (!state.loc) return;
    const nowMs = Date.now();
    // 失败指数退避（上限 5 分钟）+ 同秒双触发去重：定时刷新、恢复补刷、手动刷新可能撞在一起
    const gap = state.failCount ? Math.min(5 * 60 * 1000, 15000 * Math.pow(2, Math.min(state.failCount, 5))) : 2000;
    if (!force && nowMs - state.lastFetchTry < gap) return;
    state.lastFetchTry = nowMs;
    const seq = ++loadSeq;
    const res = await sky.fetchWeather(state.loc.lat, state.loc.lon, state.loc.name, state.loc.code);
    if (seq !== loadSeq) return; // 已有更新的请求在途/完成，本次响应过期作废
    if (res && res.error) {
      state.failCount = Math.min(state.failCount + 1, 6);
      $('condText').textContent = '网络异常';
      $('hourlySub').textContent = '正在自动重试，也可点右上角刷新';
      return;
    }
    if (res && res.stale) {
      // 全源失败但主进程留有上一份好数据：续用、不更新 fetchedAt（让「数据已过期」提示如实生效）
      state.failCount = Math.min(state.failCount + 1, 6);
      state.data = res;
      renderAll();
      return;
    }
    state.failCount = 0;
    state.data = res;
    state.fetchedAt = new Date();
    renderAll();
    checkWeatherPush(res);
    updateTrayInfo();
  }

  /* ================= 设置面板 ================= */
  function openPanel() {
    $('settingsPanel').classList.add('open');
    renderLocList();
  }
  function closePanel() { $('settingsPanel').classList.remove('open'); }

  // 地点变更串行化：并发 IPC 若各拿旧快照，会出现「丢地点 / 城市回退」
  let locQueue = Promise.resolve();
  function serializedLoc(fn) {
    const run = locQueue.then(fn, fn);
    locQueue = run.catch(() => {});
    return run;
  }

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
        const needSwitch = await serializedLoc(async () => {
          const oldActive = state.settings.activeId;
          const locs = (state.settings.locations || []).filter(l => l.id !== el.dataset.del);
          const nextId = oldActive === el.dataset.del ? (locs.length ? locs[0].id : null) : oldActive;
          state.settings = await sky.updateSettings({ locations: locs, activeId: nextId });
          renderLocList();
          return nextId !== oldActive ? nextId : null;
        });
        if (needSwitch) await switchLocation(needSwitch);
      });
    });
  }

  async function switchLocation(id) {
    return serializedLoc(async () => {
      const loc = (state.settings.locations || []).find(l => l.id === id);
      if (!loc) return;
      state.settings = await sky.updateSettings({ activeId: id });
      state.loc = loc;
      await loadWeather(true); // 换城必须立刻取数，不能被刷新去重窗口挡掉
      renderLocList();
      closePanel();
    });
  }

  async function addLocation(loc, isAuto) {
    return serializedLoc(async () => {
      const id = 'loc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const entry = Object.assign({ id }, loc, { auto: !!isAuto });
      let locs = (state.settings.locations || []).slice();
      if (isAuto) locs = locs.filter(l => !l.auto);   // 自动定位只保留一个
      locs.push(entry);
      state.settings = await sky.updateSettings({ locations: locs, activeId: id });
      state.loc = entry;
      await loadWeather(true); // 新增地点同样强制刷新
      renderLocList();
      closePanel();
    });
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
      await loadWeather(true); // 手动刷新跳过退避/去重
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
    // 单位切换：写盘后立即全量重绘（主窗 / 小窗 / 托盘 / 分享卡 / 扩展模块共用 SkyUnits）
    $('unitSelect').addEventListener('change', async e => {
      state.settings = await sky.updateSettings({ unit: e.target.value });
      renderAll();
      updateTrayInfo();
    });
    $('windUnitSelect').addEventListener('change', async e => {
      state.settings = await sky.updateSettings({ windUnit: e.target.value });
      renderAll();
    });
    // 本地键盘操作：无边框窗没有菜单栏，Esc/F5/Ctrl+,/Alt+←→ 都可不开鼠标完成
    document.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return; // IME 守卫
      if (e.key === 'Escape') {
        closePanel();
        if (e.target && e.target.blur) e.target.blur();
        return;
      }
      const tag = String((e.target && e.target.tagName) || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'r')) {
        e.preventDefault(); loadWeather(true); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openPanel(); return; }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const locs = (state.settings && state.settings.locations) || [];
        if (!locs.length) return;
        e.preventDefault();
        const i = locs.findIndex(l => l.id === (state.settings && state.settings.activeId));
        const next = locs[(i + (e.key === 'ArrowRight' ? 1 : -1) + locs.length) % locs.length];
        if (next) switchLocation(next.id);
      }
    });
    // 托盘右键：立即刷新 / 切换城市（窗口可能隐藏，直接后台执行）
    if (sky.onTrayAction) sky.onTrayAction(a => {
      if (!a) return;
      if (a.type === 'refresh') loadWeather(true);
      else if (a.type === 'switch' && a.id) switchLocation(a.id);
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
    $('chkPush').addEventListener('change', async e => {
      state.settings = await sky.updateSettings({ weatherPush: e.target.checked });
    });
    // 动效模式：system=跟随系统（默认）/ on=始终播放 / off=静止
    $('motionSelect').addEventListener('change', async e => {
      state.settings = await sky.updateSettings({ motion: e.target.value === 'off' ? 'off' : 'on' });
      applyMotion();
    });
    // 显示模块开关：隐藏即 display:none（长模块可关，论坛反馈采纳），默认全部显示
    for (const k of MOD_KEYS) {
      const chk = $('chkMod' + k.charAt(0).toUpperCase() + k.slice(1));
      if (!chk) continue;
      chk.addEventListener('change', async e => {
        const m = Object.assign({}, state.settings.modules || {}, { [k]: e.target.checked });
        state.settings = await sky.updateSettings({ modules: m });
        applyModules();
        if (window.Extra) window.Extra.renderAll(state.data, state.settings, state.loc); // 懒加载模块即时出数据
      });
    }

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

  let searchSeq = 0;
  async function doSearch() {
    const q = $('searchInput').value.trim();
    if (!q) return;
    const seq = ++searchSeq;
    $('searchResults').innerHTML = '<div class="s-item">搜索中…</div>';
    const res = await sky.geoSearch(q);
    if (seq !== searchSeq) return; // 连续搜索时旧关键词的迟到回包不得覆盖新结果
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

  /* UI 定时器（时钟 1s / 天空 60s）：隐藏到托盘、收起为小窗时全部停掉。
     此前两个 setInterval 无 id、无清理，后台仍每秒写 DOM、每分钟走完整主题链路。 */
  let clockTimer = null, skyTimer = null;
  function startUiTimers() {
    if (clockTimer == null) clockTimer = setInterval(tickClock, 1000);
    if (skyTimer == null) skyTimer = setInterval(updateSky, 60 * 1000);
  }
  function stopUiTimers() {
    if (clockTimer != null) { clearInterval(clockTimer); clockTimer = null; }
    if (skyTimer != null) { clearInterval(skyTimer); skyTimer = null; }
    clearTimeout(flipTimer); flipTimer = null;
  }
  function syncUiTimers() {
    // 只在「隐藏到托盘」时停：吸顶小窗虽然收起大窗，但 pill 上的时间/秒仍在显示，时钟不能冻住
    if (document.hidden) stopUiTimers();
    else {
      const wasStopped = clockTimer == null;
      startUiTimers();
      // 只在「从停止态恢复」时补一次主题翻转重排；悬停展收不该反复触发 paintSky
      if (wasStopped && state.data) updateSky();
    }
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
    syncUiTimers();
    syncAnimationSuspend();
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
    // 设置面板的 blur 挂在父级 .panel 上，滚动期必须同步关掉（与 el 同一 180ms 恢复节拍）
    const panel = el.classList.contains('panel-body') ? document.querySelector('.panel') : null;
    if (panel) {
      panel.classList.add('scrolling');
      clearTimeout(panel._scrollEndTimer);
      panel._scrollEndTimer = setTimeout(() => panel.classList.remove('scrolling'), 180);
    }
    clearTimeout(el._scrollEndTimer);
    el._scrollEndTimer = setTimeout(() => {
      el.classList.remove('scrolling');
      if (el.id === 'widget') repairZeroSections(); // 滚动停顿顺手自检 0 高卡死区块
    }, 180);
  }

  function initSmoothScroll(el) {
    if (!el) return;
    let target = el.scrollTop, animating = false, raf = 0, selfTop = -1, lastStep = 0;
    const EASE = 0.18;
    const maxTop = () => Math.max(0, el.scrollHeight - el.clientHeight);

    function step(now) {
      raf = 0;
      // rAF 被系统掐断（窗口遮挡/降频）再恢复时惯性上下文已过期：不能按冻结的旧 target 插值，
      // 否则会把视图拽回去。但「短暂掉帧」不能让这一格滚轮停在半路（实测曾只走 12px）：
      // 250ms~2s 内把目标一次落地；只有长时间挂起（窗口遮挡数分钟）才彻底放弃。
      if (lastStep && now - lastStep > 250) {
        const gap = now - lastStep;
        if (gap < 2000) {
          const safe = Math.min(Math.max(0, target), maxTop());
          selfTop = safe;
          el.scrollTop = safe;
        } else {
          target = el.scrollTop;
        }
        animating = false;
        return;
      }
      lastStep = now;
      if (target > maxTop()) target = maxTop();   // content-visibility 让 scrollHeight 动态变化，逐帧钳制
      const cur = el.scrollTop;
      const next = cur + (target - cur) * EASE;
      if (Math.abs(target - cur) < 0.6) {
        selfTop = target;
        el.scrollTop = target;
        animating = false;
        return;
      }
      selfTop = next;
      el.scrollTop = next;
      markScrolling(el);
      raf = requestAnimationFrame(step);
    }

    el.addEventListener('wheel', e => {
      if (e.ctrlKey) return;                        // Ctrl+滚轮缩放交还原生
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 横向手势（逐时横滑）不拦截
      e.preventDefault();
      // 行模式一格 3 行折算 120（与像素模式一格同权重）；页模式按 clientHeight
      const raw = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientHeight : 1);
      // 经典滚轮一格 = ±120px 直接跳太猛（用户反馈「一格跳很多距离」）：
      // 0.55 缩放 + 72px 封顶 → 一格 ~66px（约 3 行，贴近系统默认手感）；
      // 高精度触控板小 delta 线性缩放保跟手连续性；翻页模式不封顶
      const d = e.deltaMode === 2 ? raw * 0.85
        : Math.sign(raw) * Math.min(Math.abs(raw) * 0.55, 72);
      if (!animating) target = el.scrollTop;
      target = Math.min(maxTop(), Math.max(0, target + d));
      markScrolling(el);
      if (!animating) {
        animating = true; lastStep = 0;
        selfTop = el.scrollTop; // 认领当前位置：吸收起动前迟到的 scroll 事件，别误杀刚起步的动画
        raf = requestAnimationFrame(step);
      }
    }, { passive: false });

    // 外部滚动（脚本 / 滚动条拖动 / 键盘 / 查找定位）→ 取消惯性并接管目标，
    // 避免惯性循环把视图往旧 target 拽。只有 step 自己写入的 scroll 事件才放行。
    el.addEventListener('scroll', () => {
      if (animating && selfTop >= 0 && Math.abs(el.scrollTop - selfTop) < 1.5) { markScrolling(el); return; }
      animating = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      target = el.scrollTop;
      markScrolling(el);
    }, { passive: true });
  }

  /* ================= 鼠标拖拽平移（逐时预报 / 时辰吉凶横滑列表） =================
     按住左键直接左右拖内容（iOS 平移手感），松手按速度惯性滑行一小段；
     拖动后紧随的 click 会被吞掉，避免误触；拖动中禁文本/图片原生拖拽。 */
  function initDragScroll(el) {
    if (!el) return;
    let down = false, startX = 0, startY = 0, startLeft = 0, lastX = 0, lastT = 0, vel = 0, raf = 0, moved = false;

    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      // 点在滚动条（thumb/轨道）区：放行原生拖拽，别劫持（内容拖拽公式会把 thumb 拖反向）
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
      if (e.clientX - r.left - bl >= el.clientWidth || e.clientY - r.top - bt >= el.clientHeight) return;
      down = true; moved = false;
      startX = lastX = e.clientX; startY = e.clientY; startLeft = el.scrollLeft;
      lastT = performance.now(); vel = 0;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      el.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
      if (!down) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      if (Math.abs(e.clientY - startY) > Math.abs(dx)) return; // 竖拖为主：让位给页面纵向拖拽滚屏
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
      // 惯性滑行：按松手速度指数衰减（px/ms → 每帧位移）；停顿后松手不给陈旧速度的甩尾
      if (Math.abs(vel) > 0.12 && performance.now() - lastT < 80) {
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
    window.addEventListener('blur', () => { // 失焦兜底：拖动中切窗口松手不卡在拖动态
      if (!down) return;
      down = false;
      el.classList.remove('dragging');
    });
    el.addEventListener('dragstart', e => e.preventDefault()); // 内容不触发原生拖拽
  }

  /* ================= 鼠标纵向拖拽滚屏（滚动条隐藏后的沉浸式上下滚动） =================
     按住内容上下拖 = 内容 1:1 跟手，松手按速度惯性滑行一小段；
     方向锁：起步后判定主轴——横拖归横滑列表平移、竖拖归页面滚动，互不打架；
     .drag（拖窗体）、地球/进度条、表单控件、排序手柄等交互区豁免不启动。 */
  function initDragScrollY(el) {
    if (!el) return;
    let down = false, axis = '', startX = 0, startY = 0, startTop = 0, lastY = 0, lastT = 0, vel = 0, raf = 0, moved = false;
    const stopInertia = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      // 点在滚动条区：放行原生 thumb 拖拽
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
      if (e.clientX - r.left - bl >= el.clientWidth || e.clientY - r.top - bt >= el.clientHeight) return;
      const t = e.target;
      if (t.closest && t.closest('.drag, .mod-handle, #globeMount, #gBarWrap, input, textarea, select, button, a, label, [data-rscrub]')) return;
      down = true; axis = ''; moved = false;
      startX = e.clientX; startY = lastY = e.clientY; startTop = el.scrollTop;
      lastT = performance.now(); vel = 0;
      stopInertia();
    });
    window.addEventListener('mousemove', e => {
      if (!down) return;
      const dy = e.clientY - startY, dx = e.clientX - startX;
      if (!axis) {
        if (Math.abs(dy) < 5 && Math.abs(dx) < 5) return;
        axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      }
      if (axis !== 'y') return;
      e.preventDefault();
      if (Math.abs(dy) > 3) moved = true;
      el.scrollTop = startTop - dy; // 往下拖 = 内容跟手往下走
      const now = performance.now(), dt = now - lastT;
      if (dt > 0) { vel = (e.clientY - lastY) / dt; lastY = e.clientY; lastT = now; }
      markScrolling(el);
    });
    const end = () => {
      if (!down) return;
      down = false;
      if (moved) {
        // 拖动结束吞掉一次 click，避免松手处的项目被误点
        const kill = ev => { ev.stopPropagation(); ev.preventDefault(); };
        el.addEventListener('click', kill, { capture: true, once: true });
        setTimeout(() => el.removeEventListener('click', kill, true), 400);
      }
      // 惯性滑行：按松手速度指数衰减（px/ms → 每帧位移），与横滑列表同手感；
      // 停顿后松手不给陈旧速度的甩尾
      if (axis === 'y' && Math.abs(vel) > 0.12 && performance.now() - lastT < 80) {
        const step = () => {
          vel *= 0.94;
          el.scrollTop -= vel * 16;
          markScrolling(el);
          const edge = el.scrollTop <= 0 || el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
          if (Math.abs(vel) > 0.02 && !edge) raf = requestAnimationFrame(step);
          else raf = 0;
        };
        raf = requestAnimationFrame(step);
      }
    };
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);      // 失焦兜底，防止拖拽状态卡住
    el.addEventListener('wheel', stopInertia, { passive: true }); // 滚轮接管即停拖拽惯性，防两套滚动打架
    el.addEventListener('dragstart', e => e.preventDefault());   // 内容不触发原生拖拽
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
        sky.winDragEnd();                 // 先作废旧基准：上次拖拽若丢了 up，按旧基准续算会整窗回跳
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
    startUiTimers();

    state.settings = await sky.getSettings();
    // 推送去重键按日期滚动：启动清一次昨天的，避免 localStorage 长期堆积
    try {
      const tk = dayKey();
      Object.keys(localStorage)
        .filter(k => /^(pushQuota_|offAlert_|brief_)/.test(k) && k.indexOf(tk) === -1)
        .forEach(k => localStorage.removeItem(k));
    } catch (e) { }
    $('refreshSelect').value = String(state.settings.refreshMinutes || 10);
    $('unitSelect').value = state.settings.unit === 'f' ? 'f' : 'c';
    $('windUnitSelect').value = ['level', 'kmh', 'ms'].includes(state.settings.windUnit) ? state.settings.windUnit : 'level';
    $('chkTop').checked = !!state.settings.alwaysOnTop;
    $('chkAuto').checked = !!state.settings.autoLaunch;
    $('chkEdgeDock').checked = state.settings.edgeDock !== false;
    $('chkTrayTemp').checked = state.settings.trayTemp !== false;
    $('motionSelect').value = state.settings.motion === 'off' ? 'off' : 'on';
    applyMotion();
    $('chkBrief').checked = state.settings.brief !== false;
    $('chkPush').checked = state.settings.weatherPush !== false;
    for (const k of MOD_KEYS) {
      const chk = $('chkMod' + k.charAt(0).toUpperCase() + k.slice(1));
      if (chk) chk.checked = (state.settings.modules || {})[k] !== false;
    }
    applyModules();
    applyOrder();
    initModSort();
    if (window.Extra) { // 扩展模块回调注入：多城市点击切换主城市 / 跳设置面板
      window.Extra.hooks.switchLocation = switchLocation;
      window.Extra.hooks.openPanel = openPanel;
    }
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
    initDragScrollY($('widget'));
    initDragScrollY(document.querySelector('.panel-body'));

    // 昼夜地球（地点确定后初始化，数据回来后 renderAll 里持续更新）
    if (window.Globe) { Globe.init('globeMount'); Globe.update(state.loc); }

    // 天气
    await loadWeather();
    startRefreshTimer();
    // 断网重连立即补刷（跳过失败退避）；睡眠唤醒由 tickClock 的过期检查兜底
    window.addEventListener('online', () => loadWeather(true));
  }

  // 天空动画先跑起来（数据回来前也有氛围）
  FX.start(document.getElementById('fx'));
  updateSky();

  init().catch(e => {
    console.error(e);
    $('locText').textContent = '初始化失败，请重启插件';
  });
})();
