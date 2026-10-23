'use strict';
/* Chave do criador: o serviço local consulta o Worker (GET /v1/flags) para saber se a Netflix na sala está desligada (por exemplo, se a Netflix
   mudou o player e a sincronização quebrou), sem precisar publicar versão nova. Sem rede, sem endereço ou com resposta estranha, nada é desligado:
   se a chave já estava ligada, ela vale por no máximo 1 hora sem confirmação nova (uma queda breve de internet não destrava a Netflix quebrada).
   O pedido não leva dado algum da pessoa. */

const REFRESH_MS = 5 * 60000;
const STALE_MS = 60 * 60000;
const OPEN = Object.freeze({ netflix: true, message: '' });

function createRemoteFlags({ url, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 3000 } = {}) {
  const endpoint = typeof url === 'string' && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(url) ? url : '';
  let known = null, okAt = 0, tryAt = 0, inflight = null;

  async function refresh() {
    try {
      const res = await fetchImpl(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = JSON.parse(await res.text());
      if (!body || body.ok !== true || typeof body.netflix !== 'boolean') throw new Error('resposta inválida');
      known = { netflix: body.netflix, message: body.netflix || typeof body.message !== 'string' ? '' : body.message.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 200) };
      okAt = now();
    } catch { /* mantém o que já sabia */ }
  }

  return {
    enabled: !!endpoint && typeof fetchImpl === 'function',
    /** { netflix: boolean, message }: ligado por padrão; só desliga quando a chave diz isso. */
    async get() {
      if (!endpoint || typeof fetchImpl !== 'function') return OPEN;
      const t = now();
      if (!known || t - tryAt >= REFRESH_MS) {
        tryAt = t;
        if (!inflight) inflight = refresh().finally(() => { inflight = null; });
        await inflight;
      } else if (inflight) await inflight;
      if (!known || now() - okAt > STALE_MS) return OPEN;
      return known;
    },
    warm() { void this.get(); },
  };
}

module.exports = { createRemoteFlags };
