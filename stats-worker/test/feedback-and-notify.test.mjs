import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle, recordPing } from '../src/index.js';
import { validateFeedback, feedbackText, resetFeedbackLimits, PER_IP_PER_HOUR, PER_DAY, MAX_MESSAGE } from '../src/feedback.js';
import { runScheduled, DAILY_CRON, notifyActivity } from '../src/alerts.js';
import { newInstallText, newVersionText, dailyText } from '../src/messages.js';

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
const ENV = { TELEGRAM_BOT_TOKEN: '123:SEGREDO', TELEGRAM_CHAT_ID: '42', PANEL_URL: 'https://painel.example' };
const fakeFetch = (status = 200) => { const calls = []; const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status }); }; f.calls = calls; return f; };
const base = { v: 1, kind: 'problema', message: 'A voz não conectou ontem à noite.', contact: 'larissa@exemplo.com', app: '0.3.1', os: 'win' };
const post = (env, body, { ip = '203.0.113.9', raw, now = T0, fetchImpl } = {}) => {
  const original = globalThis.fetch; if (fetchImpl) globalThis.fetch = fetchImpl;
  return handle(new Request('https://stats.example/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': ip }, body: raw ?? JSON.stringify(body) }), env, now).finally(() => { globalThis.fetch = original; });
};

test('feedback: aceita só o formato exato, limpa o texto e recusa o resto', () => {
  assert.deepEqual(validateFeedback(base), { kind: 'problema', message: 'A voz não conectou ontem à noite.', contact: 'larissa@exemplo.com', app: '0.3.1', os: 'win' });
  assert.deepEqual(validateFeedback({ v: 1, kind: 'ideia', message: '  uma ideia boa  ' }), { kind: 'ideia', message: 'uma ideia boa', contact: '', app: '', os: '' }, 'contato, versão e sistema são opcionais');
  const dirty = validateFeedback({ v: 1, kind: 'outro', message: 'oi\u0000\u0007 tudo\r\nbem ?', contact: 'a\nb' });
  assert.equal(dirty.message, 'oi tudo\nbem?', 'sem caracteres de controle; quebras normalizadas');
  assert.equal(dirty.contact, 'a b');
  const bad = [null, [], 'x', { ...base, v: 2 }, { ...base, extra: 1 }, { ...base, kind: 'xss' }, { ...base, kind: 5 }, { ...base, message: 'oi' }, { ...base, message: '   ' }, { ...base, message: 5 },
    { ...base, message: 'x'.repeat(MAX_MESSAGE + 1) }, { ...base, message: 'a\n'.repeat(40) }, { ...base, contact: 'x'.repeat(101) }, { ...base, contact: 5 }, { ...base, app: '1.0<script>' }, { ...base, os: 'beos' }, { ...base, app: 5 }];
  for (const b of bad) assert.equal(validateFeedback(b), null, JSON.stringify(b)?.slice(0, 60));
  assert.ok(validateFeedback({ ...base, message: 'x'.repeat(MAX_MESSAGE) }), 'exatamente no limite é aceito');
});

test('a mensagem no Telegram: tipo, sistema e versão no topo, o texto da pessoa sem formatação injetada', () => {
  const t = plain(feedbackText(validateFeedback(base)));
  assert.match(t, /^🐞 Problema — Windows · versão 0\.3\.1\n\nA voz não conectou ontem à noite\.\n\n📬 Contato: larissa@exemplo\.com$/);
  assert.match(plain(feedbackText(validateFeedback({ v: 1, kind: 'elogio', message: 'Amei o app!' }))), /^❤️ Elogio\n\nAmei o app!\n\n🤐 Sem contato \(não dá para responder\)\.$/);
  const html = feedbackText(validateFeedback({ ...base, message: '<b>oi</b> <a href="https://x.com">clique</a> & mais', contact: '<i>x</i>' }));
  assert.doesNotMatch(html, /<a |<i>/, 'a pessoa não injeta tags');
  assert.match(html, /&lt;b&gt;oi&lt;\/b&gt;/);
  assert.match(html, /&amp; mais/);
});

