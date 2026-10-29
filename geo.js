'use strict';
/**
 * 地理 / 网络模块（从 main.js 抽出，便于 probe-geo.js 直接 require 跑真实链路自检）
 * - got：HTTP 抓取，网络层故障自动重试（专治长驻后 keep-alive 旧连接失效的 "fetch failed"）
 * - parseNominatim / parseOpenMeteoGeo：地名解析 -> 浙江 · 宁波 · 慈溪
 * - searchPlaces：地点搜索，主源 Nominatim + Open-Meteo 地理编码双源兜底
 */

const UA = 'SkyWeatherWidget/1.0 (Windows desktop widget)';

/* ---------------- HTTP 抓取：网络层失败自动重试一次 ----------------
   长时间驻留（开机自启）后 undici 连接池里的旧 socket 可能已失效，
   下一次请求会抛 TypeError "fetch failed"（cause: ECONNRESET/ECONNREFUSED 等），
   重试一次即可换新连接恢复——这正是「搜索偶发失败、再点一次就好」的根因。
   HTTP 状态码错误（429 限流等）与超时中断不重试，避免加重服务端负担或拖长等待。 */
const got = async (u, ms = 12000, opts = {}, tries = 2) => {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      const isNet = !!(e && e.cause) && e.name !== 'AbortError' && !/^HTTP /.test(String(e.message || ''));
      if (!isNet || i >= tries - 1) throw e;
      await new Promise(res => setTimeout(res, 350));   // 短暂退避后换新连接重试
    }
  }
  throw lastErr;
};

/* ---------------- 地名后缀清理 ---------------- */
const clean = s => {
  s = s || '';
  if (/新区$/.test(s)) return s; // 浦东新区 / 滨海新区 等整名保留
  return s.replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|特別行政區|自治州|自治县|自治縣|自治区|地区|省|市|县|縣|区|區|旗|盟|乡|鄉|镇|鎮)$/, '');
};

/* ---------------- 地理解析：Nominatim -> 浙江 · 宁波 · 慈溪 ---------------- */
function parseNominatim(item) {
  const parts = (item.display_name || '').split(', ').map(s => s.trim())
    .filter(s => s && s !== '中国' && !/^\d{6}$/.test(s));
  // 港澳台返回繁体，后缀识别需兼容；香港/澳门/台湾视为省级
  const isProvince = s => /(省|自治区|自治縣|特别行政区|特別行政區)$/.test(s)
    || /^(北京|上海|天津|重庆)市$/.test(s)
    || /^(香港|澳门|澳門|台湾|台灣)/.test(s);
  const isDistrict = s => /(区|區|县|縣|旗)$/.test(s) && !/市$/.test(s);
  const addr = item.address || {};

  // display_name 从具体到一般：[具体地名, 区县, 地级市, 省]
  const list = parts.slice();
  // 兼容两种地址链顺序：一般→具体（如"浙江省 · 宁波市 · 慈溪市"）先翻转
  if (list.length >= 2 && isProvince(list[0]) && !isProvince(list[list.length - 1])) list.reverse();
  let province = '', prefecture = '', county = '', detail = '';
  if (list.length && isProvince(list[list.length - 1])) province = list.pop(); // 含直辖市
  if (list.length) {
    const last = list[list.length - 1];
    if (isDistrict(last)) {
      // 末位是区/县（直辖市或省直管）：没有地级市一层
      county = list.pop();
      detail = list.join(' · ');
    } else if (list.length >= 2) {
      // [具体地名?, 区县, 地级市]
      prefecture = list.pop();
      county = list.pop();
      detail = list.join(' · ');
    } else {
      county = list.pop(); // 只剩单个市/县
    }
  }
  if (!province) province = addr.state || '';
  if (!detail) detail = addr.town || addr.suburb || addr.village || addr.hamlet || addr.road || '';

  const name = clean(county || item.name || detail || '未知地点');
  const parentRaw = clean(prefecture);
  const admin1 = clean(province);
  const detailClean = clean(detail.split(' · ')[0]) === name ? '' : detail;
  return {
    name,
    parent: parentRaw === admin1 ? '' : parentRaw, // 直辖市去重
    detail: detailClean,
    admin1,
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
    display: (item.display_name || '').split(', ').filter(s => s && s !== '中国').join(' · ')
  };
}

/* ---------------- 地理解析：Open-Meteo 地理编码 -> 与 parseNominatim 同构 ---------------- */
function parseOpenMeteoGeo(r) {
  const nameRaw = r.name || '';
  const name = clean(nameRaw) || nameRaw;
  const admin1 = clean(r.admin1);
  const parentRaw = clean(r.admin2);
  const detailRaw = r.admin3 ? clean(r.admin3) : '';
  return {
    name,
    parent: parentRaw === admin1 || parentRaw === name ? '' : parentRaw,
    detail: detailRaw === name ? '' : detailRaw,
    admin1,
    lat: parseFloat(r.latitude),
    lon: parseFloat(r.longitude),
    display: [nameRaw, r.admin3, r.admin2, r.admin1]
      .filter((s, i, a) => s && a.indexOf(s) === i).join(' · ')
  };
}

/* ---------------- 地点搜索：双源兜底 ----------------
   主源 Nominatim（地名全、中文地址链规范）；
   网络故障或无结果时自动切换 Open-Meteo 地理编码（免密钥、CDN 稳定）。
   两源都失败才抛错（由调用方转友好提示）。 */
async function searchPlaces(q) {
  const nomUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=zh&limit=8&addressdetails=1&q=${encodeURIComponent(q)}`;
  try {
    const list = await got(nomUrl, 12000);
    const out = (Array.isArray(list) ? list : []).map(parseNominatim).filter(x => Number.isFinite(x.lat));
    if (out.length) return out;
  } catch (e) { /* 主源故障 → 落兜底源 */ }
  const omUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=zh&format=json`;
  const r = await got(omUrl, 10000);
  return (r.results || []).map(parseOpenMeteoGeo).filter(x => Number.isFinite(x.lat));
}

/* ---------------- 友好错误文案 ---------------- */
function friendlyNetError(e) {
  const msg = String((e && e.message) || e || '');
  if (/fetch failed|aborted|abort|timeout|timed out|ENOTFOUND|ECONN|EAI_AGAIN|EPIPE|ETIMEDOUT|network/i.test(msg)) {
    return '网络连接失败，请检查网络后重试';
  }
  if (/^HTTP /.test(msg)) return '地名服务暂时不可用，请稍后重试';
  return msg;
}

module.exports = { UA, got, clean, parseNominatim, parseOpenMeteoGeo, searchPlaces, friendlyNetError };
