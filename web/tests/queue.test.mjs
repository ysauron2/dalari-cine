import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient, RoomError } = require('../server/client.js');

const V = (n) => 'abcdefghi' + String(n).padStart(2, '0');       // ids de 11 caracteres válidos
async function boot(extra = {}) {
  const clock = { t: 1_000_000 };
  const svc = createRoomService({ now: () => clock.t, ...extra });
  const addr = await svc.listen(0, '127.0.0.1');
  return { clock, url: `http://127.0.0.1:${addr.port}`, stop: () => svc.close() };
}
async function pair(env, { video = true } = {}) {
  const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
  const created = await host.createRoom();
  await guest.joinRoom(created.invite); await host.approveGuest();
  await host.selectPlatform('youtube');
  if (video) await host.openYouTubeVideo(V(0), 'Primeiro');
  await guest.getState({ after: 0 });
  return { host, guest };
}
const rejects = (p, code, status) => assert.rejects(p, (e) => e instanceof RoomError && e.code === code && (status === undefined || e.status === status));

test('fila: qualquer pessoa adiciona, a ordem é a de chegada e todos veem quem adicionou', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    assert.deepEqual(host.snapshot.queue, []);
    await host.queueAdd(V(1), 'Segundo');
    await guest.queueAdd(V(2), 'Terceiro');
    const s = await host.getState({ after: 0 });
    assert.deepEqual(s.queue, [{ id: 1, videoId: V(1), title: 'Segundo', by: 'host' }, { id: 2, videoId: V(2), title: 'Terceiro', by: 'guest' }]);
    assert.equal((await guest.getState({ after: 0 })).queue.length, 2);
    await rejects(guest.queueAdd(V(1), 'Repetido'), 'already_queued', 409);
  } finally { await env.stop(); }
});

test('fila: remover, limite de 10 e dados inválidos', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    for (let i = 1; i <= 10; i++) await host.queueAdd(V(i), 'Vídeo ' + i);
    await rejects(guest.queueAdd(V(11), 'Um a mais'), 'queue_full', 409);
    await guest.queueRemove(3);
    assert.deepEqual((await host.getState({ after: 0 })).queue.map((q) => q.id), [1, 2, 4, 5, 6, 7, 8, 9, 10]);
    await rejects(host.queueRemove(3), 'not_in_queue', 409);
    await guest.queueAdd(V(11), 'Agora cabe');
    for (const bad of [{ videoId: 'curto', title: 'Título ok' }, { videoId: V(12), title: 'x' }, { videoId: V(12), title: ' espaço' }, { videoId: V(12), title: '<b>html</b>' }, { videoId: V(12), title: 'a'.repeat(161) }, { videoId: V(12) }, { videoId: V(12), title: 'ok ok', extra: 1 }, { videoId: 5, title: 'ok ok' }]) {
      await rejects(host.send('queue.add', bad), 'bad_payload', 400);
    }
    for (const bad of [{ id: 0 }, { id: 1.5 }, { id: '1' }, {}, { id: 1, x: 1 }]) await rejects(host.send('queue.remove', bad), 'bad_payload', 400);
  } finally { await env.stop(); }
});

test('fila: "próximo" toca o primeiro, tira da fila e só vale se ainda for o que se viu', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    await rejects(host.queueNext(V(1)), 'queue_empty', 409);
    await host.queueAdd(V(1), 'Segundo'); await host.queueAdd(V(2), 'Terceiro');
    await guest.queueNext(V(1));
    const s = await host.getState({ after: 0 });
    assert.deepEqual(s.media, { provider: 'youtube', titleId: 'youtube:' + V(1), videoId: V(1), title: 'Segundo' });
    assert.equal(s.playback.state, 'playing'); assert.equal(s.playback.positionSec, 0); assert.equal(s.playback.videoId, V(1));
    assert.deepEqual(s.queue.map((q) => q.videoId), [V(2)]);
    // o outro player também avisou que o vídeo acabou, mas já com a fila adiantada: não pula mais um
    await rejects(host.queueNext(V(1)), 'queue_changed', 409);
    assert.deepEqual(host.snapshot.queue.map((q) => q.videoId), [V(2)], 'a fila continua igual');
    await rejects(host.send('queue.next', { videoId: 'curto' }), 'bad_payload', 400);
    await rejects(host.send('queue.next', {}), 'bad_payload', 400);
  } finally { await env.stop(); }
});

