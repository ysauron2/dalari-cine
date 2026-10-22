"use strict";
// Player falso: estes testes NAO provam sincronizacao na Netflix real.
const test = require("node:test");
const assert = require("node:assert/strict");
const { STATUS, createNetflixRoomSyncCore } = require("../src/netflix-room-sync-core.js");

function fakePlayer(over = {}) {
  return {
    watchId: "80100172", time: 10, calls: [], failPlay: null, failSeek: null, failPause: null,
    getWatchId() { return this.watchId; },
    getCurrentTime() { return this.time; },
    async play() { this.calls.push(["play"]); if (this.failPlay) throw this.failPlay; },
    async pause() { this.calls.push(["pause"]); if (this.failPause) throw this.failPause; },
    async seek(s) { this.calls.push(["seek", s]); if (this.failSeek) throw this.failSeek; this.time = s; },
    ...over,
  };
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

function setup({ player = fakePlayer(), sendAction, echoWindowMs } = {}) {
  const clock = { t: 0 };
  const core = createNetflixRoomSyncCore({
    roomCode: "ABCD", role: "a", player, now: () => clock.t, echoWindowMs,
    sendAction: sendAction || (() => {}),
  });
  return { core, player, clock };
}

const blockedErr = () => Object.assign(new Error("b"), { name: "NotAllowedError" });
const SECRET = "SEGREDO-123-https://x.test/?k=abc";
const secretErr = (name = "Error") => Object.assign(new Error(SECRET), { name, stack: SECRET });

test("erros de player e sendAction nao vazam mensagem/nome em nenhuma saida", async () => {
  const outs = [];
  const t = setup();
  t.player.failSeek = secretErr(SECRET);
  t.player.time = 90;
  outs.push(await t.core.applySnapshot(snap()), t.core.getStatus());
  outs.push(await t.core.retryLast(), t.core.getStatus());
  t.player.failSeek = null;
  t.player.failPlay = secretErr("NotAllowedError");
  outs.push(await t.core.retryLast(), t.core.getStatus());
  outs.push(await t.core.resumePending(), t.core.getStatus());
  const s2 = setup({ sendAction() { throw secretErr(SECRET); }, echoWindowMs: 0 });
  await s2.core.applySnapshot(snap({}, { state: "paused" }));
  outs.push(await s2.core.localEvent("play", 10), s2.core.getStatus());
  const s3 = setup({ sendAction: () => Promise.reject(secretErr()), echoWindowMs: 0 });
  await s3.core.applySnapshot(snap({}, { state: "paused" }));
  outs.push(await s3.core.localEvent("play", 10));
  const s4 = setup({ player: fakePlayer({ play() { throw secretErr(); } }) });
  outs.push(await s4.core.applySnapshot(snap()), s4.core.getStatus());
  assert.ok(outs.length >= 12);
  for (const o of outs) assert.ok(!JSON.stringify(o).includes("SEGREDO"), JSON.stringify(o));
  assert.deepEqual(outs[outs.length - 2].error, { code: "player-error" });
  assert.deepEqual(outs[6].error, { code: "autoplay-blocked" });
  assert.deepEqual(outs[8].error, { code: "send-error" });
});

test("resumePending: play bloqueado, nova falha, sucesso no gesto, uma tentativa por chamada", async () => {
  const { core, player, clock } = setup();
  assert.equal((await core.resumePending()).state, STATUS.NOTHING_PENDING);
  player.failPlay = blockedErr();
  assert.equal((await core.applySnapshot(snap())).state, STATUS.AUTOPLAY_BLOCKED);
  assert.deepEqual(core.getStatus().pending, { reason: STATUS.AUTOPLAY_BLOCKED, revision: 5, version: 3 });
  assert.equal(core.getStatus().lastRevision, 5);
  await new Promise((r) => setTimeout(r, 10)); // sem retry automatico
  assert.equal(player.calls.length, 1);
  clock.t = 1000;
  assert.equal((await core.resumePending()).state, STATUS.AUTOPLAY_BLOCKED); // nova falha
  assert.equal(player.calls.length, 2);
  assert.ok(core.getStatus().pending);
  player.failPlay = null;
  clock.t = 10000; // 10 s locais => alvo 20, atual 10 => seek
  const r = await core.resumePending();
  assert.equal(r.state, STATUS.APPLIED);
  assert.equal(r.targetSec, 20);
  assert.deepEqual(player.calls.slice(2), [["seek", 20], ["play"]]);
  assert.equal(core.getStatus().pending, null);
  assert.equal((await core.resumePending()).state, STATUS.NOTHING_PENDING);
  assert.equal(player.calls.length, 4);
  const t = setup(); // retryLast nao serve para autoplay
  t.player.failPlay = blockedErr();
  await t.core.applySnapshot(snap());
  assert.equal((await t.core.retryLast()).state, STATUS.NOTHING_PENDING);
});

test("resumePending: video errado bloqueia; sala encerrada, snapshot novo, contexto e reset limpam", async () => {
  const mk = async () => {
    const t = setup();
    t.player.failPlay = blockedErr();
    await t.core.applySnapshot(snap());
    t.player.failPlay = null;
    t.player.calls.length = 0;
    return t;
  };
  let t = await mk();
  t.player.watchId = "999";
  assert.equal((await t.core.resumePending()).state, STATUS.WRONG_WATCH);
  assert.equal(t.player.calls.length, 0);
  assert.ok(t.core.getStatus().pending);
  t.player.watchId = null;
  assert.equal((await t.core.resumePending()).state, STATUS.NO_VIDEO);
  t.player.watchId = "80100172";
  assert.equal((await t.core.resumePending()).state, STATUS.APPLIED);

  t = await mk();
  assert.equal((await t.core.applySnapshot(snap({ status: "closed", revision: 6 }))).state, STATUS.NOT_ACTIVE);
  assert.equal(t.core.getStatus().pending, null);
  assert.equal((await t.core.resumePending()).state, STATUS.NOTHING_PENDING);
  assert.equal(t.player.calls.length, 0);

  t = await mk();
  assert.equal((await t.core.applySnapshot(snap({ revision: 6 }, { version: 4, state: "paused" }))).state, STATUS.APPLIED);
  assert.equal(t.core.getStatus().pending, null);

  t = await mk();
  const other = snap({ selectedMatch: "T2", revision: 9, media: { provider: "netflix", titleId: "T2", watchId: "222" } },
    { titleId: "T2", watchId: "222", version: 9 });
  assert.equal((await t.core.applySnapshot(other)).state, STATUS.CONTEXT_CHANGED);
  assert.equal(t.core.getStatus().pending, null);
  assert.equal((await t.core.resumePending()).state, STATUS.NOTHING_PENDING);

  t = await mk();
  t.core.reset();
  assert.equal(t.core.getStatus().pending, null);
  assert.equal((await t.core.resumePending()).state, STATUS.NOTHING_PENDING);
  assert.equal(t.player.calls.length, 0);
});

test("snapshot inativo antigo/igual e stale e nao derruba sessao ativa mais nova", async () => {
  const { core } = setup();
  await core.applySnapshot(snap({ revision: 10 }, { version: 5 }));
  for (const rev of [10, 9, 0]) {
    assert.equal((await core.applySnapshot(snap({ status: "closed", revision: rev }))).state, STATUS.STALE);
    assert.equal(core.getStatus().active, true);
  }
  assert.equal((await core.localEvent("seek", 300)).state, STATUS.SENT);
  assert.equal((await core.applySnapshot(snap({ status: "closed", revision: 11 }))).state, STATUS.NOT_ACTIVE);
  assert.equal(core.getStatus().active, false);
  assert.equal(core.getStatus().lastRevision, 11);
  assert.equal((await core.applySnapshot(snap({ revision: 11 }, { version: 99 }))).state, STATUS.STALE);
  assert.equal((await core.applySnapshot(snap({ revision: 12 }, { version: 99 }))).state, STATUS.APPLIED);
  assert.equal(core.getStatus().active, true);
});

test("revision/version precisam ser inteiros seguros", async () => {
  for (const s of [snap({ revision: Number.MAX_SAFE_INTEGER + 1 }), snap({}, { version: 2 ** 53 }), snap({ revision: 1e300 })]) {
    const { core, player } = setup();
    assert.equal((await core.applySnapshot(s)).state, STATUS.INVALID);
    assert.equal(player.calls.length, 0);
  }
  const { core } = setup();
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal((await core.applySnapshot(snap({ revision: max }, { version: max }))).state, STATUS.APPLIED);
});

test("retryLast: recupera seek falho, sem retry automatico e sem repetir o que ja deu certo", async () => {
  const { core, player } = setup();
  player.time = 90;
  player.failSeek = new Error("s");
  assert.equal((await core.applySnapshot(snap())).state, STATUS.SEEK_FAILED);
  assert.deepEqual(core.getStatus().pending, { reason: STATUS.SEEK_FAILED, revision: 5, version: 3 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(player.calls.length, 1);
  assert.equal((await core.retryLast()).state, STATUS.SEEK_FAILED); // resultado visivel, uma tentativa
  assert.equal(player.calls.length, 2);
  player.failSeek = null;
  assert.equal((await core.retryLast()).state, STATUS.APPLIED);
  assert.deepEqual(player.calls.slice(2), [["seek", 10], ["play"]]);
  assert.equal(core.getStatus().pending, null);
  assert.equal((await core.retryLast()).state, STATUS.NOTHING_PENDING);
  assert.equal(player.calls.length, 4);
  assert.equal(core.getStatus().lastRevision, 5);
});

test("retryLast: play falho apos seek ok nao refaz o seek; pause e getCurrentTime falhos se recuperam", async () => {
  let t = setup();
  t.player.time = 90;
  t.player.failPlay = new Error("p");
  assert.equal((await t.core.applySnapshot(snap())).state, STATUS.PLAY_FAILED);
  t.player.failPlay = null;
  t.player.calls.length = 0;
  assert.equal((await t.core.retryLast()).state, STATUS.APPLIED);
  assert.deepEqual(t.player.calls, [["play"]]);

  t = setup();
  t.player.failPause = new Error("p");
  assert.equal((await t.core.applySnapshot(snap({}, { state: "paused" }))).state, STATUS.PAUSE_FAILED);
  t.player.failPause = null;
  assert.equal((await t.core.retryLast()).state, STATUS.APPLIED);

  let broken = true;
  t = setup({ player: fakePlayer({ getCurrentTime() { if (broken) throw new Error("x"); return 10; } }) });
  assert.equal((await t.core.applySnapshot(snap())).state, STATUS.NO_VIDEO);
  assert.equal(t.core.getStatus().pending.reason, STATUS.NO_VIDEO);
  assert.equal(t.player.calls.length, 0);
  broken = false;
  assert.equal((await t.core.retryLast()).state, STATUS.APPLIED);

  t = setup();
  t.player.failPause = new Error("p");
  await t.core.applySnapshot(snap({}, { state: "paused" }));
  t.player.watchId = "999";
  t.player.calls.length = 0;
  assert.equal((await t.core.retryLast()).state, STATUS.WRONG_WATCH);
  assert.equal(t.player.calls.length, 0);
  t.player.watchId = "80100172";
  t.player.failPause = null;
  await t.core.applySnapshot(snap({ revision: 6 }, { version: 4, state: "paused" }));
  assert.equal(t.core.getStatus().pending, null);
  assert.equal((await t.core.retryLast()).state, STATUS.NOTHING_PENDING);
});
