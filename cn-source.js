'use strict';
/**
 * 国内天气数据源（中国天气网 d1.weather.com.cn + itboy 聚合，均为免密钥公开接口）
 * - searchCityCode：toy1 地名搜索 -> 9 位城市天气码（含街道级 12 位码归并到所属城市）
 * - fetchIndex：weather_index 单发拿全（实况 dataSK + 官方预警 alarmDZ + 生活指数 dataZS）
 * - fetchItboy：7 天预报 + 日出日落 + 空气（pm25/pm10/quality）+ 昨日实况
 *   ⚠️ itboy 服务端 HTTPS 证书链损坏（TLS handshake failure），必须走 http 明文
 * - wmoFromCn：中国天气网天气码（d00/n01）或中文天气词 -> WMO 码（渲染层零改动的关键归一化）
 * - mergeCn：把国内源数据按 Open-Meteo 字段名覆盖合并进天气/空气结构
 *
 * 所有 weather.com.cn 请求必须带 Referer: http://www.weather.com.cn/ + 浏览器 UA（否则拒答）。
 * toy1 偶发限流返回空 "()"，解析层做短退避重试；全部失败由调用方降级 Open-Meteo。
 */
const { got } = require('./geo.js');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const WCN_HEADERS = { 'User-Agent': BROWSER_UA, Referer: 'http://www.weather.com.cn/' };

/* ---------------- 中国天气网天气码 -> WMO ----------------
   d=白天 n=夜间 + 两位数字（d00 晴 / d07 小雨 / d10 暴雨 …）。
   映射目标是渲染层 weather.js 的 WMO 表，语义就近取码：
   沙尘/霾类 WMO 无对应码 -> 归 45 雾（低能见度语义最接近）。 */
const WMO_BY_NUM = {
  '00': 0,   // 晴
  '01': 2,   // 多云
  '02': 3,   // 阴
  '03': 80,  // 阵雨
  '04': 95,  // 雷阵雨
  '05': 96,  // 雷阵雨伴有冰雹
  '06': 77,  // 雨夹雪（WMO 无专码，取米雪）
  '07': 61,  // 小雨
  '08': 63,  // 中雨
  '09': 65,  // 大雨
  '10': 65,  // 暴雨（WMO 65=heavy rain 上限）
  '11': 65,  // 大暴雨
  '12': 65,  // 特大暴雨
  '13': 85,  // 阵雪
  '14': 71,  // 小雪
  '15': 73,  // 中雪
  '16': 75,  // 大雪
  '17': 75,  // 暴雪
  '18': 45,  // 雾
  '19': 66,  // 冻雨
  '20': 45,  // 沙尘暴
  '21': 63,  // 小到中雨
  '22': 65,  // 中到大雨
  '23': 65,  // 大到暴雨
  '24': 65,  // 暴雨到大暴雨
  '25': 65,  // 大暴雨到特大暴雨
  '26': 73,  // 小到中雪
  '27': 75,  // 中到大雪
  '28': 75,  // 大到暴雪
  '29': 45,  // 浮尘
  '30': 45,  // 扬沙
  '31': 45,  // 强沙尘暴
  '53': 45,  // 霾
  '99': 3    // 无数据/未知
};
/* 中文天气词兜底（itboy forecast.type / 组合词取首段） */
const WMO_BY_TEXT = {
  '晴': 0, '晴间多云': 1, '多云': 2, '阴': 3,
  '阵雨': 80, '雷阵雨': 95, '雷阵雨伴有冰雹': 96, '雷阵雨伴冰雹': 96,
  '雨夹雪': 77, '小雨': 61, '中雨': 63, '大雨': 65, '暴雨': 65,
  '大暴雨': 65, '特大暴雨': 65, '阵雪': 85, '小雪': 71, '中雪': 73,
  '大雪': 75, '暴雪': 75, '雾': 45, '冻雨': 66,
  '沙尘暴': 45, '浮尘': 45, '扬沙': 45, '强沙尘暴': 45, '霾': 45
};

/**
 * 中国天气网天气解析 -> { wmo, isDay }
 * @param {string} code 天气码（d00 / n01）
 * @param {string} text 中文天气词兜底（晴转多云 等组合词取首段）
 */
function wmoFromCn(code, text) {
  const m = /^([dn])(\d{2})$/i.exec(String(code || ''));
  if (m) {
    const wmo = WMO_BY_NUM[m[2]];
    if (wmo != null) return { wmo, isDay: m[1].toLowerCase() === 'd' ? 1 : 0 };
  }
  let t = String(text || '').trim();
  if (t.includes('转')) t = t.split('转')[0];       // 晴转多云 -> 晴
  if (t.includes('到')) t = t.split('到').pop();    // 小到中雨 -> 中雨（区间词根在后段）
  const wmo = WMO_BY_TEXT[t];
  if (wmo != null) {
    // 夜间兜底：18:00 后 ~ 次日 06:00 前视为夜（仅影响晴/多云图标）
    const h = new Date().getHours();
    return { wmo, isDay: h >= 6 && h < 18 ? 1 : 0 };
  }
  return { wmo: 3, isDay: 1 };
}

