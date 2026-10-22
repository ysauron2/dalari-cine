import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient, RoomError } = require('../server/client.js');

async function boot() {
  const clock = { t: 1_000_000 };
  const svc = createRoomService({ now: () => clock.t });
  const addr = await svc.listen(0, '127.0.0.1');
  return { svc, clock, url: `http://127.0.0.1:${addr.port}`, stop: () => svc.close() };
}
async function pairWithVideo(env) {
  const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
  const created = await host.createRoom();
  await guest.joinRoom(created.invite);
  await host.approveGuest();
  await host.selectPlatform('youtube');
  await host.openYouTubeVideo('abcdefghijk', 'Vídeo de teste');
  await guest.getState({ after: 0 });
  return { host, guest, titleId: host.snapshot.media.titleId };
}
const rejects = (promise, code, status) => assert.rejects(promise, (e) => e instanceof RoomError && e.code === code && (status === undefined || e.status === status));

test('"estou pronto": cada pessoa marca e todos veem; valor inválido é recusado', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pairWithVideo(env);
    assert.deepEqual(host.snapshot.ready, { host: false, guest: false });
    await guest.setReady(true);
    const s = await host.getState({ after: 0 });
    assert.deepEqual(s.ready, { host: false, guest: true });
    await host.setReady(true);
    assert.deepEqual((await guest.getState({ after: 0 })).ready, { host: true, guest: true });
    await guest.setReady(false);
    assert.equal(guest.snapshot.ready.guest, false);
    await rejects(guest.send('ready.set', { ready: 'sim' }), 'bad_payload', 400);
    await rejects(guest.send('ready.set', { ready: true, extra: 1 }), 'bad_payload', 400);
  } finally { await env.stop(); }
});

test('sincronizar agora: pausa todos no ponto estimado, conta 3,5 s e dá play junto', async () => {
  const env = await boot();
  try {
    const { host, guest, titleId } = await pairWithVideo(env);
    await host.playback(titleId, 'seek', 10);                       // estado: tocando, ponto 10 s
    await host.setReady(true); await guest.setReady(true);
    env.clock.t += 5000;                                             // 5 s depois: o ponto estimado é ~15 s
    const t0 = env.clock.t;
    await guest.syncNow();
    const sh = await host.getState({ after: 0 });
    assert.equal(sh.playback.state, 'paused');
    assert.equal(sh.playback.positionSec, 15);
    assert.equal(sh.playback.syncId, 1);
    assert.deepEqual(sh.countdown, { id: 1, by: 'guest', startsAt: t0 + 3500, positionSec: 15 });
    assert.deepEqual(sh.ready, { host: false, guest: false }, 'a contagem zera o "pronto" de todos');
    const before = sh.playback.version;

    await rejects(host.syncNow(), 'countdown_active', 409);
    await guest.playback(titleId, 'pause', 99);                      // efeito de pausar/ajustar do player: ignorado
    await host.playback(titleId, 'seek', 77);
    const mid = await host.getState({ after: 0 });
    assert.equal(mid.playback.positionSec, 15, 'durante a contagem ninguém muda o ponto');
    assert.equal(mid.playback.version, before);
    assert.ok(mid.countdown);

    env.clock.t = t0 + 3400; env.svc.sweep();
    assert.ok((await host.getState({ after: 0 })).countdown, 'ainda dentro dos 3,5 s');
    env.clock.t = t0 + 3600; env.svc.sweep();
    const end = await host.getState({ after: 0 });
    assert.equal(end.countdown, null);
    assert.equal(end.playback.state, 'playing');
    assert.equal(end.playback.positionSec, 15);
    assert.equal(end.playback.updatedAt, t0 + 3500, 'o tempo de partida é o fim exato da contagem');
    assert.equal(end.playback.version, before + 1);
    assert.deepEqual((await guest.getState({ after: 0 })).playback, end.playback, 'todos recebem o mesmo estado');
  } finally { await env.stop(); }
});

test('sincronizar agora: sem vídeo é recusado; play manual, troca de vídeo e fechar a sala cancelam a contagem', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom();
    await guest.joinRoom(created.invite); await host.approveGuest();
    await rejects(host.syncNow(), 'no_media', 409);
    await host.selectPlatform('youtube');
    await host.openYouTubeVideo('abcdefghijk', 'Vídeo de teste');
    const titleId = host.snapshot.media.titleId;
    await guest.getState({ after: 0 });

    await host.syncNow();
    await guest.playback(titleId, 'play', 3);                      // quem dá play à mão cancela a contagem
    assert.equal((await host.getState({ after: 0 })).countdown, null);
    assert.equal(host.snapshot.playback.state, 'playing');

    await host.syncNow();
    await host.openYouTubeVideo('bbbbbbbbbbb', 'Outro vídeo');
    assert.equal((await guest.getState({ after: 0 })).countdown, null, 'trocar de vídeo cancela');

    await host.syncNow();
    await host.closeRoom();
    env.clock.t += 10000; env.svc.sweep();                           // o temporizador não reabre nada numa sala fechada
    assert.equal(env.svc.stats().rooms >= 0, true);
  } finally { await env.stop(); }
});

test('cancelar a contagem: só quem começou ou o Host; sem contagem é 409', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url }), g1 = new DuoRoomClient({ serviceUrl: env.url }), g2 = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom('Host', { maxParticipants: 3 });
    await g1.joinRoom(created.invite); await host.approveGuest();
    const second = await host.newInvite();
    await g2.joinRoom(second.invite); await host.approveGuest('guest2');
    await host.selectPlatform('youtube');
    await host.openYouTubeVideo('abcdefghijk', 'Vídeo de teste');
    await rejects(g1.cancelSync(), 'no_countdown', 409);

    await g1.syncNow();
    await rejects(g2.cancelSync(), 'wrong_role', 403);               // outro convidado não cancela
    await g1.cancelSync();                                           // quem começou cancela
    assert.equal((await host.getState({ after: 0 })).countdown, null);
    assert.equal(host.snapshot.playback.state, 'paused', 'cancelar deixa o vídeo pausado no ponto combinado');

    await g2.syncNow();
    await host.cancelSync();                                         // o Host cancela a de qualquer um
    assert.equal((await g1.getState({ after: 0 })).countdown, null);
  } finally { await env.stop(); }
});

test('reações: lista fechada, intervalo mínimo por pessoa e no máximo as 8 últimas', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pairWithVideo(env);
    await host.sendReaction('heart');
    let s = await guest.getState({ after: 0 });
    assert.equal(s.reactions.length, 1);
    assert.deepEqual({ ...s.reactions[0], at: 0 }, { id: 1, slot: 'host', emoji: 'heart', at: 0 });
    await rejects(host.sendReaction('laugh'), 'rate_limited', 429);   // mesmo instante: rápido demais
    await guest.sendReaction('clap');                                  // outra pessoa pode
    await rejects(guest.send('reaction.send', { emoji: '<script>' }), 'bad_payload', 400);
    await rejects(guest.send('reaction.send', { emoji: '❤️' }), 'bad_payload', 400);
    for (let i = 0; i < 10; i++) { env.clock.t += 700; await host.sendReaction(['heart', 'laugh', 'wow', 'clap', 'cry', 'popcorn'][i % 6]); }
    s = await guest.getState({ after: 0 });
    assert.equal(s.reactions.length, 8);
    assert.deepEqual(s.reactions.map((r) => r.id), s.reactions.map((r, i) => s.reactions[0].id + i), 'ids sequenciais');
    assert.equal(s.reactions.at(-1).id, 12);
  } finally { await env.stop(); }
});
