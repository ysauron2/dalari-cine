import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareStats, cloudflareText, usageAlerts, configured, LIMITS } from '../src/cloudflare.js';
import { commandReply, runScheduled } from '../src/alerts.js';

const plain = (t) => String(t).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0) / 1000;
const ENV = { CF_API_TOKEN: 'tok-secreto', CF_ACCOUNT_ID: 'acc123', D1_DATABASE_ID: 'db-1', TELEGRAM_BOT_TOKEN: '1:T', TELEGRAM_CHAT_ID: '42', PANEL_URL: 'https://painel.example' };

// Respostas de mentira da API GraphQL, escolhidas pelo nome do dataset consultado
function gqlFetch({ workers, d1, storage, status = 200, rejectRows = false } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, query, variables });
    if (status !== 200) return new Response('{}', { status });
    const ok = (acc) => new Response(JSON.stringify({ data: { viewer: { accounts: [acc] } } }), { status: 200 });
    const err = (m) => new Response(JSON.stringify({ errors: [{ message: m }] }), { status: 200 });
    if (query.includes('workersInvocationsAdaptive')) return workers instanceof Error ? err(workers.message) : ok({ workersInvocationsAdaptive: workers || [] });
    if (query.includes('d1AnalyticsAdaptiveGroups')) {
      if (rejectRows && query.includes('rowsRead')) return err('unknown field "rowsRead"');
      return d1 instanceof Error ? err(d1.message) : ok({ d1AnalyticsAdaptiveGroups: d1 || [] });
    }
    if (query.includes('d1StorageAdaptiveGroups')) return storage instanceof Error ? err(storage.message) : ok({ d1StorageAdaptiveGroups: storage || [] });
    return err('consulta desconhecida');
  };
  f.calls = calls;
  return f;
}
const W = [
  { sum: { requests: 800, errors: 2, subrequests: 10 }, quantiles: { cpuTimeP50: 1200, cpuTimeP99: 4800 }, dimensions: { scriptName: 'dalari-stats', status: 'success' } },
  { sum: { requests: 34, errors: 0, subrequests: 0 }, quantiles: { cpuTimeP50: 300, cpuTimeP99: 900 }, dimensions: { scriptName: 'outro', status: 'success' } },
];
const D1 = [{ sum: { readQueries: 400, writeQueries: 220, rowsRead: 5210, rowsWritten: 2130 } }];
const STORAGE = [{ max: { databaseSizeBytes: 311296 } }];

test('sem token ou conta nada é consultado e o texto explica o que falta', async () => {
  const f = gqlFetch();
  assert.equal(configured({}), false);
  assert.equal(configured({ CF_API_TOKEN: 'x' }), false);
  assert.deepEqual(await cloudflareStats({ CF_API_TOKEN: 'x' }, T0, f), { configured: false });
  assert.equal(f.calls.length, 0);
  assert.match(cloudflareText({ configured: false }), /faltam os segredos CF_API_TOKEN e CF_ACCOUNT_ID/);
});

test('junta Workers, D1 e tamanho do banco do dia (UTC), com a conta, o banco e o token certos', async () => {
  const f = gqlFetch({ workers: W, d1: D1, storage: STORAGE });
  const s = await cloudflareStats(ENV, T0, f);
  assert.deepEqual(s.workers, { requests: 834, errors: 2, cpuP50: 1200, cpuP99: 4800, scripts: { 'dalari-stats': 800, outro: 34 } });
  assert.deepEqual(s.d1, { readQueries: 400, writeQueries: 220, rowsRead: 5210, rowsWritten: 2130, hasRows: true });
  assert.equal(s.storage.bytes, 311296);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((c) => c.url === 'https://api.cloudflare.com/client/v4/graphql' && c.auth === 'Bearer tok-secreto'));
  const wk = f.calls[0].variables;
  assert.equal(wk.acc, 'acc123'); assert.equal(wk.from, '2026-10-22T00:00:00Z'); assert.equal(wk.to, '2026-10-22T12:00:00Z');
  assert.deepEqual({ ...f.calls[1].variables }, { acc: 'acc123', db: 'db-1', day: '2026-10-22' });
});

