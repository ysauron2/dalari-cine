/* Player oficial do YouTube. Só recebe IDs validados; não pesquisa vídeos nem usa credenciais. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoYouTubePlayer = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';
  const ID = /^[A-Za-z0-9_-]{11}$/;
  let apiPromise;

  function parseVideoId(input) {
    const value = String(input || '').trim();
    if (ID.test(value)) return value;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    let id = null;
    if (host === 'youtu.be') id = url.pathname.slice(1);
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else if (/^\/(embed|shorts)\/[^/]+$/.test(url.pathname)) id = url.pathname.split('/')[2];
    } else if (host === 'www.youtube-nocookie.com' && /^\/embed\/[^/]+$/.test(url.pathname)) id = url.pathname.split('/')[2];
    return ID.test(id || '') ? id : null;
  }

  function formatClock(value) {
    const total = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
  }

  function loadApi() {
    if (root.YT?.Player) return Promise.resolve(root.YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      const old = root.onYouTubeIframeAPIReady;
      const timer = setTimeout(() => reject(new Error('YouTube não carregou.')), 12000);
      root.onYouTubeIframeAPIReady = () => {
        if (typeof old === 'function') old();
        clearTimeout(timer);
        resolve(root.YT);
      };
      const script = root.document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => { clearTimeout(timer); reject(new Error('Falha ao carregar YouTube.')); };
      root.document.head.append(script);
    }).catch((error) => { apiPromise = null; throw error; });
    return apiPromise;
  }

  function create(container, { onAction, onError } = {}) {
    if (!container || !root.document) throw new TypeError('container obrigatório');
    container.classList.add('duo-youtube-player');
    const heading = root.document.createElement('b');
    const status = root.document.createElement('p');
    status.setAttribute('role', 'status');
    const startButton = root.document.createElement('button');
    startButton.type = 'button';
    startButton.textContent = 'Reproduzir aqui';
    startButton.hidden = true;
    const frame = root.document.createElement('div');
    frame.className = 'duo-youtube-frame';
    container.append(heading, status, frame, startButton);
    let player = null, videoId = null, latest = null, lastVersion = -1, suppressedUntil = 0, generation = 0, readyTimer = null, autoplayBlocked = false;
    startButton.addEventListener('click', () => {
      if (!player || !latest?.media) return;
      playLocal();
    });
    const error = (message) => { status.textContent = message; if (onError) onError(message); };
    const wantedPosition = () => {
      const p = latest?.playback;
      if (!p) return 0;
      const elapsed = p.state === 'playing' ? Math.max(0, (latest.serverTime - p.updatedAt) / 1000 + (Date.now() - latest.localReceivedAt) / 1000) : 0;
      return Math.max(0, p.positionSec + elapsed);
    };
    function applyPlayback(force = false) {
      if (!player || !latest) return;
      const p = latest.playback;
      const version = p?.version || 0;
      if (!force && version === lastVersion) return;
      lastVersion = version;
      const target = wantedPosition();
      const actual = Number(player.getCurrentTime?.()) || 0;
      suppressedUntil = Date.now() + 1200;
      if (force || Math.abs(actual - target) > 2) player.seekTo(target, true);
      if (p?.state === 'playing') player.playVideo();
      else player.pauseVideo();
      status.textContent = p?.state === 'playing' ? 'Reproduzindo para a sala' : 'Pausado para a sala';
    }
    function mount(id) {
      const mine = ++generation;
      loadApi().then((YT) => {
        if (mine !== generation || !container.isConnected) return;
        const slot = root.document.createElement('div');
        frame.replaceChildren(slot);
        readyTimer = setTimeout(() => {
          if (mine === generation) error('O player do YouTube não respondeu. Verifique a conexão ou escolha outro vídeo.');
        }, 15000);
        player = new YT.Player(slot, {
          videoId: id, width: '100%', height: '100%',
          playerVars: { origin: root.location.origin, playsinline: 1, controls: 1, rel: 0 },
          events: {
            onReady: () => { if (mine !== generation) return; clearTimeout(readyTimer); readyTimer = null; applyPlayback(true); },
            onStateChange: (event) => {
              if (event.data === YT.PlayerState.PLAYING) { autoplayBlocked = false; startButton.hidden = true; }
              if (mine !== generation || Date.now() < suppressedUntil || !latest?.media) return;
              let action = null;
              if (event.data === YT.PlayerState.PLAYING) action = 'play';
              if (event.data === YT.PlayerState.PAUSED) action = 'pause';
              if (!action) return;
              const position = Math.max(0, Number(player.getCurrentTime()) || 0);
              Promise.resolve(onAction?.(latest.media.titleId, action, position)).catch((e) => error(e?.message || 'Falha ao sincronizar.'));
            },
            onError: () => { if (mine !== generation) return; clearTimeout(readyTimer); readyTimer = null; error('Este vídeo não pode ser reproduzido aqui. Escolha outro link do YouTube.'); },
            onAutoplayBlocked: () => { autoplayBlocked = true; startButton.hidden = false; status.textContent = 'O navegador bloqueou o início automático. A sala já está liberada: clique em Reproduzir aqui.'; },
          },
        });
      }).catch((e) => error(e.message));
    }
    function update(snapshot) {
      const media = snapshot?.status === 'active' && snapshot?.media?.provider === 'youtube' ? snapshot.media : null;
      container.hidden = !media;
      if (!media) {
        generation++;
        clearTimeout(readyTimer); readyTimer = null;
        startButton.hidden = true;
        if (player?.destroy) player.destroy();
        player = null; videoId = null; latest = null; lastVersion = -1; autoplayBlocked = false; duckBase = null;
        frame.replaceChildren();
        return;
      }
      latest = { ...snapshot, localReceivedAt: Date.now() };
      heading.textContent = 'Assistindo no YouTube';
      if (media.videoId !== videoId) {
        clearTimeout(readyTimer); readyTimer = null;
        if (player?.destroy) player.destroy();
        player = null; videoId = media.videoId; lastVersion = -1; autoplayBlocked = false;
        startButton.hidden = true;
        status.textContent = 'Carregando o vídeo…';
        mount(videoId);
      } else applyPlayback();
    }
    function currentPosition() { return Math.max(0, Number(player?.getCurrentTime?.()) || 0); }
    function playLocal() { suppressedUntil = Date.now() + 1200; autoplayBlocked = false; startButton.hidden = true; status.textContent = 'Iniciando neste navegador…'; if (player?.playVideo) player.playVideo(); }
    function needsLocalStart() { return autoplayBlocked; }
    function pauseLocal() { suppressedUntil = Date.now() + 1200; if (player?.pauseVideo) player.pauseVideo(); }
    function duration() { const d = Number(player?.getDuration?.()); return Number.isFinite(d) && d > 0 ? d : 0; }
    function syncedPosition() { return latest ? wantedPosition() : 0; }
    // Ducking: abaixa o volume do player enquanto alguém fala (gain 1 = volume que a pessoa tinha). Guarda o volume original
    // ao começar a abaixar e o devolve ao voltar a 1.
    let duckBase = null;
    function duck(gain) {
      if (!player || typeof player.setVolume !== 'function' || typeof player.getVolume !== 'function') return;
      if (!(gain < 1)) { if (duckBase !== null) { player.setVolume(duckBase); duckBase = null; } return; }
      if (duckBase === null) duckBase = Number(player.getVolume());
      if (Number.isFinite(duckBase)) player.setVolume(Math.max(0, Math.round(duckBase * Math.max(0, gain))));
    }
    function fullscreen() { const el = frame.querySelector('iframe') || frame; return el.requestFullscreen?.(); }
    function destroy() { generation++; clearTimeout(readyTimer); autoplayBlocked = false; startButton.hidden = true; if (player?.destroy) player.destroy(); player = null; frame.replaceChildren(); }
    return { update, destroy, currentPosition, playLocal, pauseLocal, duration, syncedPosition, fullscreen, needsLocalStart, duck };
  }
  return { parseVideoId, formatClock, create };
});
