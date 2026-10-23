// Credenciais TURN de curta duração para o app (Cloudflare Realtime TURN). O token da chave fica só aqui, como segredo do Worker; o app recebe
// apenas usuário e senha temporários. O TURN só entra quando a conexão direta entre as duas pessoas não é possível (redes que bloqueiam, CGNAT):
// os dados continuam cifrados de ponta a ponta e a Cloudflare só vê endereços de rede e a quantidade de dados.
// Custo: a Cloudflare cobra pelo tráfego que sai do TURN (1 000 GB grátis; depois US$ 0,05/GB). Por isso: validade curta, limite por pessoa e limite diário.

export const TTL_S = 4 * 3600;            // validade das credenciais
export const PER_IP_PER_HOUR = 30;        // pedidos por pessoa (por endereço) por hora
export const PER_DAY = 3000;              // pedidos no dia, de todos juntos
const API = 'https://rtc.live.cloudflare.com/v1/turn/keys/';
const KEY_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const URL_RE = /^(stun|turn|turns):[A-Za-z0-9.-]+:\d{2,5}(\?transport=(udp|tcp))?$/;

const perIp = new Map();
function limitedIp(ip, now) {
  const key = String(ip || 'x');
  const t = (perIp.get(key) || []).filter((x) => now - x < 3600);
  if (t.length >= PER_IP_PER_HOUR) { perIp.set(key, t); return true; }
  t.push(now); perIp.set(key, t);
  if (perIp.size > 5000) for (const [k, v] of perIp) if (!v.some((x) => now - x < 3600)) perIp.delete(k);
  return false;
}
export const resetIceLimits = () => perIp.clear();

/** Só o que o app precisa: endereços stun/turn/turns em formato conhecido (sem a porta 53, que os navegadores bloqueiam) e, para o TURN, usuário e senha. */
export function sanitizeIceServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 4)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && URL_RE.test(u) && !/:53(\?|$)/.test(u)).slice(0, 8);
    if (!urls.length) continue;
    const needsAuth = urls.some((u) => u.startsWith('turn'));
    if (needsAuth) {
      if (typeof s.username !== 'string' || typeof s.credential !== 'string' || !s.username || !s.credential || s.username.length > 300 || s.credential.length > 300) continue;
      out.push({ urls, username: s.username, credential: s.credential });
    } else out.push({ urls });
  }
  return out;
}

/** GET /v1/ice. Devolve { status, body }. */
export async function handleIce(request, env, now, fetchImpl = globalThis.fetch) {
  const keyId = typeof env.TURN_KEY_ID === 'string' ? env.TURN_KEY_ID.trim() : '', token = typeof env.TURN_KEY_API_TOKEN === 'string' ? env.TURN_KEY_API_TOKEN.trim() : '';
  if (!keyId || !token || !KEY_ID_RE.test(keyId)) return { status: 503, body: { ok: false, error: 'not_configured' } };
  if (limitedIp(request.headers.get('CF-Connecting-IP'), now)) return { status: 429, body: { ok: false, error: 'rate_limited' } };
  const dayKey = new Date(now * 1000).toISOString().slice(0, 10);
  try {
    const row = await env.DB.prepare("SELECT n FROM counters WHERE day = ?1 AND name = 'ice_issued' AND key = ''").bind(dayKey).first();
    if ((row?.n || 0) >= PER_DAY) return { status: 429, body: { ok: false, error: 'daily_limit' } };
  } catch { return { status: 503, body: { ok: false, error: 'storage' } }; }
  let data = null;
  try {
    const res = await fetchImpl(API + encodeURIComponent(keyId) + '/credentials/generate-ice-servers', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: TTL_S }), signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { status: 502, body: { ok: false, error: 'upstream', upstream_status: res.status } };
    data = await res.json();
  } catch { return { status: 502, body: { ok: false, error: 'upstream' } }; }
  const iceServers = sanitizeIceServers(data?.iceServers);
  if (!iceServers.some((s) => s.urls.some((u) => u.startsWith('turn')))) return { status: 502, body: { ok: false, error: 'upstream' } };
  try { await env.DB.prepare("INSERT INTO counters (day, name, key, n) VALUES (?1, 'ice_issued', '', 1) ON CONFLICT(day, name, key) DO UPDATE SET n = n + 1").bind(dayKey).run(); } catch { /* contagem é só para o limite */ }
  return { status: 200, body: { ok: true, ttl: TTL_S, iceServers } };
}
