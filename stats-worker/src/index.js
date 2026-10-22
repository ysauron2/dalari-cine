// Estatísticas anônimas do Dalari Cine (Cloudflare Worker + D1).
//   POST /v1/ping       recebe o aviso do app (público; só aceita o formato abaixo, nada além)
//   GET  /              painel (protegido por senha)
//   GET  /api/summary   dados do painel (protegido)
//   GET  /api/export.csv  planilha (protegido)
// Não guarda endereço IP, nome, título assistido nem conteúdo. O IP só é visto de passagem, para um limite de taxa em memória.
import { DASHBOARD_HTML } from './dashboard.js';
import { runScheduled, sendTelegram, handleTelegramWebhook, notifyActivity } from './alerts.js';
import { handleFeedback } from './feedback.js';

const ENUMS = {
  os: ['win', 'mac', 'linux', 'other'],
  state: ['idle', 'room', 'call'],
};
// Eventos aceitos e as chaves permitidas de cada um (nada de texto livre)
const EVENTS = {
  room_created: [''],
  call_started: [''],
  call_ended: ['<5m', '5-30m', '30m-2h', '>2h'],
  voice_failed: [''],
  route: ['host', 'srflx', 'prflx', 'relay', 'none'],
  // funil do código curto
  pair_code: [''],                 // o Host gerou um código
  pair_try: [''],                  // o convidado digitou um código
  pair_found: [''],                // o Host recebeu a oferta do convidado
  pair_open: [''],                 // a conexão direta abriu
  pair_joined: [''],               // o convidado conseguiu pedir entrada na sala
  pair_fail: ['timeout', 'link', 'join', 'relay'],
  // qualidade da chamada, só em faixas
  voice_quality: ['good', 'fair', 'poor'],
  connect_time: ['<3s', '3-10s', '>10s'],
  // erros do app, só em categorias fixas (nunca mensagem, caminho ou texto livre)
  app_error: ['mic_denied', 'mic_missing', 'mic_busy', 'mic_insecure', 'player_fail', 'room_lost', 'update_fail', 'unexpected'],
};
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const APP_RE = /^[0-9A-Za-z.+-]{1,20}$/;
const ACTIVE_WINDOW_S = 300;          // "agora" = avisou nos últimos 5 minutos (o app avisa a cada 2)
const MAX_BODY = 1024;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/** Valida o corpo do aviso. Devolve o objeto limpo ou null. */
export function validatePing(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.v !== 1) return null;
  const allowed = new Set(['v', 'id', 'app', 'os', 'state', 'ev']);
  if (Object.keys(body).some((k) => !allowed.has(k))) return null;
  if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return null;
  if (typeof body.app !== 'string' || !APP_RE.test(body.app)) return null;
  if (!ENUMS.os.includes(body.os) || !ENUMS.state.includes(body.state)) return null;
  const out = { id: body.id, app: body.app, os: body.os, state: body.state, ev: null };
  if (body.ev !== undefined) {
    const e = body.ev;
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some((x) => x !== 'n' && x !== 'k') || typeof e.n !== 'string' || !Object.hasOwn(EVENTS, e.n)) return null;
    const k = e.k === undefined ? '' : e.k;
    if (typeof k !== 'string' || !EVENTS[e.n].includes(k)) return null;
    out.ev = { n: e.n, k };
  }
  return out;
}

