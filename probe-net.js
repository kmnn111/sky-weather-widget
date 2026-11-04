'use strict';
/**
 * 数据源网络环境诊断（node probe-net.js 直接跑，换网络后跑一遍即知各源状况）
 * 覆盖：中国天气网 d1/toy1 + itboy(http 明文，劫持检测) + Open-Meteo + Nominatim + 三源 IP 定位
 *
 * 判定哲学（对应「不同网络环境」诉求）：
 * - 不可达不算 FAIL——境外源在部分网络下不可达是预期内的，降级链路就是为此设计；
 *   只打印 INFO 供诊断。
 * - 可达但形状不对（运营商劫持返回 HTML/垃圾）才算 FAIL——那会让数据解析失败。
 * - 唯一硬断言 data-available：国内链完整 或 Open-Meteo 可达（数据总有来源）。
 */
const { got } = require('./geo.js');
const { searchCityMeta, fetchIndex, fetchItboy } = require('./cn-source.js');

let pass = 0, fail = 0, info = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`net-test ${name}: PASS`); }
  else { fail++; console.log(`net-test ${name}: FAIL ${extra !== undefined ? JSON.stringify(extra) : ''}`); }
};
const note = (name, extra) => { info++; console.log(`net-test ${name}: INFO ${extra !== undefined ? JSON.stringify(extra) : ''}`); };

const time = async fn => {
  const t = Date.now();
  try { const v = await fn(); return { ms: Date.now() - t, v }; }
  catch (e) { return { ms: Date.now() - t, e: String((e && e.message) || e).slice(0, 100) }; }
};

(async () => {
  let cnChainOk = false, omOk = false;

  /* ① 中国天气网 toy1 地名搜索（限流返回 "()" 也算可达，形状由 searchCityMeta 内部容错） */
  {
    const r = await time(() => searchCityMeta('慈溪'));
    if (r.e) note('toy1-search', `unreachable ${r.ms}ms ${r.e}`);
    else if (r.v && r.v.code) { check('toy1-search-shape', r.v.code === '101210403', r.v); note('toy1-search', `${r.ms}ms code=${r.v.code}`); }
    else { note('toy1-search', `${r.ms}ms empty（可能限流）`); }
  }

  /* ② 中国天气网 d1 实况（要 Referer，解析 dataSK） */
  {
    const r = await time(() => fetchIndex('101210403'));
    if (r.e) note('d1-index', `unreachable ${r.ms}ms ${r.e}`);
    else if (r.v && r.v.sk) {
      check('d1-index-shape', Number.isFinite(Number(r.v.sk.temp)), r.v.sk && r.v.sk.temp);
      note('d1-index', `${r.ms}ms sk ok`);
      cnChainOk = true; // 国内链至少一段真解析成功即视为可用
    } else { check('d1-index-shape', false, r.v); }
  }

  /* ③ itboy 7 天聚合（http 明文：可达但 JSON 形状坏 = 运营商劫持，会触发降级） */
  {
    const r = await time(() => fetchItboy('101210403'));
    if (r.e) note('itboy-http', `unreachable ${r.ms}ms ${r.e}（降级 Open-Meteo）`);
    else if (r.v && r.v.data && Array.isArray(r.v.data.forecast)) {
      check('itboy-json-shape', r.v.data.forecast.length >= 7, r.v.data.forecast.length);
      note('itboy-http', `${r.ms}ms forecast=${r.v.data.forecast.length}d`);
      cnChainOk = true;
    } else { check('itboy-json-shape', false, '可达但 JSON 形状异常（疑似劫持）→ 将降级 Open-Meteo'); }
  }

  /* ④ Open-Meteo（海外源：慢/不通在部分网络是常态） */
  {
    const r = await time(() => got('https://api.open-meteo.com/v1/forecast?latitude=30.17&longitude=121.23&current=temperature_2m', 15000, {}, 1));
    if (r.e) note('open-meteo', `unreachable ${r.ms}ms ${r.e}`);
    else if (r.v && r.v.current) { check('om-shape', Number.isFinite(r.v.current.temperature_2m), r.v.current); omOk = true; note('open-meteo', `${r.ms}ms`); }
    else check('om-shape', false, r.v);
  }

  /* ⑤ Nominatim（境外源：部分网络不可达 -> 搜索自动落 Open-Meteo + 拼音召回） */
  {
    const r = await time(() => got('https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=zh&limit=1&q=%E6%85%88%E6%BA%AA', 12000, {}, 1));
    if (r.e) note('nominatim', `unreachable ${r.ms}ms ${r.e}（搜索走 Open-Meteo 兜底）`);
    else if (Array.isArray(r.v)) { check('nominatim-shape', r.v.every(x => x && x.lat), r.v.length); note('nominatim', `${r.ms}ms n=${r.v.length}`); }
    else check('nominatim-shape', false, r.v);
  }

  /* ⑥ IP 定位三源（粒度诊断：移动宽带常只到地级市） */
  {
    const r = await time(() => got('http://ip-api.com/json/?lang=zh-CN&fields=status,country,regionName,city,district,lat,lon', 10000, {}, 1));
    if (r.e) note('ip-api', `unreachable ${r.ms}ms ${r.e}`);
    else note('ip-api', `${r.ms}ms ${JSON.stringify({ p: r.v.regionName, c: r.v.city, d: r.v.district })}`);
  }
  {
    const r = await time(() => got('https://whois.pconline.com.cn/ipJson.jsp?json=true', 10000, { gbk: true }, 1));
    if (r.e) note('pconline', `unreachable ${r.ms}ms ${r.e}`);
    else {
      try {
        const j = JSON.parse(String(r.v).trim());
        check('pconline-gbk-shape', !!(j && (j.pro || j.city)), j);
        note('pconline', `${r.ms}ms ${JSON.stringify({ p: j.pro, c: j.city, d: j.region })}`);
      } catch (e) { check('pconline-gbk-shape', false, String(r.v).slice(0, 80)); }
    }
  }
  {
    const r = await time(() => got('https://ipwho.is/?lang=zh', 10000, {}, 1));
    if (r.e) note('ipwho', `unreachable ${r.ms}ms ${r.e}`);
    else note('ipwho', `${r.ms}ms ${JSON.stringify({ c: r.v.city, lat: r.v.latitude })}`);
  }

  /* 硬断言：数据总有来源（国内链可用 或 Open-Meteo 可达 -> 降级链路成立） */
  check('data-available', cnChainOk || omOk, { cnChainOk, omOk });

  console.log(`net-test summary pass=${pass} fail=${fail} info=${info}`);
  console.log('net-test 提示：INFO=该网络下不可达（降级链路兜底，不算失败）；FAIL=可达但数据形状坏（需修）');
  process.exit(fail ? 1 : 0);
})();
