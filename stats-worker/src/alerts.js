// Alertas e resumo semanal por Telegram para o criador. Roda por agendamento (Cron Trigger do Worker):
//   a cada 30 min  -> confere os contadores de hoje (UTC) e avisa se algo está falhando muito (no máximo 1 aviso por tipo a cada 6 h)
//   segunda 12:00 UTC (09:00 em Brasília) -> resumo da semana
// Só usa contadores já agregados: nada que identifique alguém. Os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID vêm do ambiente;
// sem eles, nada é enviado e nada quebra.
import { summary } from './index.js';
import { cloudflareStats, cloudflareText, usageAlerts, configured as cfConfigured } from './cloudflare.js';

export const WEEKLY_CRON = '0 12 * * 1';
export const COOLDOWN_S = 6 * 3600;
const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

const total = (rows, name, key) => rows.filter((r) => r.name === name && (key === undefined || r.key === key)).reduce((a, r) => a + r.n, 0);
const byKey = (rows, name) => { const m = {}; for (const r of rows) if (r.name === name) m[r.key] = (m[r.key] || 0) + r.n; return m; };
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const list = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');

/** Regras de alerta sobre os contadores de UM dia. rows: [{name, key, n}]. Devolve [{kind, text}]. */
export function evaluate(rows) {
  const out = [];
  const tried = total(rows, 'pair_try'), pairFails = total(rows, 'pair_fail');
  if (tried >= 5 && pairFails / tried >= 0.4) {
    out.push({ kind: 'pair_fail_rate', text: `⚠️ Pareamento falhando: ${pairFails} falhas em ${tried} tentativas hoje (${pct(pairFails, tried)}%).\nOnde: ${list(byKey(rows, 'pair_fail'))}.` });
  }
  const calls = total(rows, 'call_started'), voiceFails = total(rows, 'voice_failed');
  if ((calls >= 5 && voiceFails / calls >= 0.4) || voiceFails >= 8) {
    out.push({ kind: 'voice_fail_rate', text: `⚠️ Voz falhando: ${voiceFails} falhas de voz hoje para ${calls} chamadas iniciadas.` });
  }
  const q = byKey(rows, 'voice_quality'), qTotal = (q.good || 0) + (q.fair || 0) + (q.poor || 0);
  if (qTotal >= 5 && (q.poor || 0) / qTotal >= 0.4) {
    out.push({ kind: 'voice_poor', text: `⚠️ Qualidade da voz ruim: ${q.poor} de ${qTotal} chamadas medidas hoje (${pct(q.poor, qTotal)}%).` });
  }
  const errs = byKey(rows, 'app_error'), errTotal = Object.values(errs).reduce((a, n) => a + n, 0);
  if (errTotal >= 10 || Object.values(errs).some((n) => n >= 5)) {
    out.push({ kind: 'app_errors', text: `\u{1F6A8} Erros do app hoje: ${errTotal} no total.\nPor tipo: ${list(errs)}.` });
  }
  return out;
}

/** Resumo da semana a partir de summary(db, 7, now). */
export function weeklyText(sum, panelUrl = '') {
  const rows = sum.counters || [];
  const tried = total(rows, 'pair_try'), joined = total(rows, 'pair_joined');
  const q = byKey(rows, 'voice_quality'), qTotal = (q.good || 0) + (q.fair || 0) + (q.poor || 0);
  const newInstalls = (sum.newByDay || []).reduce((a, r) => a + r.n, 0);
  const errs = byKey(rows, 'app_error');
  const versions = (sum.versions || []).slice(0, 3).map((v) => `${v.app} (${v.n})`).join(', ') || 'sem dados';
  const lines = [
    '\u{1F4CA} Dalari Cine — resumo da semana',
    `Pessoas ativas (7 dias): ${sum.wau || 0} · novas instalações: ${newInstalls} · total: ${sum.total || 0}`,
    `Salas criadas: ${total(rows, 'room_created')} · chamadas iniciadas: ${total(rows, 'call_started')}`,
    tried ? `Pareamento por código curto: ${pct(joined, tried)}% chegaram à sala (${joined} de ${tried})` : 'Pareamento por código curto: sem tentativas',
    qTotal ? `Qualidade da voz: ${pct(q.good || 0, qTotal)}% boa, ${pct(q.fair || 0, qTotal)}% média, ${pct(q.poor || 0, qTotal)}% ruim` : 'Qualidade da voz: sem medições',
    `Falhas de voz: ${total(rows, 'voice_failed')} · erros do app: ${Object.values(errs).reduce((a, n) => a + n, 0)}${Object.keys(errs).length ? ' (' + list(errs) + ')' : ''}`,
    `Versões em uso: ${versions}`,
  ];
  if (panelUrl) lines.push(panelUrl);
  return lines.join('\n');
}

export async function sendTelegram(env, text, fetchImpl = globalThis.fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, skipped: 'not_configured' };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: String(text).slice(0, 3500), disable_web_page_preview: true }),
    });
    return { ok: res.ok, status: res.status };
  } catch { return { ok: false, error: 'network' }; }   // nunca registra a URL: ela contém o token
}

