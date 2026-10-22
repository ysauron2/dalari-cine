"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../src/bridge-protocol.js");
const { createHub } = require("../src/hub.js");
const { createRoomContent } = require("../src/room-content.js");
const { createNetflixContent } = require("../src/netflix-content.js");
const { NetflixBridge } = require("../../server/netflix-bridge.js");
const { flush, makeRuntime, makePortPair, FakeWindow, FakeVideo, FakeDocument, makeOverlayFactory } = require("./helpers.cjs");

const ROOM_ORIGIN = "http://127.0.0.1:8794";
const NF = "https://www.netflix.com";
const m = (type, f = {}) => ({ v: 1, type, ...f });
const snapshot = (over = {}) => ({
  v: 1, code: "123456", you: "host", revision: 5, serverTime: 1_000_000, status: "active", platform: "netflix", selectedMatch: "tmdb:movie:42",
  media: { provider: "netflix", titleId: "tmdb:movie:42", watchId: "80057281" },
  playback: { titleId: "tmdb:movie:42", watchId: "80057281", state: "playing", positionSec: 0, updatedBy: "host", updatedAt: 1_000_000, version: 1 },
  voice: { ready: {}, links: [{ peer: "guest", remote: { session: 1, sdp: "v=0\r\nSEGREDO-SDP" } }] }, viewing: { host: {} }, names: { host: "Ana" }, ...over,
});

// ---------- protocolo ----------
test("protocolo: chaves exatas, direção, versão e limites", () => {
  assert.ok(P.validate(m("room.hello", { code: "123456", you: "host" }), "room->hub").ok);
  assert.equal(P.validate(m("room.hello", { code: "123456", you: "host", token: "x" }), "room->hub").reason, "keys");
  assert.equal(P.validate(m("room.hello", { code: "12345", you: "host" }), "room->hub").reason, "fields");
  assert.equal(P.validate(m("room.hello", { code: "123456", you: "root" }), "room->hub").reason, "fields");
  assert.equal(P.validate({ ...m("room.ping"), v: 2 }, "room->hub").reason, "version");
  assert.equal(P.validate(m("hub.pong"), "room->hub").reason, "direction");           // a aba da sala não pode falar como o hub
  assert.equal(P.validate(m("netflix.event", { id: "a1", titleId: "t", watchId: "1", action: "play", positionSec: 1 }), "room->hub").reason, "direction");
  assert.equal(P.validate(m("nada"), "room->hub").reason, "type");
  assert.equal(P.validate(null, "room->hub").reason, "shape");
  assert.equal(P.validate([], "room->hub").reason, "shape");
  const ev = (o) => m("netflix.event", { id: "a1", titleId: "tmdb:movie:42", watchId: "80057281", action: "seek", positionSec: 10, ...o });
  assert.ok(P.validate(ev({}), "netflix->hub").ok);
  for (const bad of [{ watchId: "0123456789012" }, { watchId: "12a" }, { watchId: 80057281 }, { action: "rewind" }, { positionSec: -1 }, { positionSec: 86401 }, { positionSec: NaN }, { positionSec: "5" }, { id: "x y" }, { titleId: "a b" }, { titleId: "x".repeat(81) }]) {
    assert.equal(P.validate(ev(bad), "netflix->hub").ok, false, JSON.stringify(bad));
  }
  assert.equal(P.validate(Object.assign(Object.create({ evil: 1 }), ev({})), "netflix->hub").ok, false); // protótipo estranho
});

