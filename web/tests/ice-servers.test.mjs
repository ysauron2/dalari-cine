import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient } = require('../server/client.js');

const SECRET = 'segredo-turn-de-teste-1234567890';
const STUN = [{ urls: 'stun:stun.example.test:3478' }];

async function boot(opts = {}) {
  const clock = { t: 1_000_000 };
  const svc = createRoomService({ now: () => clock.t, ...opts });
  const addr = await svc.listen(0, '127.0.0.1');
  return { svc, url: `http://127.0.0.1:${addr.port}`, clock, stop: () => svc.close() };
}

test('/ice exige credencial; participante aprovado recebe a lista, pendente é recusado', async () => {
  const env = await boot({ iceServers: STUN });
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    const guest = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom();
    assert.equal((await fetch(`${env.url}/v1/rooms/${host.code}/ice`)).status, 401);
    assert.deepEqual(await host.iceServers(), STUN);
    await guest.joinRoom(created.invite);
    await assert.rejects(() => guest.iceServers(), (e) => e.status === 403);
    await host.approveGuest();
    assert.deepEqual(await guest.iceServers(), STUN);
  } finally { await env.stop(); }
});

test('TURN: credencial temporária HMAC por papel; o segredo nunca aparece na resposta', async () => {
  const env = await boot({ iceServers: STUN, turn: { urls: ['turn:turn.example.test:3478', 'turns:turn.example.test:5349?transport=tcp'], secret: SECRET, ttlSec: 3600 } });
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    const guest = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom();
    await guest.joinRoom(created.invite); await host.approveGuest();
    const h = await host.iceServers(), g = await guest.iceServers();
    assert.equal(h.length, 2);
    const turn = h[1];
    assert.deepEqual(turn.urls, ['turn:turn.example.test:3478', 'turns:turn.example.test:5349?transport=tcp']);
    assert.equal(turn.username, `${Math.floor(1_000_000 / 1000) + 3600}:host`);
    assert.equal(turn.credential, crypto.createHmac('sha1', SECRET).update(turn.username).digest('base64'));
    assert.equal(g[1].username.endsWith(':guest'), true);
    assert.notEqual(g[1].credential, turn.credential);
    assert.equal(JSON.stringify([h, g]).includes(SECRET), false);
  } finally { await env.stop(); }
});

test('sem configuração a lista é vazia; configuração inválida é recusada na criação', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    await host.createRoom();
    assert.deepEqual(await host.iceServers(), []);
  } finally { await env.stop(); }
  const bad = [
    { iceServers: [{ urls: 'http://evil.test' }] },
    { iceServers: [{ urls: 'stun:ok.test', extra: 1 }] },
    { iceServers: 'stun:ok.test' },
    { iceServers: [{ urls: 'turn:ok.test', username: 5 }] },
    { turn: { urls: 'turn:ok.test:3478', secret: 'curto' } },
    { turn: { urls: 'javascript:alert(1)', secret: SECRET } },
  ];
  for (const opts of bad) assert.throws(() => createRoomService(opts), TypeError, JSON.stringify(opts));
});
