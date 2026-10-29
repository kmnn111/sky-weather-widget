'use strict';
/**
 * 手绘风 SVG 天气图标库（吉卜力水彩气质：圆润、暖色、带腮红的小表情）
 * 用法：Icons.svg('sun', 64)  ->  返回 <svg> 字符串
 */
const Icons = (() => {
  const face = `
    <circle cx="27.2" cy="31" r="1.7" fill="#8a5a1f"/>
    <circle cx="36.8" cy="31" r="1.7" fill="#8a5a1f"/>
    <path d="M29 36.2q3 2.4 6 0" stroke="#8a5a1f" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    <ellipse cx="23.2" cy="35" rx="2.6" ry="1.8" fill="#ffab96" opacity=".75"/>
    <ellipse cx="40.8" cy="35" rx="2.6" ry="1.8" fill="#ffab96" opacity=".75"/>`;

  const sunCore = `
    <circle cx="32" cy="32" r="13.5" fill="url(#gSun)" stroke="#efa53c" stroke-width="2.4"/>
    ${face}`;

  const rays = `
    <g class="ico-rays" stroke="#f6b94c" stroke-width="3.6" stroke-linecap="round">
      <line x1="32" y1="5" x2="32" y2="12"/><line x1="32" y1="52" x2="32" y2="59"/>
      <line x1="5" y1="32" x2="12" y2="32"/><line x1="52" y1="32" x2="59" y2="32"/>
      <line x1="13" y1="13" x2="18" y2="18"/><line x1="46" y1="46" x2="51" y2="51"/>
      <line x1="13" y1="51" x2="18" y2="46"/><line x1="46" y1="18" x2="51" y2="13"/>
    </g>`;

  const defs = `
    <defs>
      <linearGradient id="gSun" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#ffc95c"/>
      </linearGradient>
      <radialGradient id="gGlow">
        <stop offset="0" stop-color="#ffd97a" stop-opacity=".9"/>
        <stop offset="0.5" stop-color="#ffcf6a" stop-opacity=".38"/>
        <stop offset="1" stop-color="#ffcf6a" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="gCloud" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e7f1f8"/>
      </linearGradient>
      <linearGradient id="gCloudDark" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e8eef5"/><stop offset="1" stop-color="#c3d2e2"/>
      </linearGradient>
      <linearGradient id="gMoon" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fff3c9"/><stop offset="1" stop-color="#ffd97a"/>
      </linearGradient>
    </defs>`;

  // 阳光光晕（呼吸扩散 = 阳光照射感），垫在光芒与太阳体之下
  const sunGlow = `<circle class="ico-glow" cx="32" cy="32" r="21" fill="url(#gGlow)"/>`;

  // 云：内部 ico-cloud 做缓慢漂浮（多云不再静止）；delay 用于多朵云错相
  const cloud = (fill = 'url(#gCloud)', stroke = '#a9c6da', y = 0, delay = 0) => `
    <g transform="translate(0 ${y})">
      <g class="ico-cloud" style="animation-delay:${delay}s">
        <path d="M17 46 A10 10 0 0 1 20 27 A13.5 13.5 0 0 1 43.5 23 A9.5 9.5 0 0 1 52 46 Z"
          fill="${fill}" stroke="${stroke}" stroke-width="2.3" stroke-linejoin="round"/>
      </g>
    </g>`;

  // 雨滴：逐滴错峰下落 = 连续降雨感
  const drops = (n = 4, color = '#6fa8dd') => {
    let s = '<g class="ico-rain">';
    const xs = n === 3 ? [24, 32, 40] : n === 5 ? [20, 26, 32, 38, 44] : [22, 30, 38, 46];
    xs.forEach((x, i) => {
      const dy = i % 2 ? 3 : 0;
      s += `<path class="drop" style="animation-delay:${(i * 0.19).toFixed(2)}s" d="M${x} ${51 + dy} q-2.2 4 0 6.4 q2.2-2.4 0-6.4z" fill="${color}" opacity=".9"/>`;
    });
    return s + '</g>';
  };

  // 雪花：飘落 + 左右摇摆（外层定位，内层 ico-snow 动）
  const flakes = (color = '#9cc7e8') => {
    let s = '<g class="ico-snow" stroke="' + color + '" stroke-width="2" stroke-linecap="round">';
    [[22, 53], [32, 56], [42, 53], [27, 60], [37, 60]].forEach(([x, y], i) => {
      s += `<g transform="translate(${x} ${y})"><g class="flake" style="animation-delay:${(i * 0.42).toFixed(2)}s">` +
        `<line x1="-3" y1="0" x2="3" y2="0"/><line x1="0" y1="-3" x2="0" y2="3"/><line x1="-2" y1="-2" x2="2" y2="2"/><line x1="-2" y1="2" x2="2" y2="-2"/></g></g>`;
    });
    return s + '</g>';
  };

  const stars = `
    <g class="ico-twinkle" fill="#fff2c4">
      <path d="M12 14 l1.4 3.4 3.4 1.4 -3.4 1.4 -1.4 3.4 -1.4-3.4 -3.4-1.4 3.4-1.4z"/>
      <path d="M52 12 l1.1 2.7 2.7 1.1 -2.7 1.1 -1.1 2.7 -1.1-2.7 -2.7-1.1 2.7-1.1z"/>
      <circle cx="47" cy="24" r="1.5"/><circle cx="16" cy="27" r="1.2"/>
    </g>`;

  const moonShape = `
    <path d="M40 12 A17 17 0 1 0 52 38 A13.5 13.5 0 0 1 40 12 Z"
      fill="url(#gMoon)" stroke="#e8c56a" stroke-width="2.2"/>
    <circle cx="30" cy="26" r="2.4" fill="#f3d98d" opacity=".9"/>
    <circle cx="36" cy="36" r="1.8" fill="#f3d98d" opacity=".9"/>`;

  const bolt = `
    <path d="M35 42 l-9 13 h6.5 l-2.5 9 10.5-14 h-6.5 z"
      fill="#ffd34e" stroke="#e8a93b" stroke-width="2" stroke-linejoin="round" class="ico-bolt"/>`;

  const sunSmall = (x, y, r) => `
    <g transform="translate(${x} ${y})">
      <circle class="ico-glow" r="${r + 8}" fill="url(#gGlow)"/>
      <circle r="${r}" fill="url(#gSun)" stroke="#efa53c" stroke-width="2"/>
      <g class="ico-rays" stroke="#f6b94c" stroke-width="2.4" stroke-linecap="round">
        <line x1="0" y1="${-r - 5}" x2="0" y2="${-r - 1.5}"/><line x1="0" y1="${r + 1.5}" x2="0" y2="${r + 5}"/>
        <line x1="${-r - 5}" y1="0" x2="${-r - 1.5}" y2="0"/><line x1="${r + 1.5}" y1="0" x2="${r + 5}" y2="0"/>
      </g>
    </g>`;

  const moonSmall = (x, y, r) => `
    <path transform="translate(${x} ${y})" d="M${r * 0.6} ${-r} A${r} ${r} 0 1 0 ${r * 1.3} ${r * 0.7} A${r * 0.8} ${r * 0.8} 0 0 1 ${r * 0.6} ${-r} Z"
      fill="url(#gMoon)" stroke="#e8c56a" stroke-width="1.8"/>`;

  const shapes = {
    sun: sunGlow + rays + sunCore,
    'sun-cloud': sunSmall(20, 20, 9) + cloud('url(#gCloud)', '#a9c6da', 4, -1.6),
    cloud: cloud(),
    overcast: cloud('url(#gCloudDark)', '#93aac2', -2, 0) + cloud('url(#gCloud)', '#a9c6da', 6, -2.4),
    fog: cloud('url(#gCloud)', '#a9c6da', -4) + `
      <g stroke="#b7cfe2" stroke-width="3" stroke-linecap="round" class="ico-mist">
        <path style="animation-delay:0s" d="M16 52 q8-3.5 16 0 t16 0" fill="none"/>
        <path style="animation-delay:-.7s" d="M20 59 q8-3.5 16 0 t12 0" fill="none" opacity=".7"/>
      </g>`,
    drizzle: cloud('url(#gCloud)', '#a9c6da', -3) + drops(3, '#8fc0e8'),
    rain: cloud('url(#gCloud)', '#a9c6da', -3) + drops(4, '#6fa8dd'),
    'heavy-rain': cloud('url(#gCloudDark)', '#93aac2', -4) + drops(5, '#5b8fd4'),
    snow: cloud('url(#gCloud)', '#a9c6da', -4) + flakes(),
    'heavy-snow': cloud('url(#gCloud)', '#a9c6da', -4) + flakes('#7fb2dc'),
    sleet: cloud('url(#gCloud)', '#a9c6da', -3) + drops(3, '#6fa8dd') + flakes('#9cc7e8'),
    thunder: cloud('url(#gCloudDark)', '#8aa2bc', -4) + bolt,
    wind: cloud('url(#gCloud)', '#a9c6da', -4) + `
      <g stroke="#a9c6da" stroke-width="3" stroke-linecap="round" fill="none" class="ico-wind">
        <path style="animation-delay:0s" d="M12 52 h24 a5 5 0 1 0 -5-5"/>
        <path style="animation-delay:-.55s" d="M18 59 h16 a4 4 0 1 1 -4 4" opacity=".8"/>
      </g>`,
    moon: moonShape + stars,
    'moon-cloud': moonSmall(19, 17, 10) + stars + cloud('url(#gCloud)', '#a9c6da', 5, -1.8)
  };

  function svg(name, size = 48, extraClass = '') {
    const body = shapes[name] || shapes.cloud;
    return `<svg class="ico ico-${name} ${extraClass}" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">${defs}${body}</svg>`;
  }
  /* ---------- 线性 UI 图标（苹果风描边） ---------- */
  const uiShapes = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    sliders: '<path d="M4 8h9M18.5 8H20M4 16h2.5M12 16h8"/><circle cx="15.5" cy="8" r="2.2"/><circle cx="9" cy="16" r="2.2"/>',
    pin: '<path d="M12 21s6.5-5.4 6.5-11a6.5 6.5 0 1 0-13 0c0 5.6 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.5v5h-5"/>',
    shirt: '<path d="M9 4.5 5 6.5 3 10l3 2v8h12v-8l3-2-2-3.5-4-2"/><path d="M9 4.5a3 3 0 0 0 6 0"/>',
    car: '<path d="M4.5 13l1.6-4.8A2.5 2.5 0 0 1 8.5 6.5h7a2.5 2.5 0 0 1 2.4 1.7L19.5 13V18h-15z"/><path d="M4.5 13h15"/><circle cx="8" cy="18" r="1.8"/><circle cx="16" cy="18" r="1.8"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/>',
    drop: '<path d="M12 3.5s-6 6.8-6 10.5a6 6 0 0 0 12 0c0-3.7-6-10.5-6-10.5z"/>',
    run: '<circle cx="15" cy="4.5" r="2"/><path d="M12.5 21l1.8-5.5-2.8-2.8-2.2 2.2M14.3 15.5l2.7-2.5 2.3.6M11.5 13.2l1.6-3.4-2-1-2.7 2"/>',
    mask: '<circle cx="12" cy="12" r="8.5"/><path d="M7 11h10v2.2a5 5 0 0 1-10 0z"/><path d="M7 11l-2.5-1.2M17 11l2.5-1.2M8.7 8.4h1.3M14 8.4h1.3"/>'
  };

  function ui(name, size = 16) {
    return `<svg class="ui-ico ui-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${uiShapes[name] || ''}</svg>`;
  }

  return { svg, shapes, ui };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Icons;