test("protocolo: snapshot atravessa só os campos da ponte (sem voz, SDP, nomes ou tokens)", () => {
  const clean = P.sanitizeSnapshot(snapshot(), { code: "123456", you: "host" });
  assert.deepEqual(Object.keys(clean).sort(), ["code", "media", "platform", "playback", "revision", "selectedMatch", "serverTime", "status", "v", "you"]);
  assert.ok(!JSON.stringify(clean).includes("SEGREDO"));
  assert.equal(clean.playback.updatedBy, undefined);
  assert.equal(P.sanitizeSnapshot(snapshot(), { code: "999999", you: "host" }), null);       // outra sala
  assert.equal(P.sanitizeSnapshot(snapshot(), { code: "123456", you: "guest" }), null);      // outro participante
  assert.equal(P.sanitizeSnapshot(snapshot({ media: { provider: "youtube", titleId: "t", videoId: "abcdefghijk" } })), null);
  assert.equal(P.sanitizeSnapshot(snapshot({ media: { provider: "netflix", titleId: "t", watchId: "x" } })), null);
  assert.equal(P.sanitizeSnapshot(snapshot({ playback: { ...snapshot().playback, positionSec: 1e9 } })), null);
  assert.equal(P.sanitizeSnapshot(snapshot({ v: 2 })), null);
  assert.deepEqual(P.sanitizeSnapshot(snapshot({ media: null, playback: null, selectedMatch: null })).media, null);
  assert.equal(P.sanitizeSnapshot("x"), null);
});

test("protocolo: URLs da Netflix e origens da sala", () => {
  assert.equal(P.netflixWatchIdFromUrl("https://www.netflix.com/watch/80057281?trackId=1"), "80057281");
  assert.equal(P.netflixWatchIdFromUrl("https://www.netflix.com/watch/80057281/"), "80057281");
  for (const bad of ["https://www.netflix.com/title/80057281", "http://www.netflix.com/watch/1", "https://netflix.com.evil.example/watch/1", "https://www.netflix.com.evil.example/watch/1", "https://www.netflix.com/watch/1234567890123", "https://www.netflix.com/watch/12/extra", "not a url"]) {
    assert.equal(P.netflixWatchIdFromUrl(bad), null, bad);
  }
  assert.equal(P.netflixWatchUrl("80057281"), "https://www.netflix.com/watch/80057281");
  assert.equal(P.netflixWatchUrl("https://evil"), null);
  assert.ok(P.isRoomOrigin("http://127.0.0.1:8794") && P.isRoomOrigin("http://localhost:3000") && P.isRoomOrigin("http://localhost"));
  for (const bad of ["https://127.0.0.1:1", "http://127.0.0.1.evil.example", "http://evil.example", "http://127.0.0.1:99999999", null, "http://localhost@evil.example"]) assert.equal(P.isRoomOrigin(bad), false, String(bad));
});

// ---------- hub ----------
function setupHub() {
  const clock = { t: 0 };
  const hub = createHub({ runtimeId: "ext-id", now: () => clock.t });
  const room = (tabId, origin = ROOM_ORIGIN) => {
    const rt = makeRuntime(hub, { tabId, origin });
    const port = rt.connect({ name: "duotela-room" });
    const inbox = [];
    port.onMessage.addListener((x) => inbox.push(x));
    return { port, inbox, send: (x) => port.postMessage(x) };
  };
  const net = (tabId, watchId, extra = {}) => {
    const rt = makeRuntime(hub, { tabId, origin: NF, url: `${NF}/watch/${watchId}`, ...extra });
    const port = rt.connect({ name: "duotela-netflix" });
    const inbox = [];
    port.onMessage.addListener((x) => inbox.push(x));
    return { port, inbox, send: (x) => port.postMessage(x), hello: () => port.postMessage(m("netflix.hello", { watchId })) };
  };
  return { hub, clock, room, net };
}
const last = (inbox, type) => [...inbox].reverse().find((x) => x.type === type);

test("hub: recusa remetentes inválidos (outra extensão, origem, frame, URL, nome)", async () => {
  const { hub } = setupHub();
  const tries = [
    ["duotela-netflix", { id: "outra-ext", origin: NF, url: `${NF}/watch/1`, frameId: 0, tab: { id: 1 } }],
    ["duotela-netflix", { id: "ext-id", origin: "https://evil.example", url: `${NF}/watch/1`, frameId: 0, tab: { id: 1 } }],
    ["duotela-netflix", { id: "ext-id", origin: NF, url: `${NF}/browse`, frameId: 0, tab: { id: 1 } }],
    ["duotela-netflix", { id: "ext-id", origin: NF, url: `${NF}/watch/1`, frameId: 3, tab: { id: 1 } }],
    ["duotela-netflix", { id: "ext-id", origin: NF, url: `${NF}/watch/1`, frameId: 0 }],
    ["duotela-room", { id: "ext-id", origin: "https://www.netflix.com", frameId: 0, tab: { id: 2 } }],
    ["duotela-room", { id: "ext-id", origin: "http://evil.example", frameId: 0, tab: { id: 2 } }],
    ["qualquer", { id: "ext-id", origin: ROOM_ORIGIN, frameId: 0, tab: { id: 2 } }],
  ];
  for (const [name, sender] of tries) {
    const { client, server } = makePortPair(name, sender);
    let closed = false; client.onDisconnect.addListener(() => { closed = true; });
    hub.onConnect(server);
    await flush();
    assert.equal(closed, true, JSON.stringify([name, sender]));
  }
  assert.deepEqual(hub._state(), { rooms: 0, nets: 0 });
});

