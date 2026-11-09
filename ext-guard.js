'use strict';
/* ext-guard.js — ext:open 外链白名单（主进程共用，probe 可直接 require 单测）
   只放行 https + 已知天气数据站点，防渲染进程被注入后任意跳转钓鱼页。
   域名按后缀匹配（含子域），但不吃「windy.com.evil.com」这类前缀伪装。 */
const ALLOWED_HOSTS = [
  'windy.com',        // 天气图层详情（UV/风/温/气压/降水/能见度…）
  'rainviewer.com',   // 降水雷达
  'timeanddate.com'   // 月相
];
function isAllowedExtUrl(u) {
  const raw = String(u == null ? '' : u);
  // 反斜杠/控制字符：WHATWG 会把 \ 归一成 /，Windows ShellExecute 的解析却未必一致（TOCTOU）
  if (raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password || (url.port && url.port !== '443')) return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch (e) { return false; }
}
module.exports = { isAllowedExtUrl, ALLOWED_HOSTS };
