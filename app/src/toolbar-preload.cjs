'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duoPanel', Object.freeze({
  toggle: () => ipcRenderer.send('duotela:toggle-panel'),
  onState: callback => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('duotela:panel-state', (_event, open) => callback(Boolean(open)));
  }
}));
