import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../src/index.js';
import { evaluate, weeklyText, sendTelegram, runScheduled, WEEKLY_CRON, COOLDOWN_S } from '../src/alerts.js';
import { KEYBOARD } from '../src/format.js';

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
const put = (db, name, key, n, d = TODAY) => db.raw.prepare('INSERT INTO counters (day, name, key, n) VALUES (?,?,?,?) ON CONFLICT(day,name,key) DO UPDATE SET n = n + ?').run(d, name, key, n, n);
const rows = (list) => list.map(([name, key, n]) => ({ name, key, n }));
const ENV = { TELEGRAM_BOT_TOKEN: '123:SEGREDO', TELEGRAM_CHAT_ID: '42', PANEL_URL: 'https://painel.example' };
const fakeFetch = (status = 200) => { const calls = []; const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status }); }; f.calls = calls; return f; };

test('alertas: abaixo dos limites nada; acima, um aviso por tipo, com os números, o motivo e o que fazer', () => {
  assert.deepEqual(evaluate([]), []);
  assert.deepEqual(evaluate(rows([['pair_try', '', 4], ['pair_fail', 'timeout', 4]])), [], 'poucas tentativas não alarmam');
  assert.deepEqual(evaluate(rows([['pair_try', '', 10], ['pair_fail', 'timeout', 3]])), [], '30% está abaixo de 40%');
  const pair = evaluate(rows([['pair_try', '', 10], ['pair_fail', 'timeout', 3], ['pair_fail', 'relay', 2]]));
  assert.equal(pair.length, 1);
  assert.equal(pair[0].kind, 'pair_fail_rate');
  const t = plain(pair[0].text);
  assert.match(t, /^🔴 Pareamento falhando\n5 de 10 tentativas falharam hoje \(50%\)\./);
  assert.match(t, /o Host não respondeu a tempo \(3\), o serviço de encontro está fora \(2\)/, 'motivos em português, não códigos');
  assert.match(t, /👉 O que fazer:/);
  assert.doesNotMatch(t, /pair_fail|timeout|relay /, 'nada de nomes internos');
  assert.deepEqual(evaluate(rows([['call_started', '', 10], ['voice_failed', '', 4]])).map((a) => a.kind), ['voice_fail_rate']);
  assert.deepEqual(evaluate(rows([['voice_failed', '', 8]])).map((a) => a.kind), ['voice_fail_rate']);
  assert.deepEqual(evaluate(rows([['voice_quality', 'poor', 3], ['voice_quality', 'good', 2]])).map((a) => a.kind), ['voice_poor']);
  const errs = evaluate(rows([['app_error', 'mic_denied', 6], ['app_error', 'unexpected', 1]]));
  assert.equal(errs[0].kind, 'app_errors');
  assert.match(plain(errs[0].text), /microfone bloqueado \(6\), erro inesperado no app \(1\)/);
  assert.equal(evaluate(rows([['app_error', 'mic_denied', 4], ['app_error', 'room_lost', 4]])).length, 0);
  assert.equal(evaluate(rows([['app_error', 'a', 4], ['app_error', 'b', 4], ['app_error', 'c', 2]])).length, 1);
});

test('cada aviso cabe numa tela curta: no máximo 6 linhas, sem texto longo', () => {
  const all = evaluate(rows([['pair_try', '', 10], ['pair_fail', 'timeout', 6], ['call_started', '', 10], ['voice_failed', '', 9], ['voice_quality', 'poor', 5], ['app_error', 'mic_denied', 12]]));
  assert.equal(all.length, 4);
  for (const a of all) {
    const lines = plain(a.text).split('\n').filter(Boolean);
    assert.ok(lines.length <= 6, a.kind + ': ' + lines.length + ' linhas');
    assert.ok(plain(a.text).length < 400, a.kind + ' é curto');
  }
});

