'use strict';
// 假 OTA 更新源（自检用）：latest.yml + 安装包字节，版本号恒大于当前版本。
// 用法：node fake-ota-server.js [端口]  →  --shot-update --update-url=http://127.0.0.1:<端口>
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 17321;
const FAKE_VERSION = '9.9.9';
// 假安装包：1MB 随机字节即可（测试只走到「下载完成」，不会真正安装）
const blob = crypto.randomBytes(1024 * 1024);
const sha512 = crypto.createHash('sha512').update(blob).digest('base64');
const yml = [
  'version: ' + FAKE_VERSION,
  'files:',
  '  - url: fake-Setup.exe',
  '    sha512: ' + sha512,
  '    size: ' + blob.length,
  'path: fake-Setup.exe',
  'sha512: ' + sha512,
  "releaseDate: '2026-10-29T00:00:00.000Z'"
].join('\n') + '\n';

http.createServer((req, res) => {
  const u = req.url || '';
  if (u.includes('latest.yml')) {
    res.setHeader('content-type', 'text/yaml');
    res.end(yml);
  } else if (u.includes('fake-Setup.exe')) {
    res.end(blob);
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('[fake-ota] serving on http://127.0.0.1:' + PORT + ' version=' + FAKE_VERSION);
});
