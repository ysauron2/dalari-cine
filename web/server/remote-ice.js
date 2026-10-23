'use strict';
/* Retransmissor (TURN) para quando a conexão direta entre duas pessoas não abre. O serviço local pede credenciais temporárias ao serviço do criador
   (Worker na Cloudflare, que guarda a chave) e as renova antes de vencer. Sem rede ou sem o serviço configurado, a lista fica vazia e tudo segue
   só com a conexão direta e o STUN, como antes. O pedido não leva dado algum da pessoa (a Cloudflare vê só o endereço de rede). */

const URL_RE = /^(stun|turn|turns):[A-Za-z0-9.-]+:\d{2,5}(\?transport=(udp|tcp))?$/;
const RETRY_MS = 60000;           // depois de uma falha, só tenta de novo depois disso
// Poucos endereços bastam e deixam a oferta de conexão pequena: UDP 3478, UDP 443 e TLS 443 (este último atravessa redes que só deixam passar HTTPS)
const PREFERRED = [/:3478\?transport=udp$/, /:443\?transport=udp$/, /^turns:.*:443\?transport=tcp$/];
function pickTurnUrls(urls) {
  const picked = PREFERRED.map((re) => urls.find((u) => re.test(u))).filter(Boolean);
  return picked.length ? picked : urls.slice(0, 3);
}

/** Aceita só endereços stun/turn/turns em formato conhecido; TURN só com usuário e senha. */
function sanitizeServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 4)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && URL_RE.test(u) && !/:53(\?|$)/.test(u)).slice(0, 8);
    if (!urls.length) continue;
    if (urls.some((u) => u.startsWith('turn'))) {
      if (typeof s.username !== 'string' || typeof s.credential !== 'string' || !s.username || !s.credential || s.username.length > 300 || s.credential.length > 300) continue;
      out.push({ urls: pickTurnUrls(urls), username: s.username, credential: s.credential });
    } else out.push({ urls });
  }
  return out;
}

function createRemoteIce({ url, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 3000 } = {}) {
  const endpoint = typeof url === 'string' && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(url) ? url : '';
  let cache = null;               // { servers, refreshAt, expiresAt }
  let retryAt = 0, inflight = null;

  async function refresh() {
    try {
      const res = await fetchImpl(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = JSON.parse(await res.text());
      const servers = sanitizeServers(body?.iceServers);
      const ttl = Number.isFinite(body?.ttl) && body.ttl >= 300 && body.ttl <= 48 * 3600 ? body.ttl : 3600;
      if (!servers.some((s) => s.urls.some((u) => u.startsWith('turn')))) throw new Error('sem TURN');
      const t = now();
      cache = { servers, refreshAt: t + ttl * 700, expiresAt: t + ttl * 950 };      // renova com 30% de sobra; descarta com 5%
      retryAt = 0;
    } catch { retryAt = now() + RETRY_MS; }
  }

  return {
    enabled: !!endpoint && typeof fetchImpl === 'function',
    /** Lista atual de servidores (vazia se não há como obter). Renova se estiver perto de vencer. */
    async get() {
      if (!endpoint || typeof fetchImpl !== 'function') return [];
      const t = now();
      if (cache && t < cache.refreshAt) return cache.servers;
      if (t >= retryAt) {
        if (!inflight) inflight = refresh().finally(() => { inflight = null; });
        await inflight;
      } else if (inflight) await inflight;
      return cache && now() < cache.expiresAt ? cache.servers : [];
    },
    /** Sem esperar: já deixa a primeira busca em andamento (chamada ao abrir o serviço). */
    warm() { void this.get(); },
  };
}

module.exports = { createRemoteIce, sanitizeServers };
