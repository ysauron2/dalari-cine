'use strict';
/* Catálogo TMDB opcional. A credencial fica somente no processo Node. */
const API = 'https://api.themoviedb.org/3';
const IMAGE = 'https://image.tmdb.org/t/p/w342';
const REGION = 'BR';
// Nomes exatos da lista oficial do TMDB. Canais extras do Prime ficam de fora.
const SERVICE_RULES = [
  { key: 'netflix', label: 'Netflix', names: ['Netflix'], modes: ['flatrate'] },
  { key: 'prime', label: 'Prime Video', names: ['Amazon Prime Video', 'Prime Video'], modes: ['flatrate'] },
  { key: 'crunchyroll', label: 'Crunchyroll', names: ['Crunchyroll'], modes: ['flatrate'] },
  { key: 'youtube', label: 'YouTube grátis', names: ['YouTube'], modes: ['free'] },
];

const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const imageUrl = (path) => typeof path === 'string' && /^\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(path) ? IMAGE + path : '';
const genreNames = (list) => new Map((Array.isArray(list?.genres) ? list.genres : []).filter((x) => Number.isInteger(x.id) && typeof x.name === 'string').map((x) => [x.id, clean(x.name, 40)]));

function normalizeTitle(raw, type, genres) {
  if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= 0 || raw.adult === true) return null;
  const title = clean(type === 'movie' ? raw.title : raw.name, 140);
  const image = imageUrl(raw.poster_path) || imageUrl(raw.backdrop_path);
  if (!title || !image) return null;
  const ids = Array.isArray(raw.genre_ids) ? raw.genre_ids.filter(Number.isInteger) : [];
  const canonicalGenres = new Map([[878, 'ficção científica'], [10765, 'ficção científica'], [12, 'aventura'], [10759, 'aventura']]);
  const tags = [...new Set(ids.map((id) => canonicalGenres.get(id) || genres.get(id)?.toLocaleLowerCase('pt-BR')).filter(Boolean))];
  const anime = type === 'tv' && ids.includes(16) && (raw.original_language === 'ja' || raw.origin_country?.includes('JP'));
  if (anime) tags.unshift('anime');
  const genre = anime ? 'Anime' : genres.get(ids[0]) || 'Outros';
  return {
    id: `tmdb:${type}:${raw.id}`, tmdbId: raw.id, mediaType: type,
    title, kind: anime ? 'Anime' : type === 'movie' ? 'Filme' : 'Série',
    service: 'TMDB', genre, minutes: null, image,
    description: clean(raw.overview, 500) || 'Sinopse ainda não disponível em português.',
    tags: tags.length ? [...new Set(tags)] : ['outros'],
    tmdbRating: Number.isFinite(raw.vote_average) && raw.vote_count >= 30 ? Math.round(raw.vote_average * 10) / 10 : null,
    warmth: ids.includes(10749) || ids.includes(35) ? 4 : ids.includes(16) ? 3 : 2,
    adventure: ids.includes(12) || ids.includes(10759) || ids.includes(10765) || ids.includes(878) ? 4 : 2,
    year: clean(type === 'movie' ? raw.release_date : raw.first_air_date, 10).slice(0, 4),
    tmdbUrl: `https://www.themoviedb.org/${type}/${raw.id}`,
  };
}

function buildCatalog(movieData, tvData, animeData, movieGenres, tvGenres) {
  const seen = new Set(), result = [];
  for (const [type, data, genres, limit] of [
    ['movie', movieData, movieGenres, 18], ['tv', tvData, tvGenres, 18], ['tv', animeData, tvGenres, 14],
  ]) {
    let taken = 0;
    for (const raw of Array.isArray(data?.results) ? data.results : []) {
      const item = normalizeTitle(raw, type, genres);
      if (!item || seen.has(item.id)) continue;
      if (data === animeData && item.kind !== 'Anime') continue;
      result.push(item); seen.add(item.id); if (++taken >= limit) break;
    }
  }
  return result;
}

function providerRules(data) {
  const providers = Array.isArray(data?.results) ? data.results : [];
  const byId = new Map();
  for (const provider of providers) {
    if (!Number.isSafeInteger(provider?.provider_id) || provider.provider_id <= 0 || typeof provider.provider_name !== 'string') continue;
    const rule = SERVICE_RULES.find((service) => service.names.includes(provider.provider_name));
    if (rule) byId.set(provider.provider_id, rule);
  }
  return byId;
}

function withVerifiedAvailability(item, data, rules) {
  const brazil = data?.results?.[REGION];
  if (!brazil) return null;
  const matched = [];
  for (const [id, rule] of rules) {
    if (rule.modes.some((mode) => Array.isArray(brazil[mode]) && brazil[mode].some((entry) => entry?.provider_id === id))) {
      if (!matched.some((service) => service.key === rule.key)) matched.push(rule);
    }
  }
  if (!matched.length) return null;
  const watchProviders = matched.map((service) => service.label);
  return { ...item, watchProviders, service: watchProviders[0] + (watchProviders.length > 1 ? ` +${watchProviders.length - 1}` : ''),
    watchUrl: `https://www.themoviedb.org/${item.mediaType}/${item.tmdbId}/watch?locale=BR` };
}

async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index]); }
      catch { results[index] = null; } // Falha de disponibilidade: nunca mostrar o título como assistível.
    }
  }));
  return results.filter(Boolean);
}

async function loadTmdbCatalog(token, request = fetch) {
  if (typeof token !== 'string' || !token.trim()) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(token.trim())) throw new Error('TMDB_TOKEN_INVALID_FORMAT');
  const get = async (path, params = {}) => {
    const url = new URL(API + path);
    for (const [key, value] of Object.entries({ language: 'pt-BR', ...params })) url.searchParams.set(key, String(value));
    const response = await request(url, { headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
    return response.json();
  };
  const [movieProviderData, tvProviderData, movieGenreData, tvGenreData] = await Promise.all([
    get('/watch/providers/movie', { watch_region: REGION }), get('/watch/providers/tv', { watch_region: REGION }),
    get('/genre/movie/list'), get('/genre/tv/list'),
  ]);
  const movieRules = providerRules(movieProviderData), tvRules = providerRules(tvProviderData);
  if (!movieRules.size && !tvRules.size) throw new Error('TMDB sem provedores selecionados no Brasil');
  const discoverOptions = (rules) => ({ include_adult: 'false', page: 1, sort_by: 'popularity.desc',
    watch_region: REGION, with_watch_providers: [...rules.keys()].join('|'), with_watch_monetization_types: 'flatrate|free' });
  const [movies, series, anime] = await Promise.all([
    movieRules.size ? get('/discover/movie', { ...discoverOptions(movieRules), region: REGION }) : { results: [] },
    tvRules.size ? get('/discover/tv', discoverOptions(tvRules)) : { results: [] },
    tvRules.size ? get('/discover/tv', { ...discoverOptions(tvRules), with_genres: 16, with_origin_country: 'JP' }) : { results: [] },
  ]);
  const candidates = buildCatalog(movies, series, anime, genreNames(movieGenreData), genreNames(tvGenreData));
  const catalog = await mapLimited(candidates, 5, async (item) => withVerifiedAvailability(item,
    await get(`/${item.mediaType}/${item.tmdbId}/watch/providers`), item.mediaType === 'movie' ? movieRules : tvRules));
  if (catalog.length < 3) throw new Error('TMDB retornou poucos títulos com assinatura confirmada no Brasil');
  return catalog;
}

module.exports = { loadTmdbCatalog, normalizeTitle, buildCatalog, genreNames, providerRules, withVerifiedAvailability };
