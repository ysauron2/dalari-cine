// Content script da aba Netflix /watch/<id> (mundo isolado da extensao; a pagina da Netflix nao enxerga estas variaveis).
// Le apenas o watchId da URL e controla o <video> (play/pause/seek) como o proprio usuario faria.
// Sem cookies, sem rede, sem DRM/EME, sem captura, sem armazenamento. Nunca recebe credenciais da sala:
// so uma visao minima do estado (sanitizeSnapshot) e devolve eventos de play/pause/seek do player.
(function (root) {
  "use strict";

  const req = (path, global) => (typeof module !== "undefined" && module.exports ? require(path) : root[global]);
  const P = req("./bridge-protocol.js", "DuoTelaBridgeProtocol");
  const Core = req("./vendor/netflix-room-sync-core.js", "DuoTelaNetflixRoomSyncCore");
  const Ctl = req("./vendor/video-controller.js", "SessaoADoisVideoController");
  const ACK_TIMEOUT_MS = 5000;
  const URL_POLL_MS = 1000;
  const REPORTABLE = new Set(P.STATUS_STATES);

  const newId = () => {
    const bytes = new Uint8Array(12);
    (root.crypto || require("node:crypto").webcrypto).getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };

  function defaultOverlay(document, onResume) {
    // Painel pequeno em Shadow DOM fechado: texto fixo, sem HTML vindo de fora.
    const host = document.createElement("div");
    host.setAttribute("data-duotela-overlay", "");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ":host{all:initial}.box{position:fixed;left:16px;bottom:16px;z-index:2147483647;display:none;gap:10px;align-items:center;padding:10px 14px;border-radius:999px;background:#171E2B;color:#f5f2f5;font:600 13px system-ui,sans-serif;box-shadow:0 8px 30px #000a}.box.on{display:flex}button{font:inherit;border:0;border-radius:999px;padding:8px 16px;background:#FFAC8F;color:#2b1519;cursor:pointer}button:focus-visible{outline:2px solid #fff;outline-offset:2px}span{max-width:260px}";
    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "status");
    const label = document.createElement("span");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Reproduzir aqui";
    button.addEventListener("click", () => onResume());
    box.append(label, button);
    shadow.append(style, box);
    return {
      mount() { if (!host.isConnected) document.documentElement.append(host); },
      show(text) { this.mount(); label.textContent = text; box.classList.add("on"); },
      hide() { box.classList.remove("on"); },
      dispose() { host.remove(); },
    };
  }

  function createNetflixContent({ document, location, runtime, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, overlayFactory = defaultOverlay }) {
    const getLocation = () => location;
    const finder = Ctl.createPageVideoFinder(document, getLocation);
    const controller = Ctl.createVideoController({ findCurrentVideo: finder, getLocation });
    const currentWatchId = () => P.netflixWatchIdFromUrl(location.href);

    let port = null;
    let core = null;
    let bound = null;                 // { code, you, titleId, watchId }
    let lastHello = null;
    const acks = new Map();           // id -> { resolve, reject, timer }

    const send = (type, fields) => { try { if (port) port.postMessage(Object.assign({ v: P.V, type }, fields || {})); } catch (_error) { /* hub caiu */ } };

    const overlay = overlayFactory(document, () => resume());

    const player = {
      getWatchId: currentWatchId,
      getCurrentTime() { const v = finder(); if (!v || !Number.isFinite(v.currentTime)) throw new Error("no-video"); return v.currentTime; },
      async play() {
        const r = await controller.handleMessage({ type: "PLAY" });
        if (!r.ok) { const e = new Error(r.error.code); e.name = r.error.code === "PLAY_BLOCKED_BY_BROWSER" ? "NotAllowedError" : "PlayError"; throw e; }
      },
      async pause() { const r = await controller.handleMessage({ type: "PAUSE" }); if (!r.ok) throw new Error(r.error.code); },
      async seek(seconds) { const r = await controller.handleMessage({ type: "SEEK_TO_SECONDS", seconds }); if (!r.ok) throw new Error(r.error.code); },
    };

    function sendAction(payload) {
      return new Promise((resolve, reject) => {
        const id = newId();
        const timer = setTimeoutFn(() => { acks.delete(id); reject(new Error("ack-timeout")); }, ACK_TIMEOUT_MS);
        acks.set(id, { resolve, reject, timer });
        send("netflix.event", { id, titleId: payload.titleId, watchId: payload.watchId, action: payload.action, positionSec: payload.positionSec });
      });
    }

    function report(result) {
      const state = result && result.state === "applied" ? "applied" : result && result.state;
      if (!bound || !REPORTABLE.has(state)) return;
      send("netflix.status", { state, watchId: bound.watchId });
      if (state === "autoplay-blocked") overlay.show("O navegador pediu um clique para iniciar o vídeo sincronizado.");
      else if (state === "applied") overlay.hide();
    }

    async function resume() {
      if (!core) return;
      report(await core.resumePending());
    }

    function unbindLocal() {
      if (core) core.reset();
      core = null; bound = null;
      overlay.hide();
      for (const [id, a] of acks) { clearTimeoutFn(a.timer); a.reject(new Error("unbound")); acks.delete(id); }
    }

    function onHubMessage(m) {
      if (!P.validate(m, "hub->netflix").ok) return;
      if (m.type === "netflix.bind") {
        if (m.watchId !== currentWatchId()) return send("netflix.status", { state: "blocked-wrong-watch", watchId: currentWatchId() || m.watchId });
        unbindLocal();
        bound = { code: m.code, you: m.you, titleId: m.titleId, watchId: m.watchId };
        core = Core.createNetflixRoomSyncCore({ roomCode: m.code, role: m.you, player, sendAction, now });
      } else if (m.type === "netflix.snapshot") {
        if (!core) return;
        const c = core;
        c.applySnapshot(m.snapshot).then((r) => { if (core === c) report(r); }, () => {});
      } else if (m.type === "netflix.unbind") {
        unbindLocal();
      } else if (m.type === "netflix.ack") {
        const a = acks.get(m.id);
        if (!a) return;
        clearTimeoutFn(a.timer); acks.delete(m.id);
        if (m.ok) a.resolve(); else a.reject(new Error("rejected"));
      }
    }

    function connect() {
      if (port) return;
      let p;
      try { p = runtime.connect({ name: "duotela-netflix" }); } catch (_error) { return; }
      port = p;
      p.onMessage.addListener((m) => { if (port === p) onHubMessage(m); });
      p.onDisconnect.addListener(() => { if (port === p) { port = null; lastHello = null; unbindLocal(); } });
    }

    function tick() {
      const id = currentWatchId();
      if (!id) {                                  // saiu de /watch (navegacao SPA): some da lista
        if (port) { const p = port; port = null; lastHello = null; unbindLocal(); try { p.disconnect(); } catch (_error) { /* nada */ } }
        return;
      }
      if (!port) connect();
      if (bound && bound.watchId !== id) unbindLocal();   // outro episodio/titulo: a associacao nao vale mais
      if (port && lastHello !== id) { lastHello = id; send("netflix.hello", { watchId: id }); }
    }

    // Eventos reais do player (fase de captura no document: eventos de midia nao borbulham).
    function onMedia(ev) {
      const video = finder();
      if (!core || !video || ev.target !== video) return;
      const action = ev.type === "play" ? "play" : ev.type === "pause" ? "pause" : "seek";
      const c = core;
      c.localEvent(action, video.currentTime).then((r) => { if (core === c && r.state === "send-failed") report(r); }, () => {});
    }
    for (const t of ["play", "pause", "seeked"]) document.addEventListener(t, onMedia, true);

    tick();
    const timer = setIntervalFn(tick, URL_POLL_MS);

    return {
      tick,
      dispose() {
        clearIntervalFn(timer);
        for (const t of ["play", "pause", "seeked"]) document.removeEventListener(t, onMedia, true);
        unbindLocal(); overlay.dispose();
        if (port) { try { port.disconnect(); } catch (_error) { /* nada */ } port = null; }
      },
      _state: () => ({ bound, hasCore: !!core, connected: !!port }),
    };
  }

  const api = Object.freeze({ createNetflixContent });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.DuoTelaNetflixContent = api;
    const ext = root.chrome && root.chrome.runtime && root.chrome.runtime.id ? root.chrome : null;
    if (ext && root.document && root.location && P.isNetflixWatchUrl(root.location.href)) {
      createNetflixContent({ document: root.document, location: root.location, runtime: ext.runtime });
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
