/* Lado da página Dalari Cine da ponte Netflix (a página guarda a credencial; a extensão nunca a recebe).
   Conversa com o content script da extensão por um MessageChannel privado, aberto num handshake com a
   origem EXATA da página. Se a extensão não estiver instalada, nada acontece e a interface explica. */
(function (root, factory) {
  const api = factory(typeof require === 'function' && typeof module === 'object' ? require('../extension-bridge/src/bridge-protocol.js') : root.DuoTelaBridgeProtocol);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoNetflixBridge = api;
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const PING_MS = 20000;

  function randomNonce(win) {
    const bytes = new Uint8Array(18);
    win.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  }

  class NetflixBridge {
    constructor({ window: win, onChange, onEvent, setIntervalFn, clearIntervalFn } = {}) {
      this.win = win;
      this.onChange = onChange || (() => {});
      this.onEvent = onEvent || (() => {});
      // Funções nativas precisam ser chamadas sem o objeto como `this` (senão: Illegal invocation).
      this.setIntervalFn = setIntervalFn ? (fn, ms) => setIntervalFn(fn, ms) : (fn, ms) => setInterval(fn, ms);
      this.clearIntervalFn = clearIntervalFn ? (id) => clearIntervalFn(id) : (id) => clearInterval(id);
      this.port = null;
      this.nonce = null;
      this.timers = [];
      this.room = null;                // { code, you }
      this.desired = null;             // associação confirmada pelo usuário: { tabId, watchId, titleId }
      this.state = { detected: false, connected: false, version: '', tabs: [], bound: null, status: null, error: null };
      this.listener = (ev) => this.#onWindowMessage(ev);
    }

    start() {
      if (this.nonce) return;
      this.win.addEventListener('message', this.listener);
      const hello = () => {
        if (this.port) return;
        this.nonce = this.nonce || randomNonce(this.win);
        this.win.postMessage({ source: 'duotela-page', v: 1, type: 'bridge.hello', nonce: this.nonce }, this.win.location.origin);
      };
      this.nonce = randomNonce(this.win);
      hello();
      this.timers.push(this.setIntervalFn(hello, 1500));
      this.timers.push(this.setIntervalFn(() => this.#send({ v: 1, type: 'room.ping' }), PING_MS));
    }

    stop() {
      this.win.removeEventListener('message', this.listener);
      for (const t of this.timers) this.clearIntervalFn(t);
      this.timers = [];
      if (this.port) { try { this.port.close(); } catch (e) { /* nada */ } }
      this.port = null; this.nonce = null; this.desired = null; this.room = null;
      this.state = { detected: false, connected: false, version: '', tabs: [], bound: null, status: null, error: null };
      this.onChange(this.state);
    }

    #onWindowMessage(ev) {
      if (ev.source !== this.win || ev.origin !== this.win.location.origin) return;
      const d = ev.data;
      if (!d || d.source !== 'duotela-extension' || d.type !== 'bridge.port' || d.v !== 1 || d.nonce !== this.nonce || !ev.ports || ev.ports.length !== 1) return;
      if (this.port) { try { this.port.close(); } catch (e) { /* nada */ } }
      this.port = ev.ports[0];
      this.port.onmessage = (e) => this.#onPortMessage(e.data);
      this.state = { ...this.state, detected: true };
      if (this.room) this.#send({ v: 1, type: 'room.hello', code: this.room.code, you: this.room.you });
      this.onChange(this.state);
    }

    #onPortMessage(m) {
      if (m && m.v === 1 && m.type === 'ext.state' && typeof m.connected === 'boolean') {
        this.state = { ...this.state, detected: true, connected: m.connected, version: typeof m.version === 'string' ? m.version.slice(0, 16) : '' };
        if (!m.connected) this.state.bound = null;          // o hub reinicia sem estado: a associação é refeita sozinha
        else if (this.room) this.#send({ v: 1, type: 'room.hello', code: this.room.code, you: this.room.you });
        return this.onChange(this.state);
      }
      if (!P.validate(m, 'hub->room').ok) return;
      if (m.type === 'hub.tabs') {
        this.state = { ...this.state, tabs: m.tabs };
        const d = this.desired;
        if (d && !this.state.bound) {
          const t = m.tabs.find((x) => x.tabId === d.tabId && x.watchId === d.watchId && (!x.bound || x.mine));
          if (t) this.#send({ v: 1, type: 'room.bind', tabId: d.tabId, watchId: d.watchId, titleId: d.titleId });
        }
      } else if (m.type === 'hub.bound') {
        this.state = { ...this.state, bound: { tabId: m.tabId, watchId: m.watchId }, error: null, status: null };
        this.#flushSnapshot();
      } else if (m.type === 'hub.unbound') {
        if (m.reason !== 'room_replaced') this.state = { ...this.state, bound: null, status: null };
        if (['watch_changed', 'tab_closed', 'tab_replaced', 'user', 'room_changed'].includes(m.reason)) this.desired = null;
        this.state.error = m.reason === 'watch_changed' ? 'A aba da Netflix abriu outro título. Associe de novo se for o mesmo.' : m.reason === 'tab_closed' ? 'A aba da Netflix foi fechada.' : null;
      } else if (m.type === 'hub.bindError') {
        this.desired = null;
        this.state = { ...this.state, bound: null, error: m.reason === 'already_bound' ? 'Essa aba da Netflix já está ligada a outra sala deste navegador.' : m.reason === 'watch_changed' ? 'A aba da Netflix mudou de título antes da associação.' : 'Aba da Netflix não encontrada. Abra o título e tente de novo.' };
      } else if (m.type === 'hub.status') {
        this.state = { ...this.state, status: m.state };
      } else if (m.type === 'hub.event') {
        return this.onEvent(m, (ok) => this.#send({ v: 1, type: 'room.ack', id: m.id, ok: !!ok }));
      }
      this.onChange(this.state);
    }

    #send(m) { try { if (this.port) this.port.postMessage(m); } catch (e) { /* porta fechada */ } }

    setRoom(room) {
      if (room && P.CODE_RE.test(room.code) && P.ROLE_RE.test(room.you)) {
        const changed = !this.room || this.room.code !== room.code || this.room.you !== room.you;
        if (changed && this.room) {
          this.desired = null;
          this.state = { ...this.state, bound: null, status: null, error: null };
        }
        this.room = { code: room.code, you: room.you };
        if (changed) this.#send({ v: 1, type: 'room.hello', code: room.code, you: room.you });
      } else { this.room = null; this.desired = null; }
    }

    refresh() { this.#send({ v: 1, type: 'room.refresh' }); }

    /** Só chamar depois da confirmação explícita do usuário (ou para a mídia que a sala já escolheu). */
    bind(tabId, watchId, titleId) {
      this.desired = { tabId, watchId, titleId };
      this.state = { ...this.state, error: null };
      this.#send({ v: 1, type: 'room.bind', tabId, watchId, titleId });
    }
    unbind() { this.desired = null; this.#send({ v: 1, type: 'room.unbind' }); }

    #lastSnapshot = null;
    pushSnapshot(snapshot) {
      this.#lastSnapshot = snapshot;
      this.#flushSnapshot();
    }
    #flushSnapshot() {
      const s = this.#lastSnapshot;
      if (!s || !this.state.bound || !this.room) return;
      const clean = P.sanitizeSnapshot(s, this.room);   // só os campos da ponte: nunca voz/SDP/tokens
      if (clean) this.#send({ v: 1, type: 'room.snapshot', snapshot: clean });
    }
  }

  /** Cola entre a sala (credencial) e a ponte. Mesmo código na interface e nos testes. */
  function createRoomLink({ client, bridge, onApply }) {
    const snap = () => client.snapshot;
    return {
      /** O usuário confirmou que a aba (tabId, watchId) é o título do match: seleciona a mídia na sala e liga a aba. */
      async associate(tabId, watchId) {
        const s = snap();
        if (!s || !s.selectedMatch || s.platform !== 'netflix') throw new Error('Sem match da Netflix.');
        await client.selectNetflixTitle(s.selectedMatch, watchId);
        bridge.bind(tabId, watchId, s.selectedMatch);
        if (onApply) onApply(client.snapshot);
      },
      /** Mídia já escolhida na sala: liga esta aba, só se o watchId for exatamente o da sala. */
      sync(tabId, watchId) {
        const m = snap()?.media;
        if (!m || m.provider !== 'netflix' || m.watchId !== watchId) throw new Error('A aba não é o título da sala.');
        bridge.bind(tabId, watchId, m.titleId);
      },
      unsync() { bridge.unbind(); },
      /** Evento real do player da Netflix: só vale para a mídia selecionada na sala; confirma (ack) quando a sala aceitou. */
      handleEvent(m, ack) {
        const media = snap()?.media;
        if (!media || media.provider !== 'netflix' || media.titleId !== m.titleId || media.watchId !== m.watchId) { ack(false); return; }
        client.playbackNetflix(m.titleId, m.watchId, m.action, m.positionSec).then(() => { if (onApply) onApply(client.snapshot); ack(true); }, () => ack(false));
      },
    };
  }

  return { NetflixBridge, createRoomLink, netflixWatchUrl: P.netflixWatchUrl };
});
