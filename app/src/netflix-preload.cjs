'use strict';
// Ponte mínima do player: observa apenas o <video> visível em /watch/<id>.
// Não lê cookies, credenciais, rede, faixas de áudio ou legendas. O volume do <video> só é ajustado pelo ducking
// (abaixar enquanto alguém fala na conversa e devolver ao valor que a pessoa tinha).
const { ipcRenderer, webFrame } = require('electron');

const WATCH = /^\/watch\/([0-9]{1,12})\/?$/;
let room = null;
let lastVersion = 0; let lastSyncId = 0;
let lastWatch = null;
let attached = null;
let suppressedUntil = 0;
let applying = false;
let lastSeekAt = 0;
let remote = null;

function watchId() {
  return location.hostname === 'www.netflix.com' ? WATCH.exec(location.pathname)?.[1] || null : null;
}
function player() {
  if (!watchId()) return null;
  const videos = [...document.querySelectorAll('video')].filter(video => {
    const box = video.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  videos.sort((a, b) => {
    const score = video => {
      const box = video.getBoundingClientRect();
      return (video.closest('.watch-video--player-view, [data-uia="video-canvas"]') ? 1e9 : 0) + box.width * box.height;
    };
    return score(b) - score(a);
  });
  return videos[0] || null;
}
// Ducking: gain 1 = volume que a pessoa tinha; abaixo disso, esse volume multiplicado pelo fator.
let duckBase = null;
function applyDuck(gain) {
  if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 1) return;
  const video = player() || document.querySelector('video');
  if (!video) return;
  if (gain < 1) {
    if (duckBase === null) duckBase = video.volume;
    video.volume = Math.max(0, Math.min(1, duckBase * gain));
  } else if (duckBase !== null) {
    video.volume = duckBase;
    duckBase = null;
  }
}
ipcRenderer.on('duotela:duck', (_event, gain) => applyDuck(gain));
function report(type, video, status) {
  const id = watchId();
  if (!id) return;
  const positionSec = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
  ipcRenderer.send('duotela:netflix-report', { type, watchId: id, positionSec, playing: !!video && !video.paused && !video.ended, status });
}
// Ir a um ponto do filme: o player da Netflix dá erro (M7375) quando o <video>.currentTime é atribuído de fora, então a busca
// é pedida ao player interno do próprio site (o mesmo que a barra de progresso usa). Roda no mundo da página; só passa um número.
// Sem esse player não se força nada: play e pausa continuam, e a posição fica por conta de cada um (aviso "seek-unavailable").
async function seekViaNetflix(sec) {
  if (!webFrame || typeof webFrame.executeJavaScript !== 'function' || !Number.isFinite(sec)) return false;
  const ms = Math.round(Math.max(0, Math.min(86400, sec)) * 1000);
  const code = '(() => { try { const vp = window.netflix && window.netflix.appContext && window.netflix.appContext.state.playerApp.getAPI().videoPlayer;'
    + ' if (!vp) return false; const ids = vp.getAllPlayerSessionIds(); if (!ids || !ids.length) return false;'
    + ' const p = vp.getVideoPlayerBySessionId(ids[ids.length - 1]); if (!p || typeof p.seek !== "function") return false; p.seek(' + ms + '); return true; } catch (e) { return false; } })()';
  try { return (await webFrame.executeJavaScript(code)) === true; } catch { return false; }
}
function localEvent(type) {
  const video = player();
  if (!video || !room?.media || room.media.watchId !== watchId() || !lastVersion || applying || Date.now() < suppressedUntil) return;
  if (remote && Date.now() - remote.at < 10000 &&
    ((type === 'seek' && Math.abs(video.currentTime - remote.target) < 2.5) ||
      (type === 'play' && remote.playing && !video.paused) ||
      (type === 'pause' && !remote.playing && video.paused))) return;
  if (type === 'seek' && Date.now() - lastSeekAt < 700) return;
  if (type === 'seek') lastSeekAt = Date.now();
  report(type, video);
}
function attach() {
  const id = watchId();
  if (id !== lastWatch) {
    lastWatch = id;
    lastVersion = 0;
    remote = null;
    if (id) report('detected', player());
  }
  const video = player();
  if (video === attached) return;
  if (attached) {
    attached.removeEventListener('play', onPlay);
    attached.removeEventListener('pause', onPause);
    attached.removeEventListener('seeked', onSeek);
  }
  attached = video;
  if (video) {
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeek);
    report('detected', video);
    void applyRoom();
  }
}
const onPlay = () => localEvent('play');
const onPause = () => localEvent('pause');
const onSeek = () => localEvent('seek');

async function applyRoom() {
  const state = room;
  const video = player();
  if (!state?.media || !state.playback || !video || state.media.watchId !== watchId() || applying || state.playback.version <= lastVersion) return;
  applying = true;
  suppressedUntil = Date.now() + 2000;
  try {
    const pb = state.playback;
    const elapsed = pb.state === 'playing' ? Math.max(0, Math.min(14400, (state.serverTime - pb.updatedAt) / 1000)) : 0;
    const target = Math.max(0, Math.min(86400, pb.positionSec + elapsed));
    remote = { at: Date.now(), target, playing: pb.state === 'playing' };
    // "Sincronizar agora": na primeira vez que vê uma nova sincronização, vai exatamente ao ponto combinado (sem a folga de 2,5 s)
    const freshSync = Number(pb.syncId) > 0 && pb.syncId !== lastSyncId;
    let seekFailed = false;
    if (Number.isFinite(video.currentTime) && (freshSync || Math.abs(video.currentTime - target) > 2.5)) seekFailed = !(await seekViaNetflix(target));
    if (pb.state === 'playing' && video.paused) await video.play();
    if (pb.state === 'paused' && !video.paused) video.pause();
    if (room === state) { lastVersion = pb.version; if (freshSync) lastSyncId = pb.syncId; }
    report('status', video, seekFailed ? 'seek-unavailable' : 'applied');
  } catch (error) {
    if (room === state) lastVersion = state.playback.version;
    report('status', video, error?.name === 'NotAllowedError' ? 'autoplay-blocked' : 'player-failed');
  } finally {
    applying = false;
    suppressedUntil = Date.now() + 1500;
  }
}
ipcRenderer.on('duotela:netflix-state', (_event, state) => {
  if (!state?.media) { room = state; lastVersion = 0; lastSyncId = 0; remote = null; return; }
  if (room?.code !== state.code || room?.media?.watchId !== state.media.watchId) { lastVersion = 0; lastSyncId = 0; remote = null; }
  room = state;
  void applyRoom();
});
setInterval(attach, 700);
