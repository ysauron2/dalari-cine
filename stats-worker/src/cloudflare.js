// Números da própria conta Cloudflare (uso do Worker e do D1) pela API GraphQL de Analytics, para o bot do Telegram.
// Precisa de dois segredos: CF_API_TOKEN (token com permissão de LEITURA de Analytics da conta) e CF_ACCOUNT_ID.
// Cada consulta é independente: se uma falhar (campo novo, permissão), as outras continuam e o texto diz o que faltou.
const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

// Limites do plano grátis (conferidos na documentação da Cloudflare; podem mudar: veja o painel deles)
export const LIMITS = { workersRequestsPerDay: 100000, d1RowsReadPerDay: 5000000, d1RowsWrittenPerDay: 100000, d1StorageBytes: 5 * 1024 ** 3 };

import { esc, n, pctText, bar, worst } from './format.js';
const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

export function configured(env) { return !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID); }

async function gql(env, query, variables, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: JSON.stringify({ query, variables }) });
  } catch { throw new Error('rede'); }
  let body = null;
  try { body = await res.json(); } catch { /* resposta sem JSON */ }
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'token sem permissão (precisa ler Analytics da conta)' : 'HTTP ' + res.status);
  if (body?.errors?.length) throw new Error(String(body.errors[0]?.message || 'erro na consulta').slice(0, 160));
  return body?.data?.viewer?.accounts?.[0] || {};
}

const WORKERS_QUERY = `query ($acc: string!, $from: string!, $to: string!) {
  viewer { accounts(filter: { accountTag: $acc }) {
    workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $from, datetime_leq: $to }) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
      dimensions { scriptName status }
    }
  } }
}`;
const D1_QUERY_ROWS = `query ($acc: string!, $db: string!, $day: Date!) {
  viewer { accounts(filter: { accountTag: $acc }) {
    d1AnalyticsAdaptiveGroups(limit: 10, filter: { date_geq: $day, date_leq: $day, databaseId: $db }) {
      sum { readQueries writeQueries rowsRead rowsWritten }
    }
  } }
}`;
const D1_QUERY_BASIC = D1_QUERY_ROWS.replace(' rowsRead rowsWritten', '');
const D1_STORAGE_QUERY = `query ($acc: string!, $db: string!, $from: Date!, $to: Date!) {
  viewer { accounts(filter: { accountTag: $acc }) {
    d1StorageAdaptiveGroups(limit: 5, filter: { date_geq: $from, date_leq: $to, databaseId: $db }, orderBy: [date_DESC]) {
      max { databaseSizeBytes }
      dimensions { date }
    }
  } }
}`;