/** Chamado pelo agendamento. cron = a expressão que disparou (event.cron). Devolve o que foi enviado (para testes e logs). */
export async function runScheduled(env, cron, now, fetchImpl = globalThis.fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { skipped: 'not_configured', sent: [] };
  if (cron === WEEKLY_CRON) {
    const r = await sendTelegram(env, weeklyText(await summary(env.DB, 7, now), env.PANEL_URL || ''), fetchImpl);
    return { sent: r.ok ? ['weekly'] : [], failed: r.ok ? [] : ['weekly'] };
  }
  const rows = (await env.DB.prepare('SELECT name, key, n FROM counters WHERE day = ?1').bind(day(now)).all()).results || [];
  const sent = [], failed = [];
  const all = evaluate(rows);
  if (cfConfigured(env)) all.push(...usageAlerts(await cloudflareStats(env, now, fetchImpl)));   // perto do limite grátis da Cloudflare
  for (const a of all) {
    const last = await env.DB.prepare('SELECT last_at FROM alerts WHERE kind = ?1').bind(a.kind).first();
    if (last && now - last.last_at < COOLDOWN_S) continue;                      // já avisou há pouco
    const r = await sendTelegram(env, a.text + (env.PANEL_URL ? '\n' + env.PANEL_URL : ''), fetchImpl);
    if (r.ok) {
      await env.DB.prepare('INSERT INTO alerts (kind, last_at) VALUES (?1, ?2) ON CONFLICT(kind) DO UPDATE SET last_at = ?2').bind(a.kind, now).run();
      sent.push(a.kind);
    } else failed.push(a.kind);                                                // não grava: tenta de novo na próxima rodada
  }
  return { sent, failed };
}

// ---------- comandos no Telegram: você pergunta, o bot responde com os números do painel ----------
const HELP = [
  'Comandos do Dalari Cine:',
  '/agora \u2014 quem est\u00E1 com o app aberto neste momento e o resumo de hoje',
  '/hoje \u2014 todos os contadores de hoje (UTC)',
  '/semana \u2014 resumo dos \u00FAltimos 7 dias',
  '/erros \u2014 erros do app hoje e nesta semana',
  '/cloudflare \u2014 uso da sua conta Cloudflare hoje (Workers e D1) em rela\u00e7\u00e3o aos limites do plano gr\u00e1tis',
  '/ajuda \u2014 esta lista',
].join('\n');

/** Texto de /agora: presença ao vivo (último aviso nos últimos 5 min) + o dia de hoje. */
export function nowText(sum, panelUrl = '') {
  const t = sum.now || { active: 0, idle: 0, room: 0, call: 0 };
  const rows = sum.counters || [];
  const tried = total(rows, 'pair_try'), joined = total(rows, 'pair_joined');
  const today = (sum.dailyActive || []).at(-1)?.n || 0;
  const errs = byKey(rows, 'app_error'), errTotal = Object.values(errs).reduce((a, n) => a + n, 0);
  const lines = [
    '\u{1F7E2} Agora (\u00FAltimos 5 min)',
    `Com o app aberto: ${t.active} \u00B7 em sala: ${t.room} \u00B7 em chamada: ${t.call}`,
    '',
    'Hoje (UTC)',
    `Pessoas ativas: ${today} \u00B7 salas criadas: ${total(rows, 'room_created')} \u00B7 chamadas iniciadas: ${total(rows, 'call_started')}`,
    tried ? `Pareamento: ${joined} de ${tried} chegaram \u00E0 sala (${pct(joined, tried)}%)` : 'Pareamento: sem tentativas',
    `Falhas de voz: ${total(rows, 'voice_failed')} \u00B7 erros do app: ${errTotal}`,
  ];
  if (panelUrl) lines.push('', panelUrl);
  return lines.join('\n');
}
export function todayText(sum) {
  const rows = (sum.counters || []).slice().sort((a, b) => (a.name + a.key).localeCompare(b.name + b.key));
  if (!rows.length) return 'Hoje ainda n\u00E3o chegou nenhum contador.';
  return ['\u{1F4C5} Contadores de hoje (UTC)', ...rows.map((r) => `${r.name}${r.key ? ' [' + r.key + ']' : ''}: ${r.n}`)].join('\n');
}
export function errorsText(day1, week) {
  const a = byKey(day1.counters || [], 'app_error'), b = byKey(week.counters || [], 'app_error');
  const fmt = (m) => (Object.keys(m).length ? list(m) : 'nenhum');
  return `\u{1F6A8} Erros do app\nHoje: ${fmt(a)}\nSemana: ${fmt(b)}`;
}

/** Resposta ao comando recebido. Devolve o texto ou null (não é um comando que a gente conhece). */
export async function commandReply(env, text, now, fetchImpl = globalThis.fetch) {
  const cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
  if (cmd === '/start' || cmd === '/ajuda' || cmd === '/help') return HELP;
  if (cmd === '/agora') return nowText(await summary(env.DB, 1, now), env.PANEL_URL || '');
  if (cmd === '/hoje') return todayText(await summary(env.DB, 1, now));
  if (cmd === '/semana') return weeklyText(await summary(env.DB, 7, now), env.PANEL_URL || '');
  if (cmd === '/cloudflare' || cmd === '/infra' || cmd === '/limites') return cloudflareText(await cloudflareStats(env, now, fetchImpl), env.PANEL_URL || '');
  if (cmd === '/erros') return errorsText(await summary(env.DB, 1, now), await summary(env.DB, 7, now));
  return null;
}

// comparação sem curto-circuito
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Webhook do Telegram. Só responde ao SEU chat e só se o cabeçalho secreto bater; todo o resto é ignorado em silêncio (200). */
export async function handleTelegramWebhook(request, env, now, fetchImpl = globalThis.fetch) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { status: 503 };
  if (!sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) return { status: 401 };
  let update = null;
  try { update = JSON.parse(await request.text()); } catch { return { status: 400 }; }
  const msg = update?.message;
  if (!msg || String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID) || typeof msg.text !== 'string') return { status: 200, ignored: true };
  const reply = await commandReply(env, msg.text, now, fetchImpl);
  if (reply === null) return { status: 200, ignored: true };
  const r = await sendTelegram(env, reply, fetchImpl);
  return { status: 200, replied: !!r.ok };
}
