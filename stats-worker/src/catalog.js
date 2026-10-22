// Catálogo de títulos do TMDB, montado aqui (o token fica só no Worker, nunca vai para o PC de ninguém) e entregue ao app em GET /v1/catalog.
// Cada título traz onde assistir no Brasil, duração e trailer. O plano grátis da Cloudflare só permite ~50 chamadas externas por execução:
// por isso os detalhes de cada título ficam guardados (catalog_items) e cada execução busca só alguns novos; em poucas rodadas de
// 30 minutos o catálogo completa sozinho, e depois é renovado uma vez por dia.
import { esc } from './format.js';

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
export const DETAIL_BUDGET = 36;          // chamadas de detalhe por execução (6 a 7 já vão no resto; o limite grátis é 50)
export const FRESH_S = 20 * 3600;         // catálogo completo é refeito depois disso
export const DETAIL_TTL_S = 7 * 86400;    // detalhes de um título são refeitos depois disso
const LIMITS = [['movie', 24], ['tv', 24], ['anime', 12]];
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const imageUrl = (path) => (typeof path === 'string' && /^\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(path) ? IMAGE + path : '');
const genreNames = (list) => new Map((Array.isArray(list?.genres) ? list.genres : []).filter((x) => Number.isInteger(x.id) && typeof x.name === 'string').map((x) => [x.id, x.name]));

export function normalizeTitle(raw, type, genres) {
  if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= 0 || raw.adult === true) return null;
  const title = clean(type === 'movie' ? raw.title : raw.name, 140);
  const image = imageUrl(raw.poster_path) || imageUrl(raw.backdrop_path);
  if (!title || !image) return null;
  const ids = Array.isArray(raw.genre_ids) ? raw.genre_ids.filter(Number.isInteger) : [];
  const canonical = new Map([[878, 'ficção científica'], [10765, 'ficção científica'], [12, 'aventura'], [10759, 'aventura']]);
  const tags = [...new Set(ids.map((id) => canonical.get(id) || genres.get(id)?.toLocaleLowerCase('pt-BR')).filter(Boolean))];
  const anime = type === 'tv' && ids.includes(16) && (raw.original_language === 'ja' || (raw.origin_country || []).includes('JP'));
  if (anime) tags.unshift('anime');
  const genre = anime ? 'Anime' : genres.get(ids[0]) || 'Outros';
  return {
    id: 'tmdb:' + type + ':' + raw.id, tmdbId: raw.id, mediaType: type,
    title, kind: anime ? 'Anime' : type === 'movie' ? 'Filme' : 'Série',
    service: 'TMDB', genre, minutes: null, image,
    description: clean(raw.overview, 500) || 'Sinopse ainda não disponível em português.',
    tags: tags.length ? [...new Set(tags)] : ['outros'],
    tmdbRating: Number.isFinite(raw.vote_average) && raw.vote_count >= 30 ? Math.round(raw.vote_average * 10) / 10 : null,
    warmth: ids.includes(10749) || ids.includes(35) ? 4 : ids.includes(16) ? 3 : 2,
    adventure: ids.includes(12) || ids.includes(10759) || ids.includes(10765) || ids.includes(878) ? 4 : 2,
    year: clean(type === 'movie' ? raw.release_date : raw.first_air_date, 10).slice(0, 4),
    tmdbUrl: 'https://www.themoviedb.org/' + type + '/' + raw.id,
  };
}

/** Candidatos em ordem de popularidade, sem repetir: filmes, séries e animes. */
export function buildCandidates(movieData, tvData, animeData, movieGenres, tvGenres) {
  const seen = new Set(), result = [];
  const plan = { movie: [movieData, movieGenres, 'movie'], tv: [tvData, tvGenres, 'tv'], anime: [animeData, tvGenres, 'tv'] };
  for (const [name, limit] of LIMITS) {
    const [data, genres, type] = plan[name];
    let taken = 0;
    for (const raw of Array.isArray(data?.results) ? data.results : []) {
      const item = normalizeTitle(raw, type, genres);
      if (!item || seen.has(item.id)) continue;
      if (name === 'anime' && item.kind !== 'Anime') continue;
      result.push(item); seen.add(item.id);
      if (++taken >= limit) break;
    }
  }
  return result;
}

