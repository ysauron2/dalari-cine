"use strict";
// Dublês para testar a ponte sem navegador: portas de runtime, janela, documento e <video> falsos.
const flush = (n = 6) => new Promise((resolve) => { let i = 0; const step = () => (++i >= n ? resolve() : setImmediate(step)); setImmediate(step); });
const wire = [];   // tudo que atravessa portas/janelas, para provar que nenhuma credencial passa
const clone = (v) => (v === undefined ? v : structuredClone(v));

function makePortPair(name, senderInfo) {
  const mk = () => ({ msg: [], dis: [], other: null, closed: false });
  const a = mk(), b = mk();
  const port = (me, other, extra) => ({
    name, ...extra,
    postMessage(m) { if (me.closed) throw new Error("port closed"); wire.push(JSON.stringify(m)); const c = clone(m); queueMicrotask(() => { if (!other.closed) for (const fn of other.msg) fn(c); }); },
    onMessage: { addListener: (fn) => me.msg.push(fn) },
    onDisconnect: { addListener: (fn) => me.dis.push(fn) },
    disconnect() { if (me.closed) return; me.closed = true; other.closed = true; queueMicrotask(() => { for (const fn of other.dis) fn(); }); },
  });
  return { client: port(a, b, {}), server: port(b, a, { sender: senderInfo }) };
}

// Runtime de uma aba: connect() liga a porta ao hub entregando o sender que o navegador forneceria.
function makeRuntime(hub, { tabId, origin, url, id = "ext-id", frameId = 0, version = "0.1.0" }) {
  return {
    id,
    getManifest: () => ({ version }),
    connect({ name }) {
      const { client, server } = makePortPair(name, { id, origin, url, frameId, tab: { id: tabId } });
      hub.onConnect(server);
      return client;
    },
  };
}

class FakeWindow {
  constructor(origin) { this.location = { origin, href: origin + "/" }; this.listeners = []; this.crypto = globalThis.crypto; this.window = this; }
  addEventListener(t, fn) { if (t === "message") this.listeners.push(fn); }
  removeEventListener(t, fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
  postMessage(data, targetOrigin, transfer) {
    wire.push(JSON.stringify(data));
    if (targetOrigin !== this.location.origin) return;     // origem genérica ("*") nunca é usada; qualquer outra não entrega
    queueMicrotask(() => { for (const fn of [...this.listeners]) fn({ data, source: this, origin: this.location.origin, ports: transfer || [] }); });
  }
  // Mensagem vinda de OUTRA origem/janela (atacante): o filtro do receptor precisa descartá-la.
  inject(data, { origin, source }) { queueMicrotask(() => { for (const fn of [...this.listeners]) fn({ data, source: source === undefined ? {} : source, origin, ports: [] }); }); }
}

class FakeVideo {
  constructor({ duration = 7200 } = {}) {
    this._t = 0; this.duration = duration; this.paused = true; this.ended = false; this.readyState = 4;
    this.blockPlay = false; this.calls = []; this.doc = null;
  }
  getBoundingClientRect() { return { width: 1280, height: 720 }; }
  closest() { return {}; }
  fire(type) { queueMicrotask(() => this.doc && this.doc.dispatch(type, this)); }
  play() {
    this.calls.push("play");
    if (this.blockPlay) { const e = new Error("blocked"); e.name = "NotAllowedError"; return Promise.reject(e); }
    if (this.paused) { this.paused = false; this.fire("play"); }
    return Promise.resolve();
  }
  pause() { this.calls.push("pause"); if (!this.paused) { this.paused = true; this.fire("pause"); } }
  // Como o navegador: atribuir currentTime dispara "seeked" (assíncrono); o relógio normal usa advance().
  get currentTime() { return this._t; }
  set currentTime(v) { this._t = v; this.fire("seeked"); }
  advance(sec) { this._t += sec; }
  seekByUser(v) { this.currentTime = v; }
  playByUser() { this.paused = false; this.fire("play"); }
  pauseByUser() { this.paused = true; this.fire("pause"); }
}

class FakeDocument {
  constructor(video) { this.video = video; this.handlers = []; if (video) video.doc = this; this.documentElement = { append() {} }; }
  querySelectorAll(sel) { return sel === "video" && this.video ? [this.video] : []; }
  querySelector() { return null; }
  addEventListener(t, fn, cap) { this.handlers.push({ t, fn, cap }); }
  removeEventListener(t, fn) { this.handlers = this.handlers.filter((h) => !(h.t === t && h.fn === fn)); }
  dispatch(type, target) { for (const h of [...this.handlers]) if (h.t === type) h.fn({ type, target }); }
}

function makeOverlayFactory() {
  const state = { shown: false, text: "", resume: null };
  const factory = (_doc, onResume) => { state.resume = onResume; return { show(t) { state.shown = true; state.text = t; }, hide() { state.shown = false; }, dispose() {} }; };
  return { state, factory };
}

module.exports = { wire, flush, clone, makePortPair, makeRuntime, FakeWindow, FakeVideo, FakeDocument, makeOverlayFactory };
