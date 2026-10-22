import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle, validatePing, summary, csv } from '../src/index.js';

// Banco SQLite em memória com a mesma interface do D1 (prepare/bind/run/first/all e batch).
function makeDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db = {
    raw,
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return { bind: (...args) => ({ run: () => stmt.run(...args), first: async () => { const r = stmt.get(...args); return r ? { ...r } : null; }, all: async () => ({ results: stmt.all(...args).map((r) => ({ ...r })) }) }) };   // objetos simples, como o D1 devolve
    },
    async batch(list) { for (const s of list) s.run(); },
  };
  return db;
}

const ID = 'AbCdEfGhIjKlMnOpQrSt12';
const base = { v: 1, id: ID, app: '0.1.0', os: 'win', state: 'idle' };
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0) / 1000;
const post = (env, body, { now = T0, ip = '203.0.113.7', raw } = {}) => handle(new Request('https://stats.example/v1/ping', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': ip }, body: raw ?? JSON.stringify(body) }), env, now);
const get = (env, path, password, now = T0) => handle(new Request('https://stats.example' + path, { headers: password === undefined ? {} : { Authorization: 'Basic ' + btoa('x:' + password) } }), env, now);

test('validatePing aceita só o formato exato e recusa campos extras, ids ruins e eventos fora da lista', () => {
  assert.deepEqual(validatePing(base), { id: ID, app: '0.1.0', os: 'win', state: 'idle', ev: null });
  assert.deepEqual(validatePing({ ...base, ev: { n: 'call_ended', k: '5-30m' } }).ev, { n: 'call_ended', k: '5-30m' });
  assert.deepEqual(validatePing({ ...base, ev: { n: 'room_created' } }).ev, { n: 'room_created', k: '' });
  const bad = [null, [], 'x', { ...base, v: 2 }, { ...base, extra: 1 }, { ...base, name: 'Daniel' }, { ...base, id: 'curto' }, { ...base, id: 'a'.repeat(65) }, { ...base, id: 'id com espaço 123456' },
    { ...base, app: '1.0 <script>' }, { ...base, os: 'ios' }, { ...base, state: 'watching' },
    { ...base, ev: { n: 'qualquer' } }, { ...base, ev: { n: 'call_ended', k: 'Filme X' } }, { ...base, ev: { n: 'route', k: '' } }, { ...base, ev: { n: 'room_created', k: 'x' } }, { ...base, ev: 'room_created' }, { ...base, ev: { n: 'route', k: 'relay', title: 'x' } }];
  for (const b of bad) assert.equal(validatePing(b), null, JSON.stringify(b));
});

test('aviso grava instalação, dia ativo e contador; repetir no mesmo dia não duplica; o estado "agora" vem do aviso mais recente', async () => {
  const db = makeDb(), env = { DB: db };
  assert.equal((await post(env, { ...base, ev: { n: 'room_created' } })).status, 200);
  await post(env, { ...base, state: 'room' }, { now: T0 + 120 });
  await post(env, { ...base, state: 'call', ev: { n: 'call_started' } }, { now: T0 + 240, ip: '203.0.113.8' });
  await post(env, { ...base, id: 'ZyXwVuTsRqPoNmLkJiHg99', state: 'room', os: 'mac', app: '0.2.0' }, { now: T0 + 250, ip: '203.0.113.9' });
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM installs').get().n, 2);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM daily').get().n, 2);
  const s = await summary(db, 30, T0 + 260);
  assert.deepEqual(s.now, { active: 2, idle: 0, room: 1, call: 1 });
  assert.equal(s.wau, 2); assert.equal(s.mau, 2); assert.equal(s.total, 2);
  assert.deepEqual(s.dailyActive, [{ day: '2026-10-22', n: 2 }]);
  assert.deepEqual(s.versions.map((v) => [v.app, v.n]).sort(), [['0.1.0', 1], ['0.2.0', 1]]);
  assert.deepEqual(s.systems.map((v) => [v.os, v.n]).sort(), [['mac', 1], ['win', 1]]);
  const c = Object.fromEntries(s.counters.map((r) => [r.name, r.n]));
  assert.deepEqual(c, { room_created: 1, call_started: 1 });
  const later = await summary(db, 30, T0 + 10 * 60);       // 10 min depois, ninguém avisou: "agora" zera
  assert.equal(later.now.active, 0);
  assert.match(csv(s), /^tipo,dia,nome,chave,valor\nativos,2026-10-22,,,2\n/);
});

