import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRemoteIce, sanitizeServers } = require('../server/remote-ice.js');
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient } = require('../server/client.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const URLS = ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:443?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'];
const body = (ttl = 14400) => ({ ok: true, ttl, iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: URLS, username: 'u-temp', credential: 'c-temp' }] });
const reply = (b, status = 200) => async () => new Response(JSON.stringify(b), { status });

test('lista do TURN: só endereços conhecidos, poucos (UDP 3478, UDP 443 e TLS 443) e sempre com usuário e senha', () => {
  const [stun, turn] = sanitizeServers(body().iceServers);
  assert.deepEqual(stun, { urls: ['stun:stun.cloudflare.com:3478'] });
  assert.deepEqual(turn.urls, ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:443?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp']);
  assert.deepEqual(sanitizeServers([{ urls: ['turn:a.example:3478'] }]), [], 'TURN sem senha é descartado');
  assert.deepEqual(sanitizeServers([{ urls: ['turn:a.example:53?transport=udp'], username: 'u', credential: 'c' }]), [], 'porta 53 fora');
  assert.deepEqual(sanitizeServers([{ urls: ['javascript:alert(1)'] }, { urls: 'http://x.example' }, null, 7, 'x']), []);
  assert.deepEqual(sanitizeServers(undefined), []);
  assert.equal(sanitizeServers(Array(9).fill({ urls: ['stun:a.example:3478'] })).length, 4);
});

test('TURN remoto: busca, guarda, renova com 30% de sobra e nunca devolve credencial vencida', async () => {
  let t = 1_000_000, calls = 0;
  const fetchImpl = async (url, init) => { calls++; assert.equal(url, 'https://stats.example/v1/ice'); assert.equal(init.redirect, 'error'); assert.ok(init.signal); return new Response(JSON.stringify(body(1000)), { status: 200 }); };
  const ice = createRemoteIce({ url: 'https://stats.example/v1/ice', fetchImpl, now: () => t });
  assert.equal(ice.enabled, true);
  const a = await ice.get(); assert.equal(calls, 1); assert.equal(a.length, 2);
  await ice.get(); assert.equal(calls, 1, 'dentro do prazo não busca de novo');
  t += 690_000; await ice.get(); assert.equal(calls, 1, 'ainda antes de 70% da validade');
  t += 20_000; await ice.get(); assert.equal(calls, 2, 'passou de 70%: renova');
  // renovação falha: usa a que ainda vale; depois de 95% descarta
  const failing = createRemoteIce({ url: 'https://stats.example/v1/ice', fetchImpl: async () => { calls++; throw new TypeError('sem rede'); }, now: () => t });
  assert.deepEqual(await failing.get(), []);
});

test('TURN remoto: falha segura (lista vazia), espera 60 s para tentar de novo e junta pedidos simultâneos', async () => {
  let t = 5_000_000, calls = 0, mode = 'fail';
  const fetchImpl = async () => { calls++; if (mode === 'fail') throw new TypeError('sem rede'); return new Response(JSON.stringify(body(7200)), { status: 200 }); };
  const ice = createRemoteIce({ url: 'https://stats.example/v1/ice', fetchImpl, now: () => t });
  assert.deepEqual(await ice.get(), []); assert.equal(calls, 1);
  assert.deepEqual(await ice.get(), []); assert.equal(calls, 1, 'não insiste antes de 60 s');
  mode = 'ok'; t += 61_000;
  const [x, y, z] = await Promise.all([ice.get(), ice.get(), ice.get()]);
  assert.equal(calls, 2, 'três pedidos ao mesmo tempo, uma só busca'); assert.equal(x.length, 2); assert.deepEqual(x, y); assert.deepEqual(y, z);
  // respostas ruins viram falha
  for (const r of [reply({ ok: false }, 503), reply('x'), reply({ ok: true, ttl: 3600, iceServers: [{ urls: ['stun:a.example:3478'] }] }), reply({ iceServers: 'x' })]) {
    const bad = createRemoteIce({ url: 'https://stats.example/v1/ice', fetchImpl: async () => { const rs = await r(); return rs; }, now: () => t });
    assert.deepEqual(await bad.get(), []);
  }
});

test('TURN remoto: sem endereço válido fica desligado (só https, ou loopback nos testes)', async () => {
  for (const url of [undefined, '', 'http://stats.example/v1/ice', 'ftp://x.example', 'javascript:alert(1)', 5]) {
    const ice = createRemoteIce({ url, fetchImpl: async () => { throw new Error('não deveria chamar'); } });
    assert.equal(ice.enabled, false, String(url)); assert.deepEqual(await ice.get(), []);
  }
  assert.equal(createRemoteIce({ url: 'http://127.0.0.1:9/v1/ice', fetchImpl: reply(body()) }).enabled, true);
  assert.equal(createRemoteIce({ url: 'https://stats.example/v1/ice', fetchImpl: null }).enabled, false);
});

async function boot(extra = {}) {
  const svc = createRoomService({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], ...extra });
  const addr = await svc.listen(0, '127.0.0.1');
  return { svc, url: `http://127.0.0.1:${addr.port}` };
}

