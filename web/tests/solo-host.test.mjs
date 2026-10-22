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
const rejects = (p, code, status) => assert.rejects(p, (e) => e instanceof RoomError && e.code === code && (status === undefined || e.status === status));

test('Host sozinho: a sala já nasce ativa, com ele como único participante', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    await host.createRoom('Daniel');
    const s = await host.getState({ after: 0 });
    assert.equal(s.status, 'active');
    assert.deepEqual(s.participants.map((p) => p.id), ['host']);
    assert.deepEqual(s.pendingGuests, []);
  } finally { await env.stop(); }
});

test('Host sozinho usa tudo: plataforma, vídeo, play, fila, intervalo, chat, reações e atraso', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    await host.createRoom('Daniel');
    await host.selectPlatform('youtube');
    await host.openYouTubeVideo('abcdefghijk', 'Meu vídeo');
    const titleId = host.snapshot.media.titleId;
    await host.playback(titleId, 'seek', 20);
    await host.queueAdd('bcdefghijkl', 'Depois');
    await host.sendChat('Testando sozinho');
    await host.sendReaction('heart');
    await host.reportLag(0);
    await host.setReady(true);
    await host.startBreak(5);
    assert.ok(host.snapshot.break); assert.equal(host.snapshot.playback.state, 'paused');
    await host.endBreak();
    assert.ok(host.snapshot.countdown, 'volta com a contagem 3-2-1, mesmo sozinho');
    env.clock.t += 4000;
    const s = await host.getState({ after: 0 });
    assert.equal(s.playback.state, 'playing');
    await host.queueNext('bcdefghijkl');
    assert.equal(host.snapshot.media.videoId, 'bcdefghijkl');
    assert.equal(host.snapshot.chat.length, 1);
    await host.syncNow();
    assert.ok(host.snapshot.countdown);
  } finally { await env.stop(); }
});

test('Host sozinho escolhe um título: a rodada vale com uma pessoa só e um voto "sim" fecha o match', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    await host.createRoom('Daniel');
    await host.selectPlatform('youtube');
    await host.startRound('surprise');
    const r = host.snapshot.round;
    assert.ok(r && r.picks.length >= 1);
    assert.deepEqual(r.participants, ['host']);
    await host.vote(r.picks[0], 'yes');
    assert.equal(host.snapshot.selectedMatch, r.picks[0], 'uma pessoa só: o voto dela decide');
  } finally { await env.stop(); }
});

test('quem entra depois é aprovado pelo Host e se junta: o pedido não trava a sala e a rodada recomeça com os dois', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom('Daniel');
    await host.selectPlatform('youtube'); await host.openYouTubeVideo('abcdefghijk', 'Meu vídeo');
    await guest.joinRoom(created.invite, 'Larissa');
    const pending = await guest.getState({ after: 0 });
    assert.equal(pending.status, 'pending_approval', 'o convidado só vê a sala depois de aprovado');
    assert.equal(pending.media, undefined);
    await rejects(guest.sendChat('oi'), 'not_active', 409);
    const hs = await host.getState({ after: 0 });
    assert.equal(hs.status, 'active'); assert.equal(hs.pendingGuests.length, 1);
    await host.sendChat('Eu continuo usando a sala');                   // o pedido pendente não bloqueia o Host
    await host.approveGuest();
    const gs = await guest.getState({ after: 0 });
    assert.equal(gs.status, 'active');
    assert.equal(gs.media.videoId, 'abcdefghijk', 'ele entra e já vê o vídeo que estava aberto');
    assert.deepEqual(gs.participants.map((p) => p.id), ['host', 'guest']);
    assert.equal(gs.chat.at(-1).text, 'Eu continuo usando a sala');
  } finally { await env.stop(); }
});

test('a tela mostra ao Host sozinho que a sala está aberta e oferece Convidar, sem esconder nada', () => {
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /const solo = state === 'active' && role === 'host' && \(s\.participants \|\| \[\]\)\.length < 2 && !pendings\.length;/);
  assert.ok(ui.includes("'Sala aberta, só você por enquanto'"));
  assert.ok(ui.includes("'Sala sua, ainda sem convidado'"));
  const svc = readFileSync(new URL('../server/room-service.js', import.meta.url), 'utf8');
  assert.doesNotMatch(svc, /return 'waiting_guest'/);
});