test('resumo da semana: pessoas, salas, pareamento, qualidade, erros e versões, em linhas curtas', () => {
  const text = plain(weeklyText({
    wau: 7, total: 20, newByDay: [{ day: TODAY, n: 3 }, { day: '2026-10-21', n: 2 }],
    versions: [{ app: '0.3.0', n: 5 }, { app: '0.2.5', n: 2 }],
    counters: rows([['room_created', '', 9], ['call_started', '', 6], ['pair_try', '', 10], ['pair_joined', '', 8], ['voice_quality', 'good', 3], ['voice_quality', 'poor', 1], ['voice_failed', '', 2], ['app_error', 'mic_denied', 4]]),
  }, 'https://painel.example'));
  assert.match(text, /Resumo da semana/);
  assert.match(text, /7 pessoas usaram · 🆕 5 novas · total 20/);
  assert.match(text, /9 salas · 📞 6 chamadas/);
  assert.match(text, /80% chegaram à sala \(8 de 10\)/);
  assert.match(text, /75% boa · 0% média · 25% ruim/);
  assert.match(text, /2 falhas de voz · 4 erros do app/);
  assert.match(text, /0\.3\.0 \(5\), 0\.2\.5 \(2\)/);
  assert.match(text, /https:\/\/painel\.example$/);
  assert.match(plain(weeklyText({ counters: [], newByDay: [], versions: [] })), /Pareamento: sem tentativas/);
});

test('Telegram: sem segredos não envia; envia em HTML com o teclado de botões; falha de rede não lança nem vaza o token', async () => {
  assert.deepEqual(await sendTelegram({}, 'oi'), { ok: false, skipped: 'not_configured' });
  const f = fakeFetch();
  assert.equal((await sendTelegram(ENV, '<b>olá</b>', f)).ok, true);
  assert.equal(f.calls[0].url, 'https://api.telegram.org/bot123:SEGREDO/sendMessage');
  assert.deepEqual(f.calls[0].body, { chat_id: '42', disable_web_page_preview: true, reply_markup: KEYBOARD, text: '<b>olá</b>', parse_mode: 'HTML' });
  assert.equal(KEYBOARD.is_persistent, true);
  assert.equal(KEYBOARD.keyboard.length, 4, 'quatro linhas de botões');
  assert.ok(KEYBOARD.keyboard.every((row) => row.length === 2), 'dois botões por linha: fáceis de tocar');
  const err = await sendTelegram(ENV, 'x', async () => { throw new Error('falha com https://api.telegram.org/bot123:SEGREDO/sendMessage'); });
  assert.deepEqual(err, { ok: false, error: 'network' });
  assert.equal(JSON.stringify(err).includes('SEGREDO'), false);
  assert.equal((await sendTelegram(ENV, 'x'.repeat(9000), f)).ok, true);
  assert.equal(f.calls.at(-1).body.text.length, 3800, 'mensagem longa é cortada');
  const none = fakeFetch(); await sendTelegram(ENV, 'sem teclado', none, { keyboard: false });
  assert.equal('reply_markup' in none.calls[0].body, false);
});

test('se o Telegram recusar o HTML, reenvia como texto simples (o aviso nunca se perde)', async () => {
  const calls = [];
  const f = async (url, init) => { const body = JSON.parse(init.body); calls.push(body); return new Response('{}', { status: body.parse_mode ? 400 : 200 }); };
  const r = await sendTelegram(ENV, '<b>Menos de 3 &lt; 5 &amp; mais</b>', f);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parse_mode, 'HTML');
  assert.equal('parse_mode' in calls[1], false);
  assert.equal(calls[1].text, 'Menos de 3 < 5 & mais');
});