/* 风向字母 -> 角度（与渲染层 windDir(deg) 对齐） */
const WIND_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const num = v => { const x = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return Number.isFinite(x) ? x : null; };

/* ---------------- toy1 地名搜索 -> 9 位城市码 ----------------
   ref 形如 101210403~zhejiang~慈溪~Cixi~慈溪~cixi~0574~315300~CX~浙江
   字段：码~省拼音~名称~英文名~上级名~上级拼音~区号~邮编~缩写~省名
   街道级条目码为 12 位（101210403001），天气数据归并到前 9 位所属城市。 */
const nameCache = new Map(); // name -> { code, ts }（code 可为 null 负缓存）

async function searchCityCode(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  const hit = nameCache.get(key);
  const TTL = hit && hit.code ? 24 * 3600 * 1000 : 10 * 60 * 1000; // 负缓存短（toy1 偶发限流）
  if (hit && Date.now() - hit.ts < TTL) return hit.code;

  let code = null;
  for (let i = 0; i < 2 && !code; i++) {
    try {
      const t = await got('https://toy1.weather.com.cn/search?cityname=' + encodeURIComponent(key), 10000, { headers: WCN_HEADERS, text: true }, 1);
      const list = JSON.parse(String(t).replace(/^\(/, '').replace(/\)$/, '') || '[]');
      const items = (Array.isArray(list) ? list : []).map(it => {
        const p = String(it && it.ref || '').split('~');
        return { raw: p[0], name: p[2] || '', parent: p[4] || '', province: p[9] || '' };
      }).filter(x => /^\d{9}/.test(x.raw));
      if (items.length) {
        const exact = items.find(x => x.name === key || x.name === key + '市' || key === x.name + '市');
        const pick = exact || items[0];
        code = pick.raw.slice(0, 9);
      }
    } catch (e) { /* 限流/网络抖动 -> 短退避重试一次 */ }
    if (!code && i === 0) await new Promise(r => setTimeout(r, 400));
  }
  nameCache.set(key, { code, ts: Date.now() });
  return code;
}

/* ---------------- JS 变量赋值提取（dataSK/dataDZ/alarmDZ/dataZS） ----------------
   响应形如 var dataSK ={...};var dataZS ={...}; —— 非纯 JSON。
   括号配对扫描 + 字符串状态机（值内可能含 { } ; 等字符，正则非贪婪会截断）。 */
