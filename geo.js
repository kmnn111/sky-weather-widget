'use strict';
/**
 * 地理 / 网络模块（从 main.js 抽出，便于 probe-geo.js 直接 require 跑真实链路自检）
 * - got：HTTP 抓取，网络层故障自动重试（专治长驻后 keep-alive 旧连接失效的 "fetch failed"）
 * - parseNominatim / parseOpenMeteoGeo：地名解析 -> 浙江 · 宁波 · 慈溪
 * - rankPlaces：多源结果合并排序（精确名 > 行政级别 > 人口，中文查询国内优先，
 *   同名小村镇不压过真正的区县市——「慈溪」不能搜出广西/安徽小村的根治点）
 * - searchPlaces：地点搜索，Nominatim + Open-Meteo 地理编码**并行合并**（一源挂掉不再拖慢），
 *   支持 opts.pinyin 拼音二次召回（Open-Meteo 库以拼音为名，中文只命中同名小村）+
 *   opts.hint 国内地名元数据加权（toy1 中国天气网地名库）+ opts.near 坐标就近偏置
 * - locateByIp：三源 IP 定位（ip-api + pconline 国内库 + ipwho.is）投票聚合，
 *   名字链取粒度最深者，坐标再用名字检索精化到正确区县（IP 库坐标常偏到运营商枢纽）
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
      if (opts.text) return await r.text();
      if (opts.gbk) return new TextDecoder('gbk').decode(Buffer.from(await r.arrayBuffer())); // 国内老服务常见 GBK
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

/* ---------------- 行政级别打分档（区县及以上 >> 普通村镇） ----------------
   Nominatim addresstype/type：city/county/state/administrative -> 区县及以上
   Open-Meteo feature_code（geonames）：PPLA*=行政驻地、PPL=普通村镇 */
const nomAdminLevel = t => {
  t = String(t || '').toLowerCase();
  if (['city', 'county', 'state', 'municipality', 'borough', 'administrative', 'region', 'province'].includes(t)) return 50;
  if (t === 'town') return 25;
  if (['village', 'hamlet', 'suburb', 'neighbourhood', 'isolated_dwelling'].includes(t)) return 5;
  return 15;
};
const omAdminLevel = fc => {
  fc = String(fc || '');
  if (/^(PPLA|PPLC)/.test(fc)) return 50;
  if (fc === 'PPLX') return 35;
  if (fc === 'PPL') return 12;
  return 20;
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
    display: (item.display_name || '').split(', ').filter(s => s && s !== '中国').join(' · '),
    // 排序元数据（rankPlaces 用）
    type: String(item.addresstype || item.type || '').toLowerCase(),
    adminLevel: nomAdminLevel(item.addresstype || item.type),
    importance: Number(item.importance) || 0,
    population: 0,
    countryCode: String(addr.country_code || '').toLowerCase()
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
      .filter((s, i, a) => s && a.indexOf(s) === i).join(' · '),
    // 排序元数据（rankPlaces 用）
    type: String(r.feature_code || '').toLowerCase(),
    adminLevel: omAdminLevel(r.feature_code),
    importance: 0,
    population: Number(r.population) || 0,
    countryCode: String(r.country_code || '').toLowerCase()
  };
}

/* ---------------- 距离（km，haversine） ---------------- */
function distKm(a, b) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR((b.lon - a.lon) * Math.cos(toR((a.lat + b.lat) / 2)));
  return R * Math.sqrt(dLat * dLat + dLon * dLon);
}

/* ---------------- 多源结果合并排序 ----------------
   打分：精确名匹配 >> 名字包含 >> 行政级别 >> 人口/重要性 >> 中文查询国内优先；
   opts.hint（toy1 国内地名元数据）：省名/上级名一致强加分，拼音命中补汉化显示名；
   opts.near：坐标就近偏置（IP 定位精化时同名区县选对地方）。
   去重：同 admin1 且距离 <15km 视为同一地（Nominatim/OM 双源命中只留高分）。 */
