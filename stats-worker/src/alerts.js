// Bot do Telegram do criador: avisos automáticos, resumo semanal e respostas a comandos/botões.
//   a cada 30 min  -> confere os contadores de hoje (UTC) e a Cloudflare; avisa se algo falha muito (1 aviso por tipo a cada 6 h)
//   segunda 12:00 UTC (09:00 em Brasília) -> resumo da semana
//   você toca num botão (ou manda um comando) -> resposta na hora (webhook)
// Só usa contadores agregados: nada que identifique alguém. Os textos ficam em messages.js e cloudflare.js.
import { summary } from './index.js';
import { cloudflareStats, cloudflareText, usageAlerts, configured as cfConfigured } from './cloudflare.js';
import { statusText, nowText, todayText, weekText, errorsText, versionsText, helpText, alerts, WELCOME, UNKNOWN, newInstallText, newVersionText, dailyText } from './messages.js';
import { KEYBOARD, commandFromText } from './format.js';
import { catalogNote } from './catalog.js';

export const WEEKLY_CRON = '0 12 * * 1';
export const DAILY_CRON = '0 1 * * *';          // 01:00 UTC = 22:00 em Brasília
export const COOLDOWN_S = 6 * 3600;
const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

export const evaluate = alerts;
export const weeklyText = weekText;

const stripHtml = (t) => String(t).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Envia ao seu chat. HTML do Telegram + teclado de botões sempre visível; se o Telegram recusar o HTML, reenvia como texto simples. */
export async function sendTelegram(env, text, fetchImpl = globalThis.fetch, { keyboard = true } = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, skipped: 'not_configured' };
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const post = (body) => fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const base = { chat_id: env.TELEGRAM_CHAT_ID, disable_web_page_preview: true, ...(keyboard ? { reply_markup: KEYBOARD } : {}) };
  try {
    let res = await post({ ...base, text: String(text).slice(0, 3800), parse_mode: 'HTML' });
    if (res.status === 400) res = await post({ ...base, text: stripHtml(text).slice(0, 3800) });   // HTML recusado: manda sem formatação, nunca perde o aviso
    return { ok: res.ok, status: res.status };
  } catch { return { ok: false, error: 'network' }; }   // nunca registra a URL: ela contém o token
}

/** Chamado pelo agendamento. cron = a expressão que disparou (event.cron). Devolve o que foi enviado (para testes e logs). */
export async function runScheduled(env, cron, now, fetchImpl = globalThis.fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { skipped: 'not_configured', sent: [] };
  if (cron === DAILY_CRON) {
    const cf = cfConfigured(env) ? await cloudflareStats(env, now, fetchImpl) : null;
    const r = await sendTelegram(env, dailyText(await summary(env.DB, 1, now), cf, env.PANEL_URL || '') + await catalogNote(env.DB, now), fetchImpl);
    return { sent: r.ok ? ['daily'] : [], failed: r.ok ? [] : ['daily'] };
  }
  if (cron === WEEKLY_CRON) {
    const r = await sendTelegram(env, weekText(await summary(env.DB, 7, now), env.PANEL_URL || ''), fetchImpl);
    return { sent: r.ok ? ['weekly'] : [], failed: r.ok ? [] : ['weekly'] };
  }
  const rows = (await env.DB.prepare('SELECT name, key, n FROM counters WHERE day = ?1').bind(day(now)).all()).results || [];
  const sent = [], failed = [];
  const all = evaluate(rows);
  if (cfConfigured(env)) all.push(...usageAlerts(await cloudflareStats(env, now, fetchImpl)));   // perto do limite grátis da Cloudflare
  for (const a of all) {
    const last = await env.DB.prepare('SELECT last_at FROM alerts WHERE kind = ?1').bind(a.kind).first();
    if (last && now - last.last_at < COOLDOWN_S) continue;                      // já avisou há pouco
    const r = await sendTelegram(env, a.text + (env.PANEL_URL ? '\n\n' + env.PANEL_URL : ''), fetchImpl);
    if (r.ok) {
      await env.DB.prepare('INSERT INTO alerts (kind, last_at) VALUES (?1, ?2) ON CONFLICT(kind) DO UPDATE SET last_at = ?2').bind(a.kind, now).run();
      sent.push(a.kind);
    } else failed.push(a.kind);                                                // não grava: tenta de novo na próxima rodada
  }
  return { sent, failed };
}

// ---------- comandos e botões ----------
/** Resposta ao comando (ou botão). Devolve o texto em HTML ou null se não for um comando conhecido. */
export async function commandReply(env, text, now, fetchImpl = globalThis.fetch) {
  const cmd = commandFromText(text);
  if (!cmd) return null;
  const panel = env.PANEL_URL || '';
  if (cmd === '/start') return WELCOME;
  if (cmd === '/ajuda' || cmd === '/help' || cmd === '/menu') return helpText();
  if (cmd === '/status' || cmd === '/tudo' || cmd === '/ok') {
    const cf = cfConfigured(env) ? await cloudflareStats(env, now, fetchImpl) : null;
    return statusText(await summary(env.DB, 1, now), cf, panel);
  }
  if (cmd === '/agora') return nowText(await summary(env.DB, 1, now), panel);
  if (cmd === '/hoje') return todayText(await summary(env.DB, 1, now));
  if (cmd === '/semana') return weekText(await summary(env.DB, 7, now), panel);
  if (cmd === '/erros') return errorsText(await summary(env.DB, 1, now), await summary(env.DB, 7, now));
  if (cmd === '/versoes' || cmd === '/versao') return versionsText(await summary(env.DB, 7, now));
  if (cmd === '/cloudflare' || cmd === '/infra' || cmd === '/limites') return cloudflareText(await cloudflareStats(env, now, fetchImpl), panel);
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
  const reply = (await commandReply(env, msg.text, now, fetchImpl)) ?? UNKNOWN;       // dono digitou algo estranho: orienta em vez de calar
  const r = await sendTelegram(env, reply, fetchImpl);
  return { status: 200, replied: !!r.ok };
}

// ---------- avisos de novidade (chamados na hora em que um aviso do app chega) ----------
const MAX_NEW_INSTALL_MESSAGES_PER_DAY = 10;      // acima disso o resumo do dia conta; evita enxurrada de mensagens
/** info = { newInstall, previousApp, newVersion } devolvido por recordPing. Nunca lança: aviso é opcional. */
export async function notifyActivity(env, p, info, now, fetchImpl = globalThis.fetch) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || (!info.newInstall && !info.newVersion)) return { sent: false };
    if (info.newVersion) return { sent: (await sendTelegram(env, newVersionText(p, info), fetchImpl)).ok === true, kind: 'version' };
    const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM installs').bind().first())?.n || 0;
    const startOfDay = Math.floor(now / 86400) * 86400;
    const newToday = (await env.DB.prepare('SELECT COUNT(*) AS n FROM installs WHERE first_seen >= ?1').bind(startOfDay).first())?.n || 0;
    if (newToday > MAX_NEW_INSTALL_MESSAGES_PER_DAY) return { sent: false, skipped: 'many_today' };
    return { sent: (await sendTelegram(env, newInstallText(p, { total, newToday }), fetchImpl)).ok === true, kind: 'install' };
  } catch { return { sent: false }; }
}
