"use strict";
// Player falso: estes testes NAO provam sincronizacao na Netflix real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { STATUS, computeTargetPosition, createNetflixRoomSyncCore } = require("../src/netflix-room-sync-core.js");

function fakePlayer(over = {}) {
  const p = {
    watchId: "80100172", time: 10, calls: [], failPlay: null, failSeek: null, failPause: null,
    getWatchId() { return this.watchId; },
    getCurrentTime() { return this.time; },
    async play() { this.calls.push(["play"]); if (this.failPlay) throw this.failPlay; },
    async pause() { this.calls.push(["pause"]); if (this.failPause) throw this.failPause; },
    async seek(s) { this.calls.push(["seek", s]); if (this.failSeek) throw this.failSeek; this.time = s; },
    ...over,
  };
  return p;
}

function snap(over = {}, pb = {}) {
  return {
    v: 1, code: "ABCD", revision: 5, status: "active", you: "a", serverTime: 100000, platform: "netflix",
    selectedMatch: "T1",
    media: { provider: "netflix", titleId: "T1", watchId: "80100172" },
    playback: { titleId: "T1", watchId: "80100172", state: "playing", positionSec: 10, updatedBy: "b", updatedAt: 100000, version: 3, ...pb },
    ...over,
  };
}

function setup({ player = fakePlayer(), sendAction, clock = { t: 0 }, echoWindowMs } = {}) {
  const sent = [];
  const core = createNetflixRoomSyncCore({
    roomCode: "ABCD", role: "a", player, now: () => clock.t, echoWindowMs,
    sendAction: sendAction || ((m) => { sent.push(m); }),
  });
  return { core, player, sent, clock };
}

test("snapshot valido aplica play e nao faz seek dentro de 2s", async () => {
  const { core, player } = setup();
  player.time = 11;
  const r = await core.applySnapshot(snap());
  assert.equal(r.state, STATUS.APPLIED);
  assert.deepEqual(player.calls, [["play"]]);
  assert.equal(core.getStatus().bound.watchId, "80100172");
});

test("seek so quando diferenca > 2s, depois pausa", async () => {
  const { core, player } = setup();
  player.time = 50;
  const r = await core.applySnapshot(snap({}, { state: "paused", positionSec: 20 }));
  assert.equal(r.state, STATUS.APPLIED);
  assert.deepEqual(player.calls, [["seek", 20], ["pause"]]);
});

test("exatamente 2s de diferenca nao faz seek", async () => {
  const { core, player } = setup();
  player.time = 12;
  await core.applySnapshot(snap({}, { state: "paused", positionSec: 10 }));
  assert.deepEqual(player.calls, [["pause"]]);
});

test("posicao calculada: playing soma serverTime-updatedAt; paused nao; limites defensivos", async () => {
  assert.equal(computeTargetPosition("playing", 10, 5), 15);
  assert.equal(computeTargetPosition("paused", 10, 5), 10);
  assert.equal(computeTargetPosition("playing", 86000, 4 * 3600), 86400);
  const { core, player } = setup();
  const r = await core.applySnapshot(snap({ serverTime: 130000 }, { positionSec: 100, updatedAt: 100000 }));
  assert.equal(r.targetSec, 130);
  assert.deepEqual(player.calls, [["seek", 130], ["play"]]);
  // relogio do servidor atrasado (negativo) nao recua a posicao
  const t2 = setup();
  const r2 = await t2.core.applySnapshot(snap({ serverTime: 90000 }, { positionSec: 10 }));
  assert.equal(r2.targetSec, 10);
  // elapsed absurdo e limitado
  const t3 = setup();
  const r3 = await t3.core.applySnapshot(snap({ serverTime: 1e15 }, { positionSec: 10 }));
  assert.equal(r3.targetSec, 10 + 4 * 3600);
});

test("sala, papel, plataforma, status, versao errados sao rejeitados sem comandos", async () => {
  const cases = [
    [{ code: "XXXX" }, STATUS.INVALID], [{ you: "b" }, STATUS.INVALID], [{ platform: "youtube" }, STATUS.INVALID],
    [{ v: 2 }, STATUS.INVALID], [{ selectedMatch: "T2" }, STATUS.INVALID], [{ status: "closed" }, STATUS.NOT_ACTIVE],
  ];
  for (const [over, expected] of cases) {
    const { core, player } = setup();
    const r = await core.applySnapshot(snap(over));
    assert.equal(r.state, expected, JSON.stringify(over));
    assert.equal(player.calls.length, 0);
  }
});

