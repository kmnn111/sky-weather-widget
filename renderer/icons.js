'use strict';
/**
 * 云上晴雨 · 天光（Living Sky）矢量天气图标库
 * 光感立体渐变 + 柔和投影 + 合成层微动效（只动 transform/opacity）
 * 用法：Icons.svg('sun', 64)  ->  返回 <svg> 字符串
 */
const Icons = (() => {
  let uid = 0;
  // 统一柔和云体路径（64×64 坐标系，圆润有体积感）
  const CLOUD_PATH = 'M17 47 C10.2 47 6 42.2 6 36.4 C6 30.8 10.1 26.4 15.8 25.9 C17.7 18.6 24.3 13.2 32.1 13.2 C40.6 13.2 47.4 19.3 48.6 27.3 C54.0 28.0 57.6 32.3 57.6 37.4 C57.6 42.8 53.2 47 47.6 47 Z';

  function buildDefs(id) {
    return `<defs>
      <radialGradient id="${id}s" cx="38%" cy="34%" r="68%">
        <stop offset="0%" stop-color="#fff9df"/>
        <stop offset="46%" stop-color="#ffd86e"/>
        <stop offset="100%" stop-color="#ff9f38"/>
      </radialGradient>
      <radialGradient id="${id}g" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffd97a" stop-opacity=".85"/>
        <stop offset="55%" stop-color="#ffc85c" stop-opacity=".28"/>
        <stop offset="100%" stop-color="#ffc85c" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="${id}c" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#cfe0f2"/>
      </linearGradient>
      <linearGradient id="${id}cd" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#d8e1ee"/>
        <stop offset="100%" stop-color="#99abc4"/>
      </linearGradient>
      <radialGradient id="${id}m" cx="34%" cy="32%" r="72%">
        <stop offset="0%" stop-color="#fffceb"/>
        <stop offset="58%" stop-color="#f7df96"/>
        <stop offset="100%" stop-color="#e5be60"/>
      </radialGradient>
      <radialGradient id="${id}mg" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffe9a8" stop-opacity=".42"/>
        <stop offset="100%" stop-color="#ffe9a8" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#fff099"/>
        <stop offset="100%" stop-color="#ffad2e"/>
      </linearGradient>
    </defs>`;
  }

  const sunBody = (id, cx, cy, r) => {
    const rayAngles = [0, 45, 90, 135, 180, 225, 270, 315];
    const rays = rayAngles.map(a => {
      const ra = a * Math.PI / 180;
      const x1 = (cx + Math.cos(ra) * r * 1.32).toFixed(1);
      const y1 = (cy + Math.sin(ra) * r * 1.32).toFixed(1);
      const x2 = (cx + Math.cos(ra) * r * 1.66).toFixed(1);
      const y2 = (cy + Math.sin(ra) * r * 1.66).toFixed(1);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }).join('');
    return `
      <circle class="ico-glow" cx="${cx}" cy="${cy}" r="${(r * 2.15).toFixed(1)}" fill="url(#${id}g)"/>
      <g class="ico-rays" stroke="#ffbe4a" stroke-width="${(r * 0.24).toFixed(1)}" stroke-linecap="round" opacity=".92">${rays}</g>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}s)"/>`;
  };

  const moonBody = (id, cx, cy, r) => `
    <mask id="${id}mk">
      <rect width="64" height="64" fill="#fff"/>
      <circle cx="${(cx + r * 0.56).toFixed(1)}" cy="${(cy - r * 0.36).toFixed(1)}" r="${(r * 0.88).toFixed(1)}" fill="#000"/>
    </mask>
    <circle class="ico-glow" cx="${cx}" cy="${cy}" r="${(r * 1.85).toFixed(1)}" fill="url(#${id}mg)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}m)" mask="url(#${id}mk)"/>`;

  const cloudBody = (id, dark = false, tx = 0, ty = 0, scale = 1, delay = 0) => `
    <g transform="translate(${tx} ${ty}) scale(${scale})">
      <g class="ico-cloud" style="animation-delay:${delay}s">
        <path d="${CLOUD_PATH}" fill="rgba(32,62,110,0.12)" transform="translate(0 2.2)"/>
        <path d="${CLOUD_PATH}" fill="url(#${id}${dark ? 'cd' : 'c'})" stroke="rgba(255,255,255,0.88)" stroke-width="1.2" stroke-linejoin="round"/>
      </g>
    </g>`;

  const drops = (n = 4, color = '#4a98ea') => {
    let s = '<g class="ico-rain">';
    const xs = n === 3 ? [23, 32, 41] : n === 5 ? [19, 25.5, 32, 38.5, 45] : [21, 28.5, 36, 43.5];
    xs.forEach((x, i) => {
      const dy = i % 2 ? 3 : 0;
      s += `<line class="drop" style="animation-delay:${(i * 0.18).toFixed(2)}s" x1="${x}" y1="${49 + dy}" x2="${(x - 2.4).toFixed(1)}" y2="${56.5 + dy}" stroke="${color}" stroke-width="2.9" stroke-linecap="round"/>`;
    });
    return s + '</g>';
  };

  const flakes = (color = '#93c5f2') => {
    let s = `<g class="ico-snow" stroke="${color}" stroke-width="2" stroke-linecap="round">`;
    [[21, 51], [32, 54], [43, 51], [26.5, 58.5], [37.5, 58.5]].forEach(([x, y], i) => {
      s += `<g transform="translate(${x} ${y})"><g class="flake" style="animation-delay:${(i * 0.42).toFixed(2)}s">` +
        `<line x1="-3.2" y1="0" x2="3.2" y2="0"/><line x1="0" y1="-3.2" x2="0" y2="3.2"/><line x1="-2.2" y1="-2.2" x2="2.2" y2="2.2"/><line x1="-2.2" y1="2.2" x2="2.2" y2="-2.2"/></g></g>`;
    });
    return s + '</g>';
  };

  const stars = `
    <g class="ico-twinkle" fill="#fff4cc">
      <path d="M13 14 l1.4 3.4 3.4 1.4 -3.4 1.4 -1.4 3.4 -1.4-3.4 -3.4-1.4 3.4-1.4z"/>
      <path d="M51 13 l1.1 2.6 2.6 1.1 -2.6 1.1 -1.1 2.6 -1.1-2.6 -2.6-1.1 2.6-1.1z"/>
      <circle cx="47" cy="25" r="1.4"/><circle cx="17" cy="28" r="1.1"/>
    </g>`;

  const bolt = (id) => `
    <path d="M35 39 l-9.5 13.5 h6.8 l-3 10 11.5-15 h-6.8 l2.8-8.5z"
      fill="url(#${id}b)" stroke="#9a5c0a" stroke-opacity=".3" stroke-width="1" stroke-linejoin="round" class="ico-bolt"/>`;

  function shapeOf(name, id) {
    switch (name) {
      case 'sun':
        return sunBody(id, 32, 32, 13);
      case 'sun-cloud':
        return sunBody(id, 22, 22, 9.5) + cloudBody(id, false, 7, 10, 0.84, -1.6);
      case 'cloud':
        return cloudBody(id, false, 0, 2, 1, 0);
      case 'overcast':
        return cloudBody(id, true, -3, -3, 0.9, 0) + cloudBody(id, false, 5, 8, 0.9, -2.4);
      case 'fog':
        return cloudBody(id, false, 0, -4, 0.96, 0) + `
          <g stroke="#a8c2da" stroke-width="3" stroke-linecap="round" class="ico-mist">
            <path style="animation-delay:0s" d="M14 51 q9-3 18 0 t18 0" fill="none"/>
            <path style="animation-delay:-.7s" d="M19 58 q8-3 16 0 t12 0" fill="none" opacity=".7"/>
          </g>`;
      case 'drizzle':
        return cloudBody(id, false, 0, -4, 0.98, 0) + drops(3, '#6eb0ee');
      case 'rain':
        return cloudBody(id, false, 0, -4, 0.98, 0) + drops(4, '#4a98ea');
      case 'heavy-rain':
        return cloudBody(id, true, 0, -5, 0.98, 0) + drops(5, '#3b82d6');
      case 'snow':
        return cloudBody(id, false, 0, -5, 0.98, 0) + flakes('#93c5f2');
      case 'heavy-snow':
        return cloudBody(id, true, 0, -5, 0.98, 0) + flakes('#7fb6e8');
      case 'sleet':
        return cloudBody(id, false, 0, -4, 0.98, 0) + drops(3, '#4a98ea') + flakes('#93c5f2');
      case 'thunder':
        return cloudBody(id, true, 0, -5, 0.98, 0) + bolt(id);
      case 'wind':
        return cloudBody(id, false, 0, -4, 0.96, 0) + `
          <g stroke="#8db2d4" stroke-width="2.8" stroke-linecap="round" fill="none" class="ico-wind">
            <path style="animation-delay:0s" d="M12 51 h25 a5 5 0 1 0 -5-5"/>
            <path style="animation-delay:-.55s" d="M18 58 h17 a4 4 0 1 1 -4 4" opacity=".82"/>
          </g>`;
      case 'moon':
        return stars + moonBody(id, 30, 33, 15.5);
      case 'moon-cloud':
        return stars + moonBody(id, 21, 21, 10.5) + cloudBody(id, false, 7, 10, 0.84, -1.8);
      default:
        return cloudBody(id, false, 0, 2, 1, 0);
    }
  }

  // 保留 shapes 键表兼容旧代码检测
  const shapes = {
    sun: 1, 'sun-cloud': 1, cloud: 1, overcast: 1, fog: 1,
    drizzle: 1, rain: 1, 'heavy-rain': 1, snow: 1, 'heavy-snow': 1,
    sleet: 1, thunder: 1, wind: 1, moon: 1, 'moon-cloud': 1
  };

  function svg(name, size = 48, extraClass = '') {
    const id = 'ls' + (++uid);
    const key = shapes[name] ? name : 'cloud';
    return `<svg class="ico ico-${key} ${extraClass}" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" style="overflow:visible">${buildDefs(id)}${shapeOf(key, id)}</svg>`;
  }

  /* ---------- 线性 UI 图标（1.8px 圆角描边） ---------- */
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
