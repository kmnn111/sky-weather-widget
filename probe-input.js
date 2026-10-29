'use strict';
// 输入管线探针：验证 webContents.sendInputEvent 能否产生真 pointer 事件、
// 拖拽移动时 e.buttons 是否带左键状态、双击是否产生 dblclick。
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 400, height: 300, show: false });
    await win.loadFile(path.join(__dirname, 'probe.html'));
    const w = win.webContents;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    // 1) 普通拖拽（move 带 isLeftButtonDown 修饰）
    w.sendInputEvent({ type: 'mouseDown', x: 50, y: 50, button: 'left', clickCount: 1 });
    await wait(120);
    w.sendInputEvent({ type: 'mouseMove', x: 80, y: 50, modifiers: ['isLeftButtonDown'] });
    await wait(120);
    w.sendInputEvent({ type: 'mouseMove', x: 110, y: 50, modifiers: ['isLeftButtonDown'] });
    await wait(120);
    w.sendInputEvent({ type: 'mouseUp', x: 110, y: 50, button: 'left', clickCount: 1 });
    await wait(150);
    // 2) 不带修饰的 move（对照组）
    w.sendInputEvent({ type: 'mouseDown', x: 50, y: 80, button: 'left', clickCount: 1 });
    await wait(120);
    w.sendInputEvent({ type: 'mouseMove', x: 80, y: 80 });
    await wait(120);
    w.sendInputEvent({ type: 'mouseUp', x: 80, y: 80, button: 'left', clickCount: 1 });
    await wait(150);
    // 3) 真实双击（clickCount 1→2）
    w.sendInputEvent({ type: 'mouseDown', x: 50, y: 120, button: 'left', clickCount: 1 });
    await wait(60);
    w.sendInputEvent({ type: 'mouseUp', x: 50, y: 120, button: 'left', clickCount: 1 });
    await wait(60);
    w.sendInputEvent({ type: 'mouseDown', x: 50, y: 120, button: 'left', clickCount: 2 });
    await wait(60);
    w.sendInputEvent({ type: 'mouseUp', x: 50, y: 120, button: 'left', clickCount: 2 });
    await wait(200);
    const log = await w.executeJavaScript('window.log');
    console.log('[probe] events=' + JSON.stringify(log));
  } catch (e) {
    console.error('[probe] failed', e);
  }
  app.exit(0);
});