export function providerRules(data) {
  const byId = new Map();
  for (const p of Array.isArray(data?.results) ? data.results : []) {
    if (!Number.isSafeInteger(p?.provider_id) || p.provider_id <= 0 || typeof p.provider_name !== 'string') continue;
    const rule = SERVICE_RULES.find((s) => s.names.includes(p.provider_name));
    if (rule) byId.set(p.provider_id, rule);
  }
  return byId;
}

/** O melhor trailer do YouTube entre os vídeos do título (oficial primeiro); null se não houver. */
export function pickTrailer(videos) {
  const list = (Array.isArray(videos?.results) ? videos.results : []).filter((v) => v && v.site === 'YouTube' && YT_ID.test(v.key));
  const rank = (v) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 2 : 9) + (v.official ? 0 : 1);
  list.sort((a, b) => rank(a) - rank(b));
  return list.length && rank(list[0]) < 9 ? list[0].key : null;
}

export function runtimeOf(detail, type) {
  const m = type === 'movie' ? detail?.runtime : Array.isArray(detail?.episode_run_time) ? detail.episode_run_time[0] : null;
  return Number.isFinite(m) && m > 0 && m < 1000 ? Math.round(m) : null;
}

/** Só o que o detalhe acrescenta ao título (onde assistir, duração, trailer); null se não há assinatura confirmada no Brasil. */
export function enrichment(candidate, detail, rules) {
  const brazil = detail?.['watch/providers']?.results?.[REGION];
  if (!brazil) return null;
  const matched = [];
  for (const [id, rule] of rules) {
    if (rule.modes.some((mode) => Array.isArray(brazil[mode]) && brazil[mode].some((e) => e?.provider_id === id)) && !matched.some((s) => s.key === rule.key)) matched.push(rule);
  }
  if (!matched.length) return null;
  const watchProviders = matched.map((s) => s.label);
  return {
    watchProviders, service: watchProviders[0] + (watchProviders.length > 1 ? ' +' + (watchProviders.length - 1) : ''),
    watchUrl: 'https://www.themoviedb.org/' + candidate.mediaType + '/' + candidate.tmdbId + '/watch?locale=BR',
    minutes: runtimeOf(detail, candidate.mediaType), trailer: pickTrailer(detail?.videos),
  };
}

async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { results[i] = await task(items[i]); } catch { results[i] = undefined; } }   // falha: tenta de novo na próxima rodada
  }));
  return results;
}

// ---------- armazenamento (D1) ----------
async function readMeta(db) {
  const rows = (await db.prepare('SELECT k, v FROM catalog_meta').bind().all()).results || [];
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}
export async function readCatalog(db) {
  const meta = await readMeta(db);
  if (!meta.titles) return null;
  try { const titles = JSON.parse(meta.titles); return Array.isArray(titles) && titles.length ? { titles, updatedAt: Number(meta.updated_at) || 0 } : null; } catch { return null; }
}