test("hub: só liga abas associadas; snapshot é reconstruído; eventos e acks só vão ao par", async () => {
  const { room, net } = setupHub();
  const r1 = room(10), r2 = room(11);
  const n1 = net(20, "80057281"), n2 = net(21, "80057281");
  n1.hello(); n2.hello();
  r1.send(m("room.hello", { code: "123456", you: "host" }));
  r2.send(m("room.hello", { code: "654321", you: "guest" }));
  await flush();
  assert.deepEqual(last(r1.inbox, "hub.tabs").tabs.map((t) => [t.tabId, t.watchId, t.bound]), [[20, "80057281", false], [21, "80057281", false]]);
  // sem associação nada atravessa: nem snapshot para a aba Netflix, nem evento da aba para a sala
  r1.send(m("room.snapshot", { snapshot: P.sanitizeSnapshot(snapshot()) }));
  n1.send(m("netflix.event", { id: "e0", titleId: "tmdb:movie:42", watchId: "80057281", action: "play", positionSec: 1 }));
  await flush();
  assert.equal(n1.inbox.length, 0);
  assert.equal(r1.inbox.filter((x) => x.type === "hub.event").length, 0);
  // watchId errado na associação é recusado
  r1.send(m("room.bind", { tabId: 20, watchId: "11111", titleId: "tmdb:movie:42" }));
  await flush();
  assert.equal(last(r1.inbox, "hub.bindError").reason, "watch_changed");
  r1.send(m("room.bind", { tabId: 99, watchId: "80057281", titleId: "tmdb:movie:42" }));
  await flush();
  assert.equal(last(r1.inbox, "hub.bindError").reason, "no_tab");
  // associação explícita
  r1.send(m("room.bind", { tabId: 20, watchId: "80057281", titleId: "tmdb:movie:42" }));
  await flush();
  assert.deepEqual(last(r1.inbox, "hub.bound"), m("hub.bound", { tabId: 20, watchId: "80057281" }));
  assert.deepEqual(last(n1.inbox, "netflix.bind"), m("netflix.bind", { code: "123456", you: "host", titleId: "tmdb:movie:42", watchId: "80057281" }));
  // outra sala não pode tomar a mesma aba, mas vê que está em uso
  r2.send(m("room.bind", { tabId: 20, watchId: "80057281", titleId: "tmdb:movie:42" }));
  await flush();
  assert.equal(last(r2.inbox, "hub.bindError").reason, "already_bound");
  assert.deepEqual(last(r2.inbox, "hub.tabs").tabs.find((t) => t.tabId === 20), { tabId: 20, watchId: "80057281", bound: true, mine: false });
  // snapshot completo com voz/SDP vira só a visão mínima; só chega à aba associada
  const dirty = snapshot();
  r1.send(m("room.snapshot", { snapshot: dirty }));
  await flush();
  const got = last(n1.inbox, "netflix.snapshot");
  assert.ok(got);
  assert.ok(!JSON.stringify(got).includes("SEGREDO") && !JSON.stringify(got).includes("viewing"));
  assert.equal(n2.inbox.length, 0);
  // snapshot de outro participante/sala é ignorado
  const before = n1.inbox.length;
  r1.send(m("room.snapshot", { snapshot: snapshot({ code: "999999" }) }));
  r1.send(m("room.snapshot", { snapshot: snapshot({ you: "guest" }) }));
  await flush();
  assert.equal(n1.inbox.length, before);
  // evento do player vai só à sala associada; com ack só aceito para evento real
  n1.send(m("netflix.event", { id: "ev1", titleId: "tmdb:movie:42", watchId: "80057281", action: "pause", positionSec: 33 }));
  await flush();
  assert.deepEqual(last(r1.inbox, "hub.event"), m("hub.event", { id: "ev1", tabId: 20, titleId: "tmdb:movie:42", watchId: "80057281", action: "pause", positionSec: 33 }));
  assert.equal(r2.inbox.filter((x) => x.type === "hub.event").length, 0);
  r2.send(m("room.ack", { id: "ev1", ok: true }));                   // outra sala tenta confirmar
  r1.send(m("room.ack", { id: "forjado", ok: true }));               // id que nunca existiu
  await flush();
  assert.equal(n1.inbox.filter((x) => x.type === "netflix.ack").length, 0);
  r1.send(m("room.ack", { id: "ev1", ok: true }));
  await flush();
  assert.deepEqual(last(n1.inbox, "netflix.ack"), m("netflix.ack", { id: "ev1", ok: true }));
  r1.send(m("room.ack", { id: "ev1", ok: true }));                   // ack só vale uma vez
  await flush();
  assert.equal(n1.inbox.filter((x) => x.type === "netflix.ack").length, 1);
  // evento com watchId diferente da associação é descartado
  n1.send(m("netflix.event", { id: "ev2", titleId: "tmdb:movie:42", watchId: "99999", action: "play", positionSec: 1 }));
  await flush();
  assert.equal(r1.inbox.filter((x) => x.type === "hub.event").length, 1);
});