test('contadores somam por dia e por chave; dias diferentes ficam separados', async () => {
  const db = makeDb(), env = { DB: db };
  for (let i = 0; i < 3; i++) await post(env, { ...base, ev: { n: 'route', k: 'srflx' } }, { now: T0 + i, ip: '198.51.100.' + i });
  await post(env, { ...base, ev: { n: 'route', k: 'relay' } }, { now: T0 + 5, ip: '198.51.100.9' });
  await post(env, { ...base, ev: { n: 'route', k: 'srflx' } }, { now: T0 + 86400, ip: '198.51.100.10' });
  const s = await summary(db, 30, T0 + 86400 + 10);
  const get2 = (d, k) => s.counters.find((r) => r.day === d && r.key === k)?.n;
  assert.equal(get2('2026-10-22', 'srflx'), 3); assert.equal(get2('2026-10-22', 'relay'), 1); assert.equal(get2('2026-10-23', 'srflx'), 1);
  assert.equal(s.dailyActive.length, 2);
});

test('nada que identifique a pessoa é gravado: o IP de origem não aparece em nenhuma tabela', async () => {
  const db = makeDb(), env = { DB: db };
  await post(env, { ...base, ev: { n: 'voice_failed' } }, { ip: '203.0.113.77' });
  const dump = ['installs', 'daily', 'counters'].map((t) => JSON.stringify(db.raw.prepare(`SELECT * FROM ${t}`).all())).join('|');
  assert.equal(dump.includes('203.0.113.77'), false);
  assert.deepEqual(db.raw.prepare('SELECT name FROM pragma_table_info(?)').all('installs').map((r) => r.name), ['id', 'first_seen', 'last_seen', 'app', 'os', 'state', 'state_ts']);
});

test('aviso inválido, grande demais ou com método errado é recusado; OPTIONS responde CORS; limite de taxa por IP', async () => {
  const db = makeDb(), env = { DB: db };
  assert.equal((await post(env, null, { raw: 'não é json' })).status, 400);
  assert.equal((await post(env, { ...base, os: 'ios' })).status, 400);
  assert.equal((await post(env, null, { raw: JSON.stringify({ ...base, pad: 'x'.repeat(2000) }) })).status, 413);
  assert.equal((await handle(new Request('https://stats.example/v1/ping', { method: 'GET' }), env, T0)).status, 405);
  const pre = await handle(new Request('https://stats.example/v1/ping', { method: 'OPTIONS' }), env, T0);
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM installs').get().n, 0, 'nada gravado nos casos inválidos');
  let last;
  for (let i = 0; i < 35; i++) last = await post(env, { ...base }, { ip: '192.0.2.50', now: T0 + 1000 });
  assert.equal(last.status, 429);
  assert.equal((await post(env, { ...base }, { ip: '192.0.2.51', now: T0 + 1000 })).status, 200, 'outro IP não é afetado');
  assert.equal((await post(env, { ...base }, { ip: '192.0.2.50', now: T0 + 1100 })).status, 200, 'a janela de 60 s zera');
});

test('painel e API exigem a senha; sem PANEL_PASSWORD configurada o painel não abre', async () => {
  const db = makeDb();
  assert.equal((await get({ DB: db }, '/', 'qualquer')).status, 503);
  const env = { DB: db, PANEL_PASSWORD: 'senha-secreta-123' };
  const anon = await get(env, '/');
  assert.equal(anon.status, 401); assert.match(anon.headers.get('WWW-Authenticate'), /Basic/);
  assert.equal((await get(env, '/', 'errada')).status, 401);
  assert.equal((await get(env, '/api/summary', 'errada')).status, 401);
  assert.equal((await get(env, '/api/export.csv')).status, 401);
  const page = await get(env, '/', 'senha-secreta-123');
  assert.equal(page.status, 200); assert.match(await page.text(), /Dalari Cine/);
  assert.match(page.headers.get('Content-Security-Policy'), /default-src 'none'/);
  const api = await get(env, '/api/summary?days=7', 'senha-secreta-123');
  assert.equal(api.status, 200); const s = await api.json(); assert.equal(s.days, 7); assert.equal(s.now.active, 0);
  const days999 = await (await get(env, '/api/summary?days=999', 'senha-secreta-123')).json(); assert.equal(days999.days, 90);
  const file = await get(env, '/api/export.csv', 'senha-secreta-123');
  assert.equal(file.status, 200); assert.match(file.headers.get('Content-Type'), /csv/);
  assert.equal((await get(env, '/nada', 'senha-secreta-123')).status, 404);
  assert.equal((await handle(new Request('https://stats.example/api/summary', { method: 'POST', headers: { Authorization: 'Basic ' + btoa('x:senha-secreta-123') } }), env, T0)).status, 405);
});