/** Atualiza o catálogo se estiver velho ou incompleto. Seguro de chamar a cada 30 minutos: quando está em dia, só lê o banco. */
export async function refreshCatalog(env, now, fetchImpl = globalThis.fetch, { force = false } = {}) {
  const token = typeof env.TMDB_READ_ACCESS_TOKEN === 'string' ? env.TMDB_READ_ACCESS_TOKEN.trim() : '';
  if (!token) return { skipped: 'not_configured' };
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) return { skipped: 'token_invalid' };
  const meta = await readMeta(env.DB);
  if (!force && meta.titles && now - Number(meta.updated_at || 0) < FRESH_S && !(Number(meta.pending) > 0)) return { skipped: 'fresh' };
  const save = (pairs) => env.DB.batch(pairs.map(([k, v]) => env.DB.prepare('INSERT OR REPLACE INTO catalog_meta (k, v) VALUES (?1, ?2)').bind(k, String(v))));
  try {
    const get = async (path, params = {}) => {
      const url = new URL(API + path);
      for (const [key, value] of Object.entries({ language: 'pt-BR', ...params })) url.searchParams.set(key, String(value));
      const response = await fetchImpl(url.toString(), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('TMDB HTTP ' + response.status);
      return response.json();
    };
    const [movieProviders, tvProviders, movieGenres, tvGenres] = await Promise.all([get('/watch/providers/movie', { watch_region: REGION }), get('/watch/providers/tv', { watch_region: REGION }), get('/genre/movie/list'), get('/genre/tv/list')]);
    const movieRules = providerRules(movieProviders), tvRules = providerRules(tvProviders);
    if (!movieRules.size && !tvRules.size) throw new Error('sem provedores no Brasil');
    const discover = (rules) => ({ include_adult: 'false', page: 1, sort_by: 'popularity.desc', watch_region: REGION, with_watch_providers: [...rules.keys()].join('|'), with_watch_monetization_types: 'flatrate|free' });
    const [movies, series, anime] = await Promise.all([
      movieRules.size ? get('/discover/movie', { ...discover(movieRules), region: REGION }) : { results: [] },
      tvRules.size ? get('/discover/tv', discover(tvRules)) : { results: [] },
      tvRules.size ? get('/discover/tv', { ...discover(tvRules), with_genres: 16, with_origin_country: 'JP' }) : { results: [] },
    ]);
    const candidates = buildCandidates(movies, series, anime, genreNames(movieGenres), genreNames(tvGenres));

    const cachedRows = (await env.DB.prepare('SELECT id, json, fetched_at FROM catalog_items').bind().all()).results || [];
    const cache = new Map(cachedRows.map((r) => [r.id, { at: r.fetched_at, extra: (() => { try { return JSON.parse(r.json); } catch { return undefined; } })() }]));
    // primeiro os que nunca foram buscados, depois os mais velhos que o prazo
    const todo = [...candidates.filter((c) => !cache.has(c.id)), ...candidates.filter((c) => cache.has(c.id) && now - cache.get(c.id).at > DETAIL_TTL_S)].slice(0, DETAIL_BUDGET);
    const fetched = await mapLimited(todo, 5, async (c) => {
      const detail = await get('/' + c.mediaType + '/' + c.tmdbId, { append_to_response: 'watch/providers,videos', include_video_language: 'pt,en,null' });
      return enrichment(c, detail, c.mediaType === 'movie' ? movieRules : tvRules);
    });
    const writes = [];
    todo.forEach((c, i) => {
      if (fetched[i] === undefined) return;                                   // falhou: fica para a próxima rodada
      cache.set(c.id, { at: now, extra: fetched[i] });
      writes.push(env.DB.prepare('INSERT OR REPLACE INTO catalog_items (id, json, fetched_at) VALUES (?1, ?2, ?3)').bind(c.id, JSON.stringify(fetched[i]), now));
    });
    if (writes.length) await env.DB.batch(writes);

    const titles = [];
    let pending = 0;
    for (const c of candidates) {
      const hit = cache.get(c.id);
      if (!hit || hit.extra === undefined) { pending++; continue; }
      if (hit.extra) titles.push({ ...c, ...hit.extra });
    }
    if (titles.length < 3) throw new Error('poucos títulos com assinatura confirmada no Brasil');
    await save([['titles', JSON.stringify(titles)], ['updated_at', now], ['pending', pending], ['last_error', '']]);
    return { ok: true, count: titles.length, pending, fetched: writes.length };
  } catch (e) {
    try { await save([['last_error', String(e && e.message || e).slice(0, 120)], ['last_error_at', now]]); } catch { /* sem banco: nada a fazer */ }
    return { ok: false, error: String(e && e.message || e).slice(0, 120) };
  }
}

/** Linha para o resumo do dia, só quando algo precisa de atenção (catálogo parado ou com erro). */
export async function catalogNote(db, now) {
  try {
    const meta = await readMeta(db);
    if (!meta.titles && !meta.last_error) return '';
    const age = now - Number(meta.updated_at || 0);
    if (meta.last_error && age > 2 * 86400) return '\n\n📚 Catálogo parado há ' + Math.floor(age / 86400) + ' dias: ' + esc(meta.last_error);
    if (meta.titles && age > 3 * 86400) return '\n\n📚 Catálogo sem atualizar há ' + Math.floor(age / 86400) + ' dias.';
    return '';
  } catch { return ''; }
}