test("hub: trocar de título, fechar aba ou sair da sala desfaz a associação com aviso", async () => {
  const { room, net } = setupHub();
  const r = room(10), n = net(20, "80057281");
  n.hello(); r.send(m("room.hello", { code: "123456", you: "host" })); await flush();
  r.send(m("room.bind", { tabId: 20, watchId: "80057281", titleId: "tmdb:movie:42" })); await flush();
  // próximo episódio na mesma aba: o watchId mudou, a associação não vale mais
  n.send(m("netflix.hello", { watchId: "80057282" })); await flush();
  assert.equal(last(r.inbox, "hub.unbound").reason, "watch_changed");
  assert.ok(last(n.inbox, "netflix.unbind"));
  assert.deepEqual(last(r.inbox, "hub.tabs").tabs, [{ tabId: 20, watchId: "80057282", bound: false, mine: false }]);
  // reassocia e fecha a aba Netflix
  r.send(m("room.bind", { tabId: 20, watchId: "80057282", titleId: "tmdb:movie:42" })); await flush();
  n.port.disconnect(); await flush();
  assert.equal(last(r.inbox, "hub.unbound").reason, "tab_closed");
  assert.deepEqual(last(r.inbox, "hub.tabs").tabs, []);
  // aba da sala some: a Netflix recebe unbind
  const n2 = net(22, "5");
  n2.hello(); await flush();
  r.send(m("room.bind", { tabId: 22, watchId: "5", titleId: "tmdb:movie:42" })); await flush();
  r.port.disconnect(); await flush();
  assert.ok(last(n2.inbox, "netflix.unbind"));
});

test("hub: aba da sala precisa se identificar; mensagens inválidas e excesso são ignorados", async () => {
  const { room, net, clock } = setupHub();
  const r = room(10), n = net(20, "7");
  n.hello(); await flush();
  r.send(m("room.bind", { tabId: 20, watchId: "7", titleId: "t" })); await flush();       // sem hello
  assert.equal(r.inbox.filter((x) => x.type === "hub.bound").length, 0);
  r.send(m("room.hello", { code: "123456", you: "host", extra: 1 })); r.send({ v: 1, type: "room.hello" }); r.send("texto"); await flush();
  assert.equal(r.inbox.filter((x) => x.type === "hub.tabs").length, 0);
  r.send(m("room.hello", { code: "123456", you: "host" })); await flush();
  r.send(m("room.bind", { tabId: 20, watchId: "7", titleId: "t" })); await flush();
  assert.ok(last(r.inbox, "hub.bound"));
  // taxa: depois do limite a porta deixa de ser atendida até a janela virar
  for (let i = 0; i < 450; i++) r.send(m("room.ping"));
  await flush(20);
  assert.ok(r.inbox.filter((x) => x.type === "hub.pong").length <= 400);
  clock.t += 11000;
  r.send(m("room.ping")); await flush();
  assert.ok(r.inbox.filter((x) => x.type === "hub.pong").length >= 1);
});

