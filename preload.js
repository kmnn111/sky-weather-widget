'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sky', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  fetchWeather: (lat, lon, name, code) => ipcRenderer.invoke('weather:get', { lat, lon, name, code }),
  fetchArchive: (lat, lon) => ipcRenderer.invoke('weather:archive', { lat, lon }),
  radarFrames: () => ipcRenderer.invoke('radar:frames'),
  cityCurrent: (lat, lon, name, code) => ipcRenderer.invoke('city:current', { lat, lon, name, code }),
  savePng: (dataURL) => ipcRenderer.invoke('png:save', dataURL),
  geoSearch: (q) => ipcRenderer.invoke('geo:search', q),
  geoReverse: (lat, lon, fallbackName) => ipcRenderer.invoke('geo:reverse', { lat, lon, fallbackName }),
  ipLocate: () => ipcRenderer.invoke('geo:iplocate'),
  winAction: (act, arg) => ipcRenderer.invoke('win:action', act, arg),
  winDrag: (sx, sy) => ipcRenderer.send('win:drag', sx, sy),
  winDragEnd: () => ipcRenderer.send('win:drag-end'),
  openExternal: (url) => ipcRenderer.invoke('ext:open', url),
  version: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, s) => cb && cb(s)),
  dockHover: (inside) => ipcRenderer.send('dock:hover', !!inside),
  onDockState: (cb) => ipcRenderer.on('dock:state', (_e, s) => cb && cb(s)),
  trayTemp: (dataURL) => ipcRenderer.send('tray:temp', dataURL),
  trayInfo: (text) => ipcRenderer.send('tray:info', String(text || '').slice(0, 120)),
  onTrayAction: (cb) => ipcRenderer.on('tray:action', (_e, a) => cb && cb(a)),
  copyPng: (dataURL) => ipcRenderer.invoke('png:copy', dataURL),
  notify: (title, body) => ipcRenderer.send('notify', { title, body })
});