test('fila: abrir agora um vídeo que estava na fila tira ele de lá; trocar de plataforma esvazia; só no YouTube', async () => {
  const env = await boot();
  try {
    const { host } = await pair(env);
    await host.queueAdd(V(1), 'Segundo'); await host.queueAdd(V(2), 'Terceiro');
    await host.openYouTubeVideo(V(2), 'Terceiro');
    assert.deepEqual(host.snapshot.queue.map((q) => q.videoId), [V(1)]);
    await host.selectPlatform('netflix');
    assert.deepEqual(host.snapshot.queue, []);
    await rejects(host.queueAdd(V(3), 'Quarto'), 'wrong_platform', 409);
  } finally { await env.stop(); }
});

test('fila: trocar para o próximo durante um intervalo ou uma contagem encerra os dois', async () => {
  const env = await boot();
  try {
    const { host } = await pair(env);
    await host.queueAdd(V(1), 'Segundo');
    await host.startBreak(5);
    assert.ok(host.snapshot.break);
    await host.queueNext(V(1));
    assert.equal(host.snapshot.break, null);
    assert.equal(host.snapshot.playback.state, 'playing');
  } finally { await env.stop(); }
});

test('título pelo oEmbed: sem chave, com limpeza do texto e falha silenciosa', async () => {
  const calls = [];
  let reply = { ok: true, json: async () => ({ title: '  Meu <b>vídeo</b> legal  ' }) };
  const env = await boot({ fetchImpl: async (url) => { calls.push(String(url)); if (reply === 'erro') throw new Error('rede'); return reply; } });
  try {
    const { host } = await pair(env);
    assert.equal(await host.youtubeTitle(V(5)), 'Meu bvídeo/b legal');
    assert.equal(calls.length, 1);
    const u = new URL(calls[0]);
    assert.equal(u.origin + u.pathname, 'https://www.youtube.com/oembed');
    assert.equal(u.searchParams.get('url'), 'https://www.youtube.com/watch?v=' + V(5));
    reply = { ok: false, json: async () => ({}) };
    assert.equal(await host.youtubeTitle(V(5)), null, 'o serviço respondeu erro: sem título');
    reply = 'erro';
    assert.equal(await host.youtubeTitle(V(5)), null, 'sem rede: sem título, sem quebrar');
    reply = { ok: true, json: async () => ({ title: 'x' }) };
    assert.equal(await host.youtubeTitle(V(5)), null, 'título curto demais não serve');
    const before = calls.length;
    assert.equal(await host.youtubeTitle('curto'), null, 'id inválido nem chega ao YouTube');
    assert.equal(calls.length, before);
  } finally { await env.stop(); }
});

test('título pelo oEmbed: exige estar na sala (sem credencial é recusado)', async () => {
  const env = await boot({ fetchImpl: async () => ({ ok: true, json: async () => ({ title: 'Qualquer' }) }) });
  try {
    const { host } = await pair(env);
    const r = await fetch(`${env.url}/v1/rooms/${host.snapshot.code}/youtube/title?id=${V(5)}`);
    assert.ok(r.status === 401 || r.status === 403, 'status ' + r.status);
    const r2 = await fetch(`${env.url}/v1/rooms/${host.snapshot.code}/youtube/title?id=${V(5)}&extra=1`);
    assert.ok(r2.status >= 400);
  } finally { await env.stop(); }
});

test('a tela e o player: botões da fila, avanço automático quando o vídeo acaba', () => {
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  for (const a of ["'youtube-queue-add'", "'queue-add'", "'queue-remove'", "'queue-next'"]) assert.ok(ui.includes(a), a);
  assert.match(ui, /onEnded: \(videoId\) => advanceQueue\(videoId\)/);
  assert.match(ui, /client\.queueNext\(head\.videoId\)/);
  const player = readFileSync(new URL('../server/youtube-player.js', import.meta.url), 'utf8');
  assert.match(player, /YT\.PlayerState\.ENDED\) \{ Promise\.resolve\(onEnded\?\.\(latest\.media\.videoId\)\)/);
});
