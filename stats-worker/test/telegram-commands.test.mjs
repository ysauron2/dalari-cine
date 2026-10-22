import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../src/index.js';
import { commandReply, handleTelegramWebhook } from '../src/alerts.js';
import { commandFromText, BUTTONS } from '../src/format.js';
import { statusText, nowText, todayText, errorsText, versionsText, helpText, health } from '../src/messages.js';

const plain = (t) => String(t).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

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

test('botões e comandos: tocar num botão, digitar o comando ou uma palavra simples dá o mesmo resultado', () => {
  assert.equal(BUTTONS.length, 8);
  for (const [label, cmd] of BUTTONS) assert.equal(commandFromText(label), cmd, label);
  for (const [text, cmd] of [['/AGORA@MeuBot extra', '/agora'], ['agora', '/agora'], ['Está tudo bem?', '/status'], ['tudo bem', '/status'], ['STATUS', '/status'], ['erros', '/erros'], ['  /hoje  ', '/hoje'], ['oi', '/ajuda'], ['menu', '/ajuda'], ['versões', '/versoes']]) assert.equal(commandFromText(text), cmd, text);
  for (const none of ['bom dia', '', '   ', null, undefined, 'apagar tudo']) assert.equal(commandFromText(none), null, String(none));
});

test('"Está tudo bem?": veredito primeiro (verde, amarelo ou vermelho) e só o que fazer a seguir', async () => {
  const db = makeDb(); seed(db);
  const t = plain(await commandReply({ ...ENV, DB: db }, '🚦 Está tudo bem?', T0));
  const lines = t.split('\n');
  assert.equal(lines[0], '🚦 Está tudo bem?');
  assert.equal(lines[2], '🟡 Atenção — 1 ponto para olhar', 'o veredito vem na terceira linha, antes de qualquer número');
  assert.match(t, /👥 Agora: 3 pessoas com o app aberto/, 'a instalação de 4000 s atrás não conta como agora');
  assert.match(t, /🟢 Pareamento: 4 de 5 chegaram à sala \(80%\)/);
  assert.match(t, /⚪ Voz: 3 chamadas hoje \(pouco para avaliar\)/);
  assert.match(t, /🟡 Erros do app: 3 \(mais comum: microfone bloqueado\)/);
  assert.match(t, /👉 O que fazer\n• Toque em 🚨 Erros: lá explico cada tipo\./);
  assert.ok(lines.length <= 16, 'cabe numa tela: ' + lines.length);
  assert.doesNotMatch(t, /mic_denied|pair_|app_error/, 'nada de nomes internos');
});

test('veredito: tudo certo vira verde com "nada por agora"; problema vira vermelho e as dicas vêm do pior para o menor, no máximo 3', () => {
  const day = (counters, now = { active: 2, room: 1, call: 0 }) => ({ now, counters, dailyActive: [{ day: TODAY, n: 2 }] });
  const rows = (list) => list.map(([name, key, n]) => ({ name, key, n }));
  const ok = statusText(day(rows([['pair_try', '', 10], ['pair_joined', '', 10]])), null, '');
  assert.match(plain(ok), /^🚦 Está tudo bem\?\n\n🟢 Tudo certo\n/);
  assert.match(plain(ok), /Nada por agora\. 👍/);
  const bad = plain(statusText(day(rows([['pair_try', '', 10], ['pair_fail', 'timeout', 5], ['call_started', '', 10], ['voice_failed', '', 6], ['voice_quality', 'poor', 5], ['app_error', 'mic_denied', 12]])), null, ''));
  assert.match(bad, /🔴 Problema — 4 pontos para olhar/);
  assert.equal((bad.match(/^• /gm) || []).length, 3, 'no máximo 3 dicas');
  assert.equal(health(day([])).level, 'ok');
  assert.equal(health(day(rows([['app_error', 'unexpected', 1]]))).level, 'warn');
  assert.equal(health(day(rows([['app_error', 'unexpected', 5]]))).level, 'bad');
  const cfBad = health(day([]), { configured: true, workers: { requests: 75000 }, d1: { rowsWritten: 0, rowsRead: 0, hasRows: true } });
  assert.equal(cfBad.level, 'bad');
  assert.match(cfBad.items.at(-1).text, /Cloudflare: 75% do limite grátis usado hoje/);
});

test('/agora e /hoje: linguagem simples, só o que aconteceu, números agrupados', async () => {
  const db = makeDb(); seed(db);
  const env = { ...ENV, DB: db };
  const agora = plain(await commandReply(env, '/agora', T0));
  assert.match(agora, /3 pessoas com o app aberto\n🎬 1 numa sala · 🎙 1 numa chamada/);
  assert.match(agora, /👤 3 pessoas usaram\n🎬 4 salas · 📞 3 chamadas/);
  assert.match(agora, /🔗 Pareamento: 4 de 5 entraram na sala \(80%\)/);
  assert.match(agora, /🐞 Problemas: 1 de voz · 3 erros do app/);
  assert.match(plain(nowText({ now: { active: 0, room: 0, call: 0 }, counters: [], dailyActive: [] })), /Ninguém com o app aberto agora\./);
  const hoje = plain(await commandReply(env, '/hoje', T0));
  assert.match(hoje, /🏠 Uso\n• Salas criadas: 4\n• Chamadas iniciadas: 3/);
  assert.match(hoje, /🐞 Erros do app\n• Erros do app: 3\n {3}↳ microfone bloqueado: 2\n {3}↳ erro inesperado no app: 1/);
  assert.doesNotMatch(hoje, /room_created|call_started|mic_denied/);
  assert.match(plain(todayText({ counters: [] })), /Ainda nada hoje\./);
});

