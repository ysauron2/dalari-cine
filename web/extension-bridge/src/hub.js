// Hub da ponte (roda no service worker). Sem estado persistente: cada aba reconecta e se anuncia de novo.
// Faz so o encaminhamento entre UMA aba da sala e UMA aba Netflix explicitamente associadas, e nunca
// recebe credenciais: o snapshot que repassa e reconstruido por sanitizeSnapshot (sem voz, SDP ou tokens).
(function (root) {
  "use strict";

  const P = typeof module !== "undefined" && module.exports ? require("./bridge-protocol.js") : root.DuoTelaBridgeProtocol;
  const RATE_WINDOW_MS = 10000;
  const RATE_MAX = 400;     // mensagens por porta a cada 10 s (snapshots + eventos do player)
  const MAX_PENDING_ACKS = 64;

  function createHub({ runtimeId, now = Date.now }) {
    const rooms = new Map();   // tabId da sala -> { port, code, you, boundTab, boundWatchId, pending:Set<id> }
    const nets = new Map();    // tabId da Netflix -> { port, watchId, boundTo }

    const post = (port, msg) => { try { port.postMessage(msg); } catch (_error) { /* porta fechada */ } };
    const msg = (type, fields) => Object.assign({ v: P.V, type }, fields || {});

    function tabsFor(roomTabId) {
      const out = [];
      for (const [tabId, n] of nets) {
        if (!n.watchId) continue;
        out.push({ tabId, watchId: n.watchId, bound: n.boundTo !== null, mine: n.boundTo === roomTabId });
      }
      return out.slice(0, 16);
    }
    function broadcastTabs() {
      for (const [roomTabId, r] of rooms) if (r.code !== null) post(r.port, msg("hub.tabs", { tabs: tabsFor(roomTabId) }));   // só abas da sala já identificadas
    }

    function unbindRoom(roomTabId, reason, { notifyRoom = true } = {}) {
      const r = rooms.get(roomTabId);
      if (!r || r.boundTab === null) return;
      const n = nets.get(r.boundTab);
      if (n) { n.boundTo = null; post(n.port, msg("netflix.unbind")); }
      r.boundTab = null; r.boundWatchId = null; r.pending.clear();
      if (notifyRoom) post(r.port, msg("hub.unbound", { reason }));
    }

    function ratelimited(state) {
      const t = now();
      if (t - state.start >= RATE_WINDOW_MS) { state.start = t; state.n = 0; }
      return ++state.n > RATE_MAX;
    }

    function onConnect(port) {
      const sender = port.sender || {};
      const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
      const reject = () => { try { port.disconnect(); } catch (_error) { /* já fechada */ } };
      if (sender.id !== runtimeId || tabId === null || sender.frameId !== 0) return reject();
      if (port.name === "duotela-netflix") {
        if (sender.origin !== P.NETFLIX_ORIGIN) return reject();
        if (sender.url !== undefined && !P.isNetflixWatchUrl(sender.url)) return reject();
        return connectNetflix(port, tabId);
      }
      if (port.name === "duotela-room") {
        if (!P.isRoomOrigin(sender.origin)) return reject();
        return connectRoom(port, tabId);
      }
      return reject();
    }

    function connectNetflix(port, tabId) {
      const old = nets.get(tabId);
      if (old && old.port !== port) { if (old.boundTo !== null) unbindRoom(old.boundTo, "tab_replaced"); try { old.port.disconnect(); } catch (_error) { /* nada */ } }
      const entry = { port, watchId: null, boundTo: null };
      nets.set(tabId, entry);
      const rate = { start: now(), n: 0 };
      port.onMessage.addListener((m) => {
        if (nets.get(tabId) !== entry || ratelimited(rate) || !P.validate(m, "netflix->hub").ok) return;
        if (m.type === "netflix.hello") {
          const changed = entry.watchId !== m.watchId;
          entry.watchId = m.watchId;
          if (changed && entry.boundTo !== null) {
            const roomId = entry.boundTo;
            unbindRoom(roomId, "watch_changed");
          }
          broadcastTabs();
          return;
        }
        if (entry.boundTo === null || !entry.watchId) return;     // sem associacao explicita nada atravessa
        const r = rooms.get(entry.boundTo);
        if (!r || m.watchId !== entry.watchId || m.watchId !== r.boundWatchId) return;
        if (m.type === "netflix.event") {
          if (r.pending.size >= MAX_PENDING_ACKS) r.pending.clear();
          r.pending.add(m.id);
          post(r.port, msg("hub.event", { id: m.id, tabId, titleId: m.titleId, watchId: m.watchId, action: m.action, positionSec: m.positionSec }));
        } else if (m.type === "netflix.status") {
          post(r.port, msg("hub.status", { tabId, state: m.state, watchId: m.watchId }));
        }
      });
      port.onDisconnect.addListener(() => {
        if (nets.get(tabId) !== entry) return;
        nets.delete(tabId);
        if (entry.boundTo !== null) {
          const r = rooms.get(entry.boundTo);
          if (r) { r.boundTab = null; r.boundWatchId = null; r.pending.clear(); post(r.port, msg("hub.unbound", { reason: "tab_closed" })); }
        }
        broadcastTabs();
      });
    }

    function connectRoom(port, tabId) {
      const old = rooms.get(tabId);
      if (old && old.port !== port) { unbindRoom(tabId, "room_replaced", { notifyRoom: false }); try { old.port.disconnect(); } catch (_error) { /* nada */ } }
      const entry = { port, code: null, you: null, boundTab: null, boundWatchId: null, pending: new Set() };
      rooms.set(tabId, entry);
      const rate = { start: now(), n: 0 };
      port.onMessage.addListener((m) => {
        if (rooms.get(tabId) !== entry || ratelimited(rate) || !P.validate(m, "room->hub").ok) return;
        if (m.type === "room.hello") {
          if (entry.code !== null && (entry.code !== m.code || entry.you !== m.you)) unbindRoom(tabId, "room_changed");
          entry.code = m.code; entry.you = m.you;
          post(port, msg("hub.tabs", { tabs: tabsFor(tabId) }));
          return;
        }
        if (entry.code === null) return;                           // precisa se identificar primeiro
        if (m.type === "room.ping") return post(port, msg("hub.pong"));
        if (m.type === "room.refresh") return post(port, msg("hub.tabs", { tabs: tabsFor(tabId) }));
        if (m.type === "room.unbind") { unbindRoom(tabId, "user"); broadcastTabs(); return; }
        if (m.type === "room.bind") {
          const n = nets.get(m.tabId);
          if (!n || !n.watchId) return post(port, msg("hub.bindError", { reason: "no_tab" }));
          if (n.watchId !== m.watchId) return post(port, msg("hub.bindError", { reason: "watch_changed" }));
          if (n.boundTo !== null && n.boundTo !== tabId) return post(port, msg("hub.bindError", { reason: "already_bound" }));
          if (entry.boundTab !== null && entry.boundTab !== m.tabId) unbindRoom(tabId, "rebound", { notifyRoom: false });
          entry.boundTab = m.tabId; entry.boundWatchId = m.watchId; n.boundTo = tabId;
          post(n.port, msg("netflix.bind", { code: entry.code, you: entry.you, titleId: m.titleId, watchId: m.watchId }));
          post(port, msg("hub.bound", { tabId: m.tabId, watchId: m.watchId }));
          broadcastTabs();
          return;
        }
        if (entry.boundTab === null) return;                       // snapshot/ack so vao para a aba associada
        const n = nets.get(entry.boundTab);
        if (!n) return;
        if (m.type === "room.snapshot") {
          const clean = P.sanitizeSnapshot(m.snapshot, { code: entry.code, you: entry.you });
          if (clean) post(n.port, msg("netflix.snapshot", { snapshot: clean }));
        } else if (m.type === "room.ack") {
          if (!entry.pending.delete(m.id)) return;                 // so confirma eventos que realmente vieram dessa aba
          post(n.port, msg("netflix.ack", { id: m.id, ok: m.ok }));
        }
      });
      port.onDisconnect.addListener(() => {
        if (rooms.get(tabId) !== entry) return;
        unbindRoom(tabId, "room_closed", { notifyRoom: false });
        rooms.delete(tabId);
        broadcastTabs();
      });
    }

    return { onConnect, _state: () => ({ rooms: rooms.size, nets: nets.size }) };
  }

  const api = Object.freeze({ createHub });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DuoTelaBridgeHub = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
