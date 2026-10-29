'use strict';
/**
 * 万年历引擎：基于 lunar-javascript（6tail，MIT）
 * 农历 / 干支生肖 / 节气 / 宜忌 / 值神冲煞 / 时辰吉凶 / 本月吉日
 */
const Almanac = (() => {
  const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  const ZODIAC = ['水瓶', '双鱼', '白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯'];
  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  const CATEGORIES = [
    { key: 'jiaqu', label: '嫁娶', match: ['嫁娶', '纳采', '订盟', '问名', '裁衣'] },
    { key: 'kaiye', label: '开业', match: ['开市', '开业', '立券', '交易', '开光', '挂匾'] },
    { key: 'banjia', label: '搬家', match: ['入宅', '移徙', '安床'] },
    { key: 'dongtu', label: '动土', match: ['动土', '破土', '上梁', '修造', '起基'] },
    { key: 'chuxing', label: '出行', match: ['出行', '赴任', '起行'] },
    { key: 'qiyue', label: '签约', match: ['立券', '交易', '纳财', '求财'] },
    { key: 'jisi', label: '祭祀', match: ['祭祀', '祈福', '求嗣', '斋醮', '酬神'] }
  ];

  function constellation(m, d) {
    // 每月起始星座边界日：水瓶(1/20)、双鱼(2/19)、白羊(3/21)…摩羯(12/22)
    const edge = [20, 19, 21, 20, 21, 21, 23, 23, 23, 24, 22, 22];
    return d >= edge[m - 1] ? ZODIAC[m - 1] : ZODIAC[(m + 10) % 12];
  }

  /** 法定节假日（lunar-javascript HolidayUtil，数据与国务院办公厅放假通知一致） */
  function holiday(ymd) {
    if (typeof HolidayUtil === 'undefined') return null;
    const h = HolidayUtil.getHoliday(ymd);
    return h ? { name: h.getName(), isWork: !!h.isWork() } : null;
  }

  /** 节假日连休区间（如「10月1日至7日放假，共7天」）；调休上班日 span 为空 */
  function holidaySpan(ymd) {
    const hol = holiday(ymd);
    if (!hol) return null;
    const [y, m, d] = ymd.split('-').map(Number);
    const fmt = dt => `${dt.getMonth() + 1}月${dt.getDate()}日`;
    const key = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const c = new Date(y, m - 1, d);
    if (hol.isWork) return { ...hol, start: fmt(c), end: fmt(c), days: 1, span: '' };
    const same = dt => { const h = holiday(key(dt)); return !!h && !h.isWork && h.name === hol.name; };
    const s = new Date(c), e = new Date(c);
    for (let p = new Date(c);;) { p.setDate(p.getDate() - 1); if (!same(p)) break; s.setTime(p.getTime()); }
    for (let n = new Date(c);;) { n.setDate(n.getDate() + 1); if (!same(n)) break; e.setTime(n.getTime()); }
    const days = Math.round((e - s) / 86400e3) + 1;
    return { ...hol, start: fmt(s), end: fmt(e), days, span: days > 1 ? `${fmt(s)}至${fmt(e)}放假，共${days}天` : '' };
  }

  function dayInfo(date) {
    const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
    const lunar = solar.getLunar();
    const yi = lunar.getDayYi() || [];
    const ji = lunar.getDayJi() || [];
    const jieQi = lunar.getJieQi() || '';
    const festivals = [...(solar.getFestivals ? solar.getFestivals() : []),
    ...(lunar.getFestivals() || []), ...(lunar.getOtherFestivals() || [])].filter(Boolean);

    return {
      ymd: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
      week: WEEK[date.getDay()], weekIdx: date.getDay(),
      hol: holiday(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`),
      lunarText: `农历${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
      lunarMonth: lunar.getMonthInChinese() + '月',
      lunarDay: lunar.getDayInChinese(),
      yearGanZhi: lunar.getYearInGanZhi() + '年',
      monthGanZhi: lunar.getMonthInGanZhi() + '月',
      dayGanZhi: lunar.getDayInGanZhi() + '日',
      zodiac: lunar.getYearShengXiao(),
      constellation: constellation(date.getMonth() + 1, date.getDate()),
      jieQi, festivals,
      yi, ji,
      tianShen: lunar.getDayTianShen(),
      tianShenLuck: lunar.getDayTianShenLuck(),
      tianShenType: lunar.getDayTianShenType ? lunar.getDayTianShenType() : '',
      chong: lunar.getDayChongDesc ? lunar.getDayChongDesc() : '',
      sha: lunar.getDaySha ? lunar.getDaySha() : '',
      jiShen: lunar.getDayJiShen() || [],
      xiongSha: lunar.getDayXiongSha() || [],
      zhiXing: lunar.getZhiXing(),
      lu: lunar.getDayLu ? lunar.getDayLu() : '',
      wuHou: lunar.getWuHou ? lunar.getWuHou() : '',
      yueXiang: lunar.getYueXiang ? lunar.getYueXiang() : '',
      posXi: lunar.getDayPositionXi ? lunar.getDayPositionXi() : '',
      posFu: lunar.getDayPositionFu ? lunar.getDayPositionFu() : '',
      posCai: lunar.getDayPositionCai ? lunar.getDayPositionCai() : '',
      nineStar: lunar.getNineStar ? (lunar.getNineStar().toFullString ? lunar.getNineStar().toFullString() : '') : ''
    };
  }

  /** 十二时辰吉凶 / 宜忌（取 LunarTime 时辰对象的天神与宜忌） */
  function hourTable(date) {
    const lunar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate()).getLunar();
    const times = lunar.getTimes(); // 13 个：子时分早子(00-01)与晚子(23-24)
    return times.slice(0, 12).map((t, i) => {
      const startH = i === 0 ? 23 : (i * 2 - 1);
      const endH = i === 0 ? 1 : (i * 2 + 1);
      return {
        zhi: t.getZhi(),
        range: `${startH}-${endH}时`,
        tianShen: t.getTianShen(),
        luck: t.getTianShenLuck(),
        yi: t.getYi() || [],
        ji: t.getJi() || []
      };
    });
  }

  function inCategories(yi, cat) {
    return cat.match.some(k => yi.includes(k));
  }

  /** 本月吉日（按类别） */
  function auspiciousDays(year, month, categoryKey) {
    const cat = CATEGORIES.find(c => c.key === categoryKey) || CATEGORIES[0];
    const out = [];
    const last = new Date(year, month, 0).getDate();
    for (let d = 1; d <= last; d++) {
      const info = dayInfo(new Date(year, month - 1, d));
      if (inCategories(info.yi, cat)) out.push(info);
    }
    return out;
  }

  /** 月历格子 */
  function monthGrid(year, month) {
    const first = new Date(year, month - 1, 1);
    const days = new Date(year, month, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // 周一为首
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= days; d++) {
      const date = new Date(year, month - 1, d);
      const solar = Solar.fromYmd(year, month, d);
      const lunar = solar.getLunar();
      const yi = lunar.getDayYi() || [];
      cells.push({
        day: d,
        ymd: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        lunarLabel: lunar.getJieQi() || (lunar.getDayInChinese() === '初一'
          ? lunar.getMonthInChinese() + '月' : lunar.getDayInChinese()),
        jieQi: lunar.getJieQi() || '',
        hol: holiday(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`),
        lucky: yi.includes('嫁娶') || yi.includes('开市') || yi.includes('入宅'),
        date
      });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }

  return { dayInfo, hourTable, monthGrid, auspiciousDays, holiday, holidaySpan, CATEGORIES, WEEK, ZHI };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Almanac;