test("shapes invalidos nao lancam nem comandam", async () => {
  const bad = [
    null, undefined, 42, "x", [], {},
    snap({ media: null }), snap({ media: { provider: "youtube", titleId: "T1", watchId: "80100172" } }),
    snap({ media: { provider: "netflix", titleId: "T1", watchId: "12ab" } }),
    snap({ media: { provider: "netflix", titleId: "T1", watchId: "1234567890123" } }),
    snap({ media: { provider: "netflix", titleId: "T1", watchId: "" } }),
    snap({ media: { provider: "netflix", titleId: "T1", watchId: 80100172 } }),
    snap({ media: { provider: "netflix", titleId: "T1", watchId: "٨٠١" } }),
    snap({ playback: null }), snap({}, { watchId: "999" }), snap({}, { titleId: "T2" }),
    snap({}, { version: 0 }), snap({}, { version: 1.5 }), snap({}, { version: "3" }),
    snap({ revision: -1 }), snap({ revision: 1.2 }), snap({ revision: "5" }),
    snap({ serverTime: NaN }), snap({ serverTime: Infinity }), snap({}, { updatedAt: NaN }), snap({}, { updatedAt: "1" }),
    snap({}, { state: "buffering" }), snap({}, { positionSec: -1 }), snap({}, { positionSec: 86401 }),
    snap({}, { positionSec: NaN }), snap({}, { positionSec: "10" }),
    new Proxy({}, { get() { throw new Error("boom"); } }),
  ];
  for (const s of bad) {
    const { core, player } = setup();
    const r = await core.applySnapshot(s);
    assert.equal(r.state, STATUS.INVALID);
    assert.equal(r.ok, false);
    assert.equal(player.calls.length, 0);
    assert.equal(core.getStatus().bound, null);
  }
});

test("titulo errado ou sem video: bloqueado, sem Play/Pause/Seek, e reaplica quando carregar", async () => {
  for (const [watchId, expected] of [["555", STATUS.WRONG_WATCH], [null, STATUS.NO_VIDEO]]) {
    const { core, player } = setup({ player: fakePlayer({ watchId }) });
    const r = await core.applySnapshot(snap());
    assert.equal(r.state, expected);
    assert.equal(player.calls.length, 0);
    player.watchId = "80100172"; // usuario abriu o video certo; mesmo snapshot pode aplicar
    assert.equal((await core.applySnapshot(snap())).state, STATUS.APPLIED);
  }
  const throwing = setup({ player: fakePlayer({ getWatchId() { throw new Error("x"); } }) });
  assert.equal((await throwing.core.applySnapshot(snap())).state, STATUS.NO_VIDEO);
  const noTime = setup({ player: fakePlayer({ getCurrentTime() { return NaN; } }) });
  assert.equal((await noTime.core.applySnapshot(snap())).state, STATUS.NO_VIDEO);
  assert.equal(noTime.player.calls.length, 0);
});

test("revision/version antigos ou duplicados nao reaplicam", async () => {
  const { core, player } = setup();
  assert.equal((await core.applySnapshot(snap())).state, STATUS.APPLIED);
  player.calls.length = 0;
  assert.equal((await core.applySnapshot(snap())).state, STATUS.STALE);
  assert.equal((await core.applySnapshot(snap({ revision: 4 }, { version: 4 }))).state, STATUS.STALE);
  assert.equal((await core.applySnapshot(snap({ revision: 6 }, { version: 2 }))).state, STATUS.STALE);
  assert.equal(player.calls.length, 0);
  assert.equal((await core.applySnapshot(snap({ revision: 6 }, { version: 4, state: "paused" }))).state, STATUS.APPLIED);
  assert.equal(core.getStatus().lastVersion, 4);
});