// Limite de taxa por IP, em memória do isolate (melhor esforço; o IP nunca é gravado)
const hits = new Map();
function limited(ip, now) {
  if (!ip) return false;
  const h = hits.get(ip);
  if (!h || now - h.t0 > 60) { hits.set(ip, { t0: now, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  h.n++;
  return h.n > 30;
}

export async function recordPing(db, p, now) {
  // antes de gravar: já conhecíamos esta instalação e esta versão? (para os avisos de "nova instalação" e "primeira pessoa na versão")
  const prev = await db.prepare('SELECT app FROM installs WHERE id = ?1').bind(p.id).first();
  const seenVersion = await db.prepare('SELECT 1 AS x FROM versions_seen WHERE app = ?1').bind(p.app).first();
  const stmts = [
    db.prepare('INSERT INTO installs (id, first_seen, last_seen, app, os, state, state_ts) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?2) ON CONFLICT(id) DO UPDATE SET last_seen = ?2, app = ?3, os = ?4, state = ?5, state_ts = ?2')
      .bind(p.id, now, p.app, p.os, p.state),
    db.prepare('INSERT OR IGNORE INTO daily (day, id) VALUES (?1, ?2)').bind(day(now), p.id),
  ];
  const d = new Date(now * 1000);
  stmts.push(db.prepare('INSERT OR IGNORE INTO hourly (day, hour, id) VALUES (?1, ?2, ?3)').bind(day(now), d.getUTCHours(), p.id));
  if (p.ev) stmts.push(db.prepare('INSERT INTO counters (day, name, key, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT(day, name, key) DO UPDATE SET n = n + 1').bind(day(now), p.ev.n, p.ev.k));
  if (!seenVersion) stmts.push(db.prepare('INSERT OR IGNORE INTO versions_seen (app, first_seen) VALUES (?1, ?2)').bind(p.app, now));
  await db.batch(stmts);
  return { newInstall: !prev, previousApp: prev && prev.app !== p.app ? prev.app : null, newVersion: !seenVersion };
}

export async function summary(db, days, now) {
  const since = day(now - (days - 1) * 86400);
  const rows = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results || [];
  const one = async (sql, ...args) => (await db.prepare(sql).bind(...args).first()) || {};
  const live = await rows('SELECT state, COUNT(*) AS n FROM installs WHERE last_seen >= ?1 GROUP BY state', now - ACTIVE_WINDOW_S);
  const nowBy = { idle: 0, room: 0, call: 0 };
  for (const r of live) if (r.state in nowBy) nowBy[r.state] = r.n;
  const dailyActive = await rows('SELECT day, COUNT(*) AS n FROM daily WHERE day >= ?1 GROUP BY day ORDER BY day', since);
  const wau = (await one('SELECT COUNT(DISTINCT id) AS n FROM daily WHERE day >= ?1', day(now - 6 * 86400))).n || 0;
  const mau = (await one('SELECT COUNT(DISTINCT id) AS n FROM daily WHERE day >= ?1', day(now - 29 * 86400))).n || 0;
  const total = (await one('SELECT COUNT(*) AS n FROM installs')).n || 0;
  const newByDay = await rows("SELECT date(first_seen, 'unixepoch') AS day, COUNT(*) AS n FROM installs WHERE date(first_seen, 'unixepoch') >= ?1 GROUP BY day ORDER BY day", since);
  const versions = await rows('SELECT app, COUNT(*) AS n FROM installs WHERE last_seen >= ?1 GROUP BY app ORDER BY n DESC', now - 7 * 86400);
  const systems = await rows('SELECT os, COUNT(*) AS n FROM installs WHERE last_seen >= ?1 GROUP BY os ORDER BY n DESC', now - 7 * 86400);
  const counters = await rows('SELECT day, name, key, n FROM counters WHERE day >= ?1 ORDER BY day', since);
  // horários de pico (UTC; o painel converte para o fuso de quem olha): pessoas ativas por hora, até 60 dias
  const hourly = await rows('SELECT day, hour, COUNT(*) AS n FROM hourly WHERE day >= ?1 GROUP BY day, hour', day(now - (Math.min(days, 60) - 1) * 86400));
  // retenção por semana de entrada: voltou no dia seguinte (d1) e em algum dos 7 dias seguintes (w1); só coortes com 8+ dias
  const retention = await rows(`SELECT MIN(day0) AS start, COUNT(*) AS size,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM daily d WHERE d.id = i.id AND d.day = date(i.day0, '+1 day')) THEN 1 ELSE 0 END) AS d1,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM daily d WHERE d.id = i.id AND d.day > i.day0 AND d.day <= date(i.day0, '+7 day')) THEN 1 ELSE 0 END) AS w1
    FROM (SELECT id, date(first_seen, 'unixepoch') AS day0 FROM installs) i
    WHERE i.day0 <= ?1 AND i.day0 >= ?2 GROUP BY strftime('%Y-%W', i.day0) ORDER BY start`, day(now - 8 * 86400), day(now - 120 * 86400));
  return { generatedAt: now, days, now: { active: nowBy.idle + nowBy.room + nowBy.call, ...nowBy }, wau, mau, total, dailyActive, newByDay, versions, systems, counters, hourly, retention };
}

export function csv(sum) {
  const lines = ['tipo,dia,nome,chave,valor'];
  for (const r of sum.dailyActive) lines.push(`ativos,${r.day},,,${r.n}`);
  for (const r of sum.newByDay) lines.push(`novas_instalacoes,${r.day},,,${r.n}`);
  for (const r of sum.hourly || []) lines.push(`ativos_hora_utc,${r.day},${r.hour},,${r.n}`);
  for (const r of sum.counters) lines.push(`contador,${r.day},${r.name},${String(r.key).replace(/,/g, ';')},${r.n}`);
  return lines.join('\n') + '\n';
}

async function authorized(request, env) {
  const expected = env.PANEL_PASSWORD;
  if (!expected) return 'not_configured';
  const header = request.headers.get('Authorization') || '';
  const m = /^Basic (.+)$/.exec(header);
  if (!m) return false;
  let given = '';
  try { given = atob(m[1]); } catch { return false; }
  given = given.slice(given.indexOf(':') + 1);              // usuário é ignorado; vale a senha
  // comparação sem curto-circuito (resumos SHA-256 de tamanho fixo)
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Depois de responder: no Worker real continua em segundo plano (ctx.waitUntil); nos testes espera terminar
const after = (ctx, promise) => (ctx?.waitUntil ? ctx.waitUntil(promise) : promise);

export async function handle(request, env, now = Math.floor(Date.now() / 1000), ctx = null) {
  const url = new URL(request.url);
  if (url.pathname === '/v1/ping') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ ok: false }, 405, CORS);
    if (limited(request.headers.get('CF-Connecting-IP'), now)) return json({ ok: false, error: 'rate_limited' }, 429, CORS);
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413, CORS);
    let body = null;
    try { body = JSON.parse(text); } catch { /* inválido */ }
    const p = validatePing(body);
    if (!p) return json({ ok: false, error: 'bad_request' }, 400, CORS);
    let info = null;
    try { info = await recordPing(env.DB, p, now); } catch { return json({ ok: false, error: 'storage' }, 503, CORS); }
    await after(ctx, notifyActivity(env, p, info, now));
    return json({ ok: true }, 200, CORS);
  }

  // Feedback vindo do app (só quando a pessoa clica em Enviar): vai direto ao Telegram do criador, sem ser guardado
  if (url.pathname === '/v1/feedback') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ ok: false }, 405, CORS);
    const r = await handleFeedback(request, env, now);
    return json(r.status === 200 ? { ok: true } : { ok: false, error: r.error }, r.status, CORS);
  }

  if (['/', '/api/summary', '/api/export.csv'].includes(url.pathname)) {
    if (request.method !== 'GET') return json({ ok: false }, 405);
    const auth = await authorized(request, env);
    if (auth === 'not_configured') return new Response('Painel não configurado: defina o segredo PANEL_PASSWORD.', { status: 503 });
    if (!auth) return new Response('Senha necessária.', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Dalari Cine · estatísticas", charset="UTF-8"', 'Cache-Control': 'no-store' } });
    if (url.pathname === '/') return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
    const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '30', 10) || 30));
    const sum = await summary(env.DB, days, now);
    if (url.pathname === '/api/summary') return json(sum);
    return new Response(csv(sum), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dalari-estatisticas.csv"', 'Cache-Control': 'no-store' } });
  }
  // Webhook do Telegram: você manda /agora, /hoje, /semana ou /erros ao seu bot e ele responde. Sem senha do painel (o Telegram não
  // consegue), mas só com o cabeçalho secreto certo e só para o SEU chat.
  if (url.pathname === '/v1/telegram') {
    if (request.method !== 'POST') return json({ ok: false }, 405);
    const r = await handleTelegramWebhook(request, env, now);
    return json({ ok: r.status === 200 }, r.status);
  }
  // Teste do Telegram: o painel autenticado manda uma mensagem de teste (confirma o token e o chat, sem esperar um alerta de verdade)
  if (url.pathname === '/api/alert-test') {
    if (request.method !== 'POST') return json({ ok: false }, 405);
    const auth = await authorized(request, env);
    if (auth === 'not_configured') return new Response('Painel não configurado: defina o segredo PANEL_PASSWORD.', { status: 503 });
    if (!auth) return new Response('Senha necessária.', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Dalari Cine · estatísticas", charset="UTF-8"', 'Cache-Control': 'no-store' } });
    const r = await sendTelegram(env, '✅ Teste do Dalari Cine: o aviso por Telegram está funcionando.' + (env.PANEL_URL ? '\n' + env.PANEL_URL : ''));
    return json({ ok: !!r.ok, skipped: r.skipped || null, status: r.status || null }, r.ok ? 200 : (r.skipped ? 409 : 502));
  }
  return new Response('Não encontrado', { status: 404 });
}

export default {
  fetch: (request, env, ctx) => handle(request, env, Math.floor(Date.now() / 1000), ctx),
  // Agendamentos (wrangler.toml): alertas a cada 30 min e resumo semanal
  scheduled: (event, env, ctx) => { ctx.waitUntil(runScheduled(env, event.cron, Math.floor(Date.now() / 1000)).catch(() => {})); },
};