// ---------- content script da sala + lado da página ----------
function setupRoomPage({ hubSetup = setupHub() } = {}) {
  const win = new FakeWindow(ROOM_ORIGIN);
  const rt = makeRuntime(hubSetup.hub, { tabId: 10, origin: ROOM_ORIGIN });
  const timers = [];
  const cs = createRoomContent({ window: win, runtime: rt, location: win.location, setTimeoutFn: (fn) => { timers.push(fn); return timers.length; } });
  const events = [];
  const bridge = new NetflixBridge({ window: win, onChange: () => {}, onEvent: (e, ack) => events.push({ e, ack }), setIntervalFn: () => 0, clearIntervalFn: () => {} });
  return { win, cs, bridge, events, timers, ...hubSetup };
}

test("ponte: handshake exige origem e janela exatas; sem extensão nada é detectado", async () => {
  const { win, bridge, cs } = setupRoomPage();
  assert.equal(cs.disabled, false);
  bridge.setRoom({ code: "123456", you: "host" });
  bridge.start();
  await flush();
  assert.equal(bridge.state.detected, true);
  assert.equal(bridge.state.connected, true);
  // atacante: hello de outra origem / outra janela não abre canal
  const spy = [];
  const origPost = win.postMessage.bind(win);
  win.postMessage = (...a) => { spy.push(a); return origPost(...a); };
  win.inject({ source: "duotela-page", v: 1, type: "bridge.hello", nonce: "a".repeat(20) }, { origin: "https://evil.example", source: win });
  win.inject({ source: "duotela-page", v: 1, type: "bridge.hello", nonce: "a".repeat(20) }, { origin: ROOM_ORIGIN, source: {} });
  win.inject({ source: "duotela-page", v: 1, type: "bridge.hello", nonce: "curto" }, { origin: ROOM_ORIGIN, source: win });
  await flush();
  assert.equal(spy.length, 0);
  // nenhuma postMessage da ponte usa targetOrigin genérico
  const bridge2 = new NetflixBridge({ window: win, setIntervalFn: () => 0, clearIntervalFn: () => {} });
  bridge2.start(); await flush();
  assert.ok(spy.every((a) => a[1] === ROOM_ORIGIN));
  bridge.stop(); bridge2.stop(); cs.dispose();
  // fora de origem de sala o content script nem liga
  const alien = new FakeWindow("https://evil.example");
  assert.equal(createRoomContent({ window: alien, runtime: makeRuntime(setupHub().hub, { tabId: 1, origin: "https://evil.example" }), location: alien.location }).disabled, true);
});

test("ponte: a página só entrega a visão mínima e o hub só atende mensagens válidas (credencial nunca aparece)", async () => {
  const s = setupRoomPage();
  const { bridge, hub } = s;
  const secret = "T".repeat(43);
  bridge.setRoom({ code: "123456", you: "host" });
  bridge.start(); await flush();
  const n = s.net(20, "80057281"); n.hello(); await flush();
  assert.equal(bridge.state.tabs.length, 1);
  bridge.bind(20, "80057281", "tmdb:movie:42"); await flush();
  assert.deepEqual(bridge.state.bound, { tabId: 20, watchId: "80057281" });
  const seen = [];
  n.port.onMessage.addListener((x) => seen.push(x));
  bridge.pushSnapshot({ ...snapshot(), token: secret, hostToken: secret }); await flush();
  assert.ok(seen.find((x) => x.type === "netflix.snapshot"));
  assert.ok(!JSON.stringify(seen).includes(secret));
  // snapshot de outra sala não passa
  seen.length = 0;
  bridge.pushSnapshot(snapshot({ code: "000000" })); await flush();
  assert.equal(seen.length, 0);
  // evento do player chega à página com ack e a página confirma
  n.send(m("netflix.event", { id: "ev1", titleId: "tmdb:movie:42", watchId: "80057281", action: "play", positionSec: 5 })); await flush();
  assert.equal(s.events.length, 1);
  s.events[0].ack(true); await flush();
  assert.deepEqual(last(seen, "netflix.ack"), m("netflix.ack", { id: "ev1", ok: true }));
  // reinício do hub (service worker): a associação já confirmada é refeita sem novo clique
  bridge.state.bound = null;                                    // o ext.state(connected=false) zera o estado local
  n.hello(); await flush();
  assert.ok(hub._state().rooms === 1);
  bridge.stop(); s.cs.dispose();
});