test('texto simples: veredito primeiro, barras de uso, CPU, banco e o que fazer', async () => {
  const text = plain(cloudflareText(await cloudflareStats(ENV, T0, gqlFetch({ workers: W, d1: D1, storage: STORAGE })), 'https://painel.example'));
  const lines = text.split('\n');
  assert.equal(lines[0], '☁️ Cloudflare — uso de hoje (zera às 21h de Brasília)');
  assert.equal(lines[2], '🟢 Tudo dentro do limite grátis', 'o veredito vem antes de qualquer número');
  assert.match(text, /Requisições {2}▓░{9} 0,8% {2}\(834 de 100\.000\)/);
  assert.match(text, /Erros: 2 🟡/);
  assert.match(text, /CPU: normal 1,2 ms · pico 4,8 ms \(limite 10 ms\)\n/);
  assert.match(text, /Linhas lidas {5}▓░{9} 0,1% {2}\(5\.210 de 5 milhões\)/);
  assert.match(text, /Linhas gravadas {2}▓░{9} 2,1% {2}\(2\.130 de 100\.000\)/);
  assert.match(text, /Tamanho: 304 KB de 5 GB \(menos de 0,1%\)/);
  assert.doesNotMatch(cloudflareText(await cloudflareStats(ENV, T0, gqlFetch({ workers: W, d1: D1, storage: STORAGE }))), /<(?!\/?b>)/, 'nenhum "<" solto: o HTML do Telegram não quebra');
  assert.match(text, /👉 O que fazer\nNada por agora\. 👍/);
  assert.match(text, /painel\.example$/);
  assert.ok(lines.length <= 20, 'cabe numa tela: ' + lines.length);
  assert.doesNotMatch(text, /workersInvocations|d1Analytics|scriptName/, 'nada de nomes internos');
});

test('perto do limite: vermelho, com o que fazer; pico de CPU acima de 10 ms vira dica amarela', () => {
  const stats = { configured: true, workers: { requests: 85000, errors: 0, cpuP50: 4000, cpuP99: 12000, scripts: {} }, d1: { readQueries: 1, writeQueries: 1, rowsRead: 1, rowsWritten: 1, hasRows: true }, storage: { bytes: 1000 } };
  const text = plain(cloudflareText(stats));
  assert.match(text, /🔴 Perto do limite grátis!/);
  assert.match(text, /Requisições {2}▓{9}░ 85% {2}\(85\.000 de 100\.000\)/);
  assert.match(text, /pico 12,0 ms \(limite 10 ms\) 🟡/);
  assert.match(text, /• Está perto do limite grátis/);
  assert.match(text, /• O pico de CPU passou de 10 ms/);
  assert.match(plain(cloudflareText({ ...stats, workers: { ...stats.workers, requests: 60000 } })), /🟡 Atenção: passando de metade do limite grátis/);
});

test('uma consulta que falha não derruba as outras: cada parte diz o que faltou', async () => {
  const s = await cloudflareStats(ENV, T0, gqlFetch({ workers: new Error('not authorized'), d1: D1, storage: new Error('sem acesso') }));
  assert.equal(s.workers.error, 'not authorized');
  assert.equal(s.d1.rowsRead, 5210);
  assert.equal(s.storage.error, 'sem acesso');
  const text = plain(cloudflareText(s));
  assert.match(text, /⚪ Indisponível agora \(not authorized\)/);
  assert.match(text, /Tamanho: indisponível \(sem acesso\)/);
  assert.match(text, /Linhas lidas {5}.*\(5\.210 de 5 milhões\)/);
});

test('token sem permissão (401/403) vira uma mensagem clara, sem mostrar o token; falha de rede também', async () => {
  for (const status of [401, 403]) {
    const s = await cloudflareStats(ENV, T0, gqlFetch({ status }));
    assert.match(s.workers.error, /token sem permissão/);
    assert.equal(JSON.stringify(s).includes('tok-secreto'), false);
  }
  const net = await cloudflareStats(ENV, T0, async () => { throw new Error('falha com Bearer tok-secreto'); });
  assert.equal(net.workers.error, 'rede');
  assert.equal(JSON.stringify(net).includes('tok-secreto'), false);
});

test('se a API não conhece rowsRead/rowsWritten, repete só com as consultas e avisa que as linhas não estão disponíveis', async () => {
  const f = gqlFetch({ workers: W, d1: [{ sum: { readQueries: 7, writeQueries: 3 } }], storage: STORAGE, rejectRows: true });
  const s = await cloudflareStats(ENV, T0, f);
  assert.deepEqual(s.d1, { readQueries: 7, writeQueries: 3, rowsRead: 0, rowsWritten: 0, hasRows: false });
  assert.ok(f.calls.some((c) => c.query.includes('rowsRead')) && f.calls.some((c) => !c.query.includes('rowsRead') && c.query.includes('d1Analytics')));
  const text = plain(cloudflareText(s));
  assert.match(text, /7 leituras · 3 gravações/);
  assert.doesNotMatch(text, /Linhas lidas/);
});