/** Junta o dia de hoje (UTC, o mesmo período em que os limites zeram) de Workers, D1 e tamanho do banco. */
export async function cloudflareStats(env, now, fetchImpl = globalThis.fetch) {
  if (!configured(env)) return { configured: false };
  const out = { configured: true };
  const today = dayOf(now), from = today + 'T00:00:00Z', to = new Date(now * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

  try {
    const data = await gql(env, WORKERS_QUERY, { acc: env.CF_ACCOUNT_ID, from, to }, fetchImpl);
    const rows = data.workersInvocationsAdaptive || [];
    const scripts = {};
    let requests = 0, errors = 0, p50 = 0, p99 = 0;
    for (const r of rows) {
      const n = r.sum?.requests || 0, name = r.dimensions?.scriptName || '?';
      scripts[name] = (scripts[name] || 0) + n;
      requests += n; errors += r.sum?.errors || 0;
      if (name === (env.WORKER_NAME || 'dalari-stats')) { p50 = Math.max(p50, r.quantiles?.cpuTimeP50 || 0); p99 = Math.max(p99, r.quantiles?.cpuTimeP99 || 0); }
    }
    out.workers = { requests, errors, cpuP50: p50, cpuP99: p99, scripts };
  } catch (e) { out.workers = { error: e.message }; }

  if (env.D1_DATABASE_ID) {
    const vars = { acc: env.CF_ACCOUNT_ID, db: env.D1_DATABASE_ID, day: today };
    try {
      let data;
      try { data = await gql(env, D1_QUERY_ROWS, vars, fetchImpl); }
      catch (e) { if (/rowsRead|rowsWritten|unknown field/i.test(e.message)) data = await gql(env, D1_QUERY_BASIC, vars, fetchImpl); else throw e; }
      const s = (data.d1AnalyticsAdaptiveGroups || []).reduce((a, g) => ({
        readQueries: a.readQueries + (g.sum?.readQueries || 0), writeQueries: a.writeQueries + (g.sum?.writeQueries || 0),
        rowsRead: a.rowsRead + (g.sum?.rowsRead || 0), rowsWritten: a.rowsWritten + (g.sum?.rowsWritten || 0), hasRows: a.hasRows || g.sum?.rowsRead !== undefined,
      }), { readQueries: 0, writeQueries: 0, rowsRead: 0, rowsWritten: 0, hasRows: false });
      out.d1 = s;
    } catch (e) { out.d1 = { error: e.message }; }
    try {
      const data = await gql(env, D1_STORAGE_QUERY, { acc: env.CF_ACCOUNT_ID, db: env.D1_DATABASE_ID, from: dayOf(now - 86400), to: today }, fetchImpl);
      out.storage = { bytes: (data.d1StorageAdaptiveGroups || [])[0]?.max?.databaseSizeBytes ?? null };
    } catch (e) { out.storage = { error: e.message }; }
  }
  return out;
}


const bytes = (v) => (v >= 1024 ** 3 ? (v / 1024 ** 3).toFixed(1).replace('.', ',') + ' GB' : v >= 1024 ** 2 ? (v / 1024 ** 2).toFixed(1).replace('.', ',') + ' MB' : Math.round(v / 1024) + ' KB');
const level = (p) => (p >= 70 ? 'bad' : p >= 50 ? 'warn' : 'ok');
const usageLine = (label, used, limit, limitText) => {
  const p = limit ? (used * 100) / limit : 0;
  return `${label}  ${bar(used, limit)} <b>${pctText(used, limit)}</b>  (${n(used)} de ${limitText})`;
};

/** Mensagem do /cloudflare: veredito primeiro, barras de uso do limite grátis e o que fazer. */
export function cloudflareText(stats, panelUrl = '') {
  if (!stats.configured) return '☁️ <b>Cloudflare</b>\n\n⚪ Ainda não configurado: faltam os segredos CF_API_TOKEN e CF_ACCOUNT_ID.\n\n\u{1F449} Veja o passo a passo no README da pasta stats-worker.';
  const w = stats.workers && !stats.workers.error ? stats.workers : null;
  const d = stats.d1 && !stats.d1.error ? stats.d1 : null;
  const pw = w ? (w.requests * 100) / LIMITS.workersRequestsPerDay : 0;
  const pwr = d?.hasRows ? (d.rowsWritten * 100) / LIMITS.d1RowsWrittenPerDay : 0;
  const prr = d?.hasRows ? (d.rowsRead * 100) / LIMITS.d1RowsReadPerDay : 0;
  const ps = stats.storage?.bytes != null ? (stats.storage.bytes * 100) / LIMITS.d1StorageBytes : 0;
  const overall = worst([level(pw), level(pwr), level(prr), level(ps)]);
  const cpuHigh = w && w.cpuP99 / 1000 > 10;
  const lines = ['☁️ <b>Cloudflare</b> — uso de hoje (zera às 21h de Brasília)', '',
    overall === 'ok' ? '\u{1F7E2} <b>Tudo dentro do limite grátis</b>' : overall === 'warn' ? '\u{1F7E1} <b>Atenção: passando de metade do limite grátis</b>' : '\u{1F534} <b>Perto do limite grátis!</b>', ''];

  lines.push('⚙️ <b>Painel (Workers)</b>');
  if (stats.workers?.error) lines.push(`⚪ Indisponível agora (${esc(stats.workers.error)})`);
  else if (w) {
    lines.push(usageLine('Requisições', w.requests, LIMITS.workersRequestsPerDay, '100.000'));
    lines.push(`Erros: <b>${n(w.errors)}</b>${w.errors ? ' \u{1F7E1}' : ''}`);
    if (w.cpuP50 || w.cpuP99) lines.push(`CPU: normal ${(w.cpuP50 / 1000).toFixed(1).replace('.', ',')} ms · pico ${(w.cpuP99 / 1000).toFixed(1).replace('.', ',')} ms (limite 10 ms)${cpuHigh ? ' \u{1F7E1}' : ''}`);
  }
  lines.push('', '\u{1F5C4} <b>Banco (D1)</b>');
  if (stats.d1?.error) lines.push(`⚪ Indisponível agora (${esc(stats.d1.error)})`);
  else if (d) {
    if (d.hasRows) {
      lines.push(usageLine('Linhas lidas   ', d.rowsRead, LIMITS.d1RowsReadPerDay, '5 milhões'));
      lines.push(usageLine('Linhas gravadas', d.rowsWritten, LIMITS.d1RowsWrittenPerDay, '100.000'));
    } else lines.push(`${n(d.readQueries)} leituras · ${n(d.writeQueries)} gravações`);
  }
  if (stats.storage?.bytes != null) lines.push(`Tamanho: <b>${bytes(stats.storage.bytes)}</b> de 5 GB (${pctText(stats.storage.bytes, LIMITS.d1StorageBytes)})`);
  else if (stats.storage?.error) lines.push(`Tamanho: indisponível (${esc(stats.storage.error)})`);

  lines.push('', '\u{1F449} <b>O que fazer</b>');
  const todo = [];
  if (overall === 'bad') todo.push('Está perto do limite grátis: reduza o uso ou considere o plano pago antes de o painel parar.');
  else if (overall === 'warn') todo.push('Fique de olho. Eu aviso de novo se passar de 70%.');
  if (cpuHigh) todo.push('O pico de CPU passou de 10 ms. Se aparecerem erros no painel, me peça para otimizar.');
  if (todo.length) for (const t of todo) lines.push('• ' + esc(t)); else lines.push('Nada por agora. \u{1F44D}');
  if (panelUrl) lines.push('', esc(panelUrl));
  return lines.join('\n');
}

/** Avisos de uso perto do limite grátis (70% ou mais). Devolve [{kind, text}]. */
export function usageAlerts(stats, threshold = 0.7) {
  const out = [];
  if (!stats?.configured) return out;
  const add = (kind, label, used, limit, limitText) => {
    if (limit && used / limit >= threshold) {
      out.push({ kind, text: `\u{1F534} <b>Cloudflare: ${esc(label)} perto do limite</b>\n${bar(used, limit)} <b>${pctText(used, limit)}</b> do limite grátis de hoje (${n(used)} de ${limitText}).\n\n\u{1F449} <b>O que fazer:</b> reduza o uso hoje ou considere o plano pago. O contador zera às 21h de Brasília.` });
    }
  };
  if (stats.workers && !stats.workers.error) add('cf_requests', 'requisições do painel', stats.workers.requests, LIMITS.workersRequestsPerDay, '100.000');
  if (stats.d1 && !stats.d1.error && stats.d1.hasRows) {
    add('cf_d1_writes', 'linhas gravadas no banco', stats.d1.rowsWritten, LIMITS.d1RowsWrittenPerDay, '100.000');
    add('cf_d1_reads', 'linhas lidas no banco', stats.d1.rowsRead, LIMITS.d1RowsReadPerDay, '5 milhões');
  }
  if (stats.storage?.bytes != null) add('cf_d1_storage', 'tamanho do banco', stats.storage.bytes, LIMITS.d1StorageBytes, '5 GB');
  return out;
}
