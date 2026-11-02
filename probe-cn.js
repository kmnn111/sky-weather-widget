'use strict';
/**
 * cn-source.js 自检（node probe-cn.js 直接跑，无需启动 Electron）
 * 覆盖：① wmoFromCn 天气码/中文词映射 ② searchCityCode toy1 真实搜索（含 12 位街道码归并）
 *      ③ fetchIndex 实况/预警/生活指数解析 ④ fetchItboy 7 天+日出日落+空气（http 明文）
 *      ⑤ fetchCn 归一化全链路 ⑥ mergeCn 覆盖合并 + 日期对齐 + 降级路径
 */
const cn = require('./cn-source.js');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`cn-test ${name}: PASS`); }
  else { fail++; console.log(`cn-test ${name}: FAIL ${extra !== undefined ? JSON.stringify(extra) : ''}`); }
};

(async () => {
  /* ① wmoFromCn 映射 */
  const m1 = cn.wmoFromCn('d00', '晴');
  check('wmo-d00', m1.wmo === 0 && m1.isDay === 1, m1);
  const m2 = cn.wmoFromCn('n07', '小雨');
  check('wmo-n07', m2.wmo === 61 && m2.isDay === 0, m2);
  const m3 = cn.wmoFromCn('', '多云转晴');
  check('wmo-text-combo', m3.wmo === 2, m3);
  const m4 = cn.wmoFromCn('', '小到中雨');
  check('wmo-text-range', m4.wmo === 63, m4);   // 区间词归高段：小到中雨 -> 中雨（与 d21 映射一致）
  const m5 = cn.wmoFromCn('d53', '霾');
  check('wmo-d53', m5.wmo === 45, m5);
  const m6 = cn.wmoFromCn('zz', '外星天气');
  check('wmo-fallback', m6.wmo === 3, m6);

  /* ② searchCityCode 真实搜索 */
  const cx = await cn.searchCityCode('慈溪');
  check('search-cixi', cx === '101210403', cx);
  const bj = await cn.searchCityCode('北京');
  check('search-beijing', bj === '101010100', bj);
  const none = await cn.searchCityCode('zzzz不存在地名qqq');
  check('search-none', none === null, none);
  const again = await cn.searchCityCode('慈溪'); // 命中缓存
  check('search-cached', again === '101210403', again);

  /* ③ fetchIndex 实况/预警/生活指数 */
  const idx = await cn.fetchIndex('101210403');
  check('index-sk', !!(idx.sk && idx.sk.cityname === '慈溪' && Number.isFinite(Number(idx.sk.temp))), idx.sk);
  check('index-alarm-shape', !!idx.alarm && Array.isArray(idx.alarm.w), idx.alarm);
  check('index-zs', !!(idx.zs && idx.zs.zs && idx.zs.zs.gm_name), idx.zs && Object.keys(idx.zs));

  /* ④ fetchItboy 7 天 + 空气（itboy 实返 15 天，归一化截 7 天） */
  const itb = await cn.fetchItboy('101210403');
  const fc = itb && itb.data && itb.data.forecast;
  check('itboy-7day', !!(fc && fc.length >= 7 && /^\d{4}-\d{2}-\d{2}$/.test(fc[0].ymd)), fc && fc.length);
  check('itboy-sun', !!(fc && /^\d{2}:\d{2}$/.test(fc[0].sunrise) && /^\d{2}:\d{2}$/.test(fc[0].sunset)), fc && fc[0]);
  check('itboy-air', !!(itb && Number.isFinite(Number(itb.data.pm25)) && itb.data.quality), itb && itb.data && itb.data.quality);

  /* ⑤ fetchCn 归一化全链路 */
  const r = await cn.fetchCn('慈溪');
  check('fetchcn-not-null', !!r, r);
  if (r) {
    const c = r.current || {};
    check('norm-current', Number.isFinite(c.temperature_2m) && Number.isFinite(c.weather_code) &&
      Number.isFinite(c.pressure_msl) && Number.isFinite(c.visibility) && c.visibility >= 1000, c);
    check('norm-daily', !!(r.daily && r.daily.time.length === 7 && r.daily.sunrise[0] &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.daily.sunrise[0])), r.daily && r.daily.sunrise[0]);
    check('norm-air', !!(r.air && Number.isFinite(r.air.pm2_5) && r.air.pm10 != null), r.air);
    check('norm-alerts-array', Array.isArray(r.alerts), r.alerts);
    check('norm-city', r.city === '慈溪' && r.code === '101210403', { city: r.city, code: r.code });
  }

  /* ⑥ mergeCn 覆盖合并 + 日期对齐 + 降级 */
  const w = {
    current: { temperature_2m: 99, weather_code: 71, is_day: 0, apparent_temperature: 5 },
    daily: { time: ['2026-11-02', '2029-01-01'], weather_code: [1, 1], temperature_2m_max: [1, 1], temperature_2m_min: [0, 0], sunrise: ['a', 'b'], sunset: ['x', 'y'] }
  };
  const air = { current: { pm2_5: 999, pm10: 999, ozone: 80 } };
  const s = cn.mergeCn(w, air, r);
  check('merge-sources', s.current === '中国天气网' && s.daily === '中国天气网' && s.air === '中国天气网 + Open-Meteo' && s.hourly === 'Open-Meteo', s);
  check('merge-current', w.current.temperature_2m !== 99 && w.current.apparent_temperature === 5, w.current);
  check('merge-date-align', w.daily.time[0] === '2026-11-02' && w.daily.sunrise[0] !== 'a' && w.daily.sunrise[1] === 'b', w.daily);
  check('merge-air-pm', air.current.pm2_5 !== 999 && air.current.ozone === 80, air.current);
  const w2 = { current: { temperature_2m: 1 } };
  const s2 = cn.mergeCn(w2, null, null);
  check('merge-fallback', s2.current === 'Open-Meteo' && w2.current.temperature_2m === 1, s2);

  console.log(`cn-test summary pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
