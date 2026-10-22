import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../src/index.js';
import { commandReply, handleTelegramWebhook, nowText, todayText, errorsText } from '../src/alerts.js';

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
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0) / 1000;
const TODAY = '2026-10-22';
const ENV = { TELEGRAM_BOT_TOKEN: '123:SEGREDO', TELEGRAM_CHAT_ID: '42', TELEGRAM_WEBHOOK_SECRET: 'segredo-do-webhook', PANEL_URL: 'https://painel.example' };
const fakeFetch = () => { const calls = []; const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }; f.calls = calls; return f; };

function seed(db) {
  const ins = db.raw.prepare('INSERT INTO installs (id, first_seen, last_seen, app, os, state, state_ts) VALUES (?,?,?,?,?,?,?)');
  ins.run('a'.repeat(22), T0 - 86400 * 3, T0 - 60, '0.3.0', 'win', 'idle', T0 - 60);
  ins.run('b'.repeat(22), T0 - 86400 * 3, T0 - 120, '0.3.0', 'win', 'room', T0 - 120);
  ins.run('c'.repeat(22), T0 - 86400 * 3, T0 - 200, '0.3.0', 'mac', 'call', T0 - 200);
  ins.run('d'.repeat(22), T0 - 86400 * 3, T0 - 4000, '0.2.5', 'win', 'idle', T0 - 4000);   // fora da janela de 5 min
  for (const id of ['a', 'b', 'c']) db.raw.prepare('INSERT INTO daily (day, id) VALUES (?,?)').run(TODAY, id.repeat(22));
  const put = (name, key, n) => db.raw.prepare('INSERT INTO counters (day, name, key, n) VALUES (?,?,?,?)').run(TODAY, name, key, n);
  put('room_created', '', 4); put('call_started', '', 3); put('pair_try', '', 5); put('pair_joined', '', 4); put('voice_failed', '', 1);
  put('app_error', 'mic_denied', 2); put('app_error', 'unexpected', 1);
}
const request = (body, secret = ENV.TELEGRAM_WEBHOOK_SECRET) => new Request('https://stats.example/v1/telegram', { method: 'POST', headers: secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body) });
const message = (text, chat = 42) => ({ update_id: 1, message: { message_id: 1, chat: { id: chat }, text } });

test('/agora mostra quem está com o app aberto neste momento (últimos 5 min) e o resumo de hoje', async () => {
  const db = makeDb(); seed(db);
  const text = await commandReply({ ...ENV, DB: db }, '/agora', T0);
  assert.match(text, /Com o app aberto: 3 · em sala: 1 · em chamada: 1/, 'a instalação de 4000 s atrás não conta como agora');
  assert.match(text, /Pessoas ativas: 3 · salas criadas: 4 · chamadas iniciadas: 3/);
  assert.match(text, /Pareamento: 4 de 5 chegaram à sala \(80%\)/);
  assert.match(text, /Falhas de voz: 1 · erros do app: 3/);
  assert.match(text, /painel\.example/);
  assert.match(nowText({ now: { active: 0, room: 0, call: 0 }, counters: [], dailyActive: [] }), /Com o app aberto: 0/);
});

test('/hoje, /semana, /erros e /ajuda; comando com @bot, maiúsculas e argumentos; comando desconhecido devolve null', async () => {
  const db = makeDb(); seed(db);
  const env = { ...ENV, DB: db };
  const hoje = await commandReply(env, '/hoje', T0);
  assert.match(hoje, /room_created: 4/);
  assert.match(hoje, /app_error \[mic_denied\]: 2/);
  assert.match(await commandReply(env, '/semana', T0), /resumo da semana/);
  const erros = await commandReply(env, '/erros', T0);
  assert.match(erros, /Hoje: mic_denied 2, unexpected 1/);
  assert.match(erros, /Semana: mic_denied 2, unexpected 1/);
  assert.match(await commandReply(env, '/ajuda', T0), /\/agora/);
  assert.match(await commandReply(env, '/start', T0), /Comandos do Dalari Cine/);
  assert.match(await commandReply(env, '/AGORA@MeuBot extra', T0), /Agora/);
  for (const other of ['oi', '', '/apagar', '/agoras', undefined]) assert.equal(await commandReply(env, other, T0), null, String(other));
  assert.match(todayText({ counters: [] }), /ainda não chegou/);
  assert.match(errorsText({ counters: [] }, { counters: [] }), /Hoje: nenhum/);
});

test('webhook: só o cabeçalho secreto certo e só o seu chat; o resto é recusado ou ignorado', async () => {
  const db = makeDb(); seed(db);
  const env = { ...ENV, DB: db };
  const f = fakeFetch();
  assert.deepEqual(await handleTelegramWebhook(request(message('/agora'), 'errado'), env, T0, f), { status: 401 });
  assert.deepEqual(await handleTelegramWebhook(request(message('/agora'), null), env, T0, f), { status: 401 });
  assert.equal(f.calls.length, 0, 'sem o segredo nada é respondido');
  const stranger = await handleTelegramWebhook(request(message('/agora', 999)), env, T0, f);
  assert.deepEqual(stranger, { status: 200, ignored: true });
  assert.equal(f.calls.length, 0, 'outro chat não recebe os números');
  assert.deepEqual(await handleTelegramWebhook(request({ update_id: 2, edited_message: {} }), env, T0, f), { status: 200, ignored: true });
  assert.deepEqual(await handleTelegramWebhook(request(message('bom dia')), env, T0, f), { status: 200, ignored: true });
  const ok = await handleTelegramWebhook(request(message('/agora')), env, T0, f);
  assert.deepEqual(ok, { status: 200, replied: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.chat_id, '42');
  assert.match(f.calls[0].body.text, /Com o app aberto: 3/);
  assert.equal((await handleTelegramWebhook(new Request('https://stats.example/v1/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': ENV.TELEGRAM_WEBHOOK_SECRET }, body: 'não é json' }), env, T0, f)).status, 400);
});

test('webhook desligado sem os três segredos; a rota só aceita POST', async () => {
  const db = makeDb();
  for (const missing of ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    const env = { ...ENV, DB: db }; delete env[missing];
    assert.equal((await handleTelegramWebhook(request(message('/agora')), env, T0, fakeFetch())).status, 503, missing);
  }
  const get = await handle(new Request('https://stats.example/v1/telegram'), { ...ENV, DB: db }, T0);
  assert.equal(get.status, 405);
  const f = fakeFetch(); const original = globalThis.fetch; globalThis.fetch = f;
  try {
    seed(db);
    const res = await handle(request(message('/agora')), { ...ENV, DB: db }, T0);
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 1);
    const denied = await handle(request(message('/agora'), 'errado'), { ...ENV, DB: db }, T0);
    assert.equal(denied.status, 401);
    assert.equal(f.calls.length, 1);
  } finally { globalThis.fetch = original; }
});
