import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient } = require('../server/client.js');

async function boot() {
  const svc = createRoomService({ now: () => 1_000_000, logger: () => {} });
  const addr = await svc.listen(0, '127.0.0.1');
  return { url: `http://127.0.0.1:${addr.port}`, stop: () => svc.close() };
}
async function room(env, platform = 'netflix') {
  const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
  const created = await host.createRoom();
  await guest.joinRoom(created.invite);
  await host.approveGuest();
  if (platform) await host.selectPlatform(platform);
  return { host, guest };
}

test('Netflix sem votação: o /watch que o Host abre vira o título da sala e os dois controlam play, pausa e posição', async () => {
  const env = await boot();
  try {
    const { host, guest } = await room(env);
    assert.equal(host.snapshot.round ?? null, null, 'nenhuma votação foi feita');
    await host.selectNetflixTitle('netflix:80057281', '80057281');
    const s = await guest.getState({ after: 0 });
    assert.deepEqual(s.media, { provider: 'netflix', titleId: 'netflix:80057281', watchId: '80057281' });
    assert.equal(s.playback.state, 'playing');
    await guest.playbackNetflix('netflix:80057281', '80057281', 'pause', 30);
    const h = await host.getState({ after: 0 });
    assert.deepEqual([h.playback.state, h.playback.positionSec, h.playback.updatedBy], ['paused', 30, 'guest']);
    await host.playbackNetflix('netflix:80057281', '80057281', 'seek', 90);
    assert.equal((await guest.getState({ after: 0 })).playback.positionSec, 90);
    await host.selectNetflixTitle('netflix:123456789012', '123456789012');      // trocar de título sem votar
    assert.equal(host.snapshot.media.watchId, '123456789012');
  } finally { await env.stop(); }
});

test('Netflix sem votação: só o formato "netflix:<mesmo id>" passa; o resto continua exigindo match', async () => {
  const env = await boot();
  try {
    const { host } = await room(env);
    for (const [titleId, watchId] of [['netflix:1', '2'], ['netflix:abc', 'abc'], ['netflix:', ''], ['tmdb:movie:1', '80057281'], ['NETFLIX:80057281', '80057281'], ['netflix:80057281 ', '80057281']]) {
      await assert.rejects(host.send('media.netflix', { titleId, watchId }), (e) => ['unknown_title', 'bad_payload', 'no_match'].includes(e.code), `${titleId}/${watchId}`);
    }
    await assert.rejects(host.playbackNetflix('netflix:80057281', '80057281', 'play', 1), (e) => e.code === 'media_not_selected', 'tocar sem título escolhido');
  } finally { await env.stop(); }
});

test('Netflix sem votação: só vale na plataforma Netflix', async () => {
  const env = await boot();
  try {
    const { host } = await room(env, 'youtube');
    await assert.rejects(host.selectNetflixTitle('netflix:80057281', '80057281'), (e) => e.code === 'wrong_platform');
  } finally { await env.stop(); }
});

test('app e tela aceitam o título livre e o painel não pede mais votação', () => {
  const main = readFileSync(new URL('../../app/main.cjs', import.meta.url), 'utf8');
  assert.ok(main.includes("media.titleId !== state.selectedMatch && media.titleId !== 'netflix:' + media.watchId"));
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.ok(ui.includes('const netflixTitleId = (watchId) => snapshot?.selectedMatch || `netflix:${watchId}`;'));
  assert.equal(ui.includes('Votem em um título na aba Match. A Netflix pode ficar aberta'), false, 'sem a exigência de votar');
  assert.ok(ui.includes('a sala adota esse título e os outros abrem o mesmo'));
  const at = ui.indexOf('async function autoAssociateNetflix(event)');
  assert.equal(ui.slice(at, at + 400).includes('selectedMatch'), false, 'a associação automática não depende de match');
});