test('eventos novos do funil e da qualidade são aceitos só com as chaves permitidas', () => {
  const ok = [['pair_code', ''], ['pair_try', ''], ['pair_found', ''], ['pair_open', ''], ['pair_joined', ''], ['pair_fail', 'timeout'], ['pair_fail', 'link'], ['pair_fail', 'join'], ['pair_fail', 'relay'], ['voice_quality', 'good'], ['voice_quality', 'fair'], ['voice_quality', 'poor'], ['connect_time', '<3s'], ['connect_time', '3-10s'], ['connect_time', '>10s']];
  for (const [n, k] of ok) assert.ok(validatePing({ ...base, ev: k ? { n, k } : { n } }), n + ' ' + k);
  const bad = [['pair_fail', ''], ['pair_fail', 'x'], ['pair_fail', 'Convidada Larissa'], ['voice_quality', 'great'], ['connect_time', '5s'], ['pair_code', 'x'], ['constructor', ''], ['__proto__', ''], ['toString', '']];
  for (const [n, k] of bad) assert.equal(validatePing({ ...base, ev: { n, k } }), null, n + ' ' + k);
});

test('horários: uma linha por instalação por hora; o resumo devolve pessoas por dia e hora (UTC)', async () => {
  const db = makeDb(), env = { DB: db };
  const h = (hh, mm = 0) => Date.UTC(2026, 9, 22, hh, mm) / 1000;
  await post(env, base, { now: h(10, 0), ip: '198.51.100.1' }); await post(env, base, { now: h(10, 30), ip: '198.51.100.2' }); await post(env, base, { now: h(11, 5), ip: '198.51.100.3' });
  await post(env, { ...base, id: 'ZyXwVuTsRqPoNmLkJiHg99' }, { now: h(10, 40), ip: '198.51.100.4' });
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM hourly').get().n, 3);
  const s = await summary(db, 7, h(12));
  assert.deepEqual(s.hourly.slice().sort((a, b) => a.hour - b.hour), [{ day: '2026-10-22', hour: 10, n: 2 }, { day: '2026-10-22', hour: 11, n: 1 }]);
});

test('retenção por semana de entrada: voltou no dia seguinte (d1) e nos 7 dias seguintes (w1); coortes recentes ficam de fora', async () => {
  const db = makeDb(), env = { DB: db };
  const day0 = T0 - 20 * 86400;
  const A = 'AAAAAAAAAAAAAAAAAAAAAA', B = 'BBBBBBBBBBBBBBBBBBBBBB', C = 'CCCCCCCCCCCCCCCCCCCCCC', D = 'DDDDDDDDDDDDDDDDDDDDDD';
  let ip = 1; const ping = (id, now) => post(env, { ...base, id }, { now, ip: '203.0.113.' + ip++ });
  await ping(A, day0); await ping(A, day0 + 86400); await ping(A, day0 + 3 * 86400);          // A: d1 e w1
  await ping(B, day0); await ping(B, day0 + 5 * 86400);                                         // B: só w1
  await ping(C, day0);                                                                          // C: não voltou
  await ping(D, T0 - 3 * 86400); await ping(D, T0 - 2 * 86400);                                 // D: coorte recente, fora do cálculo
  const s = await summary(db, 30, T0);
  assert.equal(s.retention.length, 1);
  assert.deepEqual({ size: s.retention[0].size, d1: s.retention[0].d1, w1: s.retention[0].w1 }, { size: 3, d1: 1, w1: 2 });
  assert.match(s.retention[0].start, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(csv(s), /ativos_hora_utc/);
});

test('erros do app: só as categorias fixas passam; texto livre, mensagens e chaves desconhecidas são recusados', () => {
  const base = { v: 1, id: 'a'.repeat(22), app: '0.3.0', os: 'win', state: 'idle' };
  for (const k of ['mic_denied', 'mic_missing', 'mic_busy', 'mic_insecure', 'player_fail', 'room_lost', 'update_fail', 'unexpected']) {
    assert.deepEqual(validatePing({ ...base, ev: { n: 'app_error', k } }).ev, { n: 'app_error', k });
  }
  for (const k of ['TypeError: x is undefined', 'C:\Users\Daniel\app.js', '', 'mic', 'MIC_DENIED', 5, null]) {
    assert.equal(validatePing({ ...base, ev: { n: 'app_error', k } }), null, String(k));
  }
  assert.equal(validatePing({ ...base, ev: { n: 'app_error', k: 'unexpected', message: 'boom' } }), null, 'sem campos extras no evento');
});
