// Content script da aba Dalari Cine (mundo isolado). Liga a pagina da sala ao hub da extensao.
// A credencial da sala NUNCA passa por aqui: so mensagens do protocolo da ponte (validadas dos dois lados).
// Pagina <-> script: handshake por window.postMessage com origem EXATA da pagina e posterior MessageChannel
// privado (a porta e transferida apenas para a mesma origem). Nenhuma mensagem usa targetOrigin "*".
(function (root) {
  "use strict";

  const P = typeof module !== "undefined" && module.exports ? require("./bridge-protocol.js") : root.DuoTelaBridgeProtocol;
  const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
  const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

  function createRoomContent({ window: win, runtime, location, setTimeoutFn = setTimeout }) {
    if (!P.isRoomOrigin(location.origin)) return { disabled: true };     // defesa: so em origens da sala
    let pagePort = null;
    let hubPort = null;
    let hubUp = false;
    let backoff = 300;
    let version = "";
    try { version = String(runtime.getManifest().version).slice(0, 16); } catch (_error) { version = ""; }

    const toPage = (m) => { try { if (pagePort) pagePort.postMessage(m); } catch (_error) { /* página fechou */ } };
    const announce = () => toPage({ v: 1, type: "ext.state", connected: hubUp, version });

    function connectHub() {
      let port;
      try { port = runtime.connect({ name: "duotela-room" }); } catch (_error) { return scheduleReconnect(); }
      hubPort = port;
      hubUp = true;
      port.onMessage.addListener((m) => {
        if (hubPort !== port || !P.validate(m, "hub->room").ok) return;
        toPage(m);
      });
      port.onDisconnect.addListener(() => {
        if (hubPort !== port) return;
        hubPort = null; hubUp = false; announce();
        scheduleReconnect();
      });
      backoff = 300;
      announce();
    }
    function scheduleReconnect() {
      setTimeoutFn(() => { if (!hubPort) connectHub(); }, backoff);
      backoff = Math.min(backoff * 2, 8000);
    }

    function onPageMessage(ev) {
      const m = ev.data;
      if (!isPlain(m) || !P.validate(m, "room->hub").ok) return;
      if (!hubPort) connectHub();
      try { hubPort.postMessage(m); } catch (_error) { /* hub caiu; a reconexão avisa a página */ }
    }

    win.addEventListener("message", (ev) => {
      if (ev.source !== win || ev.origin !== location.origin) return;
      const d = ev.data;
      if (!isPlain(d) || d.source !== "duotela-page" || d.type !== "bridge.hello" || d.v !== 1 || typeof d.nonce !== "string" || !NONCE_RE.test(d.nonce)) return;
      if (pagePort) { try { pagePort.close(); } catch (_error) { /* nada */ } }
      const channel = new MessageChannel();
      pagePort = channel.port1;
      pagePort.onmessage = onPageMessage;
      win.postMessage({ source: "duotela-extension", v: 1, type: "bridge.port", nonce: d.nonce }, location.origin, [channel.port2]);
      if (!hubPort) connectHub(); else announce();
    });

    return {
      disabled: false,
      dispose() { if (pagePort) { try { pagePort.close(); } catch (_error) { /* nada */ } pagePort = null; } if (hubPort) { const p = hubPort; hubPort = null; try { p.disconnect(); } catch (_error) { /* nada */ } } },
      _state: () => ({ hubUp, hasPage: !!pagePort }),
    };
  }

  const api = Object.freeze({ createRoomContent });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.DuoTelaRoomContent = api;
    const ext = root.chrome && root.chrome.runtime && root.chrome.runtime.id ? root.chrome : null;
    if (ext && root.window === root) createRoomContent({ window: root, runtime: ext.runtime, location: root.location });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
