import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient, RoomError } = require('../server/client.js');

async function boot() {
  const clock = { t: 1_000_000 };
  const svc = createRoomService({ now: () => clock.t });
  const addr = await svc.listen(0, '127.0.0.1');
  return { clock, url: `http://127.0.0.1:${addr.port}`, stop: () => svc.close() };
}
async function pairWithVideo(env) {
  const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
  const created = await host.createRoom();
  await guest.joinRoom(created.invite); await host.approveGuest();
  await host.selectPlatform('youtube'); await host.openYouTubeVideo('abcdefghijk', 'Vídeo de teste');
  await guest.getState({ after: 0 });
  return { host, guest, titleId: host.snapshot.media.titleId };
}
const rejects = (p, code, status) => assert.rejects(p, (e) => e instanceof RoomError && e.code === code && (status === undefined || e.status === status));

test('intervalo: pausa todos no ponto estimado e mostra quem pediu e quando acaba', async () => {
  const env = await boot();
  try {
    const { host, guest, titleId } = await pairWithVideo(env);
    assert.equal(host.snapshot.break, null);
    await host.playback(titleId, 'seek', 10);
    env.clock.t += 5000;                                           // 5 s depois: o ponto estimado é ~15 s
    const t0 = env.clock.t;
    await guest.startBreak(5);
    const s = await host.getState({ after: 0 });
    assert.deepEqual(s.break, { id: 1, by: 'guest', startsAt: t0, endsAt: t0 + 5 * 60000, positionSec: 15 });
    assert.equal(s.playback.state, 'paused');
    assert.equal(s.playback.positionSec, 15);
    assert.equal(s.playback.syncId, 1, 'os players fazem o ajuste exato para o mesmo ponto');
    assert.deepEqual(s.ready, { host: false, guest: false });
    assert.equal(s.countdown, null, 'ainda não há contagem: é uma pausa');
  } finally { await env.stop(); }
});

test('intervalo: durante a pausa, pausar/ajustar ponto é ignorado, e dar play à mão encerra o intervalo', async () => {
  const env = await boot();
  try {
    const { host, guest, titleId } = await pairWithVideo(env);
    await host.playback(titleId, 'seek', 30);
    await host.startBreak(10);
    const v = host.snapshot.playback.version;
    await guest.playback(titleId, 'seek', 999);                    // um player ajustando sozinho
    await guest.playback(titleId, 'pause', 999);
    const s = await host.getState({ after: 0 });
    assert.equal(s.playback.positionSec, 30); assert.equal(s.playback.version, v); assert.ok(s.break);
    await guest.playback(titleId, 'play', 30);
    const after = await host.getState({ after: 0 });
    assert.equal(after.break, null, 'play manual volta do intervalo');
    assert.equal(after.playback.state, 'playing');
  } finally { await env.stop(); }
});

test('intervalo: "voltar agora" abre a contagem 3-2-1 a partir do mesmo ponto e todos dão play juntos', async () => {
  const env = await boot();
  try {
    const { host, guest, titleId } = await pairWithVideo(env);
    await host.playback(titleId, 'seek', 42);
    await host.startBreak(5);
    env.clock.t += 60_000;
    const t = env.clock.t;
    await guest.endBreak();
    const s = await host.getState({ after: 0 });
    assert.equal(s.break, null);
    assert.deepEqual(s.countdown, { id: 2, by: 'guest', startsAt: t + 3500, positionSec: 42 });
    assert.equal(s.playback.state, 'paused'); assert.equal(s.playback.positionSec, 42); assert.equal(s.playback.syncId, 2);
    env.clock.t += 4000;
    const end = await guest.getState({ after: 0 });
    assert.equal(end.countdown, null);
    assert.equal(end.playback.state, 'playing', 'depois da contagem o vídeo toca');
    assert.equal(end.playback.positionSec, 42);
    await rejects(host.endBreak(), 'no_break', 409);
  } finally { await env.stop(); }
});

test('intervalo: ao acabar o tempo a sala volta sozinha, sem ninguém clicar', async () => {
  const env = await boot();
  try {
    const { host, guest, titleId } = await pairWithVideo(env);
    await host.playback(titleId, 'seek', 7);
    await host.startBreak(1);
    env.clock.t += 59_000;
    assert.ok((await guest.getState({ after: 0 })).break, 'ainda no intervalo');
    env.clock.t += 2_000;
    const s = await guest.getState({ after: 0 });
    assert.equal(s.break, null);
    assert.ok(s.countdown && s.countdown.positionSec === 7 && s.countdown.by === 'host');
  } finally { await env.stop(); }
});

test('intervalo: pedir de novo estende (com teto de 30 min); limites e conflitos são recusados', async () => {
  const env = await boot();
  try {
    const { host, guest, titleId } = await pairWithVideo(env);
    await host.playback(titleId, 'seek', 1);
    await host.startBreak(5);
    const first = host.snapshot.break.endsAt;
    await guest.startBreak(5);
    assert.equal((await host.getState({ after: 0 })).break.endsAt, first + 5 * 60000, 'estendeu 5 min');
    assert.equal(host.snapshot.break.id, 1, 'é o mesmo intervalo');
    for (let i = 0; i < 8; i++) await guest.startBreak(30);
    assert.equal((await host.getState({ after: 0 })).break.endsAt - env.clock.t, 30 * 60000, 'nunca passa de 30 min a partir de agora');
    for (const bad of [0, 31, 1.5, '5', null, -1]) await rejects(host.send('break.start', { minutes: bad }), 'bad_payload', 400);
    await rejects(host.send('break.start', { minutes: 5, extra: 1 }), 'bad_payload', 400);
    await rejects(host.send('break.end', { x: 1 }), 'bad_payload', 400);
    await host.syncNow();                                          // sincronizar durante o intervalo encerra o intervalo e conta 3-2-1
    const s = await host.getState({ after: 0 });
    assert.equal(s.break, null); assert.ok(s.countdown);
    await rejects(host.startBreak(5), 'countdown_active', 409);
  } finally { await env.stop(); }
});

test('intervalo: trocar de vídeo encerra o intervalo; sem vídeo não dá para pedir', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom(); await guest.joinRoom(created.invite); await host.approveGuest();
    await rejects(host.startBreak(5), 'no_media', 409);
    await host.selectPlatform('youtube'); await host.openYouTubeVideo('abcdefghijk', 'Um');
    await host.startBreak(5);
    assert.ok(host.snapshot.break);
    await host.openYouTubeVideo('bcdefghijkl', 'Outro');
    assert.equal(host.snapshot.break, null);
  } finally { await env.stop(); }
});

test('a tela tem a faixa do intervalo, o botão e os comandos (+5 min, voltar agora)', () => {
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /id="break-banner" role="status" aria-live="polite"/);
  assert.match(ui, /'break-start'/); assert.match(ui, /'break-more'/); assert.match(ui, /'break-end'/);
  assert.match(ui, /client\.startBreak\(5\)/); assert.match(ui, /client\.endBreak\(\)/);
  assert.match(ui, /volta em /);
});