test('/semana, /erros, /versoes e /ajuda explicam em português e dizem o que fazer', async () => {
  const db = makeDb(); seed(db);
  const env = { ...ENV, DB: db };
  assert.match(plain(await commandReply(env, '/semana', T0)), /Resumo da semana[\s\S]*3 pessoas usaram[\s\S]*80% chegaram à sala \(4 de 5\)/);
  const erros = plain(await commandReply(env, '/erros', T0));
  assert.match(erros, /Hoje: 3 · Semana: 3/);
  assert.match(erros, /• microfone bloqueado: 2 na semana \(2 hoje\)\n {3}💡 A pessoa negou a permissão\./);
  assert.match(erros, /• erro inesperado no app: 1 na semana \(1 hoje\)\n {3}💡 Provável bug\./);
  assert.match(plain(errorsText({ counters: [] }, { counters: [] })), /Nenhum erro nos últimos 7 dias\. 🎉/);
  const versoes = plain(await commandReply(env, '/versoes', T0));
  assert.match(versoes, /▓{10} 0\.3\.0 · 3 \(75%\)/);
  assert.match(versoes, /▓{3}░{7} 0\.2\.5 · 1 \(25%\)/);
  assert.match(plain(versionsText({ versions: [] })), /Nenhum dado ainda\./);
  const ajuda = plain(helpText());
  for (const c of ['/status', '/agora', '/hoje', '/semana', '/erros', '/cloudflare', '/versoes']) assert.match(ajuda, new RegExp(c), c);
  assert.match(ajuda, /comece por aqui/);
  assert.match(plain(await commandReply(env, '/start', T0)), /Comece por 🚦 Está tudo bem\?/);
  assert.equal(await commandReply(env, 'bom dia', T0), null);
});

test('texto com < ou & vindo dos dados não quebra o HTML do Telegram', async () => {
  const db = makeDb(); seed(db);
  db.raw.prepare('INSERT INTO counters (day, name, key, n) VALUES (?,?,?,?)').run(TODAY, 'connect_time', '<3s', 2);
  const html = await commandReply({ ...ENV, DB: db }, '/hoje', T0);
  assert.doesNotMatch(html, /menos de 3 s.*</);
  assert.match(html, /menos de 3 s/);
  const odd = versionsText({ versions: [{ app: '1.0<b>', n: 1 }] });
  assert.match(odd, /1\.0&lt;b&gt;/);
});

test('webhook: só o cabeçalho secreto certo e só o seu chat; texto estranho do dono ganha uma dica, o resto é ignorado', async () => {
  const db = makeDb(); seed(db);
  const env = { ...ENV, DB: db };
  const f = fakeFetch();
  assert.deepEqual(await handleTelegramWebhook(request(message('/agora'), 'errado'), env, T0, f), { status: 401 });
  assert.deepEqual(await handleTelegramWebhook(request(message('/agora'), null), env, T0, f), { status: 401 });
  assert.equal(f.calls.length, 0, 'sem o segredo nada é respondido');
  assert.deepEqual(await handleTelegramWebhook(request(message('/agora', 999)), env, T0, f), { status: 200, ignored: true });
  assert.equal(f.calls.length, 0, 'outro chat não recebe os números');
  assert.deepEqual(await handleTelegramWebhook(request({ update_id: 2, edited_message: {} }), env, T0, f), { status: 200, ignored: true });
  assert.deepEqual(await handleTelegramWebhook(request({ update_id: 3, message: { chat: { id: 42 }, sticker: {} } }), env, T0, f), { status: 200, ignored: true });
  const dica = await handleTelegramWebhook(request(message('bom dia')), env, T0, f);
  assert.deepEqual(dica, { status: 200, replied: true });
  assert.match(f.calls.at(-1).body.text, /Não entendi essa\./);
  assert.match(f.calls.at(-1).body.text, /botões embaixo/);
  const ok = await handleTelegramWebhook(request(message('👥 Agora')), env, T0, f);
  assert.deepEqual(ok, { status: 200, replied: true });
  const last = f.calls.at(-1).body;
  assert.equal(last.chat_id, '42');
  assert.equal(last.parse_mode, 'HTML');
  assert.equal(last.reply_markup.is_persistent, true, 'os botões continuam na tela');
  assert.match(plain(last.text), /3 pessoas com o app aberto/);
  assert.equal((await handleTelegramWebhook(new Request('https://stats.example/v1/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': ENV.TELEGRAM_WEBHOOK_SECRET }, body: 'não é json' }), env, T0, f)).status, 400);
});

test('webhook desligado sem os três segredos; a rota só aceita POST', async () => {
  const db = makeDb();
  for (const missing of ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    const env = { ...ENV, DB: db }; delete env[missing];
    assert.equal((await handleTelegramWebhook(request(message('/agora')), env, T0, fakeFetch())).status, 503, missing);
  }
  assert.equal((await handle(new Request('https://stats.example/v1/telegram'), { ...ENV, DB: db }, T0)).status, 405);
  const f = fakeFetch(); const original = globalThis.fetch; globalThis.fetch = f;
  try {
    seed(db);
    assert.equal((await handle(request(message('/status')), { ...ENV, DB: db }, T0)).status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal((await handle(request(message('/status'), 'errado'), { ...ENV, DB: db }, T0)).status, 401);
    assert.equal(f.calls.length, 1);
  } finally { globalThis.fetch = original; }
});