test("troca de titulo exige reset; versao antiga nao vaza para o novo titulo", async () => {
  const { core, player } = setup();
  await core.applySnapshot(snap({ revision: 50 }, { version: 40 }));
  player.calls.length = 0;
  player.watchId = "222";
  const next = snap({ selectedMatch: "T2", revision: 51, media: { provider: "netflix", titleId: "T2", watchId: "222" } },
    { titleId: "T2", watchId: "222", version: 1 });
  const blocked = await core.applySnapshot(next);
  assert.equal(blocked.state, STATUS.CONTEXT_CHANGED);
  assert.equal(player.calls.length, 0);
  assert.equal(core.getStatus().active, false);
  core.reset();
  assert.equal(core.getStatus().lastVersion, 0);
  assert.equal((await core.applySnapshot(next)).state, STATUS.APPLIED);
  assert.equal(core.getStatus().bound.titleId, "T2");
});

test("falha de autoplay, play, pause e seek sao reportadas sem lancar", async () => {
  const notAllowed = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
  let t = setup();
  t.player.failPlay = notAllowed;
  let r = await t.core.applySnapshot(snap());
  assert.equal(r.state, STATUS.AUTOPLAY_BLOCKED);
  assert.equal(r.ok, false);
  assert.deepEqual(r.error, { code: "autoplay-blocked" });
  // nao marca como conhecido: usuario clicando em play ainda envia
  assert.equal((await t.core.localEvent("play", 10)).state, STATUS.SENT);

  t = setup();
  t.player.failPlay = new Error("outro");
  assert.equal((await t.core.applySnapshot(snap())).state, STATUS.PLAY_FAILED);

  t = setup();
  t.player.failPause = new Error("p");
  assert.equal((await t.core.applySnapshot(snap({}, { state: "paused" }))).state, STATUS.PAUSE_FAILED);

  t = setup();
  t.player.time = 90;
  t.player.failSeek = new Error("s");
  r = await t.core.applySnapshot(snap());
  assert.equal(r.state, STATUS.SEEK_FAILED);
  assert.deepEqual(t.player.calls, [["seek", 10]]); // sem play depois de seek falho
  // sem retry automatico: reenviar o mesmo snapshot continua stale (retryLast e o caminho explicito)
  assert.equal((await t.core.applySnapshot(snap())).state, STATUS.STALE);
  assert.equal(t.player.calls.length, 1);
});

test("player sincrono que lanca tambem e tratado", async () => {
  const p = fakePlayer({ play() { throw new Error("sync"); } });
  const { core } = setup({ player: p });
  assert.equal((await core.applySnapshot(snap())).state, STATUS.PLAY_FAILED);
});

test("localEvent envia payload exato sem credenciais e atualiza estado", async () => {
  const { core, sent, clock } = setup();
  await core.applySnapshot(snap({}, { state: "paused", positionSec: 10 }));
  clock.t = 10000; // fora da janela de eco
  const r = await core.localEvent("play", 10);
  assert.equal(r.state, STATUS.SENT);
  assert.deepEqual(sent, [{ titleId: "T1", watchId: "80100172", action: "play", positionSec: 10 }]);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["action", "positionSec", "titleId", "watchId"]);
  const s = await core.localEvent("seek", 500);
  assert.equal(s.state, STATUS.SENT);
  assert.equal(sent[1].action, "seek");
});

test("localEvent sem contexto, sem video, video errado ou invalido nao envia", async () => {
  const { core, player, sent } = setup();
  assert.equal((await core.localEvent("play", 5)).state, STATUS.NO_CONTEXT);
  await core.applySnapshot(snap());
  for (const [a, p] of [["stop", 5], ["play", -1], ["play", NaN], ["play", 86401], ["play", "5"], ["seek", undefined], [undefined, 5]]) {
    assert.equal((await core.localEvent(a, p)).state, STATUS.INVALID_EVENT);
  }
  player.watchId = "999";
  assert.equal((await core.localEvent("pause", 5)).state, STATUS.WRONG_WATCH);
  player.watchId = null;
  assert.equal((await core.localEvent("pause", 5)).state, STATUS.NO_VIDEO);
  assert.equal(sent.length, 0);
  core.reset();
  player.watchId = "80100172";
  assert.equal((await core.localEvent("pause", 5)).state, STATUS.NO_CONTEXT);
  // sala encerrada desativa envio
  const t = setup();
  await t.core.applySnapshot(snap());
  await t.core.applySnapshot(snap({ status: "closed", revision: 6 }));
  assert.equal((await t.core.localEvent("pause", 5)).state, STATUS.NO_CONTEXT);
});