test('POST /v1/feedback: entrega no Telegram, conta o dia e responde ok; nada do texto fica no banco', async () => {
  resetFeedbackLimits();
  const db = makeDb(); const f = fakeFetch();
  const res = await post({ ...ENV, DB: db }, base, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.match(f.calls[0].body.text, /A voz não conectou ontem à noite\./);
  assert.equal(f.calls[0].body.chat_id, '42');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', 'o app, que roda em 127.0.0.1, consegue ler a resposta');
  assert.equal(db.raw.prepare("SELECT n FROM counters WHERE name = 'feedback_received'").get().n, 1);
  const everything = JSON.stringify([db.raw.prepare('SELECT * FROM counters').all(), db.raw.prepare('SELECT * FROM installs').all(), db.raw.prepare('SELECT * FROM alerts').all()]);
  assert.equal(everything.includes('ontem à noite') || everything.includes('larissa@exemplo.com'), false, 'a mensagem e o contato não são gravados');
});

test('feedback: respostas de erro claras (400, 413, 405, preflight, 429 por IP e por dia, 502, 503)', async () => {
  resetFeedbackLimits();
  const db = makeDb(); const env = { ...ENV, DB: db };
  assert.equal((await post(env, { ...base, kind: 'x' }, { fetchImpl: fakeFetch() })).status, 400);
  assert.equal((await post(env, null, { raw: 'não é json', fetchImpl: fakeFetch() })).status, 400);
  assert.equal((await post(env, null, { raw: 'x'.repeat(5000), fetchImpl: fakeFetch() })).status, 413);
  assert.equal((await handle(new Request('https://stats.example/v1/feedback'), env, T0)).status, 405);
  const pre = await handle(new Request('https://stats.example/v1/feedback', { method: 'OPTIONS' }), env, T0);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /POST/);

  const f = fakeFetch();
  for (let i = 0; i < PER_IP_PER_HOUR; i++) assert.equal((await post(env, base, { fetchImpl: f, ip: '198.51.100.1' })).status, 200);
  const limited = await post(env, base, { fetchImpl: f, ip: '198.51.100.1' });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, 'rate_limited');
  assert.equal((await post(env, base, { fetchImpl: f, ip: '198.51.100.2' })).status, 200, 'outra pessoa não é afetada');
  assert.equal((await post(env, base, { fetchImpl: f, ip: '198.51.100.1', now: T0 + 3700 })).status, 200, 'depois de uma hora libera');

  resetFeedbackLimits();
  db.raw.prepare("UPDATE counters SET n = ? WHERE name = 'feedback_received'").run(PER_DAY);
  const day = await post(env, base, { fetchImpl: f, ip: '198.51.100.9', now: T0 + 3700 });
  assert.equal(day.status, 429);
  assert.equal((await day.json()).error, 'daily_limit');

  resetFeedbackLimits();
  assert.equal((await post({ ...env, DB: makeDb() }, base, { fetchImpl: fakeFetch(500) })).status, 502, 'o Telegram recusou');
  resetFeedbackLimits();
  assert.equal((await post({ DB: makeDb() }, base, { fetchImpl: fakeFetch() })).status, 503, 'sem Telegram configurado');
});

test('nova instalação e primeira pessoa na versão: avisa uma vez, com o que mudou, sem identificar ninguém', async () => {
  const db = makeDb(); const f = fakeFetch(); const env = { ...ENV, DB: db };
  const ping = { id: 'A'.repeat(22), app: '0.3.0', os: 'win', state: 'idle' };
  const notify = async (p, now = T0) => { const info = await recordPing(db, p, now); const r = await notifyActivity(env, p, info, now, f); return { info, r }; };

  const first = await notify(ping);
  assert.deepEqual(first.info, { newInstall: true, previousApp: null, newVersion: true });
  assert.equal(first.r.kind, 'version', 'a primeira versão vista ganha o aviso de versão (que já diz "instalação nova")');
  assert.match(plain(f.calls[0].body.text), /^📦 Primeira pessoa na versão 0\.3\.0\nInstalação nova · Windows/);

  const again = await notify(ping, T0 + 120);
  assert.deepEqual(again.info, { newInstall: false, previousApp: null, newVersion: false });
  assert.equal(again.r.sent, false);
  assert.equal(f.calls.length, 1, 'repetir o aviso do app não manda nada');

  const second = await notify({ id: 'B'.repeat(22), app: '0.3.0', os: 'mac', state: 'idle' }, T0 + 200);
  assert.equal(second.r.kind, 'install');
  assert.match(plain(f.calls[1].body.text), /^🆕 Nova instalação\nmacOS · versão 0\.3\.0\n👥 Já são 2 no total \(2 novas hoje\)/);

  const update = await notify({ ...ping, app: '0.3.1' }, T0 + 400);
  assert.deepEqual(update.info, { newInstall: false, previousApp: '0.3.0', newVersion: true });
  assert.match(plain(f.calls[2].body.text), /^📦 Primeira pessoa na versão 0\.3\.1\nAtualizou da 0\.3\.0 · Windows/);
  const next = await notify({ id: 'B'.repeat(22), app: '0.3.1', os: 'mac', state: 'idle' }, T0 + 500);
  assert.equal(next.r.sent, false, 'a segunda pessoa na mesma versão não gera aviso');
  assert.equal(f.calls.length, 3);
  for (const c of f.calls) assert.equal(c.body.text.includes('AAAAAAAA'), false, 'o id da instalação nunca aparece');
});