test('sem D1_DATABASE_ID só consulta os Workers', async () => {
  const f = gqlFetch({ workers: W });
  const s = await cloudflareStats({ ...ENV, D1_DATABASE_ID: undefined }, T0, f);
  assert.equal(f.calls.length, 1);
  assert.equal(s.d1, undefined);
});

test('alertas de limite: só a partir de 70% do limite grátis do dia', () => {
  const stats = (req, written, read, bytes) => ({ configured: true, workers: { requests: req, errors: 0, scripts: {} }, d1: { rowsWritten: written, rowsRead: read, hasRows: true }, storage: { bytes } });
  assert.deepEqual(usageAlerts(stats(69999, 69999, 3499999, 1e9)), []);
  assert.deepEqual(usageAlerts({ configured: false }), []);
  const a = usageAlerts(stats(70000, 90000, 4000000, LIMITS.d1StorageBytes * 0.8));
  assert.deepEqual(a.map((x) => x.kind), ['cf_requests', 'cf_d1_writes', 'cf_d1_reads', 'cf_d1_storage']);
  const t = plain(a[0].text);
  assert.match(t, /^🔴 Cloudflare: requisições do painel perto do limite\n▓{7}░{3} 70% do limite grátis de hoje \(70\.000 de 100\.000\)\./);
  assert.match(t, /👉 O que fazer: reduza o uso hoje ou considere o plano pago\. O contador zera às 21h de Brasília\./);
  assert.ok(a.every((x) => plain(x.text).split('\n').filter(Boolean).length <= 4), 'avisos curtos');
  assert.deepEqual(usageAlerts({ configured: true, workers: { error: 'x' }, d1: { error: 'y' }, storage: { error: 'z' } }), [], 'partes indisponíveis não geram alerta');
});

test('/cloudflare, /infra e /limites respondem pelo bot', async () => {
  const f = gqlFetch({ workers: W, d1: D1, storage: STORAGE });
  for (const cmd of ['/cloudflare', '/infra', '/limites', '☁️ Cloudflare']) assert.match(plain(await commandReply({ ...ENV, DB: null }, cmd, T0, f)), /\(834 de 100\.000\)/, cmd);
  assert.match(plain(await commandReply({ ...ENV, DB: null }, '/ajuda', T0)), /\/cloudflare/);
  assert.match(plain(await commandReply({ TELEGRAM_BOT_TOKEN: 'x' }, '/cloudflare', T0, f)), /faltam os segredos/);
});

test('agendamento: passando de 70% do limite avisa uma vez e respeita o intervalo de 6 h', async () => {
  const raw = new DatabaseSync(':memory:'); raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = { prepare(sql) { const st = raw.prepare(sql); return { bind: (...a) => ({ run: () => st.run(...a), first: async () => { const r = st.get(...a); return r ? { ...r } : null; }, all: async () => ({ results: st.all(...a).map((r) => ({ ...r })) }) }) }; } };
  const sent = [];
  const f = async (url, init) => {
    if (url.includes('api.telegram.org')) { sent.push(JSON.parse(init.body).text); return new Response('{}', { status: 200 }); }
    return gqlFetch({ workers: [{ sum: { requests: 80000, errors: 0 }, quantiles: {}, dimensions: { scriptName: 'dalari-stats' } }], d1: D1, storage: STORAGE })(url, init);
  };
  const env = { ...ENV, DB };
  assert.deepEqual((await runScheduled(env, '*/30 * * * *', T0, f)).sent, ['cf_requests']);
  assert.match(plain(sent[0]), /80% do limite grátis de hoje \(80\.000 de 100\.000\)/);
  assert.deepEqual((await runScheduled(env, '*/30 * * * *', T0 + 1800, f)).sent, []);
  assert.equal(sent.length, 1);
});

test('o ID do banco D1 está no wrangler.toml e o README explica o token da API', () => {
  assert.match(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'), /D1_DATABASE_ID = "600153dd-bd08-42e2-936b-40af0f816591"/);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /CF_API_TOKEN/);
  assert.match(readme, /\/cloudflare/);
});
