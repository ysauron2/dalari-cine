import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient, RoomError } = require('../server/client.js');
const L = require('../server/lag-watch.js');

async function boot() {
  const clock = { t: 1_000_000 };
  const svc = createRoomService({ now: () => clock.t });
  const addr = await svc.listen(0, '127.0.0.1');
  return { clock, url: `http://127.0.0.1:${addr.port}`, stop: () => svc.close() };
}
async function pair(env) {
  const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
  const created = await host.createRoom();
  await guest.joinRoom(created.invite); await host.approveGuest();
  await host.selectPlatform('youtube'); await host.openYouTubeVideo('abcdefghijk', 'Vídeo de teste');
  await guest.getState({ after: 0 });
  return { host, guest };
}

test('meu atraso: só se mede tocando, com vídeo carregado e liberado; vira segundos inteiros', () => {
  assert.equal(L.myLag({ playing: true, dur: 600, blocked: false, local: 92, wanted: 100 }), -8);
  assert.equal(L.myLag({ playing: true, dur: 600, blocked: false, local: 103.4, wanted: 100 }), 3);
  assert.equal(L.myLag({ playing: true, dur: 600, blocked: false, local: 99.6, wanted: 100 }), 0);
  assert.equal(L.myLag({ playing: false, dur: 600, blocked: false, local: 1, wanted: 100 }), null, 'pausado: nada a medir');
  assert.equal(L.myLag({ playing: true, dur: 0, blocked: false, local: 1, wanted: 100 }), null, 'ainda carregando');
  assert.equal(L.myLag({ playing: true, dur: 600, blocked: true, local: 1, wanted: 100 }), null, 'esperando clique para iniciar');
  assert.equal(L.myLag({ playing: true, dur: 600, blocked: false, local: NaN, wanted: 100 }), null);
  assert.equal(L.myLag({ playing: true, dur: 9999, blocked: false, local: 0, wanted: 90000 }), -3600, 'limitado ao que a sala aceita');
});

test('envio do atraso: só quando muda (2 s ou mais), de tempos em tempos, e zera ao parar de medir', () => {
  const r = L.createReporter();
  assert.equal(r.next(0, 0), 0, 'o primeiro valor sempre vai');
  assert.equal(r.next(1, 2000), null, 'mudança de 1 s não vale uma mensagem');
  assert.equal(r.next(-8, 4000), -8);
  assert.equal(r.next(-8, 6000), null);
  assert.equal(r.next(-9, 8000), null);
  assert.equal(r.next(-8, 4000 + L.HEARTBEAT_MS), -8, 'reenvia o mesmo valor para a sala não esquecer');
  assert.equal(r.next(null, 30000), 0, 'pausou ou fechou: a sala é avisada uma vez de que não há mais atraso');
  assert.equal(r.next(null, 32000), null, 'e não fica repetindo');
  const q = L.createReporter();
  assert.equal(q.next(null, 0), null, 'quem nunca mediu não manda nada');
  assert.equal(q.next(0, 1000), 0);
  assert.equal(q.next(null, 2000), null, 'estava em dia (0): nada a zerar');
});

test('aviso: só depois de durar 6 s, só para os outros, com nome e a ação certa no texto', () => {
  const name = (r) => ({ host: 'Daniel', guest: 'Larissa', guest2: 'Pedro' }[r]);
  const b = L.createBanner();
  assert.equal(b.update({ host: 0, guest: -8 }, 'host', name, 0), null, 'ainda não passou de 6 s: não pisca');
  assert.equal(b.update({ host: 0, guest: -8 }, 'host', name, 5000), null);
  assert.deepEqual(b.update({ host: 0, guest: -8 }, 'host', name, 6000), { text: 'Larissa ficou 8 s atrás.', roles: ['guest'] });
  assert.equal(b.update({ host: 0, guest: -3 }, 'host', name, 7000), null, 'voltou para perto: o aviso some');
  assert.equal(b.update({ host: 0, guest: -9 }, 'host', name, 8000), null, 'recomeça a contagem de 6 s');
  assert.equal(b.update({ host: 0, guest: 12 }, 'guest', name, 9000), null, 'o meu próprio atraso não vira aviso para mim');
  assert.equal(b.update({ host: 40 }, 'guest', name, 9500), null);
  assert.deepEqual(b.update({ host: 40 }, 'guest', name, 15500), { text: 'Daniel está 40 s na frente.', roles: ['host'] });
  assert.equal(b.update({}, 'guest', name, 16000), null, 'o relato expirou na sala: o aviso some');
  const m = L.createBanner();
  m.update({ guest: -7, guest2: 6 }, 'host', name, 0);
  assert.equal(m.update({ guest: -7, guest2: 6 }, 'host', name, 6000).text, 'Larissa ficou 7 s atrás e Pedro está 6 s na frente.');
  assert.equal(L.createBanner().update(undefined, 'host', name, 0), null, 'versões sem o campo não quebram');
});

test('sala: relato de atraso é um número inteiro limitado, visível a todos, e expira sozinho', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    assert.deepEqual(host.snapshot.lags, {});
    await guest.reportLag(-8);
    assert.deepEqual((await host.getState({ after: 0 })).lags, { guest: -8 });
    await host.reportLag(2);
    assert.deepEqual((await guest.getState({ after: 0 })).lags, { host: 2, guest: -8 });
    env.clock.t += 19000;
    await host.reportLag(2);                                       // o do convidado ainda não expirou
    assert.deepEqual((await host.getState({ after: 0 })).lags, { host: 2, guest: -8 });
    env.clock.t += 2000;
    assert.deepEqual((await guest.getState({ after: 0 })).lags, { host: 2 }, 'passou de 20 s sem renovar: some');
    await guest.reportLag(0);
    await guest.reportLag(-3);
    await guest.reportLag(0);
    assert.equal((await host.getState({ after: 0 })).lags.guest, 0);
    for (const bad of [1.5, '8', null, 3601, -3601, NaN, Infinity]) await assert.rejects(guest.send('lag.report', { lagSec: bad }), (e) => e instanceof RoomError && e.code === 'bad_payload' && e.status === 400, String(bad));
    await assert.rejects(guest.send('lag.report', { lagSec: 1, extra: 1 }), (e) => e instanceof RoomError && e.status === 400);
    await assert.rejects(guest.send('lag.report', {}), (e) => e instanceof RoomError && e.status === 400);
  } finally { await env.stop(); }
});

test('a página carrega o módulo, tem o aviso com o botão "Alinhar todos" e o serviço entrega o arquivo', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="server\/lag-watch\.js"><\/script>/);
  assert.match(readFileSync(new URL('../server/room-service.js', import.meta.url), 'utf8'), /'\/server\/lag-watch\.js', 'server\/lag-watch\.js'/);
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /id="lag-banner" role="status" aria-live="polite"/);
  assert.match(ui, /Alinhar todos', 'sync-now'/, 'o botão usa o mesmo caminho do Sincronizar agora (pausa, 3-2-1 e play junto)');
  assert.match(ui, /client\.reportLag\(v\)/);
});