test("ponte: trocar de sala descarta a associação antiga sem religar a aba Netflix", async () => {
  const s = setupRoomPage();
  const { bridge } = s;
  bridge.setRoom({ code: "123456", you: "host" });
  bridge.start(); await flush();
  const n = s.net(20, "80057281"); n.hello(); await flush();
  bridge.bind(20, "80057281", "tmdb:movie:42"); await flush();
  assert.deepEqual(bridge.state.bound, { tabId: 20, watchId: "80057281" });
  bridge.setRoom({ code: "654321", you: "guest" }); await flush();
  assert.equal(bridge.desired, null);
  assert.equal(bridge.state.bound, null);
  assert.ok(last(n.inbox, "netflix.unbind"));
  assert.equal(n.inbox.filter((x) => x.type === "netflix.bind").length, 1);
  bridge.stop(); s.cs.dispose();
});

// ---------- content script da Netflix ----------
function setupNetflix({ watchId = "80057281", hubSetup = setupHub(), tabId = 20 } = {}) {
  const video = new FakeVideo();
  const doc = new FakeDocument(video);
  const location = { href: `${NF}/watch/${watchId}` };
  const clock = { t: 1_000_000 };
  const overlay = makeOverlayFactory();
  const intervals = [];
  const rt = makeRuntime(hubSetup.hub, { tabId, origin: NF, url: location.href });
  const nc = createNetflixContent({ document: doc, location, runtime: rt, now: () => clock.t, setIntervalFn: (fn) => { intervals.push(fn); return intervals.length; }, clearIntervalFn: () => {}, overlayFactory: overlay.factory });
  return { video, doc, location, clock, overlay, nc, tick: () => intervals.forEach((f) => f()), ...hubSetup };
}

test("aba Netflix: anuncia só o watchId da URL; some da lista ao sair de /watch; outro episódio desfaz a associação", async () => {
  const hs = setupHub();
  const r = hs.room(10);
  r.send(m("room.hello", { code: "123456", you: "host" }));
  const nf = setupNetflix({ hubSetup: hs });
  await flush();
  assert.deepEqual(last(r.inbox, "hub.tabs").tabs.map((t) => t.watchId), ["80057281"]);
  r.send(m("room.bind", { tabId: 20, watchId: "80057281", titleId: "tmdb:movie:42" })); await flush();
  assert.equal(nf.nc._state().hasCore, true);
  nf.location.href = `${NF}/watch/80057282`;               // autoplay do próximo episódio
  nf.tick(); await flush();
  assert.equal(nf.nc._state().hasCore, false);
  assert.equal(last(r.inbox, "hub.unbound").reason, "watch_changed");
  nf.location.href = `${NF}/browse`;                       // saiu do player
  nf.tick(); await flush();
  assert.deepEqual(last(r.inbox, "hub.tabs").tabs, []);
  nf.location.href = `${NF}/watch/5`;
  nf.tick(); await flush();
  assert.deepEqual(last(r.inbox, "hub.tabs").tabs.map((t) => t.watchId), ["5"]);
});

