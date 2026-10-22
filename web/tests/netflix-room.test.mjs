import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient } = require('../server/client.js');

async function boot() {
  const clock = { t: 1_000_000 };
  const svc = createRoomService({ now: () => clock.t, logger: () => {} });
  const addr = await svc.listen(0, '127.0.0.1');
  return { url: `http://127.0.0.1:${addr.port}`, stop: () => svc.close() };
}

// Sala com Host e Convidado aprovados, plataforma escolhida e (se agree) match no primeiro título.
async function matchedRoom(env, { platform = 'netflix', agree = true } = {}) {
  const host = new DuoRoomClient({ serviceUrl: env.url });
  const guest = new DuoRoomClient({ serviceUrl: env.url });
  const created = await host.createRoom();
  await guest.joinRoom(created.invite);
  await host.approveGuest();
  await host.selectPlatform(platform);
  await host.startRound('surprise');
  const [a, b] = host.snapshot.round.picks;
  await host.vote(a, 'yes');
  await guest.getState({ after: 0 });
  await guest.vote(a, agree ? 'yes' : 'no');
  await host.getState({ after: 0 });
  return { host, guest, a, b };
}

test('Netflix: Host e Convidado selecionam a mídia e controlam a reprodução com version/updatedBy', async () => {
  const env = await boot();
  try {
    const { host, guest, a } = await matchedRoom(env);
    await host.selectNetflixTitle(a, '80057281');
    const m = await guest.getState({ after: 0 });
    assert.deepEqual(m.media, { provider: 'netflix', titleId: a, watchId: '80057281' });
    assert.deepEqual({ ...m.playback, updatedAt: 0 }, { titleId: a, watchId: '80057281', state: 'playing', positionSec: 0, updatedBy: 'host', updatedAt: 0, version: 1 });
    await guest.playbackNetflix(a, '80057281', 'pause', 30);
    let s = await host.getState({ after: 0 });
    assert.equal(s.playback.state, 'paused');
    assert.equal(s.playback.positionSec, 30);
    assert.equal(s.playback.updatedBy, 'guest');
    assert.equal(s.playback.version, 2);
    await host.playbackNetflix(a, '80057281', 'seek', 86400);
    s = await guest.getState({ after: 0 });
    assert.equal(s.playback.state, 'paused'); // seek preserva o estado
    assert.equal(s.playback.updatedBy, 'host');
    assert.equal(s.playback.version, 3);
    await guest.playbackNetflix(a, '80057281', 'play', 0);
    assert.equal(guest.snapshot.playback.state, 'playing');
    await host.selectNetflixTitle(a, '123456789012'); // 12 dígitos é o limite
    assert.equal(host.snapshot.playback.version, 5);
  } finally { await env.stop(); }
});

test('Netflix: exige match e dados bem formados, e recusa mismatch de título/ID', async () => {
  const env = await boot();
  try {
    const { host, guest, a, b } = await matchedRoom(env);
    await assert.rejects(host.selectNetflixTitle(b, '80057281'), (e) => e.code === 'no_match');
    const malformed = ['', '0123456789012', '12a', ' 123', '123 ', '١٢٣', 'https://www.netflix.com/watch/80057281', '-1', '1.5'];
    for (const bad of malformed) {
      await assert.rejects(host.selectNetflixTitle(a, bad), (e) => e.code === 'bad_payload', JSON.stringify(bad));
    }
    await assert.rejects(host.selectNetflixTitle(a, 80057281), (e) => e.code === 'bad_payload');
    await assert.rejects(host.send('media.netflix', { titleId: a, watchId: '1', url: 'x' }), (e) => e.code === 'bad_payload');
    await assert.rejects(host.send('media.netflix', { titleId: 'tmdb:movie:0', watchId: '1' }), (e) => e.code === 'unknown_title');
    await assert.rejects(guest.playbackNetflix(a, '80057281', 'play', 1), (e) => e.code === 'media_not_selected');
    await host.selectNetflixTitle(a, '80057281');
    await assert.rejects(guest.playbackNetflix(b, '80057281', 'play', 1), (e) => e.code === 'no_match');
    await assert.rejects(guest.playbackNetflix(a, '80057282', 'play', 1), (e) => e.code === 'media_not_selected');
    const invalid = [['rewind', 1], ['play', -1], ['play', 86401], ['play', Infinity], ['play', NaN], ['play', '5']];
    for (const [action, pos] of invalid) {
      await assert.rejects(guest.playbackNetflix(a, '80057281', action, pos), (e) => e.code === 'bad_payload', `${action} ${pos}`);
    }
    assert.equal((await host.getState({ after: 0 })).playback.version, 1);
    await host.startRound('surprise'); // nova rodada limpa a mídia
    assert.equal(host.snapshot.media, null);
    await assert.rejects(guest.playbackNetflix(a, '80057281', 'play', 1), (e) => ['no_match', 'media_not_selected'].includes(e.code));
  } finally { await env.stop(); }
});

