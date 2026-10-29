'use strict';
/**
 * 云上晴雨 · 昼夜地球
 * 正交投影伪 3D 球体：真实大陆轮廓 + 晨昏线（太阳赤纬/时角实时计算）
 * + 太阳/月亮按真实方位绕场景环移动（月出月落控制显隐）+ 定位点日出日落闪现。
 * 自转两种模式：演示（45 秒/圈，时间流逝）/ 真实（恒星时 1×）。
 * 性能：球体/网格/大洲名称只在切换地点时重算；每帧只重算晨昏线与日月；
 * 真实模式 2 秒一算；滚动 / 收起小窗 / 离屏 / 隐藏窗口时暂停。
 */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const D = Math.PI / 180;
  const CX = 180, CY = 180, R = 122;          // 场景 360×360，球心居中
  const SUN_RING = 150, MOON_RING = 124;      // 太阳/月亮绕场景环的半径
  const DEMO_SPEED = 86400 / 45;              // 演示：45 秒转一圈（时间流逝 1920×）

  /* ================= 天文（低精度，日出日落 ±1min 级） ================= */
  function dCent(ms) { return ms / 86400000 + 2440587.5 - 2451545.0; }

  function sunEq(d) {
    const g = (357.529 + 0.98560028 * d) * D;
    const q = (280.459 + 0.98564736 * d) * D;
    const L = q + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D;
    const e = (23.439 - 0.0000004 * d) * D;
    return {
      ra: Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / D,
      dec: Math.asin(Math.sin(e) * Math.sin(L)) / D
    };
  }

  function moonEq(d) {
    const Lp = (218.316 + 13.176396 * d) * D;
    const Mp = (134.963 + 13.064993 * d) * D;
    const M = (357.529 + 0.98560028 * d) * D;
    const Dd = (297.850 + 12.190749 * d) * D;
    const F = (93.272 + 13.229350 * d) * D;
    const lam = Lp + (
      6.289 * Math.sin(Mp) - 1.274 * Math.sin(Mp - 2 * Dd) + 0.658 * Math.sin(2 * Dd)
      - 0.186 * Math.sin(M) - 0.059 * Math.sin(2 * Mp - 2 * Dd) - 0.057 * Math.sin(Mp - 2 * Dd + M)
      + 0.053 * Math.sin(Mp + 2 * Dd) + 0.046 * Math.sin(2 * Dd - M) + 0.041 * Math.sin(Mp - M)
      - 0.035 * Math.sin(Dd) - 0.031 * Math.sin(Mp + M) - 0.015 * Math.sin(2 * F - 2 * Dd)
      + 0.011 * Math.sin(Mp - 4 * Dd)) * D;
    const bet = (5.128 * Math.sin(F) + 0.281 * Math.sin(Mp + F) - 0.278 * Math.sin(Mp - F)
      - 0.173 * Math.sin(F - 2 * Dd) + 0.055 * Math.sin(Mp + F - 2 * Dd)
      - 0.046 * Math.sin(Mp - F - 2 * Dd) + 0.033 * Math.sin(F + 2 * Dd)
      + 0.017 * Math.sin(2 * Mp + F)) * D;
    const e = (23.439 - 0.0000004 * d) * D;
    return {
      ra: Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(bet) * Math.sin(e), Math.cos(lam)) / D,
      dec: Math.asin(Math.sin(bet) * Math.cos(e) + Math.cos(bet) * Math.sin(e) * Math.sin(lam)) / D
    };
  }

  function gmstDeg(d) { return 280.46061837 + 360.98564736629 * d; }

  // 天体地心经纬度（用于球面投影）
  function bodyLatLon(kind, ms) {
    const d = dCent(ms);
    const eq = kind === 'sun' ? sunEq(d) : moonEq(d);
    const lon = ((eq.ra - gmstDeg(d)) % 360 + 540) % 360 - 180;
    return { lat: eq.dec, lon, ra: eq.ra, dec: eq.dec };
  }

  // 天体在观测点的高度角（度）
  function altOf(kind, ms, lat, lon) {
    const b = bodyLatLon(kind, ms);
    const H = ((gmstDeg(dCent(ms)) + lon - b.ra) % 360 + 540) % 360 - 180;
    return Math.asin(Math.sin(lat * D) * Math.sin(b.dec * D)
      + Math.cos(lat * D) * Math.cos(b.dec * D) * Math.cos(H * D)) / D;
  }

  // 日/月出没时刻（系统时区当天）；h0：太阳 -0.833°，月亮 +0.125°
  function riseSet(kind, ms, lat, lon) {
    const h0 = kind === 'sun' ? -0.833 : 0.125;
    const t0 = new Date(ms); t0.setHours(0, 0, 0, 0);
    const t = t0.getTime(), step = 10 * 60000;
    let prev = altOf(kind, t, lat, lon) - h0;
    const out = { rise: null, set: null };
    for (let i = 1; i <= 144; i++) {
      const cur = altOf(kind, t + i * step, lat, lon) - h0;
      if (prev < 0 && cur >= 0 && !out.rise) out.rise = t + (i - 1 + (-prev) / (cur - prev)) * step;
      if (prev >= 0 && cur < 0 && !out.set) out.set = t + (i - 1 + prev / (prev - cur)) * step;
      prev = cur;
    }
    return out;
  }

  // 月亮亮面比例（0..1）与是否盈（上弦前）
  function moonIllum(ms) {
    const d = dCent(ms);
    const s = sunEq(d), m = moonEq(d);
    const cosPsi = Math.sin(s.dec * D) * Math.sin(m.dec * D)
      + Math.cos(s.dec * D) * Math.cos(m.dec * D) * Math.cos((s.ra - m.ra) * D);
    const k = (1 - cosPsi) / 2;
    const diff = ((m.ra - s.ra) % 360 + 360) % 360;
    return { k, waxing: diff < 180 };
  }

  /* ================= 大陆轮廓（真实经纬度多边形） ================= */
  const LAND = {
    africa: [[-5.5,35.8],[0,36.5],[10,37],[11,33.5],[15,32],[20,32.5],[25,31.5],[29,31],[31.5,31.5],[32.5,29.5],[34,28],[35.5,24],[37,21],[38.5,18],[39.5,15],[43,12.5],[45,10.5],[48,11.5],[51,12],[49,8],[47,4],[44,1.5],[41,-2],[40,-5.5],[39.5,-8],[40.5,-11],[40.5,-15],[37,-18],[35,-21],[32.5,-26],[31,-29],[28,-32],[24,-34],[20,-34.5],[18,-33.5],[15.5,-27],[14,-22],[12.5,-18],[12,-14],[12.5,-10],[13,-7],[12,-5.5],[9.5,-1],[9.5,2],[8.5,4],[6,4.5],[4,6],[0,5.5],[-4,5],[-8,4.5],[-11,6],[-13,9],[-15.5,12],[-17,15],[-17,20],[-15,23],[-13,27],[-10,30],[-6,35.5]],
    eurasia: [[-6,36],[-7,37],[-9,38.5],[-9,41],[-8.8,43.5],[-4,43.5],[-1.5,43.5],[-1,46],[-4,48],[-1,49.5],[1.5,51],[4,52],[5,53.5],[8,53.8],[8.2,56],[9.5,57.5],[10.5,59],[10,60.5],[7,63],[10,64],[12,66],[15,68],[19,69.5],[24,71],[29,70.5],[33,69.5],[38,68],[41,67],[44,66.5],[48,68],[55,69],[60,70.5],[67,72],[71,73],[76,72.5],[80,73.5],[87,75],[94,76],[100,77],[106,77],[112,74],[118,73.5],[125,73],[132,72.5],[139,72],[145,71.5],[151,70.5],[157,70],[163,69.5],[169,68.5],[176,67.5],[180,66.5],[178,64],[173,62],[170,60],[165,60],[162,57],[158,53],[156,51],[155,54],[152,59],[146,59],[142,57],[138,54],[135,50],[132,46],[130,43],[128,42],[126,39.5],[126,36.5],[126,34.5],[122,37],[119,35],[121,32],[122,30.5],[120,27],[118,24],[115,22.5],[113,22],[110,21],[108,21],[106,20],[106,17],[108,13],[107,10],[104,9],[101,13],[100,12],[99,10],[100,7],[101,4],[104,1.5],[102,2],[100,6],[98,8],[97,12],[94,16],[92,21],[90,22],[87,21],[82,17],[80,13],[79,10],[77.5,8],[74,12],[73,16],[70,19],[68,22],[66,23],[63,24],[60,25],[57,25.5],[56,25],[58,22.5],[59.5,22.5],[58,20],[55,17],[52,15],[48,14],[45,13],[43,13],[42,15],[39,20],[37,24],[35,28],[34.5,28.5],[34,31],[35,33],[36,36],[33,36.5],[30,36.5],[27,36.5],[26,38.5],[24,38],[23,37.5],[24,40.5],[21,39.5],[19,40],[19,42],[15,44],[13,45.5],[12.5,45],[12,44],[14,42],[16,41.8],[18,40.3],[17,38.9],[15.6,38],[14,40.5],[12,41.5],[11,42.5],[10,44],[8.5,44.2],[6,43.2],[3,42.5],[0,39.5],[-2,36.8],[-5.5,36]],
    namerica: [[-168,65.5],[-166,61],[-162,58.5],[-158,57],[-153,58],[-148,60],[-143,60],[-138,58],[-134,56],[-130,53],[-126,50],[-124,46],[-123,42],[-121,37],[-118,34],[-114,31],[-112,27],[-110,23],[-109,23],[-106,23],[-101,20],[-97,16],[-92,13],[-87,11],[-83,8],[-79,8],[-79,9],[-83,11],[-87,15],[-88,18],[-87,21],[-90,21],[-94,19],[-97,21],[-97,26],[-94,29],[-89,29],[-84,30],[-82,27],[-80,25],[-80,28],[-78,32],[-75,35],[-74,39],[-71,42],[-67,45],[-65,44],[-60,46],[-56,47],[-55,50],[-58,54],[-62,57],[-65,58],[-68,58],[-74,60],[-78,62],[-82,64],[-86,66],[-90,68],[-95,68],[-100,69],[-108,68],[-115,69],[-122,70],[-128,70],[-134,69],[-140,70],[-148,70],[-155,71],[-162,69],[-166,68]],
    samerica: [[-77,7.5],[-72,12],[-66,10.5],[-60,8],[-54,6],[-50,2],[-46,-1],[-41,-3],[-37,-5],[-35,-7],[-37,-11],[-39,-15],[-40,-20],[-43,-23],[-47,-25],[-50,-28],[-53,-32],[-56,-35],[-58,-38],[-62,-40],[-64,-43],[-66,-46],[-68,-50],[-68,-53],[-71,-54],[-73,-52],[-74,-48],[-73,-44],[-73,-40],[-72,-36],[-71,-32],[-70,-27],[-70,-22],[-71,-18],[-75,-14],[-78,-10],[-80,-6],[-81,-4],[-80,-1],[-78,2],[-77,5]],
    australia: [[113,-22],[114,-26],[115,-31],[118,-35],[122,-34],[126,-32],[130,-31],[133,-32],[135,-35],[138,-35],[140,-38],[144,-39],[147,-38],[150,-36],[152,-32],[153,-28],[152,-25],[149,-21],[146,-19],[145,-15],[142,-11],[139,-13],[136,-13],[133,-12],[130,-12],[127,-14],[124,-17],[121,-19],[117,-20]],
    greenland: [[-43,60],[-48,62],[-52,65],[-54,69],[-57,72],[-61,76],[-66,79],[-60,82],[-45,83],[-30,82],[-22,78],[-20,74],[-24,70],[-30,67],[-36,64],[-40,62]],
    madagascar: [[43,-12],[47,-14],[50,-17],[49,-21],[47,-25],[45,-25],[43,-22],[42,-18]],
    japan: [[130,31],[131,33],[134,34],[137,35],[140,36],[141,39],[143,41],[145,43],[142,45],[140,42],[139,38],[136,35],[133,34],[130,33]],
    uk: [[-5,50],[-4,52],[-5,54],[-4,56],[-5,58],[-3,58],[-1,56],[0,53],[1,52],[-2,51]],
    ireland: [[-10,52],[-9,54],[-8,55],[-6,55],[-6,52],[-8,51]],
    nz: [[173,-35],[176,-38],[178,-38],[176,-41],[173,-43],[169,-45],[167,-45],[170,-42],[172,-39]],
    tasmania: [[145,-41],[148,-41],[148,-43],[145,-43]],
    srilanka: [[80,9],[82,8],[81,6],[80,6]],
    cuba: [[-85,22],[-80,23],[-75,20],[-79,20],[-83,21]],
    sumatra: [[95,5],[99,3],[102,-2],[106,-6],[103,-5],[98,1]],
    java: [[105,-6],[112,-7],[115,-8],[112,-8],[107,-7]],
    borneo: [[109,2],[113,4],[117,4],[119,-1],[116,-4],[111,-3],[109,-1]],
    newguinea: [[131,-1],[137,-3],[141,-3],[147,-6],[150,-10],[143,-9],[137,-8],[132,-5]],
    philippines: [[120,18],[122,14],[125,10],[122,7],[120,12]],
    antarctica: [[-180,-68],[-150,-70],[-120,-71],[-90,-70],[-72,-66],[-62,-63],[-58,-66],[-60,-71],[-30,-72],[0,-70],[30,-69],[60,-68],[90,-67],[120,-67],[150,-69],[180,-68]]
  };
  const WATER = [
    [[-95,58],[-94,63],[-88,65],[-82,64],[-78,62],[-79,57],[-83,53],[-88,52],[-93,55]],
    [[28,41.5],[29,45],[33,46],[38,45.5],[41,43],[37,41],[32,41]],
    [[12,55],[13,59],[18,62],[23,63],[26,60],[22,56],[17,54.5]],
    [[47,45],[51,46],[54,42],[52,38],[49,37],[47,40]]
  ];
  const LABELS = [
    { zh: '亚洲', lon: 92, lat: 45 }, { zh: '欧洲', lon: 16, lat: 52 },
    { zh: '非洲', lon: 20, lat: 3 }, { zh: '北美洲', lon: -101, lat: 45 },
    { zh: '南美洲', lon: -58, lat: -12 }, { zh: '大洋洲', lon: 133, lat: -25 },
    { zh: '南极洲', lon: -10, lat: -73 }
  ];

  /* ================= 投影 ================= */
  let cam = { lat: 30.173, lon: 121.262, e: null, n: null, c: null };
  function setCam(lat, lon) {
    const l = lon * D, p = lat * D;
    cam = {
      lat, lon,
      e: [-Math.sin(l), Math.cos(l), 0],
      n: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
      c: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]
    };
  }
  function pvec(lon, lat) {
    const l = lon * D, p = lat * D, cp = Math.cos(p);
    return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)];
  }
  function viewP(P) {
    return [P[0] * cam.e[0] + P[1] * cam.e[1] + P[2] * cam.e[2],
            P[0] * cam.n[0] + P[1] * cam.n[1] + P[2] * cam.n[2],
            P[0] * cam.c[0] + P[1] * cam.c[1] + P[2] * cam.c[2]];
  }
  function scr(v) {
    let x = v[0], y = v[1];
    if (v[2] < 0) { const r = Math.hypot(x, y) || 1e-6; x /= r; y /= r; }
    return [CX + x * R, CY - y * R];
  }

  /* ================= DOM ================= */
  const $ = id => document.getElementById(id);
  let el = {};               // 元素引用
  let loc = null;            // {lat, lon, name}
  let times = null;          // {sunrise, sunset}  Date | null（来自 Open-Meteo）
  let moonTimes = null; // 已废弃：月出月落改由 renderPanel 按模拟日动态推算
  let speed = 1;             // 1=真实，DEMO_SPEED=演示
  let base = Date.now(), epoch = Date.now();
  let suspended = false, onScreen = true, lastGeo = 0, raf = 0;
  let lastDay = null, glintTimer = 0;
  let view = { lat: 30.173, lon: 121.262 };  // 相机对准点（可被鼠标拖拽旋转）
  let dragging = false, scrubbing = false, geoDirty = false;
  const geo = {};            // 静态几何元素

  const globeNow = () => base + (Date.now() - epoch) * speed;
  const pad = n => String(n).padStart(2, '0');
  const hhmm = t => t ? pad(new Date(t).getHours()) + ':' + pad(new Date(t).getMinutes()) : '—:—';

  function buildSvg() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 360 360');
    svg.setAttribute('role', 'img');
    const title = document.createElementNS(NS, 'title');
    title.textContent = '昼夜地球';
    svg.appendChild(title);
    const desc = document.createElementNS(NS, 'desc');
    desc.textContent = '地球昼夜分布与晨昏线，标注本地定位点，太阳与月亮按真实方位移动。';
    svg.appendChild(desc);
    svg.insertAdjacentHTML('beforeend', `
      <defs>
        <radialGradient id="gOcean" gradientUnits="userSpaceOnUse" cx="132" cy="122" r="215">
          <stop offset="0" stop-color="#dcedff"/><stop offset="0.55" stop-color="#a3c9ef"/><stop offset="1" stop-color="#5c8fcf"/>
        </radialGradient>
        <radialGradient id="gLimb" gradientUnits="userSpaceOnUse" cx="136" cy="126" r="208">
          <stop offset="0.55" stop-color="rgba(10,30,70,0)"/><stop offset="1" stop-color="rgba(10,30,70,0.42)"/>
        </radialGradient>
        <radialGradient id="gSunG" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#fff8dd"/><stop offset="0.6" stop-color="#ffd75e"/><stop offset="1" stop-color="#f5a62f"/>
        </radialGradient>
        <radialGradient id="gHalo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="rgba(255,208,105,0.5)"/><stop offset="1" stop-color="rgba(255,208,105,0)"/>
        </radialGradient>
        <radialGradient id="gMoonHalo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="rgba(190,210,245,0.55)"/><stop offset="1" stop-color="rgba(190,210,245,0)"/>
        </radialGradient>
        <clipPath id="gDisc"><circle cx="${CX}" cy="${CY}" r="${R}"/></clipPath>
      </defs>
      <circle cx="${CX}" cy="${CY}" r="${R + 5}" fill="none" stroke="#bcdcf8" stroke-width="7" opacity="0.5"/>
      <g clip-path="url(#gDisc)">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#gOcean)"/>
        <g id="gGrat" stroke="#7fb0e4" stroke-width="0.8" fill="none" opacity="0.55"></g>
        <g id="gLands" fill="#9ec96d" stroke="#7cab54" stroke-width="0.7"></g>
        <g id="gWaters" fill="url(#gOcean)" stroke="#7cab54" stroke-width="0.5"></g>
        <path id="gNight" fill="#0c1c42" opacity="0.86"></path>
        <path id="gTermGlow" fill="none" stroke="#ffb347" stroke-width="6" opacity="0.38"></path>
        <path id="gTerm" fill="none" stroke="#ffc466" stroke-width="2.2"></path>
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#gLimb)"/>
      </g>
      <g id="gLabels"></g>
      <g id="gMarker" transform="translate(${CX} ${CY})">
        <circle id="gMkRing" class="g-glint" r="12" fill="none" stroke="#f0625a" stroke-width="2.5"/>
        <circle id="gMkHalo" r="10" fill="none" stroke="#f0625a" stroke-width="1.6" opacity="0.55"/>
        <circle id="gMkDot" r="5.5" fill="#f0625a" stroke="#ffffff" stroke-width="1.6"/>
        <text id="gMkLabel" x="16" y="-11" font-size="15" font-weight="500" fill="#2c2c2a" stroke="#ffffff" stroke-width="3.6" paint-order="stroke"></text>
      </g>
      <g id="gSun">
        <circle class="g-halo" r="32" fill="url(#gHalo)"/>
        <g class="g-rays" stroke="#f0a93c" stroke-width="2.6" stroke-linecap="round">
          <line x1="0" y1="-18" x2="0" y2="-28"/><line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(30)"/>
          <line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(60)"/><line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(90)"/>
          <line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(120)"/><line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(150)"/>
          <line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(180)"/><line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(210)"/>
          <line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(240)"/><line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(270)"/>
          <line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(300)"/><line x1="0" y1="-18" x2="0" y2="-28" transform="rotate(330)"/>
        </g>
        <circle r="13" fill="url(#gSunG)"/>
      </g>
      <g id="gMoon" class="g-moonwrap">
        <circle class="g-halo" r="26" fill="url(#gMoonHalo)" style="animation-duration:4.5s"/>
        <circle r="11" fill="#3a4665"/>
        <path id="gMoonLit" fill="#fdf7e8"></path>
      </g>
      <g id="gStars" fill="#b9c9e2">
        <circle class="g-star" cx="300" cy="42" r="1.6"/><circle class="g-star" cx="330" cy="120" r="1.3" style="animation-delay:.7s"/>
        <circle class="g-star" cx="312" cy="196" r="1.7" style="animation-delay:1.3s"/><circle class="g-star" cx="338" cy="268" r="1.3" style="animation-delay:1.9s"/>
        <circle class="g-star" cx="292" cy="318" r="1.6" style="animation-delay:.4s"/><circle class="g-star" cx="216" cy="342" r="1.3" style="animation-delay:2.2s"/>
        <circle class="g-star" cx="132" cy="336" r="1.6" style="animation-delay:1.1s"/><circle class="g-star" cx="58" cy="300" r="1.3" style="animation-delay:2.7s"/>
        <circle class="g-star" cx="22" cy="222" r="1.5" style="animation-delay:1.6s"/><circle class="g-star" cx="30" cy="132" r="1.3" style="animation-delay:.9s"/>
        <circle class="g-star" cx="62" cy="52" r="1.5" style="animation-delay:2.4s"/><circle class="g-star" cx="140" cy="22" r="1.3" style="animation-delay:1.4s"/>
        <circle class="g-star" cx="212" cy="16" r="1.6" style="animation-delay:.2s"/><circle class="g-star" cx="258" cy="26" r="1.3" style="animation-delay:2.9s"/>
      </g>`);
    return svg;
  }

  /* ================= 静态几何（切换地点时重算一次） ================= */
  function polyD(poly) {
    let d = '';
    for (let i = 0; i < poly.length; i++) {
      const s = scr(viewP(pvec(poly[i][0], poly[i][1])));
      d += (i ? 'L' : 'M') + s[0].toFixed(1) + ' ' + s[1].toFixed(1);
    }
    return d + 'Z';
  }
  function polyVisible(poly) {
    let m = -2;
    for (let i = 0; i < poly.length; i++) {
      const z = viewP(pvec(poly[i][0], poly[i][1]))[2];
      if (z > m) m = z;
    }
    return m > -0.02;
  }
  function lineD(pts) {
    let d = '', pen = false;
    for (let i = 0; i < pts.length; i++) {
      const v = viewP(pvec(pts[i][0], pts[i][1]));
      if (v[2] >= 0) {
        const s = scr(v);
        d += (pen ? 'L' : 'M') + s[0].toFixed(1) + ' ' + s[1].toFixed(1);
        pen = true;
      } else pen = false;
    }
    return d;
  }

  function renderStatic() {
    setCam(view.lat, view.lon);
    // 大洲
    Object.keys(LAND).forEach(k => {
      const p = geo.land[k];
      p.setAttribute('d', polyVisible(LAND[k]) ? polyD(LAND[k]) : '');
    });
    geo.water.forEach((p, i) => p.setAttribute('d', polyVisible(WATER[i]) ? polyD(WATER[i]) : ''));
    // 经纬网
    geo.grat.forEach(g => g.el.setAttribute('d', lineD(g.pts)));
    // 大洲名称
    LABELS.forEach((Lb, i) => {
      const t = geo.labels[i], v = viewP(pvec(Lb.lon, Lb.lat));
      if (v[2] < 0.12) { t.setAttribute('opacity', '0'); return; }
      const s = scr(v);
      t.setAttribute('x', s[0].toFixed(1));
      t.setAttribute('y', (s[1] + 4).toFixed(1));
      t.setAttribute('opacity', v[2] > 0.3 ? '0.95' : (((v[2] - 0.12) / 0.18) * 0.95).toFixed(2));
    });
    updateLabelColors();
    updateMarker();
  }

  // 定位点随相机投影（拖拽旋转时沿球面移动，转到背面隐藏）
  function updateMarker() {
    if (!el.marker || !loc) return;
    const v = viewP(pvec(loc.lon, loc.lat));
    if (v[2] < 0.04) { el.marker.setAttribute('opacity', '0'); return; }
    el.marker.setAttribute('opacity', '1');
    const s = scr(v);
    el.marker.setAttribute('transform', `translate(${s[0].toFixed(1)} ${s[1].toFixed(1)})`);
  }

  function updateLabelColors() {
    const ms = globeNow();
    LABELS.forEach((Lb, i) => {
      const t = geo.labels[i];
      const day = altOf('sun', ms, Lb.lat, Lb.lon) > -6;
      t.setAttribute('fill', day ? '#1d4f7c' : '#eaf2fb');
      t.setAttribute('stroke', day ? '#ffffff' : '#0c1c42');
    });
  }

  /* ================= 每帧几何：晨昏线 + 太阳月亮 ================= */
  // 稳健垂直基：S 接近坐标轴时选最不对齐的轴构造 U。
  // 旧实现固定用 y 轴：S≈(0,±1,0) 时 u 为近零向量，归一化把舍入噪声放大成
  // 随机方向（甚至不再⊥S）→ 投影点跑出球面 → 球体抖动 / 黑影变长条。
  function perpBasis(S) {
    const ax = Math.abs(S[0]), ay = Math.abs(S[1]), az = Math.abs(S[2]);
    const ref = (ax <= ay && ax <= az) ? [1, 0, 0] : (ay <= az ? [0, 1, 0] : [0, 0, 1]);
    const d = ref[0] * S[0] + ref[1] * S[1] + ref[2] * S[2];
    let u = [ref[0] - d * S[0], ref[1] - d * S[1], ref[2] - d * S[2]];
    const ur = Math.hypot(u[0], u[1], u[2]) || 1;
    u = [u[0] / ur, u[1] / ur, u[2] / ur];
    const v = [S[1] * u[2] - S[2] * u[1], S[2] * u[0] - S[0] * u[2], S[0] * u[1] - S[1] * u[0]];
    return { u, v };
  }

  // 夜半球在可见盘上的填充路径：晨昏线可见弧 + 夜侧边缘弧闭合。
  // 退化特判（太阳恰在相机轴上）：正午 → 无夜；午夜 → 整盘皆夜。
  function termGeom(S) {
    const Sz = S[2];
    const amp = Math.sqrt(Math.max(0, 1 - Sz * Sz));   // 可见弧 z(t) 振幅 = |S_xy|
    if (amp < 1e-9) {
      if (Sz > 0) return { line: '', fill: '' };
      const r = R.toFixed(1);
      return { line: '', fill: `M${CX - R} ${CY}A${r} ${r} 0 1 0 ${CX + R} ${CY}A${r} ${r} 0 1 0 ${CX - R} ${CY}Z` };
    }
    const { u, v } = perpBasis(S);
    const zAt = t => Math.cos(t) * u[2] + Math.sin(t) * v[2];
    const ptAt = t => [Math.cos(t) * u[0] + Math.sin(t) * v[0], Math.cos(t) * u[1] + Math.sin(t) * v[1]];
    const N = 180, zs = [];
    for (let i = 0; i < N; i++) zs.push(zAt(i * 2 * Math.PI / N));
    let start = -1;
    for (let i = 0; i < N; i++) if (zs[i] >= 0 && zs[(i - 1 + N) % N] < 0) { start = i; break; }
    if (start < 0) return { line: '', fill: '' };
    const run = [];
    for (let i = 0; i < N; i++) {
      const idx = (start + i) % N;
      if (zs[idx] < 0) break;
      run.push(idx);
    }
    let lo = (run[0] - 1 + N) % N * 2 * Math.PI / N, hi = run[0] * 2 * Math.PI / N;
    if (hi < lo) hi += 2 * Math.PI;   // run[0]=0 缠绕：hi 归到 2π，否则二分收敛到错误过零点
    for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (zAt(mid) < 0) lo = mid; else hi = mid; }
    const tStart = hi;
    const lastIdx = run[run.length - 1];
    lo = lastIdx * 2 * Math.PI / N; hi = ((lastIdx + 1) % N) * 2 * Math.PI / N;
    if (hi < lo) hi += 2 * Math.PI;
    for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (zAt(mid) > 0) lo = mid; else hi = mid; }
    const tEnd = lo;
    const ts = [tStart];
    for (let i = 0; i < run.length; i++) ts.push(run[i] * 2 * Math.PI / N);
    ts.push(tEnd);
    const pts = ts.map(t => {
      const P = ptAt(t);
      return [CX + P[0] * R, CY - P[1] * R];
    });
    let line = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (let j = 1; j < pts.length; j++) line += 'L' + pts[j][0].toFixed(1) + ' ' + pts[j][1].toFixed(1);
    // 夜侧边缘弧：从弧终点 A 沿球沿折线回到起点 B。
    // 两支方向的中点互为对径点、测试值恰好反号，取中点落在夜侧（<0）的一支；
    // 用折线段而非 SVG arc，规避 large/sweep 旗标在端点接近对径时翻转 → 细条伪影。
    const A = pts[pts.length - 1], B = pts[0];
    const aA = Math.atan2(A[1] - CY, A[0] - CX), aB = Math.atan2(B[1] - CY, B[0] - CX);
    let dAng = aB - aA;
    while (dAng < 0) dAng += 2 * Math.PI;
    while (dAng >= 2 * Math.PI) dAng -= 2 * Math.PI;
    // 球沿屏幕角 θ 对应视坐标 xy = (cosθ, -sinθ)；z=0 处昼夜只看 xy·S
    const midTest = d => {
      const m = aA + d / 2;
      return Math.cos(m) * S[0] - Math.sin(m) * S[1];
    };
    const sweepD = midTest(dAng) < 0 ? dAng : dAng - 2 * Math.PI;
    const SEG = 60;
    let rim = '';
    for (let k = 1; k <= SEG; k++) {
      // atan2 的屏幕角 y 向下：重建点须用 +sin（视坐标翻转约定只用于投影）
      const ang = aA + sweepD * k / SEG;
      rim += 'L' + (CX + R * Math.cos(ang)).toFixed(1) + ' ' + (CY + R * Math.sin(ang)).toFixed(1);
    }
    return { line, fill: line + rim + 'Z' };
  }

  // 月亮亮面形状（盈亏）
  function moonLitPath(r, k, waxing) {
    const rx = Math.max(0.5, Math.abs(1 - 2 * k) * r).toFixed(1);
    const outerSweep = waxing ? 1 : 0;
    const innerSweep = k >= 0.5 ? outerSweep : (outerSweep ? 0 : 1);
    return `M 0 ${-r} A ${r} ${r} 0 0 ${outerSweep} 0 ${r} A ${rx} ${r} 0 0 ${innerSweep} 0 ${-r} Z`;
  }

  function renderFrame() {
    const ms = globeNow();
    // 太阳方向（视坐标）
    const sb = bodyLatLon('sun', ms);
    const Sv = viewP(pvec(sb.lon, sb.lat));
    const g = termGeom(Sv);
    el.night.setAttribute('d', g.fill);
    el.term.setAttribute('d', g.line);
    el.termGlow.setAttribute('d', g.line);

    // 太阳：按真实方位绕场景环；高度角 < 0 隐去
    const sunAlt = altOf('sun', ms, loc.lat, loc.lon);
    const azS = Math.atan2(Sv[0], Sv[1]);          // 自北起算
    el.sun.setAttribute('transform', `translate(${(CX + SUN_RING * Math.sin(azS)).toFixed(1)} ${(CY - SUN_RING * Math.cos(azS)).toFixed(1)})`);
    el.sun.setAttribute('opacity', sunAlt > -2 ? '1' : '0');

    // 月亮：出没显隐 + 盈亏
    const mb = bodyLatLon('moon', ms);
    const Mv = viewP(pvec(mb.lon, mb.lat));
    const moonAlt = altOf('moon', ms, loc.lat, loc.lon);
    const azM = Math.atan2(Mv[0], Mv[1]);
    el.moon.setAttribute('transform', `translate(${(CX + MOON_RING * Math.sin(azM)).toFixed(1)} ${(CY - MOON_RING * Math.cos(azM)).toFixed(1)})`);
    el.moon.setAttribute('opacity', moonAlt > 0 ? '1' : '0');
    const ill = moonIllum(ms);
    el.moonLit.setAttribute('d', moonLitPath(11, ill.k, ill.waxing));

    // 星空：夜间更亮
    el.stars.setAttribute('opacity', sunAlt > 0 ? '0.35' : '1');

    // 定位点昼夜变色 + 越晨昏线闪现
    const day = sunAlt > 0;
    if (day !== lastDay) {
      if (lastDay !== null) {
        el.mkLabel.textContent = day ? '日出' : '日落';
        el.mkLabel.setAttribute('class', 'on');
        clearTimeout(glintTimer);
        glintTimer = setTimeout(() => el.mkLabel.setAttribute('class', ''), 2600);
        // 重启动画必须先摘掉 class 再强制 reflow，否则同名 class 不会重放
        el.mkRing.setAttribute('class', '');
        void el.mkRing.getBoundingClientRect();
        el.mkRing.setAttribute('class', 'g-glint');
      }
      lastDay = day;
      const col = day ? '#f0625a' : '#8aa2d8';
      el.mkDot.setAttribute('fill', col);
      el.mkRing.setAttribute('stroke', col);
      el.mkHalo.setAttribute('stroke', col);
    }
    updateBar();   // 进度条逐帧平滑移动（演示模式下肉眼可见地推进）
  }

  /* ================= 信息栏（每 30 秒刷新） ================= */
  // 取「模拟时刻所在自然日」的日出日落：API 的 times 仅当与模拟同一天才采用（权威值），
  // 否则按模拟日期天文推算——否则演示自转越过当天后，进度条会永久卡死在端点、不随翻天复位。
  function dayRiseSet(ms) {
    const rs = riseSet('sun', ms, loc.lat, loc.lon);
    let sr = rs.rise || null, ss = rs.set || null;
    if (times && times.sunrise && times.sunset) {
      const a = new Date(times.sunrise.getTime()), b = new Date(ms);
      if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()) {
        sr = times.sunrise.getTime(); ss = times.sunset.getTime();
      }
    }
    return { sr, ss };
  }

  function renderPanel() {
    const ms = globeNow();
    const now = new Date(ms);
    const lat = loc.lat, lon = loc.lon;
    const { sr, ss } = dayRiseSet(ms);
    const mt = riseSet('moon', ms, lat, lon);
    el.sunrise.textContent = hhmm(sr);
    el.sunset.textContent = hhmm(ss);
    el.moonrise.textContent = hhmm(mt.rise);
    el.moonset.textContent = hhmm(mt.set);

    if (sr && ss) {
      const len = ss - sr;
      const hh = Math.floor(len / 3600000), mm = Math.round((len % 3600000) / 60000);
      el.daylen.textContent = `昼长 ${hh} 小时 ${pad(mm)} 分`;
      el.noon.textContent = '正午 ' + hhmm(new Date((sr + ss) / 2));
    }
    updateBar();

    const sunAlt = altOf('sun', ms, lat, lon);
    const h = now.getHours();
    el.state.textContent = sunAlt > 0 ? (h < 12 ? '白天 · 上午' : '白天 · 下午') : '夜间';
    const toDusk = ss && ms < ss ? ss - ms : null;
    const toDawn = (!toDusk && sr) ? (sr + 86400000 - ms) : null;
    const fmt = m => {
      const t = Math.max(0, Math.round(m / 60000));
      return t >= 60 ? `${Math.floor(t / 60)} 小时 ${pad(t % 60)} 分` : `${t} 分`;
    };
    el.countdown.textContent = toDusk != null ? `距日落 ${fmt(toDusk)}` : (toDawn != null ? `距日出 ${fmt(toDawn)}` : '');
  }

  /* ================= 昼夜进度条（逐帧更新，供拖动 scrub） ================= */
  function updateBar() {
    const ms = globeNow();
    const now = new Date(ms);
    const { sr, ss } = dayRiseSet(ms);
    el.endA.textContent = '日出 ' + hhmm(sr);
    el.endB.textContent = '日落 ' + hhmm(ss);
    if (sr && ss) {
      const pct = Math.min(1, Math.max(0, (ms - sr) / (ss - sr)));
      el.fill.style.width = (pct * 100).toFixed(1) + '%';
      el.nowDot.style.left = `calc(${(pct * 100).toFixed(1)}% - 9px)`;
      el.nowLab.style.left = (pct * 100).toFixed(1) + '%';
      el.nowLab.textContent = `现在 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    return { sr, ss };
  }

  // 进度条 scrub：把指针位置映射为日出→日落之间的模拟时刻
  function scrubTo(clientX) {
    const wrap = $('gBarWrap');
    if (!wrap || !wrap.getBoundingClientRect) return;
    const r = wrap.getBoundingClientRect();
    if (!r.width) return;
    const { sr, ss } = updateBar();
    if (!sr || !ss) return;
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    base = sr + pct * (ss - sr); epoch = Date.now();
    lastGeo = 0;
  }

  // 切换自转模式。切回「真实自转」= 一键复位：
  // 时间回到真实当前时刻、进度条归位、球体视角回到定位点居中（取消拖拽旋转）。
  function setMode(real) {
    if (real) {
      speed = 1;
      base = Date.now(); epoch = Date.now();
      if (loc) { view.lat = loc.lat; view.lon = loc.lon; }
      lastDay = null;
    } else {
      speed = DEMO_SPEED;
      base = globeNow(); epoch = Date.now();   // 演示从当前时刻起加速流逝
    }
    localStorage.setItem('globeSpeed', real ? 'real' : 'demo');
    if (el.marker) { renderStatic(); renderPanel(); lastGeo = 0; }
  }

  /* ================= 循环 ================= */
  function loop() {
    raf = requestAnimationFrame(loop);
    const widget = document.getElementById('widget');
    const scrolling = widget && widget.classList.contains('scrolling');
    const docked = document.body.classList.contains('docked') && !document.body.classList.contains('expanded');
    if (suspended || scrolling || docked || document.hidden || !onScreen) return;
    const now = Date.now();
    // 拖球 / 拖进度条时逐帧跟手；平时真实模式 2 秒、演示模式 30fps
    const interactive = dragging || scrubbing;
    const interval = interactive ? 33 : (speed === 1 ? 2000 : 33);
    if (now - lastGeo < interval) return;
    lastGeo = now;
    try {
      if (geoDirty) { renderStatic(); geoDirty = false; }
      renderFrame();
    } catch (e) { console.error('globe frame', e); }
  }

  /* ================= 对外接口 ================= */
  function init(mountId) {
    const mount = $(mountId || 'globeMount');
    if (!mount) return;
    mount.innerHTML = `
      <div class="g-row">
        <div class="g-stage" id="gStage"></div>
        <div class="g-col">
          <div class="g-tiles">
            <div class="g-tile"><div class="g-t">日出</div><div class="g-v" id="gSunrise">—:—</div></div>
            <div class="g-tile"><div class="g-t">日落</div><div class="g-v" id="gSunset">—:—</div></div>
            <div class="g-tile"><div class="g-t">月出</div><div class="g-v" id="gMoonrise">—:—</div></div>
            <div class="g-tile"><div class="g-t">月落</div><div class="g-v" id="gMoonset">—:—</div></div>
          </div>
          <div class="g-chips"><span class="chip" id="gState">—</span><span class="chip" id="gCountdown">—</span></div>
          <div class="g-chips"><span class="chip" id="gDaylen">—</span><span class="chip" id="gNoon">—</span></div>
        </div>
      </div>
      <div class="g-barwrap" id="gBarWrap"><div class="g-bar"><div class="g-fill" id="gFill"></div><div class="g-now" id="gNowDot"></div><div class="g-lab" id="gNowLab">现在</div></div></div>
      <div class="g-ends"><span id="gEndA">日出 —:—</span><span id="gEndB">日落 —:—</span></div>`;
    $('gStage').appendChild(buildSvg());

    el = {
      night: $('gNight'), term: $('gTerm'), termGlow: $('gTermGlow'),
      marker: $('gMarker'), mkDot: $('gMkDot'), mkRing: $('gMkRing'), mkHalo: $('gMkHalo'), mkLabel: $('gMkLabel'),
      sun: $('gSun'), moon: $('gMoon'), moonLit: $('gMoonLit'), stars: $('gStars'),
      sunrise: $('gSunrise'), sunset: $('gSunset'), moonrise: $('gMoonrise'), moonset: $('gMoonset'),
      state: $('gState'), countdown: $('gCountdown'), daylen: $('gDaylen'), noon: $('gNoon'),
      fill: $('gFill'), nowDot: $('gNowDot'), nowLab: $('gNowLab'), endA: $('gEndA'), endB: $('gEndB')
    };

    // 静态几何元素
    geo.land = {};
    Object.keys(LAND).forEach(k => {
      const p = document.createElementNS(NS, 'path');
      $('gLands').appendChild(p);
      geo.land[k] = p;
    });
    geo.water = WATER.map(() => {
      const p = document.createElementNS(NS, 'path');
      $('gWaters').appendChild(p);
      return p;
    });
    geo.grat = [];
    [-60, -30, 0, 30, 60].forEach(lat => {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 5) pts.push([lon, lat]);
      const p = document.createElementNS(NS, 'path');
      $('gGrat').appendChild(p);
      geo.grat.push({ el: p, pts });
    });
    for (let lon = -180; lon < 180; lon += 30) {
      const pts = [];
      for (let lat = -88; lat <= 88; lat += 6) pts.push([lon, lat]);
      const p = document.createElementNS(NS, 'path');
      $('gGrat').appendChild(p);
      geo.grat.push({ el: p, pts });
    }
    // geo.grat 保持 {el, pts} 结构，renderStatic 里 g.el.setAttribute('d', lineD(g.pts))
    geo.labels = LABELS.map(Lb => {
      const t = document.createElementNS(NS, 'text');
      t.textContent = Lb.zh;   // 必须赋文字，否则标签只是空文本节点
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', '15');
      t.setAttribute('font-weight', '500');
      t.setAttribute('stroke-width', '3.4');
      t.setAttribute('paint-order', 'stroke');
      t.setAttribute('opacity', '0');
      $('gLabels').appendChild(t);
      return t;
    });

    // 自转模式切换（切回「真实自转」= 一键复位：时间/进度条/球体视角）
    const modeBtn = $('globeMode');
    if (modeBtn) {
      const saved = localStorage.getItem('globeSpeed');
      if (saved === 'real') speed = 1; else if (saved === 'demo') speed = DEMO_SPEED;
      const sync = () => {
        modeBtn.textContent = speed === 1 ? '真实自转' : '演示自转';
        const sub = $('globeSub');
        if (sub) sub.textContent = speed === 1 ? '恒星时真实速度' : '45 秒/圈 · 时间流逝演示';
      };
      modeBtn.addEventListener('click', () => { setMode(speed !== 1); sync(); });
      sync();
    }

    // 拖拽旋转球体：按住地球拖动 → 相机跟手 360° 旋转，昼夜/日月/大陆/标签实时跟随
    // lastX/lastY 提升到 init 作用域：window mousemove 与 stage mousedown 共用
    let lastX = 0, lastY = 0;
    const stage = $('gStage');
    if (stage && stage.addEventListener) {
      stage.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        e.preventDefault();
      });
      stage.addEventListener('dblclick', () => {
        if (!loc) return;
        view.lat = loc.lat; view.lon = loc.lon;   // 双击复位：定位点回球心
        geoDirty = true; lastGeo = 0;
      });
    }

    // 拖动昼夜进度条 = 时间 scrub（在日出→日落之间来回拨动）
    const barWrap = $('gBarWrap');
    if (barWrap && barWrap.addEventListener) {
      barWrap.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        scrubbing = true; scrubTo(e.clientX);
        e.preventDefault();
      });
    }

    // 拖球/拖进度条的移动与松手挂在 window 上：滑出元素也不丢事件
    if (window.addEventListener) {
      window.addEventListener('mousemove', e => {
        if (dragging && stage) {
          const dx = e.clientX - lastX, dy = e.clientY - lastY;
          lastX = e.clientX; lastY = e.clientY;
          view.lon -= dx * 0.45;                       // 拖动方向与球面相反
          view.lat = Math.max(-85, Math.min(85, view.lat + dy * 0.45));
          geoDirty = true; lastGeo = 0;
        }
        if (scrubbing) scrubTo(e.clientX);
      });
      const release = () => {
        if (dragging) { dragging = false; }
        if (scrubbing) { scrubbing = false; }
      };
      window.addEventListener('mouseup', release);
      window.addEventListener('blur', release);
    }

    // 离屏暂停
    if (window.IntersectionObserver) {
      new IntersectionObserver(en => { onScreen = en[0].isIntersecting; }, { threshold: 0 })
        .observe($('gStage'));
    }

    setInterval(renderPanel, 30000);
    setInterval(updateLabelColors, 120000);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function update(newLoc, daily) {
    if (!newLoc) return;
    const posChanged = !loc || loc.lat !== newLoc.lat || loc.lon !== newLoc.lon;
    loc = newLoc;
    if (daily && daily.sunrise && daily.sunrise[0]) {
      times = {
        sunrise: new Date(daily.sunrise[0]),
        sunset: new Date(daily.sunset[0])
      };
    }
    moonTimes = null;
    if (posChanged && el.marker) {
      view.lat = newLoc.lat; view.lon = newLoc.lon;   // 换地点 → 相机回到定位点居中
      renderStatic();
      lastDay = null;
    }
    if (el.sunrise) renderPanel();
    lastGeo = 0;
  }

  function setSuspended(v) { suspended = !!v; }

  window.Globe = {
    init, update, setSuspended, setMode,
    _astro: { sunEq, moonEq, altOf, riseSet, moonIllum },
    _debug: {
      termGeom, perpBasis, globeNow,
      getView: () => ({ lat: view.lat, lon: view.lon }),
      getSpeed: () => speed,
      setSimTime: t => { base = t; epoch = Date.now(); },
      renderNow: () => { renderFrame(); }
    }
  };
})();
