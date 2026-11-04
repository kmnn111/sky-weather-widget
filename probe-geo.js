'use strict';
/**
 * geo.js 自检（node probe-geo.js 直接跑，无需启动 Electron）
 * 覆盖：① parseNominatim 回归（直辖市/省市链/新区）② parseOpenMeteoGeo 映射
 *      ③ searchPlaces 真实双源搜索 ④ got() 网络层故障自动重试 ⑤ HTTP 错误不重试
 *      ⑥ rankPlaces 智能排序（同名小村镇不压过真区县市 + 拼音召回汉化 + 就近偏置）
 *      ⑦ aggregateIp IP 投票聚合 ⑧ 拼音召回实测（「慈溪」必须搜出浙江，不许广西/安徽小村）
 */
const { got, parseNominatim, parseOpenMeteoGeo, searchPlaces, rankPlaces, aggregateIp, friendlyNetError } = require('./geo.js');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`geo-test ${name}: PASS`); }
  else { fail++; console.log(`geo-test ${name}: FAIL ${extra !== undefined ? JSON.stringify(extra) : ''}`); }
};

(async () => {
  /* ① parseNominatim 回归 */
  const cx = parseNominatim({ display_name: '慈溪市, 宁波市, 浙江省, 中国', name: '慈溪', lat: '30.17', lon: '121.27', address: {} });
  check('nominatim-cixi', cx.name === '慈溪' && cx.parent === '宁波' && cx.admin1 === '浙江' && Math.abs(cx.lat - 30.17) < 1e-9, cx);
  const bj = parseNominatim({ display_name: '北京市, 中国', name: '北京市', lat: '39.9', lon: '116.4', address: {} });
  check('nominatim-beijing', bj.name === '北京' && bj.parent === '' && bj.admin1 === '北京', bj);
  const pd = parseNominatim({ display_name: '浦东新区, 上海市, 中国', name: '浦东新区', lat: '31.2', lon: '121.5', address: {} });
  check('nominatim-pudong', pd.name === '浦东新区' && pd.admin1 === '上海', pd);

  /* ② parseOpenMeteoGeo 映射 */
  const om = parseOpenMeteoGeo({ name: '慈溪', latitude: 31.21753, longitude: 118.87493, admin1: '安徽', admin2: '宣城市' });
  check('om-geo-map', om.name === '慈溪' && om.parent === '宣城' && om.admin1 === '安徽' && Math.abs(om.lat - 31.21753) < 1e-6, om);
  const om2 = parseOpenMeteoGeo({ name: '朝阳区', latitude: 39.92, longitude: 116.48, admin1: '北京市', admin2: '北京市' });
  check('om-geo-muni', om2.name === '朝阳' && om2.admin1 === '北京' && om2.parent === '' && om2.detail === '', om2);

  /* ③ searchPlaces 真实双源搜索 */
  for (const q of ['慈溪', '北京', '朝阳区']) {
    try {
      const out = await searchPlaces(q);
      const ok = Array.isArray(out) && out.length > 0 && out.every(x => Number.isFinite(x.lat) && Number.isFinite(x.lon) && x.name);
      check('search-' + q, ok, out.slice(0, 2));
      if (ok) console.log(`geo-test search-${q} top:`, JSON.stringify(out[0]));
    } catch (e) { check('search-' + q, false, String(e.message)); }
  }
  try {
    const out = await searchPlaces('zzzz不存在地名qqq');
    check('search-empty', Array.isArray(out) && out.length === 0, out);
  } catch (e) { check('search-empty', false, String(e.message)); }

  /* ④ got() 网络层故障自动重试（模拟死连接：首次 fetch failed，重试成功） */
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) { const e = new TypeError('fetch failed'); e.cause = new Error('read ECONNRESET'); throw e; }
    return { ok: true, json: async () => ({ ok: 1 }) };
  };
  try {
    const r = await got('https://example.invalid/x', 3000);
    check('got-retry', calls === 2 && r.ok === 1, { calls, r });
  } catch (e) { check('got-retry', false, { calls, err: String(e.message) }); }

  /* ⑤ HTTP 状态错误不重试（429 等直接抛出，避免加重限流） */
  calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 429 }; };
  try {
    await got('https://example.invalid/x', 3000);
    check('got-no-retry-on-http', false, { calls });
  } catch (e) {
    check('got-no-retry-on-http', calls === 1 && /HTTP 429/.test(e.message), { calls, err: e.message });
  }
  /* 超时中断也不重试 */
  calls = 0;
  global.fetch = (u, o) => new Promise((_, rej) => {
    calls++;
    o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  });
  try {
    await got('https://example.invalid/x', 300);
    check('got-no-retry-on-abort', false, { calls });
  } catch (e) {
    check('got-no-retry-on-abort', calls === 1, { calls });
  }
  global.fetch = realFetch;

  /* ⑥ rankPlaces 智能排序（确定性 fixture，不依赖网络） */
  const fakeCixiZj = parseNominatim({
    display_name: '慈溪市, 宁波市, 浙江省, 中国', name: '慈溪', lat: '30.17', lon: '121.26',
    address: { country_code: 'cn' }, addresstype: 'city', type: 'administrative', importance: 0.49
  });
  const fakeCixiAh = parseOpenMeteoGeo({ name: '慈溪', latitude: 31.21753, longitude: 118.87493, admin1: '安徽', admin2: '宣城市', country_code: 'CN', feature_code: 'PPL', population: 5000 });
  const fakeCixiGd = parseOpenMeteoGeo({ name: '慈溪', latitude: 22.34363, longitude: 113.09306, admin1: '广东', admin2: '江门市', country_code: 'CN', feature_code: 'PPL' });
  // ⑥a 精确名同分时：行政级别/重要性让真区县市压过同名小村镇（用户「广西慈溪」bug 的根治点）
  const ranked = rankPlaces([fakeCixiAh, fakeCixiGd, fakeCixiZj], '慈溪');
  check('rank-cixi-zj-first', ranked[0] && ranked[0].admin1 === '浙江', ranked.map(x => x.admin1));
  // ⑥b 拼音召回 + 汉化：toy1 hint 把 OM 的 "Cixi"（真慈溪市）顶到第一并汉化显示名
  const fakeCixiPy = parseOpenMeteoGeo({ name: 'Cixi', latitude: 30.1764, longitude: 121.2457, admin1: '浙江', admin2: '宁波市', country_code: 'CN', feature_code: 'PPLA3', population: 1457510 });
  const ranked2 = rankPlaces([fakeCixiAh, fakeCixiGd, fakeCixiPy], '慈溪', { hint: { name: '慈溪', province: '浙江', pinyin: 'Cixi' } });
  check('rank-pinyin-rescue', ranked2[0] && ranked2[0].name === '慈溪' && ranked2[0].admin1 === '浙江', ranked2.map(x => [x.name, x.admin1]));
  // ⑥c 同名双命中去重（浙江两源同地只留一条）+ 就近偏置（IP 定位精化选对地方）
  const dedup = rankPlaces([fakeCixiZj, parseOpenMeteoGeo({ name: '慈溪', latitude: 30.1764, longitude: 121.2457, admin1: '浙江', admin2: '宁波市', country_code: 'CN', feature_code: 'PPLA3', population: 1457510 })], '慈溪');
  check('rank-dedup', dedup.length === 1 && dedup[0].admin1 === '浙江', dedup.map(x => [x.name, x.admin1, x.lat]));
  const nearPick = rankPlaces([fakeCixiAh, fakeCixiZj], '慈溪', { near: { lat: 30.18, lon: 121.25 } });
  check('rank-near-bias', nearPick[0] && nearPick[0].admin1 === '浙江', nearPick.map(x => x.admin1));

  /* ⑦ aggregateIp 投票聚合（确定性 fixture）：两源一致胜出、区县取最深 */
  const agg = aggregateIp([
    { province: '浙江省', city: '宁波市', district: '', lat: 29.87, lon: 121.55 },
    { province: '浙江省', city: '宁波市', district: '鄞州区', lat: NaN, lon: NaN },
    { province: 'Zhejiang', city: 'Ningbo', district: '', lat: 29.9, lon: 121.5 }
  ]);
  check('aggregate-ip-vote', agg.province === '浙江' && agg.city === '宁波' && agg.district === '鄞州'
    && Math.abs(agg.lat - 29.87) < 1e-9, agg);

  /* ⑧ 拼音召回实测：「慈溪」+ toy1 hint，无论 Nominatim 在线与否，第一必须是浙江慈溪 */
  try {
    const out = await searchPlaces('慈溪', { pinyin: 'Cixi', hint: { name: '慈溪', province: '浙江', pinyin: 'Cixi' } });
    check('search-cixi-zj-live', !!(out[0] && out[0].admin1 === '浙江' && out[0].name === '慈溪'), out.slice(0, 3).map(x => [x.name, x.admin1]));
    if (out[0]) console.log('geo-test search-cixi-zj-live top:', JSON.stringify(out[0]));
  } catch (e) { check('search-cixi-zj-live', false, String(e.message)); }

  /* ⑨ 友好错误文案 */
  check('friendly-net', friendlyNetError(new TypeError('fetch failed')) === '网络连接失败，请检查网络后重试');
  check('friendly-http', friendlyNetError(new Error('HTTP 429')) === '地名服务暂时不可用，请稍后重试');

  console.log(`geo-test summary pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