test('Netflix: sem match ou em plataforma errada a mídia é recusada', async () => {
  const env = await boot();
  const env2 = await boot();
  try {
    const { host, a } = await matchedRoom(env, { platform: 'youtube' });
    await assert.rejects(host.selectNetflixTitle(a, '80057281'), (e) => e.code === 'wrong_platform');
    await assert.rejects(host.playbackNetflix(a, '80057281', 'play', 1), (e) => e.code === 'wrong_platform');
    await assert.rejects(host.send('media.netflix', { titleId: a, watchId: '1', role: 'host' }), (e) => e.code === 'bad_payload');
    assert.equal(host.snapshot?.media ?? null, null);
    const n = await matchedRoom(env2, { agree: false });
    await assert.rejects(n.host.selectNetflixTitle(n.a, '80057281'), (e) => e.code === 'no_match');
  } finally { await env.stop(); await env2.stop(); }
});

test('Netflix: playback legado não controla a mídia Netflix', async () => {
  const env = await boot();
  try {
    const { host, guest, a } = await matchedRoom(env);
    await host.selectNetflixTitle(a, '12345678901'); // 11 dígitos: também casaria o formato de ID do YouTube
    await assert.rejects(guest.send('playback', { titleId: a, videoId: '12345678901', action: 'pause', positionSec: 5 }), (e) => e.code === 'media_not_selected');
    await assert.rejects(guest.send('media.youtube', { titleId: a, videoId: '12345678901' }), (e) => e.code === 'wrong_platform');
    await assert.rejects(guest.openYouTubeVideo('abcdefghijk', 'Vídeo'), (e) => e.code === 'wrong_platform');
    const s = await host.getState({ after: 0 });
    assert.equal(s.playback.state, 'playing');
    assert.equal(s.playback.version, 1);
    assert.equal(s.media.provider, 'netflix');
  } finally { await env.stop(); }
});

test('Netflix: playback.netflix não controla o YouTube e o fluxo YouTube segue intacto', async () => {
  const env = await boot();
  try {
    const { host, guest, a } = await matchedRoom(env, { platform: 'youtube' });
    await host.selectYouTubeVideo(a, 'abcdefghijk');
    assert.deepEqual(host.snapshot.media, { provider: 'youtube', titleId: a, videoId: 'abcdefghijk' });
    await assert.rejects(guest.playbackNetflix(a, '12345', 'pause', 3), (e) => e.code === 'wrong_platform');
    await assert.rejects(guest.send('playback.netflix', { titleId: a, videoId: 'abcdefghijk', action: 'pause', positionSec: 3 }), (e) => e.code === 'bad_payload');
    await guest.getState({ after: 0 });
    await guest.playback(a, 'pause', 9);
    const s = await host.getState({ after: 0 });
    assert.equal(s.playback.state, 'paused');
    assert.equal(s.playback.positionSec, 9);
    assert.equal(s.playback.videoId, 'abcdefghijk');
    assert.equal(s.playback.watchId, undefined);
    assert.equal(s.playback.version, 2);
    await host.openYouTubeVideo('123456789ab', 'Direto');
    await guest.getState({ after: 0 });
    await guest.playback('youtube:123456789ab', 'seek', 4);
    assert.equal((await host.getState({ after: 0 })).playback.positionSec, 4);
    await host.selectPlatform('netflix'); // trocar de plataforma limpa mídia e rodada
    assert.equal(host.snapshot.media, null);
    await assert.rejects(host.selectNetflixTitle(a, '80057281'), (e) => e.code === 'no_match');
  } finally { await env.stop(); }
});