test('serviço: a sala entrega o TURN aos aprovados e o convidado sem sala pega a lista pela rota local', async () => {
  const remote = createRemoteIce({ url: 'https://stats.example/v1/ice', fetchImpl: reply(body()) });
  const { svc, url } = await boot({ remoteIce: remote, servePrototype: true });
  try {
    const host = new DuoRoomClient({ serviceUrl: url });
    await host.createRoom('Ana');
    const list = await host.iceServers();
    assert.ok(list.some((s) => s.urls.some((u) => u.startsWith('stun:stun.l.google.com'))), 'o STUN de sempre continua');
    const turn = list.find((s) => s.username === 'u-temp');
    assert.ok(turn && turn.credential === 'c-temp' && turn.urls.length === 3);
    const local = await (await fetch(url + '/v1/local/ice')).json();
    assert.equal(local.ok, true); assert.ok(local.iceServers.some((s) => s.username === 'u-temp'));
    assert.equal((await fetch(url + '/v1/local/ice')).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url + '/v1/local/ice?x=1')).status, 400);
    assert.equal((await fetch(url + '/v1/local/ice', { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/v1/local/ice', { headers: { Origin: 'https://evil.example' } })).status, 403, 'página de fora não lê');
  } finally { await svc.close(); }
});

test('serviço: sem TURN (ou com falha nele) a lista é a de antes e nada quebra; fora do modo local a rota some', async () => {
  const broken = { async get() { throw new Error('quebrou'); } };
  const { svc, url } = await boot({ remoteIce: broken, servePrototype: true });
  try {
    const host = new DuoRoomClient({ serviceUrl: url }); await host.createRoom('Ana');
    const list = await host.iceServers();
    assert.ok(list.length >= 1 && !list.some((s) => s.username));
    assert.equal((await (await fetch(url + '/v1/local/ice')).json()).iceServers.some((s) => s.username), false);
  } finally { await svc.close(); }
  const plain = await boot({});
  try { assert.equal((await fetch(plain.url + '/v1/local/ice')).status, 403, 'sem o modo local a rota recusa'); } finally { await plain.svc.close(); }
});

test('ligações: o servidor do app liga o TURN ao Worker e o convidado usa a lista local nos 3 pontos de conexão', () => {
  const index = read('../server/index.js');
  assert.match(index, /const remoteIce = origin && process\.env\.DUOTELA_NO_RELAY !== '1' \? createRemoteIce\(\{ url: origin \+ '\/v1\/ice' \}\) : null;/);
  assert.match(index, /remoteIce\?\.warm\(\);/);
  const ui = read('../server/online-ui.js');
  assert.equal((ui.match(/iceServers: await localIce\(\)/g) || []).length, 3, 'p2pJoin, shortJoin e a reconexão do convidado');
  assert.ok(ui.includes("fetch(location.origin + '/v1/local/ice'"));
  assert.doesNotMatch(ui, /iceServers: P2P_ICE/);
});
