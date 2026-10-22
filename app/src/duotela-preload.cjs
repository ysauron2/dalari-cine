'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duoDesktop', Object.freeze({
  versions: Object.freeze({ electron: String(process.versions.electron || ''), chrome: String(process.versions.chrome || ''), node: String(process.versions.node || '') }),
  setPlatform: platform => {
    if (platform === null || ['youtube', 'netflix', 'prime', 'crunchyroll'].includes(platform)) {
      ipcRenderer.send('duotela:room-platform', platform);
    }
  },
  // Abre no navegador padrão, e só se o endereço estiver na lista do processo principal (src/external-links.cjs)
  openExternal: url => { if (typeof url === 'string' && url.length < 200) ipcRenderer.send('duotela:open-external', url); },
  syncNetflix: state => ipcRenderer.send('duotela:netflix-room-state', state),
  // Ducking: fator de volume (0..1) que o vídeo da Netflix deve ter enquanto alguém fala
  setDuck: gain => { if (typeof gain === 'number' && Number.isFinite(gain) && gain >= 0 && gain <= 1) ipcRenderer.send('duotela:duck', gain); },
  // Push-to-talk: a tecla escolhida (KeyboardEvent.code) ou null; o aplicativo avisa quando ela é apertada com a Netflix em foco
  setPttKey: code => { if (code === null || (typeof code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(code))) ipcRenderer.send('duotela:ptt-key', code); },
  onPtt: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, down) => callback(down === true);
    ipcRenderer.on('duotela:ptt', listener);
    return () => ipcRenderer.removeListener('duotela:ptt', listener);
  },
  // Atualização automática: o app principal verifica, baixa e confere; aqui só há comandos simples e o estado.
  updates: Object.freeze({
    getState: () => ipcRenderer.invoke('duotela:update-get'),
    check: () => ipcRenderer.invoke('duotela:update-check'),
    install: () => ipcRenderer.invoke('duotela:update-install'),
    setAuto: on => ipcRenderer.invoke('duotela:update-auto', on === true),
    onState: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('duotela:update-state', listener);
      return () => ipcRenderer.removeListener('duotela:update-state', listener);
    }
  }),
  onNetflixEvent: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('duotela:netflix-event', listener);
    return () => ipcRenderer.removeListener('duotela:netflix-event', listener);
  }
}));