test('muitas instalações no mesmo dia: depois de 10 avisos, só o resumo do dia conta; sem Telegram nada é enviado; erro de envio não derruba', async () => {
  const db = makeDb(); const f = fakeFetch(); const env = { ...ENV, DB: db };
  await recordPing(db, { id: 'Z'.repeat(22), app: '0.3.0', os: 'win', state: 'idle' }, T0 - 2 * 86400);   // instalada há dois dias: a versão já é conhecida e não conta como "nova hoje"
  let sent = 0;
  for (let i = 0; i < 14; i++) {
    const p = { id: 'x'.repeat(21) + String.fromCharCode(97 + i), app: '0.3.0', os: 'win', state: 'idle' };
    const info = await recordPing(db, p, T0 + i);
    if ((await notifyActivity(env, p, info, T0 + i, f)).sent) sent++;
  }
  assert.equal(sent, 10);
  const p = { id: 'q'.repeat(22), app: '0.3.0', os: 'win', state: 'idle' };
  const info = await recordPing(db, p, T0 + 30);
  assert.deepEqual(await notifyActivity({ DB: db }, p, info, T0 + 30, f), { sent: false });
  const p2 = { id: 'r'.repeat(22), app: '9.9.9', os: 'win', state: 'idle' };
  const info2 = await recordPing(db, p2, T0 + 40);
  assert.equal((await notifyActivity(env, p2, info2, T0 + 40, async () => { throw new Error('rede'); })).sent, false);
});

test('o aviso do app continua respondendo ok mesmo que o Telegram esteja fora', async () => {
  const db = makeDb(); const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error('rede'); };
  try {
    const res = await handle(new Request('https://stats.example/v1/ping', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ v: 1, id: 'C'.repeat(22), app: '0.3.0', os: 'win', state: 'idle' }) }), { ...ENV, DB: db }, T0);
    assert.equal(res.status, 200);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM installs').get().n, 1);
  } finally { globalThis.fetch = original; }
});

test('versões que já estavam em uso quando o banco foi atualizado não geram aviso (schema.sql as marca como vistas)', () => {
  const raw = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  raw.exec(schema);
  raw.prepare('INSERT INTO installs (id, first_seen, last_seen, app, os, state, state_ts) VALUES (?,?,?,?,?,?,?)').run('a'.repeat(22), 100, 200, '0.2.5', 'win', 'idle', 200);
  raw.prepare('DELETE FROM versions_seen').run();
  raw.exec(schema);                       // rodar o arquivo de novo (como no deploy) é seguro e preenche
  assert.equal(raw.prepare("SELECT first_seen FROM versions_seen WHERE app = '0.2.5'").get().first_seen, 100);
  raw.exec(schema);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM versions_seen').get().n, 1, 'idempotente');
});

test('resumo do dia (22h de Brasília): veredito, números do dia e só os pontos de atenção', async () => {
  const day = { now: { active: 1, room: 0, call: 0 }, dailyActive: [{ day: '2026-10-22', n: 5 }], newByDay: [{ day: '2026-10-22', n: 2 }],
    counters: [{ name: 'room_created', key: '', n: 4 }, { name: 'call_started', key: '', n: 3 }, { name: 'pair_try', key: '', n: 5 }, { name: 'pair_joined', key: '', n: 5 }, { name: 'app_error', key: 'mic_denied', n: 2 }] };
  const t = plain(dailyText(day, null, 'https://painel.example'));
  assert.match(t, /^🌙 Resumo do dia\n\n🟡 Atenção — 1 ponto para olhar\n\n👤 5 pessoas usaram · 🆕 2 novas\n🎬 4 salas · 📞 3 chamadas\n🔗 Pareamento: 5 de 5 entraram na sala \(100%\)\n🟡 Erros do app: 2 \(mais comum: microfone bloqueado\)/);
  assert.match(plain(dailyText({ ...day, counters: [] }, null)), /🟢 Tudo certo/);
  assert.equal(DAILY_CRON, '0 1 * * *');
  const db = makeDb(); const f = fakeFetch();
  db.raw.prepare('INSERT INTO daily (day, id) VALUES (?,?)').run('2026-10-22', 'a'.repeat(22));
  const r = await runScheduled({ ...ENV, DB: db }, DAILY_CRON, T0, f);
  assert.deepEqual(r.sent, ['daily']);
  assert.match(plain(f.calls[0].body.text), /Resumo do dia/);
});

test('textos de novidade: curtos e escapados', () => {
  const t = plain(newInstallText({ app: '1.0<b>', os: 'win' }, { total: 1, newToday: 1 }));
  assert.match(t, /1 novas? hoje|1 nova hoje/);
  assert.match(newInstallText({ app: '1.0<b>', os: 'win' }, { total: 1, newToday: 1 }), /1\.0&lt;b&gt;/);
  assert.match(plain(newVersionText({ app: '0.4.0', os: 'linux' }, { previousApp: null })), /Instalação nova · Linux/);
});