function extractVar(text, varName) {
  const key = 'var ' + varName;
  const at = text.indexOf(key);
  if (at < 0) return null;
  const start = text.indexOf('{', at + key.length);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/* ---------------- weather_index：实况 + 官方预警 + 生活指数 ---------------- */
async function fetchIndex(code) {
  const t = await got('https://d1.weather.com.cn/weather_index/' + code + '.html', 10000, { headers: WCN_HEADERS, text: true }, 1);
  const j = s => { const raw = extractVar(t, s); return raw ? JSON.parse(raw) : null; };
  return { sk: j('dataSK'), alarm: j('alarmDZ'), zs: j('dataZS'), dz: j('cityDZ') };
}

/* ---------------- itboy 7 天聚合（⚠️ 必须 http） ---------------- */
async function fetchItboy(code) {
  const r = await got('http://t.weather.itboy.net/api/weather/city/' + code, 12000, {}, 2);
  return r && r.data ? r : null;
}

/* ---------------- 归一化：国内源 -> Open-Meteo 字段名 ----------------
   返回 { current, daily, air, alerts, zs, city, code }（各段可为 null） */
function normalize(idx, itb) {
  const out = { current: null, daily: null, air: null, alerts: [], zs: null, city: '', code: '' };

  // 实况（dataSK）：与 OM current 同名字段
  const sk = idx && idx.sk;
  if (sk) {
    const { wmo, isDay } = wmoFromCn(sk.weathercode, sk.weather);
    out.city = sk.cityname || '';
    out.code = sk.city || '';
    const wde = String(sk.wde || '').toUpperCase();
    out.current = {
      temperature_2m: num(sk.temp),
      relative_humidity_2m: num(sk.SD),
      pressure_msl: num(sk.qy),                 // hPa
      visibility: (() => { const v = num(sk.njd); return v == null ? null : (String(sk.njd).includes('km') ? v * 1000 : v); })(), // -> 米
      wind_speed_10m: (() => { const v = num(sk.wse); return v == null ? null : (String(sk.wse).toLowerCase().includes('km') ? v : v * 3.6); })(), // -> km/h
      wind_direction_10m: WIND_DEG[wde] != null ? WIND_DEG[wde] : null,
      weather_code: wmo,
      is_day: isDay,
      precipitation: num(sk.rain)               // 当前时雨量 mm
    };
    Object.keys(out.current).forEach(k => { if (out.current[k] == null) delete out.current[k]; });
  }

  // 7 天 + 日出日落 + 空气（itboy）
  const fc = itb && itb.data && Array.isArray(itb.data.forecast) ? itb.data.forecast : null;
  if (fc && fc.length) {
    const time = [], wcode = [], tmax = [], tmin = [], sunrise = [], sunset = [];
    for (const d of fc.slice(0, 7)) {
      const ymd = String(d.ymd || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
      time.push(ymd);
      wcode.push(wmoFromCn('', d.type).wmo);
      tmax.push(num(String(d.high || '').replace('高温', '')));
      tmin.push(num(String(d.low || '').replace('低温', '')));
      sunrise.push(/^\d{2}:\d{2}$/.test(String(d.sunrise)) ? ymd + 'T' + d.sunrise : null);
      sunset.push(/^\d{2}:\d{2}$/.test(String(d.sunset)) ? ymd + 'T' + d.sunset : null);
    }
    if (time.length) out.daily = { time, weather_code: wcode, temperature_2m_max: tmax, temperature_2m_min: tmin, sunrise, sunset };
    const pm25 = num(itb.data.pm25), pm10 = num(itb.data.pm10);
    if (pm25 != null || pm10 != null) out.air = {
      pm2_5: pm25, pm10,
      quality: String(itb.data.quality || ''),
      wendu: num(itb.data.wendu)                 // 它家的「当前温度」（与实况略有出入，仅兜底用）
    };
    if (!out.city && itb.cityInfo) out.city = itb.cityInfo.city || '';
  }

  // 官方预警（alarmDZ.w[]，字段名随发布渠道有两代格式，防御解析）
  const wl = idx && idx.alarm && Array.isArray(idx.alarm.w) ? idx.alarm.w : [];
  out.alerts = wl.map(a => ({
    type: String(a.alertType || a.title || ''),
    level: String(a.alertLevel || ''),
    text: String(a.alertContent || a.alertDetail || a.desc || '').slice(0, 300),
    time: String(a.Issuetime || a.issueTime || '')
  })).filter(a => a.type || a.text);

  // 生活指数（dataZS.zs，透传给上层按需消费）
  out.zs = idx && idx.zs && idx.zs.zs ? idx.zs.zs : null;
  return out;
}

/* ---------------- 一键抓取：name/code -> 归一化国内数据 ----------------
   两路并行、各自容错；全空返回 null（调用方降级 Open-Meteo）。 */
async function fetchCn(name, code) {
  const cd = code || await searchCityCode(name);
  if (!cd) return null;
  const [idx, itb] = await Promise.all([
    fetchIndex(cd).catch(() => null),
    fetchItboy(cd).catch(() => null)
  ]);
  if (!idx && !itb) return null;
  const out = normalize(idx, itb);
  out.code = out.code || cd;
  return out;
}

/* ---------------- 合并：国内数据覆盖 Open-Meteo 结构 ----------------
   实况逐字段覆盖（有值才盖）；7 天按日期对齐覆盖；空气只盖 pm2.5/pm10。
   逐时/分钟级/UV/花粉/能见度逐时等仍由 Open-Meteo 提供（国内无免密钥源）。
   返回 sources 数据源标识（写进返回结构，供 UI 如实标注）。 */
function mergeCn(w, air, cn) {
  const sources = {
    current: 'Open-Meteo', daily: 'Open-Meteo', air: 'Open-Meteo',
    hourly: 'Open-Meteo', minutely: 'Open-Meteo',
    cnCity: (cn && cn.city) || '', cnCode: (cn && cn.code) || ''
  };
  if (!cn) return sources;

  if (cn.current && w && w.current) {
    let touched = false;
    for (const k of Object.keys(cn.current)) {
      const v = cn.current[k];
      if (v != null && Number.isFinite(v)) { w.current[k] = v; touched = true; }
    }
    if (touched) sources.current = '中国天气网';
  }

  if (cn.daily && w && w.daily && Array.isArray(w.daily.time)) {
    const byDate = {};
    cn.daily.time.forEach((d, i) => { byDate[d] = i; });
    let touched = false;
    w.daily.time.forEach((d, i) => {
      const j = byDate[d];
      if (j == null) return;
      const dc = cn.daily;
      if (dc.weather_code[j] != null) { w.daily.weather_code[i] = dc.weather_code[j]; touched = true; }
      if (dc.temperature_2m_max[j] != null) { w.daily.temperature_2m_max[i] = dc.temperature_2m_max[j]; touched = true; }
      if (dc.temperature_2m_min[j] != null) { w.daily.temperature_2m_min[i] = dc.temperature_2m_min[j]; touched = true; }
      if (dc.sunrise[j]) { w.daily.sunrise[i] = dc.sunrise[j]; touched = true; }
      if (dc.sunset[j]) { w.daily.sunset[i] = dc.sunset[j]; touched = true; }
    });
    if (touched) sources.daily = '中国天气网';
  }

  if (cn.air && air && air.current) {
    let touched = false;
    if (cn.air.pm2_5 != null) { air.current.pm2_5 = cn.air.pm2_5; touched = true; }
    if (cn.air.pm10 != null) { air.current.pm10 = cn.air.pm10; touched = true; }
    if (touched) sources.air = '中国天气网 + Open-Meteo';
  }

  return sources;
}

module.exports = { searchCityCode, fetchIndex, fetchItboy, fetchCn, normalize, mergeCn, wmoFromCn };
