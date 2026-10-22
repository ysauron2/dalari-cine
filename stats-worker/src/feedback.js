// Canal de feedback: o app manda uma mensagem curta (só quando a pessoa clica em Enviar) e ela chega direto ao Telegram do criador.
// Nada é guardado no banco: a mensagem só passa por aqui. Validação estrita, limite por IP e limite diário para não virar spam.
import { sendTelegram } from './alerts.js';
import { esc, OS_NAMES } from './format.js';

export const KINDS = { ideia: '\u{1F4A1} Ideia', problema: '\u{1F41E} Problema', elogio: '\u2764\uFE0F Elogio', outro: '\u{1F4AC} Mensagem' };
export const MAX_MESSAGE = 1000, MAX_CONTACT = 100, MAX_BODY = 4096;
export const PER_IP_PER_HOUR = 3, PER_DAY = 60;
const APP_RE = /^[0-9A-Za-z.+-]{1,20}$/;

const LINE_SEPARATORS = new RegExp('[' + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']', 'g');
const clean = (s) => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(LINE_SEPARATORS, '').replace(/\r\n?/g, '\n').trim();

/** Valida o corpo. Devolve o objeto limpo ou null (campo extra, tipo errado, vazio ou grande demais). */
export function validateFeedback(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.v !== 1) return null;
  const allowed = new Set(['v', 'kind', 'message', 'contact', 'app', 'os']);
  if (Object.keys(body).some((k) => !allowed.has(k))) return null;
  if (typeof body.kind !== 'string' || !Object.hasOwn(KINDS, body.kind)) return null;
  if (typeof body.message !== 'string') return null;
  const message = clean(body.message);
  if (message.length < 3 || message.length > MAX_MESSAGE || (message.match(/\n/g) || []).length > 30) return null;
  const out = { kind: body.kind, message, contact: '', app: '', os: '' };
  if (body.contact !== undefined) {
    if (typeof body.contact !== 'string') return null;
    out.contact = clean(body.contact).replace(/\n/g, ' ');
    if (out.contact.length > MAX_CONTACT) return null;
  }
  if (body.app !== undefined) { if (typeof body.app !== 'string' || !APP_RE.test(body.app)) return null; out.app = body.app; }
  if (body.os !== undefined) { if (typeof body.os !== 'string' || !Object.hasOwn(OS_NAMES, body.os)) return null; out.os = body.os; }
  return out;
}

/** A mensagem como chega no Telegram do criador. Todo texto da pessoa passa por esc(): ela não consegue injetar formatação. */
export function feedbackText(f) {
  const where = [OS_NAMES[f.os], f.app ? 'versão ' + f.app : ''].filter(Boolean).join(' · ');
  const lines = [`${KINDS[f.kind]}${where ? ' — ' + esc(where) : ''}`, '', esc(f.message)];
  lines.push('', f.contact ? `\u{1F4EC} Contato: ${esc(f.contact)}` : '\u{1F910} Sem contato (não dá para responder).');
  return lines.join('\n');
}

const perIp = new Map();
function limitedIp(ip, now) {
  const key = String(ip || 'x');
  const t = (perIp.get(key) || []).filter((x) => now - x < 3600);
  if (t.length >= PER_IP_PER_HOUR) { perIp.set(key, t); return true; }
  t.push(now); perIp.set(key, t);
  if (perIp.size > 5000) for (const [k, v] of perIp) if (!v.some((x) => now - x < 3600)) perIp.delete(k);
  return false;
}
export const resetFeedbackLimits = () => perIp.clear();

/** Atende POST /v1/feedback. Devolve { status, error? }. */
export async function handleFeedback(request, env, now, fetchImpl = globalThis.fetch) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { status: 413, error: 'too_large' };
  let body = null;
  try { body = JSON.parse(text); } catch { /* inválido */ }
  const f = validateFeedback(body);
  if (!f) return { status: 400, error: 'bad_request' };
  if (limitedIp(request.headers.get('CF-Connecting-IP'), now)) return { status: 429, error: 'rate_limited' };
  // limite do dia (todas as pessoas juntas), contado no banco para valer entre instâncias do Worker
  const dayKey = new Date(now * 1000).toISOString().slice(0, 10);
  try {
    const row = await env.DB.prepare("SELECT n FROM counters WHERE day = ?1 AND name = 'feedback_received' AND key = ''").bind(dayKey).first();
    if ((row?.n || 0) >= PER_DAY) return { status: 429, error: 'daily_limit' };
  } catch { return { status: 503, error: 'storage' }; }
  const sent = await sendTelegram(env, feedbackText(f), fetchImpl);
  if (!sent.ok) return { status: sent.skipped ? 503 : 502, error: sent.skipped ? 'unavailable' : 'delivery' };
  try { await env.DB.prepare("INSERT INTO counters (day, name, key, n) VALUES (?1, 'feedback_received', '', 1) ON CONFLICT(day, name, key) DO UPDATE SET n = n + 1").bind(dayKey).run(); } catch { /* o aviso já foi entregue */ }
  return { status: 200 };
}
