/* extra.js — 16 个扩展模块：实时增强(UV/花粉/风力/能见度) · 生活指数(穿衣/洗车/晾晒/感冒)
   日月气候(月相/历史对比/降水统计/气压) · 玩法效率(多城市/雷达/提醒/分享卡)
   性能约定：动效只走 transform/opacity（合成层），prefers-reduced-motion 全静止，
   离屏由 content-visibility:auto 跳过绘制；数据渲染为纯 innerHTML 替换，无定时重排。 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /* ===================== 指数引擎 ===================== */
  // 紫外线（WHO 分级）
  function uvLevel(u) {
    if (u < 3) return { lv: '低', tone: '', seg: 1, adv: '无需特殊防护' };
    if (u < 6) return { lv: '中等', tone: '', seg: 2, adv: '外出戴帽子，涂防晒霜' };
    if (u < 8) return { lv: '较强', tone: 'warn', seg: 3, adv: '减少暴晒，建议 SPF30+' };
    if (u < 11) return { lv: '很强', tone: 'bad', seg: 4, adv: '避免正午外出，务必防晒' };
    return { lv: '极强', tone: 'bad', seg: 5, adv: '尽量待在室内，强防护' };
  }
  // 花粉（粒/m³ 参考分级）
  function pollenLevel(v) {
    if (v < 10) return { lv: '低', tone: '', pct: 6 };
    if (v < 50) return { lv: '中等', tone: '', pct: 30 };
    if (v < 100) return { lv: '偏高', tone: 'warn', pct: 55 };
    if (v < 200) return { lv: '高', tone: 'warn', pct: 78 };
    return { lv: '很高', tone: 'bad', pct: 95 };
  }
  // 蒲福风力等级
  function beaufort(mps) {
    const t = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
    let b = 0; while (b < t.length && mps >= t[b]) b++;
    return b;
  }
  const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const dirName = deg => DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  // 能见度
  function visLevel(m) {
    const km = m / 1000;
    if (km >= 10) return { lv: '视野开阔', tone: '', seg: 1, km };
    if (km >= 4) return { lv: '轻雾', tone: '', seg: 2, km };
    if (km >= 1) return { lv: '雾', tone: 'warn', seg: 3, km };
    if (km >= 0.5) return { lv: '浓雾', tone: 'bad', seg: 4, km };
    return { lv: '强浓雾', tone: 'bad', seg: 5, km };
  }
  // 穿衣（按体感温度分档）
  const DRESS_TIERS = [
    { min: 26, name: '短袖', sub: '短袖 / 裙装', adv: '天气偏热，注意补水防晒' },
    { min: 18, name: '长袖', sub: '长袖 T 恤 / 薄裤', adv: '体感舒适，正常穿搭' },
    { min: 10, name: '薄外套', sub: '长袖 + 薄外套', adv: '早晚偏凉，随身备一件' },
    { min: 2, name: '大衣', sub: '毛衣 / 大衣', adv: '注意保暖，围巾手套可上场' },
    { min: -10, name: '羽绒', sub: '羽绒服 / 厚外套', adv: '天寒多穿，注意防风' },
    { min: -999, name: '厚羽绒', sub: '厚羽绒 + 保暖内搭', adv: '严寒天气，减少户外时间' }
  ];
  const dressIndex = t => DRESS_TIERS.find(x => t >= x.min) || DRESS_TIERS[DRESS_TIERS.length - 1];
  // 洗车（未来 24h 降水概率 + 雨量）
  function washIndex(w) {
    const h = w.hourly, now = hourIdx(h.time);
    let pop = 0, sum = 0;
    for (let i = now; i < Math.min(now + 24, h.time.length); i++) {
      pop = Math.max(pop, Number(h.precipitation_probability[i]) || 0);
      sum += Number(h.precipitation[i]) || 0;
    }
    const gust = Number(w.current.wind_gusts_10m) || 0;
    if (pop >= 60 || sum > 0.5) return { lv: '不宜', tone: 'bad', seg: 4, pop, sub: '未来 24h 有降水' };
    if (pop >= 40) return { lv: '不太适宜', tone: 'warn', seg: 3, pop, sub: '降水概率偏高' };
    if (pop >= 20) return { lv: '较适宜', tone: '', seg: 2, pop, sub: '可能有零星小雨' };
    return { lv: gust > 12 ? '较适宜' : '适宜', tone: '', seg: 3 - (gust > 12 ? 1 : 0), pop, sub: gust > 12 ? '风大易落灰' : '未来 24h 无降水' };
  }
  // 晾晒（降水概率 + 湿度 + 云量综合）
  function dryIndex(w) {
    const c = w.current, h = w.hourly, now = hourIdx(h.time);
    let pop = 0, hum = Number(c.relative_humidity_2m) || 0, cloud = Number(c.cloud_cover) || 0;
    for (let i = now; i < Math.min(now + 12, h.time.length); i++) pop = Math.max(pop, Number(h.precipitation_probability[i]) || 0);
    if (pop < 10 && hum < 65 && cloud < 50) return { lv: '极佳', tone: 'good', sub: '湿度 ' + Math.round(hum) + '% · 日照充足', seg: 4 };
    if (pop < 25 && hum < 78) return { lv: '较好', tone: 'good', sub: '湿度 ' + Math.round(hum) + '% · 适宜晾晒', seg: 3 };
    if (pop < 50) return { lv: '一般', tone: '', sub: '云量较多，晾干偏慢', seg: 2 };
    if (pop < 75) return { lv: '较差', tone: 'warn', sub: '可能有雨，室内晾', seg: 1 };
    return { lv: '不宜', tone: 'bad', sub: '有雨，别晾了', seg: 0 };
  }
  // 感冒（昼夜温差 + 湿度 + 低温）
  function coldIndex(w) {
    const d = w.daily;
    const hi = Number(d.temperature_2m_max[0]), lo = Number(d.temperature_2m_min[0]);
    const delta = hi - lo;
    const hum = Number(w.current.relative_humidity_2m) || 0;
    let score = 0;
    if (delta >= 12) score += 2; else if (delta >= 8) score += 1;
    if (hum >= 85) score += 2; else if (hum >= 70) score += 1;
    if (lo <= 0) score += 2; else if (lo <= 5) score += 1;
    const map = [{ lv: '低', tone: 'good' }, { lv: '较低', tone: 'good' }, { lv: '中等', tone: '' }, { lv: '较高', tone: 'warn' }, { lv: '高', tone: 'bad' }];
    const r = map[clamp(score, 0, 4)];
    return { lv: r.lv, tone: r.tone, seg: clamp(score, 0, 4), delta: Math.round(delta), lo: Math.round(lo), hi: Math.round(hi) };
  }
  // 月相（朔望月推算，精度 ±数小时，展示足够）
  function moonInfo(date) {
    const SYN = 29.530588853;
    const ref = Date.UTC(2000, 0, 6, 18, 14); // 已知新月时刻
    const age = (((date.getTime() - ref) / 864e5) % SYN + SYN) % SYN;
    const illum = (1 - Math.cos(2 * Math.PI * age / SYN)) / 2;
    let name;
    if (age < 1.85 || age >= 27.6) name = '新月';
    else if (age < 5.53) name = '娥眉月';
    else if (age < 9.2) name = '上弦月';
    else if (age < 12.88) name = '盈凸月';
    else if (age < 16.55) name = '满月';
    else if (age < 20.2) name = '亏凸月';
    else if (age < 23.9) name = '下弦月';
    else name = '残月';
    return { age, illum, name, waxing: age < SYN / 2 };
  }
  // 找当前小时在 hourly.time 的下标
  function hourIdx(times) {
    if (!times || !times.length) return 0;
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:00`;
    const i = times.indexOf(key);
    if (i >= 0) return i;
    for (let k = 0; k < times.length; k++) if (times[k] >= key) return Math.max(0, k - 1);
    return times.length - 1;
  }

  /* ===================== 图标（内联 SVG，随卡片轻动画） ===================== */
  const ICO = {
    sun: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="#BA7517"/><g stroke="#BA7517" stroke-width="1.5" stroke-linecap="round"><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4"/></g></svg>',
    flower: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" class="ico-sway"><circle cx="10" cy="10" r="2.4" fill="#BA7517"/><g fill="#97C459"><circle cx="10" cy="4.2" r="2.1"/><circle cx="15.5" cy="8.2" r="2.1"/><circle cx="13.4" cy="14.8" r="2.1"/><circle cx="6.6" cy="14.8" r="2.1"/><circle cx="4.5" cy="8.2" r="2.1"/></g></svg>',
    wind: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="#378ADD" stroke-width="1.5"/><path d="M10 4.5L12 11L10 9.8L8 11Z" fill="#185FA5"/><circle cx="10" cy="10" r="1.2" fill="#185FA5"/></svg>',
    eye: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10Q10 4 18 10Q10 16 2 10Z" fill="none" stroke="#378ADD" stroke-width="1.5"/><circle cx="10" cy="10" r="2.6" fill="#185FA5"/></svg>',
    shirt: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" class="ico-sway2"><path d="M7 3L10 5L13 3L17 6L15 8.5V17H5V8.5L3 6Z" fill="#CECBF6" stroke="#534AB7" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    car: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="8" width="15" height="6" rx="2" fill="#B5D4F4" stroke="#185FA5" stroke-width="1.2"/><path d="M5.5 8L7.5 4.8H12.5L14.5 8" fill="none" stroke="#185FA5" stroke-width="1.2"/><circle cx="6.5" cy="15.2" r="1.8" fill="#185FA5"/><circle cx="13.5" cy="15.2" r="1.8" fill="#185FA5"/></svg>',
    hanger: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4V6" stroke="#BA7517" stroke-width="1.4" stroke-linecap="round"/><circle cx="10" cy="3.2" r="1.2" fill="none" stroke="#BA7517" stroke-width="1.2"/><path d="M3 12L10 7L17 12" fill="none" stroke="#BA7517" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12H17" stroke="#BA7517" stroke-width="1.4" stroke-linecap="round"/></svg>',
    thermo: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="8.2" y="3" width="3.6" height="9.4" rx="1.8" fill="#F5C4B3" stroke="#993C1D" stroke-width="1.2"/><circle cx="10" cy="14.2" r="2.8" fill="#D85A30" class="ico-pulse"/><rect x="9.2" y="6" width="1.6" height="5.4" fill="#D85A30"/></svg>',
    moon: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="#CECBF6"/><circle cx="6.8" cy="8.4" r="5.6" fill="#F0EFFC"/></svg>',
    bars: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="11" width="3.4" height="6" fill="#9FE1CB"/><rect x="8.3" y="7" width="3.4" height="10" fill="#1D9E75"/><rect x="13.6" y="4" width="3.4" height="13" fill="#0F6E56"/></svg>',
    drop: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3C10 3 5 9 5 12.2A5 5 0 0 0 15 12.2C15 9 10 3 10 3Z" fill="#B5D4F4" stroke="#185FA5" stroke-width="1.2"/></svg>',
    gauge: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 14A7.5 7.5 0 0 1 17 14" fill="none" stroke="#1D9E75" stroke-width="1.5" stroke-linecap="round"/><path d="M10 14L13.4 8.6" stroke="#0F6E56" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="14" r="1.4" fill="#0F6E56"/></svg>',
    city: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="7" width="6" height="10" fill="#B5D4F4" stroke="#185FA5" stroke-width="1.1"/><rect x="11" y="4" width="6" height="13" fill="#85B7EB" stroke="#185FA5" stroke-width="1.1"/><g fill="#185FA5"><rect x="5" y="9.2" width="1.6" height="1.6"/><rect x="5" y="12.2" width="1.6" height="1.6"/><rect x="13" y="6.2" width="1.6" height="1.6"/><rect x="13" y="9.2" width="1.6" height="1.6"/><rect x="13" y="12.2" width="1.6" height="1.6"/></g></svg>',
    radar: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2" fill="none" stroke="#639922" stroke-width="1.2"/><circle cx="10" cy="10" r="3.8" fill="none" stroke="#97C459" stroke-width="1.2"/><circle cx="10" cy="10" r="1.4" fill="#3B6D11"/><path d="M10 10L15 5.6" stroke="#3B6D11" stroke-width="1.3" stroke-linecap="round"/></svg>',
    bell: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" class="ico-swing"><path d="M10 3.2C7.4 3.2 5.6 5.2 5.6 8L5.6 12L4 14H16L14.4 12L14.4 8C14.4 5.2 12.6 3.2 10 3.2Z" fill="#FAC775" stroke="#BA7517" stroke-width="1.2" stroke-linejoin="round"/><circle cx="10" cy="16.2" r="1.7" fill="#BA7517"/></svg>',
    image: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" class="ico-bob"><rect x="3" y="4" width="14" height="12" rx="2" fill="#F4C0D1" stroke="#993556" stroke-width="1.2"/><circle cx="7.2" cy="8" r="1.5" fill="#993556"/><path d="M5 14L8.8 10L11.2 12.4L13.2 10.6L15 14Z" fill="#993556"/></svg>'
  };
  const segBar = (seg, n, cls) => `<div class="x-segs ${cls || ''}">` +
    Array.from({ length: n }, (_, i) => `<i class="${i < seg ? 'on s' + (i + 1) : ''}"></i>`).join('') + '</div>';
  const badge = (txt, tone) => tone === '' ? `<span class="x-badge">${esc(txt)}</span>` : `<span class="x-badge ${tone}">${esc(txt)}</span>`;

  /* ===================== 批1：实时天气增强 ===================== */
  function renderReal(w, air) {
    // — 紫外线 —
    const h = w.hourly, now = hourIdx(h.time);
    const uvNow = Number(h.uv_index && h.uv_index[now]) || Number(w.daily.uv_index_max[0]) || 0;
    const uvMax = Number(w.daily.uv_index_max[0]) || uvNow;
    const u = uvLevel(uvMax);
    const uvEl = $('modUv');
    if (uvEl) {
      uvEl.querySelector('.x-body').innerHTML =
        `<div class="x-val">${Math.round(uvMax)}</div>` +
        `<div class="x-sub">UV 指数 · 现在 ${Math.round(uvNow)} · 今日峰值</div>` +
        segBar(u.seg, 5, 'x-uv-segs') +
        `<div class="x-adv">${esc(u.adv)}</div>`;
      uvEl.querySelector('.x-badge-slot').innerHTML = badge(u.lv, u.tone);
    }
    // — 花粉 —
    const polEl = $('modPollen');
    if (polEl) {
      const ah = air && air.hourly;
      let vals = [];
      if (ah && ah.birch_pollen) {
        const pi = hourIdx(ah.time);
        vals = [
          ['桦树花粉', Number(ah.birch_pollen[pi]) || 0],
          ['草花粉', Number(ah.grass_pollen[pi]) || 0],
          ['豚草花粉', Number(ah.ragweed_pollen[pi]) || 0]
        ];
      }
      const worst = vals.length ? vals.reduce((a, b) => b[1] > a[1] ? b : a) : null;
      const wl = worst ? pollenLevel(worst[1]) : null;
      polEl.querySelector('.x-body').innerHTML = vals.length ? (
        vals.map(([nm, v]) => {
          const l = pollenLevel(v);
          return `<div class="x-prow"><span>${nm}</span><span class="x-plv">${l.lv}</span></div>` +
            `<div class="x-track"><i class="fill ${l.tone}" style="width:${l.pct}%"></i></div>`;
        }).join('') +
        `<div class="x-adv">${wl && wl.tone ? '过敏人群外出建议戴口罩' : '花粉浓度不高，可放心活动'}</div>`
      ) : '<div class="x-adv">花粉数据暂不可用</div>';
      polEl.querySelector('.x-badge-slot').innerHTML = wl ? badge(worst[0].slice(0, 2) + ' ' + wl.lv, wl.tone) : badge('数据缺失', '');
    }
    // — 风力罗盘 —
    const wdEl = $('modWind');
    if (wdEl) {
      const spd = Number(w.current.wind_speed_10m) || 0;
      const gust = Number(w.current.wind_gusts_10m) || 0;
      const deg = Number(w.current.wind_direction_10m) || 0;
      const bft = beaufort(spd);
      wdEl.querySelector('.x-body').innerHTML =
        `<div class="x-wind-wrap"><div class="x-compass"><svg viewBox="0 0 76 76" aria-hidden="true">
          <circle cx="38" cy="38" r="32" class="xc-face"/>
          <g class="xc-tick"><path d="M38 10v5M38 66v5M10 38h5M66 38h5"/></g>
          <g class="xc-lab"><text x="38" y="9">N</text><text x="38" y="73">S</text><text x="71" y="41">E</text><text x="5" y="41">W</text></g>
          <g class="xc-needle" style="transform:rotate(${deg}deg)"><path d="M38 14L43.5 34L38 29.6L32.5 34Z"/><rect x="37" y="29" width="2" height="26"/></g>
        </svg></div>
        <div><div class="x-val">${spd.toFixed(1)}<span class="x-unit"> m/s</span></div>
        <div class="x-sub">${dirName(deg)}风 · 阵风 ${gust.toFixed(1)} · ${bft} 级</div></div></div>` +
        `<div class="x-adv">${bft <= 3 ? '风力平稳，适合开窗通风' : bft <= 5 ? '风力适中，注意高空坠物' : '风力较强，出行注意防风'}</div>`;
      wdEl.querySelector('.x-badge-slot').innerHTML = badge(bft + ' 级', bft >= 6 ? 'warn' : '');
    }
    // — 能见度 —
    const vsEl = $('modVisib');
    if (vsEl) {
      const raw = Number(w.current.visibility != null ? w.current.visibility : (h.visibility && h.visibility[now])) || 10000;
      const v = visLevel(raw);
      vsEl.querySelector('.x-body').innerHTML =
        `<div class="x-val">${v.km >= 1 ? v.km.toFixed(1) : (v.km * 1000).toFixed(0)}<span class="x-unit"> ${v.km >= 1 ? 'km' : 'm'}</span></div>` +
        `<div class="x-sub">${v.lv}</div>` +
        segBar(v.seg, 5, 'x-vis-segs') +
        `<div class="x-adv">${v.km >= 10 ? '视野开阔，正常出行' : v.km >= 4 ? '略有薄雾，驾驶注意车距' : '能见度低，减速慢行'}</div>`;
      vsEl.querySelector('.x-badge-slot').innerHTML = badge(v.lv, v.tone);
    }
  }

  /* ===================== 批2：生活指数 ===================== */
  function renderLife4(w) {
    const c = w.current;
    const feels = Number(c.apparent_temperature != null ? c.apparent_temperature : c.temperature_2m) || 0;
    // 穿衣
    const dr = dressIndex(feels);
    const dEl = $('modDress');
    if (dEl) {
      const chips = ['短袖', '长袖', '薄外套', '大衣', '羽绒'];
      dEl.querySelector('.x-body').innerHTML =
        `<div class="x-val">${dr.name}</div><div class="x-sub">${esc(dr.sub)} · 体感 ${Math.round(feels)}°</div>` +
        `<div class="x-chips">${chips.map(nm => `<i class="${nm === dr.name ? 'on' : ''}">${nm}</i>`).join('')}</div>` +
        `<div class="x-adv">${esc(dr.adv)}</div>`;
      dEl.querySelector('.x-badge-slot').innerHTML = badge(Math.round(feels) + '°', '');
    }
    // 洗车
    const ws = washIndex(w);
    const wEl = $('modCarwash');
    if (wEl) {
      wEl.querySelector('.x-body').innerHTML =
        `<div class="x-val">${ws.lv}洗车</div><div class="x-sub">${esc(ws.sub)}</div>` +
        segBar(ws.seg, 4, 'x-wash-segs') +
        `<div class="x-adv">降水概率 ${Math.round(ws.pop)}%（未来 24h）</div>`;
      wEl.querySelector('.x-badge-slot').innerHTML = badge(ws.lv, ws.tone);
    }
    // 晾晒
    const dy = dryIndex(w);
    const yEl = $('modDry');
    if (yEl) {
      yEl.querySelector('.x-body').innerHTML =
        `<div class="x-val">${dy.lv}</div><div class="x-sub">${esc(dy.sub)}</div>` +
        segBar(dy.seg, 4, 'x-dry-segs') +
        `<div class="x-adv">${dy.seg >= 3 ? '衣物快干，放心晾' : dy.seg >= 2 ? '晾干偏慢，可放通风处' : '建议室内晾晒'}</div>`;
      yEl.querySelector('.x-badge-slot').innerHTML = badge(dy.lv, dy.tone);
    }
    // 感冒
    const cd = coldIndex(w);
    const cEl = $('modCold');
    if (cEl) {
      cEl.querySelector('.x-body').innerHTML =
        `<div class="x-val">${cd.lv}</div><div class="x-sub">昼夜温差 ${cd.delta}° · ${cd.lo}°~${cd.hi}°</div>` +
        segBar(cd.seg + 1, 5, 'x-cold-segs') +
        `<div class="x-adv">${cd.seg >= 2 ? '温差较大，注意增减衣物' : '感冒风险不高，正常作息'}</div>`;
      cEl.querySelector('.x-badge-slot').innerHTML = badge('风险' + cd.lv, cd.tone);
    }
  }

  /* ===================== 批3：日月与气候 ===================== */
  // 历史气候缓存（渲染层留一份，archive IPC 主进程也有 24h 缓存）
  let archiveData = null;
  async function ensureArchive(loc) {
    if (archiveData || !loc) return archiveData;
    archiveData = await sky.fetchArchive(loc.lat, loc.lon);
    return archiveData;
  }
  function renderMoon() {
    const el = $('modMoon');
    if (!el) return;
    const now = new Date();
    const m = moonInfo(now);
    const w = (window.__extraWeather && window.__extraWeather.daily) || null;
    let sunRow = '';
    if (w && w.sunrise && w.sunrise[0]) {
      const sr = String(w.sunrise[0]).slice(11, 16), ss = String(w.sunset[0]).slice(11, 16);
      const toMin = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
      const pos = clamp((now.getHours() * 60 + now.getMinutes() - toMin(sr)) / Math.max(1, toMin(ss) - toMin(sr)), 0, 1);
      sunRow = `<div class="x-suntrack"><i style="left:${(pos * 100).toFixed(1)}%"></i></div>
        <div class="x-sub x-spaced"><span>日出 ${sr}</span><span>现在 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}</span><span>日落 ${ss}</span></div>`;
    }
    // 农历日（lunar.js 提供 Lunar 可用则显示）
    let lunarTxt = '';
    try {
      if (window.Lunar && window.Lunar.fromDate) {
        const ld = window.Lunar.fromDate(now);
        lunarTxt = '农历' + ld.getMonthInChinese() + '月' + ld.getDayInChinese();
      }
    } catch (e) { }
    el.querySelector('.x-body').innerHTML =
      `<div class="x-moon-wrap"><svg viewBox="0 0 64 64" class="x-moonball" aria-hidden="true">
        <defs><mask id="xm-k"><rect width="64" height="64" fill="#fff"/><circle cx="${m.waxing ? 21 : 43}" cy="27" r="17" fill="#000"/></mask></defs>
        <circle cx="32" cy="32" r="30" class="xm-halo"/><circle cx="32" cy="32" r="21" class="xm-disc" mask="url(#xm-k)"/></svg>
        <div><div class="x-val">${m.name}</div><div class="x-sub">月面亮度 ${Math.round(m.illum * 100)}%${lunarTxt ? ' · ' + lunarTxt : ''}</div></div></div>` +
      sunRow;
  }
  function renderHistory() {
    const el = $('modHistory');
    if (!el) return;
    const body = el.querySelector('.x-body');
    const w = window.__extraWeather;
    if (!archiveData || !archiveData.hist || !w) {
      body.innerHTML = '<div class="x-adv">历史气候数据加载中…</div>';
      return;
    }
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const hd = archiveData.hist.daily || {};
    const times = hd.time || [], means = hd.temperature_2m_mean || [];
    const same = [];
    let lastYear = null;
    for (let i = 0; i < times.length; i++) {
      if (String(times[i]).slice(5) === mmdd && means[i] != null) {
        const yr = Number(String(times[i]).slice(0, 4));
        same.push(Number(means[i]));
        if (yr === now.getFullYear() - 1) lastYear = Number(means[i]);
      }
    }
    const avg = same.length ? same.reduce((a, b) => a + b, 0) / same.length : null;
    const todayMean = (Number(w.daily.temperature_2m_max[0]) + Number(w.daily.temperature_2m_min[0])) / 2;
    if (avg == null) {
      body.innerHTML = '<div class="x-adv">历史数据不足，换个大点的城市试试</div>';
      return;
    }
    const diff = todayMean - avg;
    const tone = diff >= 2 ? 'warn' : diff <= -2 ? 'info' : '';
    const label = Math.abs(diff) < 1 ? '与常年持平' : (diff > 0 ? '偏暖 ' : '偏冷 ') + Math.abs(diff).toFixed(0) + '°';
    el.querySelector('.x-badge-slot').innerHTML = badge(label, tone);
    body.innerHTML =
      `<div class="x-3col">
        <div><small>今天</small><b>${todayMean.toFixed(0)}°</b><i class="grow" style="height:${clamp(4 + todayMean, 3, 22)}px"></i></div>
        <div><small>常年同期</small><b>${avg.toFixed(0)}°</b><i class="grow mid" style="height:${clamp(4 + avg, 3, 22)}px"></i></div>
        <div><small>去年今天</small><b>${lastYear != null ? lastYear.toFixed(0) + '°' : '--'}</b><i class="grow" style="height:${clamp(4 + (lastYear || 0), 3, 22)}px"></i></div>
      </div>
      <div class="x-adv">近 ${same.length} 年同日均温 ${avg.toFixed(1)}°</div>`;
  }
  function renderPrecipStat() {
    const el = $('modPrecipstat');
    if (!el) return;
    const body = el.querySelector('.x-body');
    const w = window.__extraWeather;
    if (!archiveData || !archiveData.recent || !w) {
      body.innerHTML = '<div class="x-adv">降水统计加载中…</div>';
      return;
    }
    const rd = archiveData.recent.daily || {};
    const rTimes = rd.time || [], rSum = rd.precipitation_sum || [];
    // 近 7 天 = archive 尾 6 天 + 今天（预报实况）
    const days = [];
    for (let i = Math.max(0, rTimes.length - 6); i < rTimes.length; i++) days.push({ t: String(rTimes[i]), v: Number(rSum[i]) || 0 });
    days.push({ t: 'today', v: Number(w.daily.precipitation_sum[0]) || 0 });
    // 本月 = archive 近 29 天 + 今天
    let monthSum = Number(w.daily.precipitation_sum[0]) || 0, monthDays = monthSum >= 0.1 ? 1 : 0;
    for (let i = Math.max(0, rTimes.length - 29); i < rTimes.length; i++) {
      const v = Number(rSum[i]) || 0;
      monthSum += v;
      if (v >= 0.1) monthDays++;
    }
    const weekSum = days.reduce((a, b) => a + b.v, 0);
    const weekDays = days.filter(d => d.v >= 0.1).length;
    const maxV = Math.max(1, ...days.map(d => d.v));
    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    body.innerHTML =
      `<div class="x-bars">${days.map(d => {
        const nm = d.t === 'today' ? '今' : WD[new Date(d.t + 'T00:00').getDay()];
        const hpx = Math.round(d.v / maxV * 34);
        return `<div class="x-bcol"><i class="${d.v > 0 ? 'wet' : ''}" style="height:${Math.max(2, hpx)}px"></i><span>${nm}</span></div>`;
      }).join('')}</div>
      <div class="x-2col"><span>本周降水 <b>${weekDays}</b> 天 · 累计 <b>${weekSum.toFixed(0)}mm</b></span><span>本月 <b>${monthDays}</b> 天 · <b>${monthSum.toFixed(0)}mm</b></span></div>`;
  }
  function renderPressure() {
    const el = $('modPressure');
    if (!el) return;
    const w = window.__extraWeather;
    const body = el.querySelector('.x-body');
    if (!w || !w.hourly || !w.hourly.pressure_msl) {
      body.innerHTML = '<div class="x-adv">气压数据加载中…</div>';
      return;
    }
    const h = w.hourly, now = hourIdx(h.time);
    const from = Math.max(0, now - 12), to = Math.min(h.time.length, now + 12);
    const seg = [];
    for (let i = from; i < to; i++) seg.push(Number(h.pressure_msl[i]));
    const cur = Number(w.current.pressure_msl) || seg[seg.length - 1] || 0;
    const prev = Number(h.pressure_msl[Math.max(0, now - 3)]) || cur;
    const d3 = cur - prev;
    const mn = Math.min(...seg), mx = Math.max(...seg);
    const span = Math.max(1, mx - mn);
    const pts = seg.map((v, i) => `${(i / (seg.length - 1) * 240).toFixed(1)},${(46 - (v - mn) / span * 36).toFixed(1)}`).join(' ');
    const area = `0,56 ${pts} 240,56`;
    const trend = d3 >= 1 ? { lv: '上升', tone: 'good', txt: '气压回升，未来转晴趋势' } :
      d3 <= -1 ? { lv: '下降', tone: 'warn', txt: '气压走低，可能转阴雨' } :
        { lv: '平稳', tone: '', txt: '气压平稳，天气维持' };
    el.querySelector('.x-badge-slot').innerHTML = badge(trend.lv, trend.tone);
    body.innerHTML =
      `<div class="x-2col x-base"><b class="x-num">${cur.toFixed(0)}</b><span>hPa · 3h ${d3 >= 0 ? '+' : ''}${d3.toFixed(1)}</span></div>
      <svg viewBox="0 0 240 56" class="x-spark" aria-hidden="true"><polygon points="${area}" class="xs-area"/><polyline points="${pts}" class="xs-line"/></svg>
      <div class="x-adv">${trend.txt}</div>`;
  }

  /* ===================== 批4：玩法与效率 ===================== */
  // — 多城市（复用「我的地点」收藏，点击切换主城市） —
  const cityCache = {}; // id -> {t, code, isDay, ts}
  async function refreshCities() {
    const locs = (window.__extraSettings && window.__extraSettings.locations) || [];
    const jobs = locs.slice(0, 8).map(async l => {
      if (cityCache[l.id] && Date.now() - cityCache[l.id].ts < 10 * 60 * 1000) return;
      const r = await sky.cityCurrent(l.lat, l.lon);
      if (r && r.current) cityCache[l.id] = {
        t: Math.round(Number(r.current.temperature_2m)),
        code: Number(r.current.weather_code), isDay: Number(r.current.is_day) !== 0, ts: Date.now()
      };
    });
    await Promise.all(jobs);
    renderCities();
  }
  function condMini(code) {
    if (code == null) return { txt: '--', cls: '' };
    if (code === 0) return { txt: '晴', cls: 'c-sun' };
    if (code <= 2) return { txt: '多云', cls: 'c-cloud' };
    if (code === 3) return { txt: '阴', cls: 'c-cloud' };
    if (code <= 48) return { txt: '雾', cls: 'c-fog' };
    if (code <= 57) return { txt: '毛毛雨', cls: 'c-rain' };
    if (code <= 65) return { txt: '雨', cls: 'c-rain' };
    if (code <= 67) return { txt: '冻雨', cls: 'c-rain' };
    if (code <= 77) return { txt: '雪', cls: 'c-snow' };
    if (code <= 82) return { txt: '阵雨', cls: 'c-rain' };
    return { txt: '雷雨', cls: 'c-storm' };
  }
  function renderCities() {
    const el = $('modCities');
    if (!el) return;
    const body = el.querySelector('.x-body');
    const st = window.__extraSettings || {};
    const locs = st.locations || [];
    if (!locs.length) {
      body.innerHTML = '<div class="x-adv">还没有保存的地点，去设置里添加</div>';
      return;
    }
    body.innerHTML = locs.slice(0, 8).map(l => {
      const cc = cityCache[l.id];
      const cm = condMini(cc && cc.code);
      return `<div class="x-cityrow ${l.id === st.activeId ? 'on' : ''}" data-cid="${esc(l.id)}">
        <i class="x-chip ${cm.cls}">${cc && cc.isDay === false ? '☾' : ''}</i>
        <span class="x-cname">${esc(l.name)}</span>
        <span class="x-ccond">${cm.txt}</span>
        <b>${cc ? cc.t + '°' : '--'}</b></div>`;
    }).join('') + `<div class="x-addrow" data-addcity>＋ 添加城市（设置面板）</div>`;
    body.querySelectorAll('[data-cid]').forEach(r => {
      r.addEventListener('click', () => {
        const id = r.getAttribute('data-cid');
        if (window.Extra.hooks && window.Extra.hooks.switchLocation) window.Extra.hooks.switchLocation(id);
      });
    });
    const add = body.querySelector('[data-addcity]');
    if (add) add.addEventListener('click', () => {
      if (window.Extra.hooks && window.Extra.hooks.openPanel) window.Extra.hooks.openPanel();
    });
  }
  // — 降水雷达（RainViewer 瓦片：帧循环用 opacity 切换，零重绘） —
  const radar = { frames: null, imgs: [], timer: null, idx: 0, z: 6 };
  function tileXY(lat, lon, z) {
    const n = Math.pow(2, z);
    const x = Math.floor((lon + 180) / 360 * n);
    const la = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n);
    return { x, y };
  }
  async function ensureRadar(loc) {
    if (radar.frames || !loc) return;
    const meta = await sky.radarFrames();
    if (!meta) { renderRadar(null, loc); return; }
    radar.frames = meta;
    renderRadar(meta, loc);
  }
  function renderRadar(meta, loc) {
    const el = $('modRadar');
    if (!el) return;
    const body = el.querySelector('.x-body');
    if (radar.timer) { clearInterval(radar.timer); radar.timer = null; }
    if (!meta || !meta.past || !meta.past.length || !loc) {
      body.innerHTML = '<div class="x-adv">降水雷达暂不可用（网络或服务限制）</div>';
      return;
    }
    const z = radar.z, t = tileXY(loc.lat, loc.lon, z);
    const all = meta.past.concat(meta.nowcast || []);
    const layers = all.map((f, i) => {
      const tiles = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        tiles.push(`<img src="${meta.host}${f.path}/256/${z}/${t.x + dx}/${t.y + dy}/4/1_1.png" alt="" class="x-rtile" style="left:${(dx + 1) * 256}px;top:${(dy + 1) * 256}px">`);
      }
      return `<div class="x-rlayer" data-fi="${i}">${tiles.join('')}</div>`;
    }).join('');
    const lastTime = new Date((meta.past[meta.past.length - 1].time || 0) * 1000);
    const hh = String(lastTime.getHours()).padStart(2, '0'), mm2 = String(lastTime.getMinutes()).padStart(2, '0');
    body.innerHTML =
      `<div class="x-radar-view"><div class="x-radar-move">${layers}</div>
        <i class="x-radar-ring r1"></i><i class="x-radar-ring r2"></i><i class="x-radar-ring r3"></i>
        <i class="x-radar-me"></i></div>
      <div class="x-adv">回波帧 ${hh}:${mm2} · ${all.length} 帧循环（含外推）</div>`;
    const layerEls = [...body.querySelectorAll('.x-rlayer')];
    layerEls.forEach((l, i) => { l.style.opacity = i === layerEls.length - 1 ? 1 : 0; });
    radar.idx = layerEls.length - 1;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && layerEls.length > 1) {
      radar.timer = setInterval(() => {
        layerEls[radar.idx].style.opacity = 0;
        radar.idx = (radar.idx + 1) % layerEls.length;
        layerEls[radar.idx].style.opacity = 1;
      }, 900);
    }
  }
  // — 自定义提醒（规则引擎：模板内置，每条 6h 冷却防轰炸） —
  const ALERT_TPL = [
    { id: 'tpl_rain', type: 'rain', threshold: 0.1, lead: 60, enabled: true, label: '降雨前提醒带伞' },
    { id: 'tpl_cold', type: 'tempBelow', threshold: 10, lead: 0, enabled: true, label: '气温跌破 10° 提醒加衣' },
    { id: 'tpl_uv', type: 'uv', threshold: 6, lead: 0, enabled: true, label: '紫外线过强提醒防晒' },
    { id: 'tpl_wind', type: 'wind', threshold: 10, lead: 0, enabled: true, label: '大风提醒收衣物' }
  ];
  const alertFired = {}; // id -> ts
  function alertsList() {
    const st = window.__extraSettings || {};
    return Array.isArray(st.alerts) && st.alerts.length ? st.alerts : ALERT_TPL;
  }
  function renderAlerts() {
    const el = $('modAlerts');
    if (!el) return;
    const body = el.querySelector('.x-body');
    const list = alertsList();
    body.innerHTML = list.map((a2, i) => {
      const desc = alertDesc(a2);
      return `<div class="x-alertrow">
        <span class="x-switch ${a2.enabled ? 'on' : ''}" data-alert="${i}"><i></i></span>
        <div><b>${esc(a2.label || desc)}</b><small>${esc(desc)}</small></div></div>`;
    }).join('') + `<div class="x-addrow" data-alertadd>＋ 新建提醒规则</div>`;
    body.querySelectorAll('[data-alert]').forEach(sw => {
      sw.addEventListener('click', async () => {
        const i = Number(sw.getAttribute('data-alert'));
        const list2 = alertsList().map(x => Object.assign({}, x));
        list2[i].enabled = !list2[i].enabled;
        window.__extraSettings = await sky.updateSettings({ alerts: list2 });
        renderAlerts();
      });
    });
    const add = body.querySelector('[data-alertadd]');
    if (add) add.addEventListener('click', async () => {
      const list2 = alertsList().map(x => Object.assign({}, x));
      const types = ['rain', 'tempBelow', 'tempAbove', 'uv', 'wind'];
      const t = types[list2.length % types.length];
      list2.push({ id: 'a' + Date.now(), type: t, threshold: t === 'tempAbove' ? 30 : t === 'tempBelow' ? 5 : t === 'uv' ? 6 : t === 'wind' ? 10 : 0.1, lead: t === 'rain' ? 60 : 0, enabled: true, label: '自定义规则 ' + (list2.length + 1) });
      window.__extraSettings = await sky.updateSettings({ alerts: list2.slice(0, 24) });
      renderAlerts();
    });
  }
  function alertDesc(a2) {
    switch (a2.type) {
      case 'rain': return '未来 ' + (a2.lead || 60) + ' 分钟内有雨时通知';
      case 'tempAbove': return '气温高于 ' + a2.threshold + '° 时通知';
      case 'tempBelow': return '气温低于 ' + a2.threshold + '° 时通知';
      case 'uv': return '紫外线指数 ≥ ' + a2.threshold + ' 时通知';
      case 'wind': return '风速 ≥ ' + a2.threshold + ' m/s 时通知';
      default: return '满足条件时通知';
    }
  }
  function evalAlerts(w) {
    if (!w) return;
    const now = Date.now();
    for (const a2 of alertsList()) {
      if (!a2.enabled) continue;
      if (alertFired[a2.id] && now - alertFired[a2.id] < 6 * 3600 * 1000) continue;
      let hit = false, why = '';
      if (a2.type === 'rain') {
        const m15 = w.minutely_15;
        if (m15 && m15.precipitation) {
          const lead = Math.max(15, Number(a2.lead) || 60);
          const n = Math.min(m15.precipitation.length, Math.ceil(lead / 15));
          for (let i = 0; i < n; i++) {
            if ((Number(m15.precipitation[i]) || 0) >= Math.max(0.1, Number(a2.threshold) || 0.1)) {
              hit = true; why = `${i * 15 + 15} 分钟内有雨，记得带伞`;
              break;
            }
          }
        }
      } else if (a2.type === 'tempBelow') {
        const t = Number(w.current.temperature_2m);
        if (t <= Number(a2.threshold)) { hit = true; why = `当前 ${Math.round(t)}°，注意加衣`; }
      } else if (a2.type === 'tempAbove') {
        const t = Number(w.current.temperature_2m);
        if (t >= Number(a2.threshold)) { hit = true; why = `当前 ${Math.round(t)}°，注意防暑`; }
      } else if (a2.type === 'uv') {
        const u = Number(w.daily.uv_index_max && w.daily.uv_index_max[0]) || 0;
        if (u >= Number(a2.threshold)) { hit = true; why = `今日 UV ${Math.round(u)}，注意防晒`; }
      } else if (a2.type === 'wind') {
        const s = Number(w.current.wind_speed_10m) || 0;
        if (s >= Number(a2.threshold)) { hit = true; why = `风速 ${s.toFixed(1)} m/s，注意防风`; }
      }
      if (hit) {
        alertFired[a2.id] = now;
        try { sky.notify('云上晴雨 · 天气提醒', (a2.label ? a2.label + '：' : '') + why); } catch (e) { }
      }
    }
  }
  // — 分享卡片（canvas 绘制 → dataURL 预览/保存） —
  function paintShare() {
    const cv = $('shareCanvas');
    if (!cv) return;
    const w = window.__extraWeather;
    const st = window.__extraSettings || {};
    const loc = (st.locations || []).find(l => l.id === st.activeId) || (st.locations || [])[0];
    const city = loc ? loc.name : '未知地点';
    const ctx = cv.getContext('2d');
    const W = 720, H = 900;
    cv.width = W; cv.height = H;
    const isDay = !w || !w.current || Number(w.current.is_day) !== 0;
    const code = w && w.current ? Number(w.current.weather_code) : 0;
    // 天空底色
    const g = ctx.createLinearGradient(0, 0, 0, H);
    if (isDay) { g.addColorStop(0, '#8EC5F0'); g.addColorStop(0.55, '#C9E4F7'); g.addColorStop(1, '#F6E7C9'); }
    else { g.addColorStop(0, '#2B3A67'); g.addColorStop(0.6, '#41528A'); g.addColorStop(1, '#7A6FA8'); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 日/月
    if (isDay) {
      ctx.fillStyle = 'rgba(255,210,120,.95)';
      ctx.beginPath(); ctx.arc(540, 150, 74, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,235,180,.35)';
      ctx.beginPath(); ctx.arc(540, 150, 110, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(240,238,255,.95)';
      ctx.beginPath(); ctx.arc(540, 150, 62, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(43,58,103,.9)';
      ctx.beginPath(); ctx.arc(512, 132, 50, 0, Math.PI * 2); ctx.fill();
    }
    // 云/雨
    const cloud = (x, y, s) => {
      ctx.fillStyle = 'rgba(255,255,255,.88)';
      for (const [dx, dy, r] of [[0, 0, 46], [42, -12, 36], [-42, -8, 34], [8, -26, 34]]) {
        ctx.beginPath(); ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2); ctx.fill();
      }
    };
    if (code >= 2 && code <= 3) cloud(200, 250, 1);
    if (code >= 45 && code <= 48) { cloud(200, 250, 1); ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(0, 300, W, 200); }
    if (code >= 51) {
      cloud(200, 250, 1.1);
      ctx.strokeStyle = 'rgba(160,210,255,.9)'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      for (let i = 0; i < 8; i++) {
        const x = 110 + i * 42, y = 330 + (i % 3) * 26;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 10, y + 34); ctx.stroke();
      }
    }
    if (code >= 71) {
      cloud(200, 250, 1.1);
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      for (let i = 0; i < 10; i++) {
        const x = 100 + i * 40, y = 330 + (i % 4) * 24;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      }
    }
    // 文案
    ctx.fillStyle = isDay ? '#20304A' : '#F2F0FF';
    ctx.font = '500 40px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillText(city, 56, 520);
    const now = new Date();
    ctx.font = '400 26px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillStyle = isDay ? 'rgba(32,48,74,.75)' : 'rgba(242,240,255,.8)';
    ctx.fillText(`${now.getMonth() + 1}月${now.getDate()}日 · ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]}`, 56, 562);
    const temp = w && w.current ? Math.round(Number(w.current.temperature_2m)) : '--';
    const condTxt = w && w.current ? condMini(Number(w.current.weather_code)).txt : '';
    ctx.font = '500 150px system-ui, sans-serif';
    ctx.fillStyle = isDay ? '#20304A' : '#FFFFFF';
    ctx.fillText(`${temp}°`, 52, 720);
    ctx.font = '500 44px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillText(condTxt, 300, 716);
    if (w && w.current) {
      const line3 = `${dirName(Number(w.current.wind_direction_10m) || 0)}风 ${Math.round(Number(w.current.wind_speed_10m) || 0)} 级 · 湿度 ${Math.round(Number(w.current.relative_humidity_2m) || 0)}%`;
      ctx.font = '400 28px system-ui, "Microsoft YaHei", sans-serif';
      ctx.fillStyle = isDay ? 'rgba(32,48,74,.8)' : 'rgba(242,240,255,.85)';
      ctx.fillText(line3, 56, 790);
    }
    ctx.font = '400 22px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillStyle = isDay ? 'rgba(32,48,74,.55)' : 'rgba(242,240,255,.6)';
    ctx.fillText('云上晴雨天气台 · 大软子哥哥', 56, 852);
    const prev = $('sharePreview');
    if (prev) prev.src = cv.toDataURL('image/png');
  }
  function renderShare() {
    const el = $('modShare');
    if (!el) return;
    paintShare();
    const btn = $('btnSaveShare');
    if (btn && !btn.__wired) {
      btn.__wired = true;
      btn.addEventListener('click', async () => {
        const cv = $('shareCanvas');
        if (!cv) return;
        const p = await sky.savePng(cv.toDataURL('image/png'));
        btn.textContent = p ? '已保存 ✓' : '已取消';
        setTimeout(() => { btn.textContent = '保存天气卡片'; }, 1600);
      });
    }
  }

  /* ===================== 总调度 ===================== */
  function renderAll(data, settings, loc) {
    window.__extraWeather = data && data.weather;
    window.__extraSettings = settings;
    if (!data || !data.weather) return;
    renderReal(data.weather, data.air);
    renderLife4(data.weather);
    renderMoon();
    renderHistory();
    renderPrecipStat();
    renderPressure();
    renderCities();
    renderAlerts();
    renderShare();
    evalAlerts(data.weather);
    // 懒加载：仅在对应模块开启时拉重资源
    const m = (settings && settings.modules) || {};
    const on = k => m[k] !== false;
    if (on('moon') || on('history') || on('precipstat')) ensureArchive(loc).then(() => { renderHistory(); renderPrecipStat(); });
    if (on('radar')) ensureRadar(loc);
    if (on('cities')) refreshCities();
  }

  /* —— 图标注入（一次性）：ICO 内联 SVG 填进各卡 .x-ico —— */
  (function initIcons() {
    const map = [
      ['x-uv', 'sun'], ['x-pollen', 'flower'], ['x-wind', 'wind'], ['x-visib', 'eye'],
      ['x-dress', 'shirt'], ['x-carwash', 'car'], ['x-dry', 'hanger'], ['x-cold', 'thermo'],
      ['x-moon', 'moon'], ['x-history', 'bars'], ['x-precipstat', 'drop'], ['x-pressure', 'gauge'],
      ['x-cities', 'city'], ['x-radar', 'radar'], ['x-alerts', 'bell'], ['x-share', 'image']
    ];
    for (const [cls, key] of map) {
      const slot = document.querySelector('.' + cls + ' .x-ico');
      if (slot && !slot.firstChild) slot.innerHTML = ICO[key];
    }
  })();

  window.Extra = {
    renderAll, renderCities, refreshCities, renderRadar, ensureRadar, ensureArchive, paintShare,
    moonInfo, uvLevel, dressIndex, beaufort, visLevel, hourIdx,
    hooks: { switchLocation: null, openPanel: null }, // app.js 注入
    _cityCache: cityCache
  };
})();
