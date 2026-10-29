'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sky', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  fetchWeather: (lat, lon) => ipcRenderer.invoke('weather:get', { lat, lon }),
  geoSearch: (q) => ipcRenderer.invoke('geo:search', q),
  geoReverse: (lat, lon, fallbackName) => ipcRenderer.invoke('geo:reverse', { lat, lon, fallbackName }),
  ipLocate: () => ipcRenderer.invoke('geo:iplocate'),
  winAction: (act, arg) => ipcRenderer.invoke('win:action', act, arg),
  winDrag: (sx, sy) => ipcRenderer.send('win:drag', sx, sy),
  winDragEnd: () => ipcRenderer.send('win:drag-end'),
  version: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, s) => cb && cb(s)),
  dockHover: (inside) => ipcRenderer.send('dock:hover', !!inside),
  onDockState: (cb) => ipcRenderer.on('dock:state', (_e, s) => cb && cb(s))
});