test("eco do ultimo comando remoto e ignorado so dentro da janela", async () => {
  const { core, player, sent, clock } = setup({ echoWindowMs: 1000 });
  player.time = 60;
  await core.applySnapshot(snap({}, { state: "paused", positionSec: 20 })); // seek 20 + pause
  clock.t = 300;
  assert.equal((await core.localEvent("seek", 20.2)).state, STATUS.ECHO);
  assert.equal((await core.localEvent("pause", 20)).state, STATUS.ECHO);
  // play nao foi comandado: evento real do usuario passa
  assert.equal((await core.localEvent("play", 20)).state, STATUS.SENT);
  assert.equal(sent.length, 1);
  // fora da janela, um pause real do usuario (estado conhecido agora playing) e enviado
  clock.t = 5000;
  assert.equal((await core.localEvent("pause", 25)).state, STATUS.SENT);
});

test("eventos redundantes sao ignorados; mudanca real passa", async () => {
  const { core, sent, clock } = setup({ echoWindowMs: 0 });
  await core.applySnapshot(snap({}, { state: "playing", positionSec: 10 }));
  clock.t = 1000; // 1s depois, esperado ~11
  assert.equal((await core.localEvent("play", 11)).state, STATUS.REDUNDANT);
  assert.equal((await core.localEvent("seek", 11.5)).state, STATUS.REDUNDANT);
  assert.equal(sent.length, 0);
  assert.equal((await core.localEvent("seek", 300)).state, STATUS.SENT);
  assert.equal((await core.localEvent("pause", 300)).state, STATUS.SENT);
  assert.equal((await core.localEvent("pause", 300)).state, STATUS.REDUNDANT);
  assert.equal(sent.length, 2);
});

test("callback sendAction falho (sincrono ou promessa) e reportado e permite reenvio", async () => {
  let fail = "sync";
  const sent = [];
  const sendAction = (m) => {
    if (fail === "sync") throw new Error("rede caiu");
    if (fail === "async") return Promise.reject(new Error("timeout"));
    sent.push(m);
  };
  const { core } = setup({ sendAction, echoWindowMs: 0 });
  await core.applySnapshot(snap({}, { state: "paused", positionSec: 10 }));
  let r = await core.localEvent("play", 10);
  assert.equal(r.state, STATUS.SEND_FAILED);
  assert.equal(r.ok, false);
  assert.deepEqual(r.error, { code: "send-error" });
  fail = "async";
  r = await core.localEvent("play", 10);
  assert.equal(r.state, STATUS.SEND_FAILED);
  assert.deepEqual(r.error, { code: "send-error" });
  fail = null;
  assert.equal((await core.localEvent("play", 10)).state, STATUS.SENT); // nao virou "redundante"
  assert.equal(sent.length, 1);
  assert.equal(core.getStatus().state, STATUS.SENT);
});

test("snapshots concorrentes sao serializados", async () => {
  const order = [];
  const player = fakePlayer({
    async play() { order.push("play-start"); await new Promise((r) => setTimeout(r, 20)); order.push("play-end"); },
    async pause() { order.push("pause"); },
  });
  const { core } = setup({ player });
  const a = core.applySnapshot(snap({ revision: 5 }, { version: 3 }));
  const b = core.applySnapshot(snap({ revision: 6 }, { version: 4, state: "paused" }));
  await Promise.all([a, b]);
  assert.deepEqual(order, ["play-start", "play-end", "pause"]);
});

test("construcao invalida lanca; modulo nao referencia DOM/rede/storage", () => {
  assert.throws(() => createNetflixRoomSyncCore({}), TypeError);
  assert.throws(() => createNetflixRoomSyncCore({ roomCode: "A", role: "a", player: {}, sendAction() {} }), TypeError);
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "netflix-room-sync-core.js"), "utf8");
  for (const word of ["document", "window", "chrome.", "browser.", "fetch(", "XMLHttpRequest", "WebSocket", "localStorage", "sessionStorage", "location", "token"]) {
    assert.ok(!src.includes(word), `nao deve conter ${word}`);
  }
});