test("aba Netflix: snapshot da sala controla o vídeo; ação do usuário vai à sala; sem eco", async () => {
  const hs = setupHub();
  const r = hs.room(10);
  r.send(m("room.hello", { code: "123456", you: "host" }));
  const nf = setupNetflix({ hubSetup: hs });
  await flush();
  r.send(m("room.bind", { tabId: 20, watchId: "80057281", titleId: "tmdb:movie:42" })); await flush();
  const roomEvents = [];
  r.port.onMessage.addListener((x) => { if (x.type === "hub.event") { roomEvents.push(x); r.send(m("room.ack", { id: x.id, ok: true })); } });
  // sala manda "tocando em 100s"
  const snap = (rev, ver, state, pos) => P.sanitizeSnapshot(snapshot({ revision: rev, serverTime: 1_000_000, playback: { titleId: "tmdb:movie:42", watchId: "80057281", state, positionSec: pos, updatedAt: 1_000_000, version: ver } }));
  r.send(m("room.snapshot", { snapshot: snap(6, 2, "playing", 100) })); await flush(12);
  assert.equal(nf.video.paused, false);
  assert.equal(nf.video.currentTime, 100);
  await flush(12);
  assert.equal(roomEvents.length, 0, "os eventos causados pela sala não podem voltar para a sala");
  // o usuário pausa no player da Netflix → a sala recebe uma pausa na posição atual
  nf.video.advance(7); nf.video.pauseByUser(); await flush(12);
  assert.equal(roomEvents.length, 1);
  assert.deepEqual([roomEvents[0].action, roomEvents[0].positionSec, roomEvents[0].watchId], ["pause", 107, "80057281"]);
  // e um seek manual
  nf.video.seekByUser(500); await flush(12);
  assert.equal(roomEvents.at(-1).action, "seek");
  assert.equal(roomEvents.at(-1).positionSec, 500);
  // snapshot antigo (revisão/versão menor) não mexe no vídeo
  const calls = nf.video.calls.length;
  r.send(m("room.snapshot", { snapshot: snap(5, 1, "playing", 0) })); await flush(12);
  assert.equal(nf.video.calls.length, calls);
  assert.equal(nf.video.currentTime, 500);
});

test("aba Netflix: autoplay bloqueado mostra 'Reproduzir aqui' só nesta aba e não pausa os outros", async () => {
  const hs = setupHub();
  const r = hs.room(10);
  r.send(m("room.hello", { code: "123456", you: "guest" }));
  const nf = setupNetflix({ hubSetup: hs });
  nf.video.blockPlay = true;
  await flush();
  r.send(m("room.bind", { tabId: 20, watchId: "80057281", titleId: "tmdb:movie:42" })); await flush();
  const roomEvents = [];
  const states = [];
  r.port.onMessage.addListener((x) => { if (x.type === "hub.event") roomEvents.push(x); if (x.type === "hub.status") states.push(x.state); });
  r.send(m("room.snapshot", { snapshot: P.sanitizeSnapshot(snapshot({ you: "guest", revision: 6, playback: { titleId: "tmdb:movie:42", watchId: "80057281", state: "playing", positionSec: 10, updatedAt: 1_000_000, version: 2 } })) })); await flush(12);
  assert.equal(nf.overlay.state.shown, true);
  assert.ok(states.includes("autoplay-blocked"));
  assert.equal(roomEvents.length, 0, "nenhuma pausa/ação sobe para a sala por causa do bloqueio local");
  // o clique do usuário nesta aba permite o play
  nf.video.blockPlay = false;
  await nf.overlay.state.resume(); await flush(12);
  assert.equal(nf.video.paused, false);
  assert.equal(nf.overlay.state.shown, false);
  assert.ok(states.includes("applied"));
});

test("aba Netflix: bind de um hub com watchId diferente da URL é recusado e informado", async () => {
  const { client, server } = makePortPair("duotela-netflix", { id: "ext-id", origin: NF, url: `${NF}/watch/80057281`, frameId: 0, tab: { id: 20 } });
  const rt = { id: "ext-id", getManifest: () => ({ version: "0" }), connect: () => client };
  const seen = [];
  server.onMessage.addListener((x) => seen.push(x));
  const video = new FakeVideo(); const doc = new FakeDocument(video);
  const nc = createNetflixContent({ document: doc, location: { href: `${NF}/watch/80057281` }, runtime: rt, setIntervalFn: () => 1, clearIntervalFn: () => {}, overlayFactory: makeOverlayFactory().factory });
  await flush();
  assert.deepEqual(seen[0], m("netflix.hello", { watchId: "80057281" }));
  server.postMessage(m("netflix.bind", { code: "123456", you: "host", titleId: "tmdb:movie:42", watchId: "99999" }));   // hub com defeito/atrasado
  await flush();
  assert.equal(nc._state().bound, null);
  assert.equal(nc._state().hasCore, false);
  assert.deepEqual(seen.at(-1), m("netflix.status", { state: "blocked-wrong-watch", watchId: "80057281" }));
  // mensagens fora do contrato são ignoradas
  server.postMessage({ v: 1, type: "netflix.bind", code: "123456", you: "host", titleId: "t", watchId: "80057281", extra: 1 });
  server.postMessage({ v: 1, type: "room.ping" });
  await flush();
  assert.equal(nc._state().hasCore, false);
  nc.dispose();
});

