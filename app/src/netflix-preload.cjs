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
// Comandos ao player: o player da Netflix dá erro (M7375) quando o <video>.currentTime é atribuído de fora, e também quando há
// saltos muito seguidos; por isso play, pausa e busca são pedidos ao player interno do próprio site (o mesmo que a barra de
// progresso usa), com intervalo mínimo entre buscas. Roda no mundo da página e só passa uma ação fixa e um número.
// Sem esse player não se força a posição: play e pausa caem no <video>, e a posição fica por conta de cada um ("seek-unavailable").
const SEEK_GAP_MS = 2500;
let lastApiSeekAt = 0;
let retryTimer = null;
const ACTIONS = { probe: 'return typeof p.seek === "function" && typeof p.play === "function" && typeof p.pause === "function";', play: 'p.play(); return true;', pause: 'p.pause(); return true;' };
async function viaPlayer(action, sec) {
  if (!webFrame || typeof webFrame.executeJavaScript !== 'function') return false;
  let body = ACTIONS[action];
  if (action === 'seek') {
    if (!Number.isFinite(sec)) return false;
    body = 'p.seek(' + Math.round(Math.max(0, Math.min(86400, sec)) * 1000) + '); return true;';
  }
  if (!body) return false;
  const code = '(() => { try { const vp = window.netflix && window.netflix.appContext && window.netflix.appContext.state.playerApp.getAPI().videoPlayer;'
    + ' if (!vp) return false; const ids = vp.getAllPlayerSessionIds(); if (!ids || !ids.length) return false;'
    + ' const p = vp.getVideoPlayerBySessionId(ids[ids.length - 1]); if (!p) return false; ' + body + ' } catch (e) { return false; } })()';
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
  const pb = state.playback;
  const elapsed = pb.state === 'playing' ? Math.max(0, Math.min(14400, (state.serverTime - pb.updatedAt) / 1000)) : 0;
  const target = Math.max(0, Math.min(86400, pb.positionSec + elapsed));
  // "Sincronizar agora": na primeira vez que vê uma nova sincronização, vai exatamente ao ponto combinado (sem a folga de 2,5 s)
  const freshSync = Number(pb.syncId) > 0 && pb.syncId !== lastSyncId;
  const needSeek = Number.isFinite(video.currentTime) && (freshSync || Math.abs(video.currentTime - target) > 2.5);
  // saltos muito seguidos são bloqueados pela Netflix: espera o intervalo e aplica o estado mais recente
  const wait = needSeek && !freshSync ? SEEK_GAP_MS - (Date.now() - lastApiSeekAt) : 0;
  if (wait > 0) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { void applyRoom(); }, wait + 50); return; }
  applying = true;
  suppressedUntil = Date.now() + 2000;
  try {
    remote = { at: Date.now(), target, playing: pb.state === 'playing' };
    let seekFailed = false;
    if (needSeek) { lastApiSeekAt = Date.now(); seekFailed = !(await viaPlayer('seek', target)); }
    if (pb.state === 'playing' && video.paused && !(await viaPlayer('play'))) await video.play();
    if (pb.state === 'paused' && !video.paused && !(await viaPlayer('pause'))) video.pause();
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

// Saúde do player: em /watch, avisa se o player interno da Netflix não aparece (dois testes seguidos, ~10 s com o vídeo na tela)
// ou se a página mostra um código de erro da Netflix. Só estas palavras de status saem daqui: "api-ok", "api-missing" e
// "netflix-error:<código>". O texto da página só é lido para achar o código (letra + 4 dígitos); nada dele é enviado além do código.
const ERROR_CODE = /\b([MF]\d{4}(?:-\d{3,5}){0,2})\b/;
let healthMisses = 0, healthLast = null, noVideoTicks = 0;
async function healthTick() {
  if (!watchId()) { healthMisses = 0; healthLast = null; noVideoTicks = 0; return; }
  const video = player();
  if (!video) {
    if (++noVideoTicks >= 2) {
      const text = String(document.body && document.body.innerText || '').slice(0, 4000);
      const code = /erro|error|problem/i.test(text) ? ERROR_CODE.exec(text)?.[1] : null;
      if (code && healthLast !== 'netflix-error:' + code) { healthLast = 'netflix-error:' + code; report('status', null, healthLast); }
    }
    return;
  }
  noVideoTicks = 0;
  const ok = await viaPlayer('probe');
  healthMisses = ok ? 0 : healthMisses + 1;
  const next = ok ? 'api-ok' : healthMisses >= 2 ? 'api-missing' : healthLast;
  if (next && next !== healthLast) { healthLast = next; report('status', video, next); }
}
setInterval(healthTick, 5000);
