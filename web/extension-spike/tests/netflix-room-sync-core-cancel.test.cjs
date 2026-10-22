"use strict";
// Player falso: estes testes NAO provam sincronizacao na Netflix real.
const test = require("node:test");
const assert = require("node:assert/strict");
const { STATUS, createNetflixRoomSyncCore } = require("../src/netflix-room-sync-core.js");

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Seek controlado: so conclui quando o teste resolve a Promise.
function gatedPlayer() {
  const gate = deferred();
  const player = {
    calls: [], time: 90,
    getWatchId() { return "80100172"; },
    getCurrentTime() { return this.time; },
    async play() { this.calls.push(["play"]); },
    async pause() { this.calls.push(["pause"]); },
    async seek(s) { this.calls.push(["seek", s]); await gate.promise; this.time = s; },
  };
  return { player, gate };
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

function setup(player, now) {
  return createNetflixRoomSyncCore({ roomCode: "ABCD", role: "a", player, now: now || (() => 0), sendAction: () => {} });
}

const tick = () => new Promise((r) => setImmediate(r));
const actions = (p) => p.calls.filter((c) => c[0] !== "seek");

for (const state of ["playing", "paused"]) {
  test(`reset() durante seek pendente cancela ${state}: sem play/pause, estado limpo`, async () => {
    const { player, gate } = gatedPlayer();
    const core = setup(player);
    const applying = core.applySnapshot(snap({}, { state }));
    await tick();
    assert.deepEqual(player.calls, [["seek", 10]]);
    core.reset();
    const afterReset = core.getStatus();
    gate.resolve();
    const result = await applying;
    assert.equal(result.state, STATUS.CANCELLED);
    assert.equal(result.ok, false);
    assert.deepEqual(actions(player), []);
    const st = core.getStatus();
    assert.equal(st.active, false);
    assert.equal(st.pending, null);
    assert.equal(st.bound, null);
    assert.equal(st.state, STATUS.IDLE);
    assert.deepEqual(st, afterReset);
  });
}

test("seek que falha depois do reset: cancelled, sem pendencia nem status novo", async () => {
  const { player, gate } = gatedPlayer();
  const core = setup(player);
  const applying = core.applySnapshot(snap());
  await tick();
  core.reset();
  gate.reject(new Error("x"));
  assert.equal((await applying).state, STATUS.CANCELLED);
  const st = core.getStatus();
  assert.equal(st.pending, null);
  assert.equal(st.active, false);
  assert.equal(st.state, STATUS.IDLE);
});

test("snapshot inativo durante seek invalida o comando pendente", async () => {
  const { player, gate } = gatedPlayer();
  const core = setup(player);
  const applying = core.applySnapshot(snap());
  await tick();
  const inactive = await core.applySnapshot(snap({ status: "ended", revision: 6 }));
  assert.equal(inactive.state, STATUS.NOT_ACTIVE);
  gate.resolve();
  assert.equal((await applying).state, STATUS.CANCELLED);
  assert.deepEqual(actions(player), []);
  const st = core.getStatus();
  assert.equal(st.active, false);
  assert.equal(st.pending, null);
  assert.equal(st.state, STATUS.NOT_ACTIVE);
});

test("troca de plataforma ou perda do match desativa eventos Netflix", async () => {
  const { player, gate } = gatedPlayer();
  const core = setup(player);
  const applying = core.applySnapshot(snap());
  await tick();
  const changed = await core.applySnapshot(snap({ revision: 6, platform: "youtube", media: null, playback: null, selectedMatch: null }));
  assert.equal(changed.state, STATUS.INVALID);
  gate.resolve();
  assert.equal((await applying).state, STATUS.CANCELLED);
  assert.deepEqual(actions(player), []);
  assert.equal(core.getStatus().active, false);
  assert.equal((await core.localEvent("play", 10)).state, STATUS.NO_CONTEXT);

  const { player: p2 } = gatedPlayer();
  p2.time = 10;
  const c2 = setup(p2);
  assert.equal((await c2.applySnapshot(snap({}, { state: "paused" }))).state, STATUS.APPLIED);
  assert.equal((await c2.applySnapshot(snap({ revision: 6, media: null, playback: null, selectedMatch: null }))).state, STATUS.INVALID);
  assert.equal(c2.getStatus().active, false);
  assert.equal((await c2.localEvent("seek", 20)).state, STATUS.NO_CONTEXT);
});

test("snapshot de outra sala ou papel nao desativa contexto atual", async () => {
  const { player } = gatedPlayer();
  player.time = 10;
  const core = setup(player);
  await core.applySnapshot(snap({}, { state: "paused" }));
  for (const wrong of [snap({ code: "OTHER", revision: 99 }), snap({ you: "b", revision: 99 })]) {
    assert.equal((await core.applySnapshot(wrong)).state, STATUS.INVALID);
    assert.equal(core.getStatus().active, true);
  }
});

test("troca de contexto durante seek invalida o comando pendente", async () => {
  const { player, gate } = gatedPlayer();
  const core = setup(player);
  const applying = core.applySnapshot(snap());
  await tick();
  const other = snap({ revision: 6, selectedMatch: "T2", media: { provider: "netflix", titleId: "T2", watchId: "80100173" } },
    { titleId: "T2", watchId: "80100173", version: 4 });
  assert.equal((await core.applySnapshot(other)).state, STATUS.CONTEXT_CHANGED);
  gate.resolve();
  assert.equal((await applying).state, STATUS.CANCELLED);
  assert.deepEqual(actions(player), []);
  assert.equal(core.getStatus().active, false);
  assert.equal(core.getStatus().pending, null);
});

test("snapshot antigo de outro titulo nao cancela a midia atual", async () => {
  const { player, gate } = gatedPlayer();
  const core = setup(player);
  const applying = core.applySnapshot(snap());
  await tick();
  const oldOther = snap({ revision: 4, selectedMatch: "T2", media: { provider: "netflix", titleId: "T2", watchId: "80100173" } },
    { titleId: "T2", watchId: "80100173", version: 2 });
  assert.equal((await core.applySnapshot(oldOther)).state, STATUS.STALE);
  gate.resolve();
  assert.equal((await applying).state, STATUS.APPLIED);
  assert.deepEqual(actions(player), [["play"]]);
  assert.deepEqual(core.getStatus().bound, { titleId: "T1", watchId: "80100172" });
});

test("envio local que termina apos reset nao restaura estado antigo", async () => {
  const gate = deferred();
  const player = gatedPlayer().player;
  player.time = 10;
  const core = createNetflixRoomSyncCore({
    roomCode: "ABCD", role: "a", player, now: () => 0,
    sendAction: () => gate.promise,
  });
  await core.applySnapshot(snap({}, { state: "paused" }));
  const sending = core.localEvent("play", 50);
  await tick();
  core.reset();
  gate.resolve();
  assert.equal((await sending).state, STATUS.CANCELLED);
  assert.equal(core.getStatus().state, STATUS.IDLE);
  assert.equal(core.getStatus().active, false);
  assert.equal(core.getStatus().bound, null);
});

test("snapshot enfileirado antes do reset nao roda depois dele", async () => {
  const { player, gate } = gatedPlayer();
  const core = setup(player);
  const first = core.applySnapshot(snap());
  const queued = core.applySnapshot(snap({ revision: 6 }, { version: 4, state: "paused" }));
  await tick();
  core.reset();
  gate.resolve();
  assert.equal((await first).state, STATUS.CANCELLED);
  assert.equal((await queued).state, STATUS.CANCELLED);
  assert.deepEqual(actions(player), []);
  assert.equal(core.getStatus().bound, null);
});

test("apos cancelar, a sala funciona de novo com snapshot novo", async () => {
  const { player, gate } = gatedPlayer();
  const core = setup(player);
  const applying = core.applySnapshot(snap());
  await tick();
  core.reset();
  gate.resolve();
  await applying;
  player.time = 10;
  const res = await core.applySnapshot(snap());
  assert.equal(res.state, STATUS.APPLIED);
  assert.deepEqual(actions(player), [["play"]]);
  assert.equal(core.getStatus().active, true);
});

test("now() que lanca nao faz applySnapshot nem localEvent rejeitarem", async () => {
  let throwing = false;
  const { player } = gatedPlayer();
  player.time = 10;
  const core = setup(player, () => { if (throwing) throw new Error("clock"); return 0; });
  assert.equal((await core.applySnapshot(snap({}, { state: "paused" }))).state, STATUS.APPLIED);
  throwing = true;
  for (const action of ["play", "pause", "seek"]) {
    const r = await core.localEvent(action, 50);
    assert.ok(Object.values(STATUS).includes(r.state), r.state);
  }
  const applied = await core.applySnapshot(snap({ revision: 6 }, { version: 4 }));
  assert.ok(Object.values(STATUS).includes(applied.state));
  assert.doesNotThrow(() => core.getStatus());
});

test("now() lancando desde o inicio: tudo resolve", async () => {
  const { player } = gatedPlayer();
  player.time = 10;
  const core = setup(player, () => { throw new Error("clock"); });
  assert.equal((await core.applySnapshot(snap())).state, STATUS.APPLIED);
  const r = await core.localEvent("pause", 10);
  assert.ok(Object.values(STATUS).includes(r.state));
});