test('agendamento: avisa uma vez, respeita o intervalo de 6 h, reenvia depois e não grava se o envio falhou', async () => {
  const db = makeDb();
  put(db, 'pair_try', '', 10); put(db, 'pair_fail', 'timeout', 6);
  const env = { ...ENV, DB: db };
  const f = fakeFetch();
  assert.deepEqual((await runScheduled(env, '*/30 * * * *', T0, f)).sent, ['pair_fail_rate']);
  assert.match(f.calls[0].body.text, /Pareamento falhando/);
  assert.match(f.calls[0].body.text, /painel\.example/);
  assert.deepEqual((await runScheduled(env, '*/30 * * * *', T0 + 1800, f)).sent, [], 'meia hora depois: ainda no intervalo');
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await runScheduled(env, '*/30 * * * *', T0 + COOLDOWN_S + 1, f)).sent, ['pair_fail_rate']);
  const down = makeDb(); put(down, 'pair_try', '', 10); put(down, 'pair_fail', 'link', 6);
  const bad = await runScheduled({ ...ENV, DB: down }, '*/30 * * * *', T0, fakeFetch(500));
  assert.deepEqual(bad, { sent: [], failed: ['pair_fail_rate'] });
  assert.equal((await down.prepare('SELECT COUNT(*) AS n FROM alerts').bind().first()).n, 0, 'falha de envio não consome o intervalo');
  assert.deepEqual((await runScheduled({ ...ENV, DB: down }, '*/30 * * * *', T0 + 60, fakeFetch())).sent, ['pair_fail_rate']);
});

test('agendamento: contadores de outro dia não contam; sem segredos nada acontece; segunda-feira manda o resumo', async () => {
  const db = makeDb();
  put(db, 'pair_try', '', 10, '2026-10-21'); put(db, 'pair_fail', 'timeout', 9, '2026-10-21');
  const f = fakeFetch();
  assert.deepEqual((await runScheduled({ ...ENV, DB: db }, '*/30 * * * *', T0, f)).sent, [], 'só vale o dia de hoje (UTC)');
  assert.deepEqual(await runScheduled({ DB: db }, '*/30 * * * *', T0, f), { skipped: 'not_configured', sent: [] });
  assert.equal(f.calls.length, 0);
  const r = await runScheduled({ ...ENV, DB: db }, WEEKLY_CRON, T0, f);
  assert.deepEqual(r.sent, ['weekly']);
  assert.match(f.calls[0].body.text, /Resumo da semana/);
});

test('/api/alert-test: exige senha e POST; sem Telegram configurado responde 409; configurado manda a mensagem', async () => {
  const db = makeDb();
  const call = (env, { method = 'POST', password } = {}) => handle(new Request('https://stats.example/api/alert-test', { method, headers: password === undefined ? {} : { Authorization: 'Basic ' + btoa('x:' + password) } }), env, T0);
  assert.equal((await call({ DB: db, PANEL_PASSWORD: 'segredo' })).status, 401);
  assert.equal((await call({ DB: db, PANEL_PASSWORD: 'segredo' }, { password: 'errada' })).status, 401);
  assert.equal((await call({ DB: db, PANEL_PASSWORD: 'segredo' }, { method: 'GET', password: 'segredo' })).status, 405);
  assert.equal((await call({ DB: db }, { password: 'x' })).status, 503);
  assert.equal((await call({ DB: db, PANEL_PASSWORD: 'segredo' }, { password: 'segredo' })).status, 409);
  const f = fakeFetch(); const original = globalThis.fetch; globalThis.fetch = f;
  try {
    const ok = await call({ DB: db, PANEL_PASSWORD: 'segredo', ...ENV }, { password: 'segredo' });
    assert.equal(ok.status, 200);
    assert.match(f.calls[0].body.text, /Teste do Dalari Cine/);
  } finally { globalThis.fetch = original; }
});

test('o agendamento está ligado no wrangler.toml e a tabela de avisos existe no schema', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /crons = \["\*\/30 \* \* \* \*", "0 12 \* \* 1", "0 1 \* \* \*"\]/);
  assert.equal(WEEKLY_CRON, '0 12 * * 1');
  assert.match(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'), /CREATE TABLE IF NOT EXISTS alerts/);
});