test("aba Netflix: ação local sem confirmação da sala não derruba a associação nem gera repetição", async () => {
  const hs = setupHub();
  const r = hs.room(10);
  r.send(m("room.hello", { code: "123456", you: "host" }));
  const nf = setupNetflix({ hubSetup: hs });
  await flush();
  r.send(m("room.bind", { tabId: 20, watchId: "80057281", titleId: "tmdb:movie:42" })); await flush();
  r.send(m("room.snapshot", { snapshot: P.sanitizeSnapshot(snapshot({ revision: 6 })) })); await flush(12);
  const events = [];
  r.port.onMessage.addListener((x) => { if (x.type === "hub.event") events.push(x); });   // a "sala" nunca confirma
  nf.video.advance(3); nf.video.pauseByUser();
  await flush(12);
  assert.equal(events.length, 1);                      // um único envio; sem laço de reenvio
  assert.equal(nf.nc._state().hasCore, true);
});

// ---------- arquivos da extensão ----------
test("manifest: permissões mínimas, só Netflix /watch e origens locais de teste, sem host_permissions", () => {
  const mf = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(mf.manifest_version, 3);
  assert.deepEqual(mf.permissions, []);
  assert.equal(mf.host_permissions, undefined);
  assert.equal(mf.optional_permissions, undefined);
  assert.equal(mf.externally_connectable, undefined);
  assert.equal(mf.web_accessible_resources, undefined);
  assert.deepEqual(mf.content_scripts.map((c) => c.matches), [["https://www.netflix.com/watch/*"], ["http://127.0.0.1/*", "http://localhost/*"]]);
  assert.ok(mf.content_scripts.every((c) => c.all_frames === false));
  assert.ok(mf.content_scripts.every((c) => c.world === undefined));       // mundo isolado (padrão)
  assert.equal(mf.background.service_worker, "src/background.js");
  for (const c of mf.content_scripts) for (const f of c.js) assert.ok(fs.existsSync(path.join(__dirname, "..", f)), f);
});

test("código da extensão não usa rede, armazenamento, cookies, eval nem targetOrigin genérico", () => {
  const dir = path.join(__dirname, "..", "src");
  const files = ["bridge-protocol.js", "hub.js", "room-content.js", "netflix-content.js", "background.js"].map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
  for (const [f, src] of files) {
    const code = src.replace(/\/\/.*$/gm, "");
    for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /localStorage|sessionStorage|indexedDB/, /chrome\.storage|browser\.storage/, /document\.cookie|chrome\.cookies/, /\beval\s*\(/, /new Function/, /chrome\.tabs|chrome\.scripting|webRequest|declarativeNetRequest/, /postMessage\([^)]*,\s*["']\*["']/, /innerHTML|insertAdjacentHTML/, /EncryptedMedia|requestMediaKeySystemAccess|captureStream|MediaRecorder|getDisplayMedia/]) {
      assert.ok(!bad.test(code), `${f}: ${bad}`);
    }
  }
});

test("cópias em vendor/ são idênticas às do spike (sem divergência)", () => {
  const root = path.join(__dirname, "..", "..");
  for (const f of ["video-controller.js", "netflix-room-sync-core.js"]) {
    assert.equal(fs.readFileSync(path.join(root, "extension-bridge", "src", "vendor", f), "utf8"), fs.readFileSync(path.join(root, "extension-spike", "src", f), "utf8"), f);
  }
});