function rankPlaces(list, q, opts = {}) {
  const kw = clean(String(q || '')) || String(q || '');
  const hint = opts.hint || null;
  const near = opts.near && Number.isFinite(opts.near.lat) ? opts.near : null;

  const scored = list.filter(x => x && Number.isFinite(x.lat) && Number.isFinite(x.lon)).map(x => {
    let s = 0;
    const nm = clean(x.name) || x.name || '';
    if (kw && (nm === kw || x.name === q)) s += 100;
    else if (kw && (nm.includes(kw) || kw.includes(nm))) s += 30;
    s += x.adminLevel || 0;
    s += Math.log10((x.population || 0) + 1) * 6;
    s += (x.importance || 0) * 30;
    if (/[一-龥]/.test(kw)) {
      if (x.countryCode === 'cn' || (x.display || '').includes('中国')) s += 15;
    }
    if (hint) {
      const hn = clean(hint.name) || '';
      const pinyinHit = !!(hint.pinyin && x.name && !/[一-龥]/.test(x.name)
        && x.name.toLowerCase() === String(hint.pinyin).toLowerCase());
      if (pinyinHit) {
        // 拼音命中 = 该条目就是查询目标（toy1 权威拼音为证）：按精确名对待 + 显示名汉化
        s += 100;
        x.name = hint.name;
      } else if (hn && (nm === hn || x.name === hn)) s += 40;
      if (hint.province && x.admin1) {
        const hp = clean(hint.province);
        if (hp && (x.admin1.includes(hp) || hp.includes(x.admin1))) s += 30;
        else s -= 25; // 省对不上：多半是外地同名小村镇，降权（「慈溪」不许被安徽/广东小村压住）
      }
      if (hint.parent && x.parent) {
        const hpp = clean(hint.parent);
        if (hpp && (x.parent.includes(hpp) || hpp.includes(x.parent))) s += 15;
      }
    }
    if (near) {
      const d = distKm(near, x);
      if (d < 50) s += 45; else if (d < 200) s += 25; else if (d < 600) s += 8;
    }
    return { x, s };
  });

  scored.sort((a, b) => b.s - a.s || (b.x.population || 0) - (a.x.population || 0)
    || (b.x.importance || 0) - (a.x.importance || 0));
  const out = [];
  for (const { x } of scored) {
    const dup = out.some(y => (y.admin1 || '') === (x.admin1 || '') && distKm(y, x) < 15);
    if (!dup) out.push(x);
    if (out.length >= (opts.limit || 8)) break;
  }
  return out;
}

/* ---------------- 地点搜索：双源并行合并 + 智能排序 ----------------
   两源并行（Nominatim 慢/挂不再串行拖住 Open-Meteo）；都有结果时合并排序，
   只有一源可用时也能给出结果；全失败才抛错（由调用方转友好提示）。
   opts.pinyin：拼音二次召回（Open-Meteo 库以拼音为名，中文查询只命中同名小村镇，
   如「慈溪」-> 安徽/广东小村，而真慈溪市要查 "Cixi" 才出来）。 */
