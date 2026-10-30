'use strict';
/**
 * 天气数据加工层：WMO 天气码 -> 中文/图标、风向、中国 AQI（GB 3095-2012）、生活指数、提示条
 */
const Weather = (() => {

  /* ---------- WMO 天气码 ---------- */
  const WMO = {
    0: ['晴', 'sun', 'clear'],
    1: ['晴间多云', 'sun', 'clear'],
    2: ['局部多云', 'sun-cloud', 'cloudy'],
    3: ['多云', 'cloud', 'cloudy'],
    45: ['雾', 'fog', 'fog'],
    48: ['雾凇', 'fog', 'fog'],
    51: ['毛毛雨', 'drizzle', 'rain'],
    53: ['毛毛雨', 'drizzle', 'rain'],
    55: ['毛毛雨', 'drizzle', 'rain'],
    56: ['冻毛毛雨', 'sleet', 'rain'],
    57: ['冻毛毛雨', 'sleet', 'rain'],
    61: ['小雨', 'rain', 'rain'],
    63: ['中雨', 'rain', 'rain'],
    65: ['大雨', 'heavy-rain', 'rain'],
    66: ['冻雨', 'sleet', 'rain'],
    67: ['冻雨', 'sleet', 'rain'],
    71: ['小雪', 'snow', 'snow'],
    73: ['中雪', 'snow', 'snow'],
    75: ['大雪', 'heavy-snow', 'snow'],
    77: ['米雪', 'snow', 'snow'],
    80: ['阵雨', 'rain', 'rain'],
    81: ['阵雨', 'rain', 'rain'],
    82: ['强阵雨', 'heavy-rain', 'rain'],
    85: ['阵雪', 'snow', 'snow'],
    86: ['阵雪', 'heavy-snow', 'snow'],
    95: ['雷阵雨', 'thunder', 'thunder'],
    96: ['雷阵雨伴冰雹', 'thunder', 'thunder'],
    99: ['雷阵雨伴冰雹', 'thunder', 'thunder']
  };

  const codeInfo = (code, isDay = 1) => {
    const e = WMO[code] || WMO[3];
    let icon = e[1];
    if (!isDay && (icon === 'sun' || icon === 'sun-cloud')) icon = icon === 'sun' ? 'moon' : 'moon-cloud';
    return { text: e[0], icon, group: e[2] };
  };

  /* ---------- 风向 / 风力 ---------- */
  const WIND_DIR = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const windDir = deg => WIND_DIR[Math.round(((deg || 0) % 360) / 45) % 8] + '风';
  const windLevel = kmh => {
    const t = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117];
    for (let i = 0; i < t.length; i++) if (kmh <= t[i]) return i + 1;
    return 12;
  };

  /* ---------- 中国 AQI（GB 3095-2012 线性插值） ---------- */
  const IAQI = [0, 50, 100, 150, 200, 300, 400, 500];
  const BP = {
    pm25: [0, 35, 75, 115, 150, 250, 350, 500],
    pm10: [0, 50, 150, 250, 350, 420, 500, 600],
    o3: [0, 100, 160, 215, 265, 800, 800, 800],
    no2: [0, 40, 80, 180, 280, 565, 750, 750],
    so2: [0, 50, 150, 475, 800, 1600, 2100, 2100],
    co: [0, 2, 4, 14, 24, 36, 48, 60]
  };
  const NAMES = { pm25: 'PM2.5', pm10: 'PM10', o3: 'O3', no2: 'NO2', so2: 'SO2', co: 'CO' };

  function iaqi(key, c) {
    const bp = BP[key];
    if (!Number.isFinite(c) || c < 0) return null;
    for (let i = 1; i < bp.length; i++) {
      if (c <= bp[i]) {
        return Math.round((IAQI[i] - IAQI[i - 1]) / (bp[i] - bp[i - 1]) * (c - bp[i - 1]) + IAQI[i - 1]);
      }
    }
    return 500;
  }

  function calcAQI(air) {
    if (!air || !air.current) return null;
    const c = air.current;
    const vals = {
      pm25: c.pm2_5, pm10: c.pm10, o3: c.ozone,
      no2: c.nitrogen_dioxide, so2: c.sulphur_dioxide,
      co: Number.isFinite(c.carbon_monoxide) ? c.carbon_monoxide / 1000 : null // μg/m³ -> mg/m³
    };
    let aqi = 0, primary = '';
    const sub = {};
    for (const k of Object.keys(vals)) {
      const v = iaqi(k, vals[k]);
      if (v != null) {
        sub[k] = { name: NAMES[k], value: vals[k], iaqi: v };
        if (v > aqi) { aqi = v; primary = NAMES[k]; }
      }
    }
    const level = aqi <= 50 ? '优' : aqi <= 100 ? '良' : aqi <= 150 ? '轻度污染'
      : aqi <= 200 ? '中度污染' : aqi <= 300 ? '重度污染' : '严重污染';
    const tone = aqi <= 50 ? 'great' : aqi <= 100 ? 'good' : aqi <= 150 ? 'light'
      : aqi <= 200 ? 'mid' : 'bad';
    return { aqi: Math.round(aqi), level, tone, primary, sub, usAqi: c.us_aqi };
  }

  /* ---------- 生活指数 ---------- */
  const clothing = (feels, rainy) => {
    let lv, tip;
    if (feels >= 30) { lv = '炎热'; tip = '短袖、短裤、连衣裙，透气面料'; }
    else if (feels >= 26) { lv = '热'; tip = '短袖T恤、薄裤'; }
    else if (feels >= 22) { lv = '舒适偏暖'; tip = '短袖+薄外套，早晚可披'; }
    else if (feels >= 18) { lv = '舒适'; tip = '长袖T恤、薄开衫'; }
    else if (feels >= 15) { lv = '微凉'; tip = '薄毛衣、卫衣、风衣'; }
    else if (feels >= 10) { lv = '凉'; tip = '夹克、厚外套、薄毛衣'; }
    else if (feels >= 5) { lv = '冷'; tip = '厚外套、薄羽绒'; }
    else if (feels >= 0) { lv = '寒冷'; tip = '棉服、羽绒服+保暖内衣'; }
    else { lv = '严寒'; tip = '羽绒服、围巾手套全副武装'; }
    if (rainy) tip += '，记得带伞';
    return { lv, tip };
  };

  const travel = (group, windKmh, visibility, feels) => {
    const tips = [];
    if (group === 'thunder') tips.push('雷雨天气，减少外出，远离大树和空旷地');
    else if (group === 'rain') tips.push('有雨路滑，出行带伞、注意交通安全');
    else if (group === 'snow') tips.push('有雪路滑，注意防滑保暖');
    if (visibility && visibility < 1000) tips.push('能见度低，驾车请减速');
    else if (visibility && visibility < 4000) tips.push('能见度一般，驾车留意');
    if (windKmh >= 38) tips.push('风力较大，注意防风、避开临时搭建物');
    if (feels >= 35) tips.push('高温天气，防暑降温、及时补水');
    if (feels <= -5) tips.push('严寒天气，注意防冻防滑');
    return tips.length ? tips : ['天气不错，适宜出行和户外活动'];
  };

  const uv = u => {
    if (!Number.isFinite(u)) return { lv: '未知', tip: '' };
    if (u <= 2) return { lv: '弱', tip: '无需特别防护' };
    if (u <= 4) return { lv: '中等', tip: '外出可涂低倍防晒' };
    if (u <= 6) return { lv: '强', tip: '涂防晒霜、戴遮阳帽' };
    if (u <= 9) return { lv: '很强', tip: '避免长时间暴晒，防晒必备' };
    return { lv: '极强', tip: '尽量不出门，全面防晒' };
  };

  const carWash = (precipProb24, group, popDay = 0) => {
    const dayWord = popDay === 0 ? '今天' : '明天';
    if (group === 'rain' || group === 'snow' || group === 'thunder')
      return { lv: '不宜', tip: '近期有雨雪，洗车容易白洗' };
    if (precipProb24 >= 50) return { lv: '不宜', tip: `${dayWord}降水概率 ${precipProb24}%，洗车容易白洗` };
    if (precipProb24 >= 30) return { lv: '较不宜', tip: `${dayWord}降水概率偏高（${precipProb24}%），可再等等` };
    return { lv: '适宜', tip: '未来无明显降水，适合洗车' };
  };

  const sport = (group, feels, windKmh) => {
    if (group === 'thunder') return { lv: '不宜', tip: '雷雨天气，请在室内运动' };
    if (group === 'rain' || group === 'snow') return { lv: '较不宜', tip: '雨雪天气，建议改为室内' };
    if (feels >= 35) return { lv: '较不宜', tip: '高温酷暑，避开正午时段' };
    if (feels <= -5) return { lv: '较不宜', tip: '严寒天气，注意热身防伤' };
    if (windKmh >= 38) return { lv: '不太适宜', tip: '风力较大，换个日子更舒服' };
    return { lv: '适宜', tip: '天气舒适，户外运动走起' };
  };

  const cold = (dayNightDiff, feels) => {
    if (dayNightDiff >= 10 || feels < 5) return { lv: '较易发', tip: '温差大/气温低，注意添衣防感冒' };
    if (dayNightDiff >= 8) return { lv: '易发', tip: '昼夜温差明显，早晚记得加衣' };
    return { lv: '少发', tip: '气温平稳，保持正常作息即可' };
  };

  /* ---------- 提示条（类比气象预警） ---------- */
  const dayWord = i => (i === 0 ? '今天' : i === 1 ? '明天' : '后天');
  function buildAlerts(daily, hourly) {
    const out = [];
    const maxTemp = Math.max(...daily.temperature_2m_max.slice(0, 3));
    const minTemp = Math.min(...daily.temperature_2m_min.slice(0, 3));
    const maxWind = Math.max(...(daily.wind_speed_10m_max || [0]).slice(0, 3));
    const maxUv = Math.max(...(daily.uv_index_max || [0]).slice(0, 3));
    const codes = (daily.weather_code || []).slice(0, 3);

    // 雷雨/降雨/降雪提醒：点名具体哪一天（比「未来三天」含糊说法更可读）
    // 用 codeInfo 权威分组判定：旧区间判断会把阵雨 80-82 误判成降雪、漏掉毛毛雨 51-57
    const grpOf = c => codeInfo(c, 1).group;
    const thunderI = codes.findIndex(c => grpOf(c) === 'thunder');
    const rainI = codes.findIndex(c => grpOf(c) === 'rain');
    const snowI = codes.findIndex(c => grpOf(c) === 'snow');
    let wetNamedI = -1;
    if (thunderI >= 0) { wetNamedI = thunderI; out.push({ tone: 'red', text: `${dayWord(thunderI)}有雷阵雨，注意防雷避雨` }); }
    else if (rainI >= 0) { wetNamedI = rainI; out.push({ tone: 'blue', text: `${dayWord(rainI)}有降雨，出门记得带伞` }); }
    else if (snowI >= 0) { wetNamedI = snowI; out.push({ tone: 'blue', text: `${dayWord(snowI)}有降雪，注意防滑保暖` }); }

    // 降水概率提醒：定位概率最高的一天并与该日降水量/天气码交叉校验——
    // 概率与降水量是两套模型产物，可能出现「高概率 + 0mm + 非雨天码」，
    // 不标日期、不校验就和预报卡片「无雨」自相矛盾（论坛反馈实证），措辞按证据强度分级
    const pops = daily.precipitation_probability_max || [];
    let bestI = -1, best = 0;
    for (let i = 0; i < Math.min(3, pops.length); i++) {
      const v = Math.round(pops[i] || 0);
      if (v > best) { best = v; bestI = i; }
    }
    if (best >= 70 && bestI >= 0 && bestI !== wetNamedI) {
      const sum = Number((daily.precipitation_sum || [])[bestI]) || 0;
      const grp = codeInfo((daily.weather_code || [])[bestI], 1).group;
      const wet = sum > 0.1 || grp === 'rain' || grp === 'snow' || grp === 'thunder';
      if (wet) out.push({ tone: 'blue', text: `${dayWord(bestI)}降水概率 ${best}%，备好雨具` });
      else out.push({ tone: 'green', text: `${dayWord(bestI)}可能有降水（概率 ${best}%），可备伞` });
    }
    if (maxWind >= 39) out.push({ tone: 'orange', text: '风力较大（6级+），注意防风' });
    if (maxTemp >= 35) out.push({ tone: 'orange', text: '高温橙色提醒：注意防暑降温' });
    if (minTemp <= 0) out.push({ tone: 'orange', text: '气温将跌破冰点，注意防寒保暖' });
    if (maxUv >= 8) out.push({ tone: 'orange', text: '紫外线很强，防晒必备' });
    const diff = maxTemp - minTemp;
    if (diff >= 10 && out.length < 2) out.push({ tone: 'green', text: `昼夜温差 ${Math.round(diff)}℃，注意增减衣物` });
    return out.slice(0, 2);
  }

  /* ---------- 逐时/逐日聚合 ---------- */
  function summarizeDaily(w, idx) {
    const d = w.daily;
    // 用当日 6-18 点的天气码聚合出「上午→下午」的转变描述
    const date = d.time[idx];
    const hi = w.hourly.time.findIndex(t => t.startsWith(date) && t.slice(11, 13) >= '06');
    let am = null, pm = null;
    if (hi >= 0) {
      const seg = [];
      for (let i = hi; i < w.hourly.time.length && w.hourly.time[i].startsWith(date); i++) seg.push(w.hourly.weather_code[i]);
      const amCodes = seg.slice(0, 6), pmCodes = seg.slice(6, 12);
      if (amCodes.length && pmCodes.length) {
        am = amCodes.sort((a, b) => b - a)[0];
        pm = pmCodes.sort((a, b) => b - a)[0];
      }
    }
    const base = codeInfo(d.weather_code[idx], 1);
    let text = base.text;
    if (am != null && pm != null && am !== pm) {
      const amT = codeInfo(am, 1).text, pmT = codeInfo(pm, 1).text;
      text = amT === pmT ? amT : `${amT}转${pmT}`;
    }
    return { ...base, text };
  }

  return { WMO, codeInfo, windDir, windLevel, calcAQI, clothing, travel, uv, carWash, sport, cold, buildAlerts, summarizeDaily };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Weather;
