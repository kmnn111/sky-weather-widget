'use strict';
/**
 * 氛围动画引擎：水彩天空渐变（按时段/天气）、太阳月亮轨迹、雨/雪/雾/雷/星光粒子
 */
const FX = (() => {
  let canvas, ctx, W = 0, H = 0;
  let particles = [], mode = 'clear', night = false;
  let flash = 0, nextFlash = 0, rafId = null;

  /* ---------- 天空渐变（吉卜力水彩色） ---------- */
  const PHASES = {
    night: ['#202a52', '#3a4a7d', '#5b6ba5'],
    dawn: ['#5b4a8a', '#e2789a', '#ffce8a'],
    day: ['#5aa8dd', '#8fcbe9', '#d8eefb'],
    dusk: ['#4b3a7d', '#c76d9f', '#ff9a5c'],
    evening: ['#2b3364', '#5d4e93', '#a06a9c']
  };
  const MOOD = {
    rain: ['rgba(72,88,120,0.72)', 'rgba(96,112,142,0.6)', 'rgba(120,136,166,0.5)'],
    thunder: ['rgba(48,56,84,0.85)', 'rgba(72,80,112,0.75)', 'rgba(96,104,136,0.6)'],
    snow: ['rgba(150,170,196,0.5)', 'rgba(180,198,218,0.42)', 'rgba(226,236,246,0.4)'],
    fog: ['rgba(150,158,172,0.6)', 'rgba(178,186,198,0.5)', 'rgba(206,212,222,0.42)'],
    cloudy: ['rgba(120,136,168,0.32)', 'rgba(150,166,194,0.26)', 'rgba(186,200,222,0.2)']
  };

  function phaseOf(h) {
    if (h < 5) return 'night';
    if (h < 8) return 'dawn';
    if (h < 16) return 'day';
    if (h < 19.5) return 'dusk';
    if (h < 21.5) return 'evening';
    return 'night';
  }

  let skyToggle = false;
  function paintSky(date, group) {
    const h = date.getHours() + date.getMinutes() / 60;
    // night 由 setMode(is_day) 统一决定（API 权威），这里不再按钟点猜测
    const p = PHASES[phaseOf(h)];
    const mood = MOOD[group] && group !== 'clear' ? MOOD[group] : null;
    const grad = `linear-gradient(180deg, ${p.join(', ')})`;
    const overlay = mood ? `linear-gradient(180deg, ${mood.join(', ')})` : 'none';

    const a = document.getElementById('skyA');
    const b = document.getElementById('skyB');
    if (!a || !b) return;
    const [show, hide] = skyToggle ? [a, b] : [b, a];
    show.style.backgroundImage = overlay === 'none' ? grad : `${overlay}, ${grad}`;
    // 白天只做 0.3 的极轻氛围染色（保持玻璃透明感）；夜晚加深染色，压出星空暗色调
    show.style.opacity = night ? '0.55' : '0.3';
    hide.style.opacity = '0';
    skyToggle = !skyToggle;

    const stars = document.getElementById('stars');
    if (stars) stars.style.opacity = night && (group === 'clear' || group === 'cloudy') ? '0.9' : '0';
  }

  /* ---------- 太阳 / 月亮轨迹 ----------
     位置用 transform 位移 + 过渡（合成层驱动，不触发重绘）；
     旧实现动画 left/top 会让日月带着大号光晕阴影每帧重绘 55 秒 → 明显卡顿。 */
  function placeCelestial(sunrise, sunset) {
    const sun = document.getElementById('sun');
    const moon = document.getElementById('moon');
    if (!sun || !moon) return;
    const now = Date.now();
    const parse = s => new Date(s.replace(' ', 'T') + ':00').getTime();
    const r = parse(sunrise), set = parse(sunset);
    const dayT = (now - r) / (set - r);
    const nightLen = 24 * 3600e3 - (set - r);
    const nightT = now > set ? (now - set) / nightLen : (now - r + (24 * 3600e3 - (set - r))) / nightLen;

    const put = (el, xp, yp) => {
      const x = xp * window.innerWidth / 100;
      const y = yp * window.innerHeight / 100;
      const jump = el._px === undefined
        || Math.abs(el._px - x) > window.innerWidth * 0.2
        || Math.abs(el._py - y) > window.innerHeight * 0.2;
      if (jump) el.style.transition = 'none'; // 昼夜切换/首次定位：瞬移，不滑行
      el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      if (jump) requestAnimationFrame(() => { el.style.transition = ''; });
      el._px = x; el._py = y;
    };

    if (dayT >= 0 && dayT <= 1) {
      sun.style.opacity = '1'; moon.style.opacity = '0';
      put(sun, 8 + dayT * 84, 46 - Math.sin(dayT * Math.PI) * 34);
    } else {
      sun.style.opacity = '0'; moon.style.opacity = '1';
      const t = ((nightT % 1) + 1) % 1;
      put(moon, 8 + t * 84, 42 - Math.sin(t * Math.PI) * 30);
    }
  }

  /* ---------- 粒子 ---------- */
  function resize() {
    if (!canvas) return;
    W = canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
    H = canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1);
    ctx && ctx.scale(1, 1);
  }

  function spawn() {
    particles = [];
    // 数量按 CSS 像素面积算：W/H 是含 dpr 的画布像素，直接相乘会让 2x 屏粒子翻 4 倍
    const n = Math.min(220, Math.round((canvas.offsetWidth * canvas.offsetHeight) / 24000));
    const mk = (extra) => Object.assign({
      x: Math.random() * W, y: Math.random() * H, r: Math.random() * 2 + 1,
      v: Math.random() * 1.5 + 0.4, a: Math.random() * 0.5 + 0.2, ph: Math.random() * Math.PI * 2
    }, extra);
    // 横向气流（风）：细长条快速掠过，传达"有风"
    const windWisps = (count) => {
      for (let i = 0; i < count; i++) {
        particles.push(mk({ wind: true, len: Math.random() * 80 + 55, v: Math.random() * 5 + 4, a: Math.random() * 0.18 + 0.06, y: Math.random() * H }));
      }
    };

    if (mode === 'rain' || mode === 'thunder') {
      for (let i = 0; i < n * 5; i++) particles.push(mk({ len: Math.random() * 22 + 12, v: Math.random() * 10 + 16 }));
      windWisps(Math.round(n * 0.6));
    } else if (mode === 'snow') {
      for (let i = 0; i < n * 3.2; i++) particles.push(mk({ r: Math.random() * 3.4 + 1.6, v: Math.random() * 1.3 + 0.6, drift: Math.random() * 1.5 }));
      windWisps(Math.round(n * 0.4));
    } else if (mode === 'fog') {
      for (let i = 0; i < 13; i++) particles.push(mk({ r: Math.random() * 160 + 110, v: Math.random() * 0.3 + 0.1, a: Math.random() * 0.22 + 0.11 }));
      windWisps(Math.round(n * 0.3));
    } else if (mode === 'cloudy') {
      // 多云：缓慢横向漂移的柔和云影 + 光尘 + 微风（不再静止）
      for (let i = 0; i < 6; i++) particles.push(mk({ cloud: true, r: Math.random() * 120 + 95, v: Math.random() * 0.4 + 0.14, a: Math.random() * 0.17 + 0.08 }));
      for (let i = 0; i < n * 0.5; i++) particles.push(mk({ r: Math.random() * 2.4 + 1, v: Math.random() * 0.3 + 0.1, a: Math.random() * 0.25 + 0.08 }));
      windWisps(Math.round(n * 0.5));
    } else if (mode === 'clear' && night) {
      for (let i = 0; i < n * 0.7; i++) particles.push(mk({ r: Math.random() * 1.6 + 0.5, v: 0, tw: Math.random() * 2 + 0.5 }));
    } else {
      // 晴天的光尘
      for (let i = 0; i < n * 0.35; i++) particles.push(mk({ r: Math.random() * 2.4 + 1, v: Math.random() * 0.3 + 0.1, a: Math.random() * 0.25 + 0.08 }));
    }
  }

  function tick(t) {
    rafId = null;
    if (!ctx || suspended || document.hidden) return;
    // 全部天气模式跟随屏幕刷新率（vsync）逐帧绘制，不隔帧、不锁帧
    ctx.clearRect(0, 0, W, H);
    const dpr = window.devicePixelRatio || 1;

    if (flash > 0) {
      ctx.fillStyle = `rgba(255,252,240,${flash})`;
      ctx.fillRect(0, 0, W, H);
      flash *= 0.86;
      if (flash < 0.01) flash = 0;
    }

    for (const p of particles) {
      if (p.wind) {
        // 风：细长横向气流掠过
        ctx.strokeStyle = `rgba(255,255,255,${p.a})`;
        ctx.lineWidth = 1.3 * dpr;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.len * dpr, p.y);
        ctx.stroke();
        p.x += p.v * dpr;
        if (p.x > W + p.len * dpr) { p.x = -p.len * dpr; p.y = Math.random() * H; }
        continue;
      }
      if (p.cloud) {
        // 多云：柔和云影横向漂移
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * dpr);
        g.addColorStop(0, `rgba(255,255,255,${p.a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * dpr, 0, Math.PI * 2);
        ctx.fill();
        p.x += p.v * dpr;
        if (p.x - p.r * dpr > W) p.x = -p.r * dpr;
        continue;
      }
      if (mode === 'rain' || mode === 'thunder') {
        ctx.strokeStyle = `rgba(214,234,255,${0.42 + p.a * 0.35})`;
        ctx.lineWidth = 1.9 * dpr;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - 5 * dpr, p.y + p.len * dpr);
        ctx.stroke();
        p.y += p.v * dpr; p.x -= 1.6 * dpr;
        if (p.y > H) { p.y = -20; p.x = Math.random() * (W + 120); }
      } else if (mode === 'snow') {
        ctx.fillStyle = `rgba(255,255,255,${0.5 + p.a * 0.4})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * dpr, 0, Math.PI * 2);
        ctx.fill();
        p.y += p.v * dpr;
        p.x += Math.sin(t / 900 + p.ph) * p.drift * dpr;
        if (p.y > H) { p.y = -8; p.x = Math.random() * W; }
      } else if (mode === 'fog') {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * dpr);
        g.addColorStop(0, `rgba(240,244,248,${p.a})`);
        g.addColorStop(1, 'rgba(240,244,248,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * dpr, 0, Math.PI * 2);
        ctx.fill();
        p.x += p.v * dpr;
        if (p.x - p.r * dpr > W) p.x = -p.r * dpr;
      } else if (mode === 'clear' && night) {
        const tw = 0.35 + 0.35 * Math.sin(t / 700 * p.tw + p.ph);
        ctx.fillStyle = `rgba(255,244,214,${tw})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * dpr, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 晴天的光尘
        const tw = 0.5 + 0.5 * Math.sin(t / 1100 + p.ph);
        ctx.fillStyle = `rgba(255,238,190,${p.a * tw})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * dpr, 0, Math.PI * 2);
        ctx.fill();
        p.y -= p.v * 0.3 * dpr;
        if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
      }
    }

    if (mode === 'thunder' && t > nextFlash) {
      flash = 0.22;
      nextFlash = t + 3500 + Math.random() * 6000;
    }
    rafId = requestAnimationFrame(tick);
  }

  /* ---------- 启停（隐藏/收起为小窗时暂停动画循环，省内存省电） ---------- */
  let suspended = false;
  function pump() {
    const idle = suspended || document.hidden;
    if (idle && rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    else if (!idle && rafId == null) rafId = requestAnimationFrame(tick);
  }
  function setSuspended(v) { suspended = !!v; pump(); }

  function start(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', () => { resize(); spawn(); });
    document.addEventListener('visibilitychange', pump);
    pump();
  }

  function setMode(group, isDay, date) {
    const map = {
      clear: 'clear', cloudy: 'cloudy', fog: 'fog',
      rain: 'rain', snow: 'snow', thunder: 'thunder'
    };
    night = !isDay;
    mode = map[group] || 'clear';
    spawn();
    if (date) paintSky(date, group === 'clear' ? 'clear' : group);
  }

  return { start, setMode, paintSky, placeCelestial, setSuspended };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FX;
