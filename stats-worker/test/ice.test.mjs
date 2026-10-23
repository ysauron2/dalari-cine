import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../src/index.js';
import { handleIce, sanitizeIceServers, resetIceLimits, PER_IP_PER_HOUR, PER_DAY, TTL_S } from '../src/ice.js';

function makeDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    raw,
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return { bind: (...args) => ({ run: () => stmt.run(...args), first: async () => { const r = stmt.get(...args); return r ? { ...r } : null; }, all: async () => ({ results: stmt.all(...args).map((r) => ({ ...r })) }) }) };
    },
    async batch(list) { for (const s of list) s.run(); },
  };
}
const T0 = 1_800_000_000;
const SECRETS = { TURN_KEY_ID: 'abcd1234efgh5678', TURN_KEY_API_TOKEN: 'segredo-super-secreto-123' };
const upstream = (over = {}) => ({ iceServers: [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'user-temp', credential: 'senha-temp' },
], ...over });
const okFetch = (calls = []) => async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(upstream()), { status: 201 }); };
const req = (ip = '203.0.113.5') => new Request('https://stats.example/v1/ice', { headers: { 'CF-Connecting-IP': ip } });

test('sanitiza: só endereços conhecidos, sem porta 53, TURN só com usuário e senha, no máximo o necessário', () => {
  const clean = sanitizeIceServers(upstream().iceServers);
  assert.deepEqual(clean[0], { urls: ['stun:stun.cloudflare.com:3478'] });
  assert.deepEqual(clean[1].urls, ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], 'a porta 53 sai');
  assert.equal(clean[1].username, 'user-temp'); assert.equal(clean[1].credential, 'senha-temp');
  assert.deepEqual(sanitizeIceServers([{ urls: ['turn:x.example:3478'] }]), [], 'TURN sem senha é descartado');
  assert.deepEqual(sanitizeIceServers([{ urls: ['javascript:alert(1)'], username: 'a', credential: 'b' }, { urls: 'http://evil.example' }, { urls: ['turn:a b:3478'], username: 'a', credential: 'b' }, null, 5]), []);
  assert.deepEqual(sanitizeIceServers([{ urls: 'stun:stun.exemplo.com:3478' }]), [{ urls: ['stun:stun.exemplo.com:3478'] }], 'texto único vira lista');
  assert.deepEqual(sanitizeIceServers(null), []); assert.deepEqual(sanitizeIceServers('x'), []);
  assert.equal(sanitizeIceServers(Array(10).fill({ urls: ['stun:a.example:3478'] })).length, 4);
  assert.deepEqual(sanitizeIceServers([{ urls: ['turn:a.example:3478'], username: 'u'.repeat(400), credential: 'c' }]), []);
});

test('sem os segredos do TURN o serviço diz que não está configurado (503) e não chama a Cloudflare', async () => {
  resetIceLimits();
  const calls = [];
  const r = await handleIce(req(), { DB: makeDb() }, T0, okFetch(calls));
  assert.deepEqual([r.status, r.body.error], [503, 'not_configured']); assert.equal(calls.length, 0);
  const bad = await handleIce(req(), { DB: makeDb(), TURN_KEY_ID: 'curto', TURN_KEY_API_TOKEN: 'x' }, T0, okFetch(calls));
  assert.equal(bad.status, 503);
});

test('pedido válido: chama a Cloudflare com o token (que nunca volta na resposta) e devolve credenciais temporárias', async () => {
  resetIceLimits();
  const db = makeDb(), calls = [];
  const r = await handleIce(req(), { DB: db, ...SECRETS }, T0, okFetch(calls));
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.ttl, TTL_S);
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/abcd1234efgh5678/credentials/generate-ice-servers');
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.headers.Authorization, 'Bearer segredo-super-secreto-123');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ttl: TTL_S });
  const text = JSON.stringify(r.body);
  assert.equal(text.includes('segredo-super-secreto'), false, 'o token da chave nunca aparece');
  assert.ok(r.body.iceServers.some((s) => s.username === 'user-temp'));
  assert.equal(db.raw.prepare("SELECT n FROM counters WHERE name = 'ice_issued'").get().n, 1, 'conta no dia para o limite');
});

test('limites: por pessoa por hora, no dia, e erros da Cloudflare viram 502 sem vazar detalhes', async () => {
  resetIceLimits();
  const env = { DB: makeDb(), ...SECRETS };
  for (let i = 0; i < PER_IP_PER_HOUR; i++) assert.equal((await handleIce(req('198.51.100.1'), env, T0 + i, okFetch())).status, 200);
  const limited = await handleIce(req('198.51.100.1'), env, T0 + 100, okFetch());
  assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
  assert.equal((await handleIce(req('198.51.100.2'), env, T0 + 100, okFetch())).status, 200, 'outra pessoa não é afetada');
  assert.equal((await handleIce(req('198.51.100.1'), env, T0 + 3700, okFetch())).status, 200, 'depois de uma hora libera');

  resetIceLimits();
  const day = { DB: makeDb(), ...SECRETS };
  day.DB.raw.prepare("INSERT INTO counters (day, name, key, n) VALUES (?, 'ice_issued', '', ?)").run(new Date(T0 * 1000).toISOString().slice(0, 10), PER_DAY);
  const d = await handleIce(req(), day, T0, okFetch());
  assert.deepEqual([d.status, d.body.error], [429, 'daily_limit']);

  resetIceLimits();
  for (const f of [async () => new Response('erro com o segredo segredo-super-secreto-123', { status: 401 }), async () => { throw new Error('rede com segredo-super-secreto-123'); }, async () => new Response(JSON.stringify({ iceServers: [{ urls: ['stun:a.example:3478'] }] }), { status: 201 }), async () => new Response('não é json', { status: 201 })]) {
    const e = await handleIce(req('203.0.113.77'), { DB: makeDb(), ...SECRETS }, T0, f); resetIceLimits();
    assert.deepEqual([e.status, e.body.error], [502, 'upstream']);
    assert.equal(JSON.stringify(e.body).includes('segredo'), false);
  }
});

test('GET /v1/ice: CORS, método e corpo; sem o segredo responde 503', async () => {
  resetIceLimits();
  const env = { DB: makeDb(), ...SECRETS };
  const original = globalThis.fetch; globalThis.fetch = okFetch();
  try {
    const res = await handle(req(), env, T0);
    assert.equal(res.status, 200); assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*'); assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal((await res.json()).iceServers.length, 2);
    assert.equal((await handle(new Request('https://stats.example/v1/ice', { method: 'POST' }), env, T0)).status, 405);
    assert.equal((await handle(new Request('https://stats.example/v1/ice', { method: 'OPTIONS' }), env, T0)).status, 204);
    resetIceLimits();
    assert.equal((await handle(req(), { DB: makeDb() }, T0)).status, 503);
  } finally { globalThis.fetch = original; }
});
