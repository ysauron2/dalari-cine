'use strict';
/* Catálogo de títulos vindo do serviço do criador (Worker na Cloudflare, que guarda o token do TMDB). O pedido não leva nenhum dado
   da pessoa; a Cloudflare só vê o endereço de rede, como em qualquer site. Tudo o que chega é validado campo a campo antes de ser usado:
   o que não estiver no formato esperado é descartado, e se sobrar pouco o app continua com o catálogo que veio junto (catálogo local). */

const WATCH = ['Netflix', 'Prime Video', 'Crunchyroll', 'YouTube grátis'];
const KINDS = ['Filme', 'Série', 'Anime'];
const MAX_BYTES = 600000, MAX_TITLES = 200;
const text = (v, max) => (typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= max ? v : null);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** Um título no formato que a sala aceita, só com os campos conhecidos; null se algo essencial estiver fora do padrão. */
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = /^tmdb:(movie|tv):([1-9][0-9]{0,9})$/.exec(raw.id || '');
  if (!m) return null;
  const [, type, tmdbId] = m;
  const title = text(raw.title, 140), genre = text(raw.genre, 40), service = text(raw.service, 40);
  const image = typeof raw.image === 'string' && /^https:\/\/image\.tmdb\.org\/t\/p\/[a-z0-9]+\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(raw.image) ? raw.image : null;
  const providers = Array.isArray(raw.watchProviders) && raw.watchProviders.length && raw.watchProviders.length <= 4 && raw.watchProviders.every((p) => WATCH.includes(p)) ? [...new Set(raw.watchProviders)] : null;
  if (!title || !genre || !service || !image || !providers || !KINDS.includes(raw.kind)) return null;
  if (raw.mediaType !== type || raw.tmdbId !== Number(tmdbId)) return null;
  if (raw.watchUrl !== 'https://www.themoviedb.org/' + type + '/' + tmdbId + '/watch?locale=BR') return null;
  return {
    id: raw.id, tmdbId: Number(tmdbId), mediaType: type, title, kind: raw.kind, service, genre, image, watchProviders: providers,
    watchUrl: raw.watchUrl, tmdbUrl: 'https://www.themoviedb.org/' + type + '/' + tmdbId,
    minutes: int(raw.minutes, 1, 999), trailer: typeof raw.trailer === 'string' && /^[A-Za-z0-9_-]{11}$/.test(raw.trailer) ? raw.trailer : null,
    description: typeof raw.description === 'string' ? raw.description.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, 500) || 'Sinopse ainda não disponível em português.' : 'Sinopse ainda não disponível em português.',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string' && t.length > 0 && t.length <= 30).slice(0, 8) : ['outros'],
    tmdbRating: typeof raw.tmdbRating === 'number' && raw.tmdbRating >= 0 && raw.tmdbRating <= 10 ? raw.tmdbRating : null,
    warmth: int(raw.warmth, 0, 5) ?? 2, adventure: int(raw.adventure, 0, 5) ?? 2,
    year: typeof raw.year === 'string' && /^[0-9]{4}$/.test(raw.year) ? raw.year : '',
  };
}

/** Baixa e valida. Devolve a lista ou null (sem rede, serviço sem catálogo ainda, resposta estranha ou poucos títulos válidos). */
async function loadRemoteCatalog({ origin, fetchImpl = globalThis.fetch, timeoutMs = 3000, min = 8 } = {}) {
  if (typeof origin !== 'string' || !/^https?:\/\//.test(origin) || typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl(origin.replace(/\/+$/, '') + '/v1/catalog', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.text();
    if (body.length > MAX_BYTES) return null;
    const data = JSON.parse(body);
    if (!data || data.v !== 1 || !Array.isArray(data.titles) || data.titles.length > MAX_TITLES) return null;
    const seen = new Set(), list = [];
    for (const raw of data.titles) {
      const item = sanitizeItem(raw);
      if (item && !seen.has(item.id)) { seen.add(item.id); list.push(item); }
    }
    return list.length >= min ? list : null;
  } catch { return null; }
}

module.exports = { loadRemoteCatalog, sanitizeItem, WATCH };