async function searchPlaces(q, opts = {}) {
  const kw = String(q == null ? '' : q).trim();
  const omSearch = term => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(term)}&count=8&language=zh&format=json`;
  const jobs = [
    got(`https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=zh&limit=8&addressdetails=1&q=${encodeURIComponent(kw)}`, 12000)
      .then(l => (Array.isArray(l) ? l : []).map(parseNominatim)),
    got(omSearch(kw), 10000).then(r => ((r && r.results) || []).map(parseOpenMeteoGeo))
  ];
  if (opts.pinyin) jobs.push(got(omSearch(opts.pinyin), 10000).then(r => ((r && r.results) || []).map(parseOpenMeteoGeo)));
  const settled = await Promise.all(jobs.map(p => p.then(v => ({ v }), e => ({ e }))));
  const ok = settled.filter(s => s.v);
  if (!ok.length) {
    const firstErr = (settled.find(s => s.e) || {}).e;
    throw firstErr || new Error('fetch failed');
  }
  const merged = ok.flatMap(s => s.v);
  return rankPlaces(merged, kw, opts);
}

/* ---------------- IP 定位：三源并行 + 投票聚合 ----------------
   ip-api：坐标 + district（部分宽带段有区县）；
   pconline：国内库（GBK），移动/电信归属比海外库准（省/市名，无坐标）；
   ipwho.is：坐标兜底。
   运营商 IP 注册常只到地级市且坐标偏到枢纽，故名字链取「票数多、粒度深」者，
   最终坐标用名字检索精化（locateByIp 里完成）。 */
const ipSources = [
  {
    key: 'ip-api',
    fn: async () => {
      const r = await got('http://ip-api.com/json/?lang=zh-CN&fields=status,country,regionName,city,district,lat,lon', 10000);
      if (!r || r.status !== 'success') return null;
      return { province: r.regionName || '', city: r.city || '', district: r.district || '', lat: r.lat, lon: r.lon };
    }
  },
  {
    key: 'pconline',
    fn: async () => {
      const t = await got('https://whois.pconline.com.cn/ipJson.jsp?json=true', 10000, { gbk: true }, 1);
      const r = JSON.parse(String(t).trim());
      if (!r || r.err) return null;
      return { province: r.pro || '', city: r.city || '', district: r.region || '', lat: NaN, lon: NaN };
    }
  },
  {
    key: 'ipwho',
    fn: async () => {
      const r = await got('https://ipwho.is/?lang=zh', 10000);
      if (!r || !r.success) return null;
      return { province: r.region || '', city: r.city || '', district: '', lat: r.latitude, lon: r.longitude };
    }
  }
];

/* 纯函数：候选投票聚合（probe-geo 可单测）
   两票以上胜出；平票时中文名优先、再长名优先（海外库英文名在中文环境降权）。 */
function aggregateIp(cands) {
  const vote = key => {
    const m = new Map();
    for (const c of cands) {
      const v = clean(c[key]);
      if (v) m.set(v, (m.get(v) || 0) + 1);
    }
    const arr = [...m.entries()];
    arr.sort((a, b) => b[1] - a[1]
      || (/[一-龥]/.test(b[0]) ? 1 : 0) - (/[一-龥]/.test(a[0]) ? 1 : 0)
      || b[0].length - a[0].length);
    return arr.length ? arr[0][0] : '';
  };
  const withCoords = cands.filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  return {
    province: vote('province'),
    city: vote('city'),
    district: cands.map(c => clean(c.district)).find(Boolean) || '',
    lat: withCoords.length ? withCoords[0].lat : NaN,
    lon: withCoords.length ? withCoords[0].lon : NaN
  };
}

/* 一键 IP 定位：投票出名字链 -> 用名字检索精化坐标 -> 返回地名结构。
   返回 { name, parent, admin1, lat, lon, display, province, city, district } 或 null。 */
async function locateByIp() {
  const settled = await Promise.all(ipSources.map(s => s.fn().then(v => v, () => null)));
  const cands = settled.filter(Boolean);
  if (!cands.length) return null;
  const agg = aggregateIp(cands);
  const label = agg.district || agg.city || agg.province;
  if (!label && !Number.isFinite(agg.lat)) return null;

  // 坐标精化：同名区县/市按「就近 + 行政链一致」选对（IP 库坐标常偏到运营商枢纽）
  let loc = null;
  if (label) {
    try {
      const results = await searchPlaces(label, {
        near: Number.isFinite(agg.lat) ? { lat: agg.lat, lon: agg.lon } : null,
        hint: { name: label, parent: agg.city, province: agg.province }
      });
      loc = results.find(x => (clean(x.name) || '') === (clean(label) || '')) || results[0] || null;
    } catch (e) { /* 地名服务挂了就用 IP 库坐标兜底 */ }
  }
  const base = loc || {
    name: clean(label) || '当前位置', parent: '', admin1: clean(agg.province),
    detail: '', lat: agg.lat, lon: agg.lon,
    display: [agg.province, agg.city, agg.district].filter(Boolean).join(' · ')
  };
  return { ...base, province: agg.province, city: agg.city, district: agg.district };
}

/* ---------------- 逆地理：坐标 -> 中文地址链（Nominatim reverse） ---------------- */
async function reverseGeo(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=zh&zoom=16&addressdetails=1&lat=${lat}&lon=${lon}`;
  const r = await got(url, 15000);
  return parseNominatim(r);
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

module.exports = {
  UA, got, clean, parseNominatim, parseOpenMeteoGeo,
  rankPlaces, searchPlaces, aggregateIp, locateByIp, reverseGeo, friendlyNetError
};
