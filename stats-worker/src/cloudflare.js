// Números da própria conta Cloudflare (uso do Worker e do D1) pela API GraphQL de Analytics, para o bot do Telegram.
// Precisa de dois segredos: CF_API_TOKEN (token com permissão de LEITURA de Analytics da conta) e CF_ACCOUNT_ID.
// Cada consulta é independente: se uma falhar (campo novo, permissão), as outras continuam e o texto diz o que faltou.
const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

// Limites do plano grátis (conferidos na documentação da Cloudflare; podem mudar: veja o painel deles)
export const LIMITS = { workersRequestsPerDay: 100000, d1RowsReadPerDay: 5000000, d1RowsWrittenPerDay: 100000, d1StorageBytes: 5 * 1024 ** 3 };

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

const n = (v) => Math.round(v).toLocaleString('pt-BR');
const pct = (a, b) => (b ? (a * 100) / b : 0);
const pctText = (a, b) => { const p = pct(a, b); return (p < 10 ? p.toFixed(1).replace('.', ',') : String(Math.round(p))) + '%'; };
const bytes = (v) => (v >= 1024 ** 3 ? (v / 1024 ** 3).toFixed(2).replace('.', ',') + ' GB' : (v / 1024 ** 2).toFixed(1).replace('.', ',') + ' MB');

export function cloudflareText(stats, panelUrl = '') {
  if (!stats.configured) return '☁️ Cloudflare não configurado: faltam os segredos CF_API_TOKEN e CF_ACCOUNT_ID (veja o README do stats-worker).';
  const lines = ['☁️ Cloudflare — hoje (UTC, zera às 21h de Brasília)'];
  const w = stats.workers;
  if (w?.error) lines.push('Workers: indisponível (' + w.error + ')');
  else if (w) {
    lines.push(`Workers: ${n(w.requests)} requisições (${pctText(w.requests, LIMITS.workersRequestsPerDay)} do limite grátis de ${n(LIMITS.workersRequestsPerDay)}/dia) · erros: ${n(w.errors)}`);
    if (w.cpuP50 || w.cpuP99) lines.push(`Tempo de CPU do painel: mediana ${(w.cpuP50 / 1000).toFixed(1).replace('.', ',')} ms · p99 ${(w.cpuP99 / 1000).toFixed(1).replace('.', ',')} ms (limite grátis: 10 ms)`);
    const top = Object.entries(w.scripts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${n(v)}`).join(', ');
    if (top) lines.push('Por Worker: ' + top);
  }
  if (stats.d1) {
    if (stats.d1.error) lines.push('D1: indisponível (' + stats.d1.error + ')');
    else {
      lines.push(`D1: ${n(stats.d1.readQueries)} consultas de leitura · ${n(stats.d1.writeQueries)} de gravação`);
      if (stats.d1.hasRows) lines.push(`Linhas lidas: ${n(stats.d1.rowsRead)} (${pctText(stats.d1.rowsRead, LIMITS.d1RowsReadPerDay)} de ${n(LIMITS.d1RowsReadPerDay)}/dia) · gravadas: ${n(stats.d1.rowsWritten)} (${pctText(stats.d1.rowsWritten, LIMITS.d1RowsWrittenPerDay)} de ${n(LIMITS.d1RowsWrittenPerDay)}/dia)`);
    }
    if (stats.storage?.bytes != null) lines.push(`Banco: ${bytes(stats.storage.bytes)} de ${bytes(LIMITS.d1StorageBytes)} (${pctText(stats.storage.bytes, LIMITS.d1StorageBytes)})`);
    else if (stats.storage?.error) lines.push('Tamanho do banco: indisponível (' + stats.storage.error + ')');
  }
  if (panelUrl) lines.push('', panelUrl);
  return lines.join('\n');
}

/** Alertas de uso perto do limite grátis (70% ou mais). Devolve [{kind, text}]. */
export function usageAlerts(stats, threshold = 0.7) {
  const out = [];
  if (!stats?.configured) return out;
  const add = (kind, label, used, limit) => { if (limit && used / limit >= threshold) out.push({ kind, text: `⚠️ Cloudflare: ${label} em ${pctText(used, limit)} do limite grátis diário (${n(used)} de ${n(limit)}).` }); };
  if (stats.workers && !stats.workers.error) add('cf_requests', 'requisições dos Workers', stats.workers.requests, LIMITS.workersRequestsPerDay);
  if (stats.d1 && !stats.d1.error && stats.d1.hasRows) { add('cf_d1_writes', 'linhas gravadas no D1', stats.d1.rowsWritten, LIMITS.d1RowsWrittenPerDay); add('cf_d1_reads', 'linhas lidas no D1', stats.d1.rowsRead, LIMITS.d1RowsReadPerDay); }
  if (stats.storage?.bytes != null) add('cf_d1_storage', 'tamanho do banco D1', stats.storage.bytes, LIMITS.d1StorageBytes);
  return out;
}
