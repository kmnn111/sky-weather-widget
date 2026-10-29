'use strict';
/* 用 Electron nativeImage 裁水印 + 出多尺寸图标，再打包 ico */
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  try {
    const dir = path.join(__dirname, '..', 'assets');
    const src = path.join(dir, 'Cute_Ghibli_style_watercolor_a_2026-10-28T04-22-25.png');
    const img = nativeImage.createFromPath(src);
    const size = img.getSize();
    console.log('source:', size.width, size.height);
    const cropH = Math.round(size.height * 0.9375); // 去掉底部 6%（水印区）
    const side = Math.min(size.width, cropH);
    const x = Math.round((size.width - side) / 2);
    const cropped = img.crop({ x, y: 0, width: side, height: side });

    fs.writeFileSync(path.join(dir, 'icon.png'), cropped.resize({ width: 512, height: 512 }).toPNG());
    fs.writeFileSync(path.join(dir, 'icon-256.png'), cropped.resize({ width: 256, height: 256 }).toPNG());
    console.log('icon.png / icon-256.png written');

    const pngToIco = require('png-to-ico');
    pngToIco([path.join(dir, 'icon-256.png')]).then(buf => {
      fs.writeFileSync(path.join(dir, 'icon.ico'), buf);
      console.log('icon.ico written', buf.length, 'bytes');
      app.quit();
    }).catch(e => { console.error(e); app.quit(); });
  } catch (e) {
    console.error(e);
    app.quit();
  }
});
