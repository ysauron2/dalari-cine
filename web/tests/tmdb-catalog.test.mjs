import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeTitle, buildCatalog, genreNames, loadTmdbCatalog, providerRules, withVerifiedAvailability } = require('../server/tmdb-catalog.js');

const movieGenres = genreNames({ genres: [{ id: 35, name: 'Comédia' }, { id: 10749, name: 'Romance' }] });
const tvGenres = genreNames({ genres: [{ id: 16, name: 'Animação' }, { id: 18, name: 'Drama' }] });
const item = (id, extra = {}) => ({ id, title: `Filme ${id}`, name: `Série ${id}`, poster_path: '/poster.jpg', overview: 'Sinopse', genre_ids: [35], vote_average: 7.5, vote_count: 100, ...extra });

test('TMDB usa tipo e ID como chave canônica e filtra imagem/adulto inválidos', () => {
  const a = normalizeTitle(item(42), 'movie', movieGenres);
  assert.equal(a.id, 'tmdb:movie:42');
  assert.equal(a.image, 'https://image.tmdb.org/t/p/w342/poster.jpg');
  assert.equal(a.tmdbUrl, 'https://www.themoviedb.org/movie/42');
  assert.deepEqual(a.tags, ['comédia']);
  assert.equal(a.tmdbRating, 7.5);
  assert.equal(normalizeTitle(item(42, { adult: true }), 'movie', movieGenres), null);
  assert.equal(normalizeTitle(item(42, { poster_path: 'https://evil.example/a.jpg', backdrop_path: null }), 'movie', movieGenres), null);
  assert.equal(normalizeTitle(item(42, { poster_path: 'bad', backdrop_path: '/backdrop.jpg' }), 'movie', movieGenres).image,
    'https://image.tmdb.org/t/p/w342/backdrop.jpg');
  const anime = normalizeTitle(item(42, { genre_ids: [16], original_language: 'ja' }), 'tv', tvGenres);
  assert.equal(anime.id, 'tmdb:tv:42');
  assert.equal(anime.kind, 'Anime');
  assert.ok(anime.tags.includes('anime'));
});

test('token com caracteres de cabeçalho inválidos é recusado antes da rede', async () => {
  await assert.rejects(loadTmdbCatalog('abc\nsecret', () => { throw new Error('rede não deve ser chamada'); }), /TMDB_TOKEN_INVALID_FORMAT/);
});

test('listas de séries e animes compartilham a mesma chave, sem duplicar', () => {
  const result = buildCatalog(
    { results: [item(42)] },
    { results: [item(42, { genre_ids: [16], original_language: 'ja' }), item(43, { genre_ids: [18] })] },
    { results: [item(42, { genre_ids: [16], original_language: 'ja' }), item(44, { genre_ids: [16], original_language: 'ja' })] },
    movieGenres, tvGenres,
  );
  assert.deepEqual(result.map((x) => x.id), ['tmdb:movie:42', 'tmdb:tv:42', 'tmdb:tv:43', 'tmdb:tv:44']);
});

test('só aceita disponibilidade brasileira incluída; aluguel, compra e canais extras ficam de fora', () => {
  const rules = providerRules({ results: [
    { provider_id: 8, provider_name: 'Netflix' }, { provider_id: 119, provider_name: 'Amazon Prime Video' },
    { provider_id: 283, provider_name: 'Crunchyroll' }, { provider_id: 192, provider_name: 'YouTube' },
    { provider_id: 999, provider_name: 'Crunchyroll Amazon Channel' },
  ] });
  assert.equal(rules.size, 4);
  const film = normalizeTitle(item(42), 'movie', movieGenres);
  assert.equal(withVerifiedAvailability(film, { results: { US: { flatrate: [{ provider_id: 8 }] } } }, rules), null);
  assert.equal(withVerifiedAvailability(film, { results: { BR: { rent: [{ provider_id: 192 }], buy: [{ provider_id: 119 }] } } }, rules), null);
  assert.equal(withVerifiedAvailability(film, { results: { BR: { flatrate: [{ provider_id: 999 }] } } }, rules), null);
  const available = withVerifiedAvailability(film, { results: { BR: { flatrate: [{ provider_id: 8 }, { provider_id: 119 }], free: [{ provider_id: 192 }] } } }, rules);
  assert.deepEqual(available.watchProviders, ['Netflix', 'Prime Video', 'YouTube grátis']);
  assert.equal(available.watchUrl, 'https://www.themoviedb.org/movie/42/watch?locale=BR');
});

test('consulta autenticada mantém token no cabeçalho e entrega catálogo normalizado', async () => {
  const calls = [];
  const request = async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.Authorization });
    const path = url.pathname;
    const data = path.endsWith('/watch/providers/movie') || path.endsWith('/watch/providers/tv')
      ? { results: [{ provider_id: 8, provider_name: 'Netflix' }, { provider_id: 283, provider_name: 'Crunchyroll' }] }
      : /\/(movie|tv)\/\d+\/watch\/providers$/.test(path)
        ? { results: { BR: Number(path.match(/\/(?:movie|tv)\/(\d+)\/watch\/providers$/)[1]) === 1 ? { rent: [{ provider_id: 8 }] } : { flatrate: [{ provider_id: 8 }] } } }
      : path.endsWith('/genre/movie/list') ? { genres: [{ id: 35, name: 'Comédia' }] }
      : path.endsWith('/genre/tv/list') ? { genres: [{ id: 16, name: 'Animação' }] }
      : path.endsWith('/discover/movie') ? { results: Array.from({ length: 10 }, (_, i) => item(i + 1)) }
      : url.searchParams.has('with_genres') ? { results: [item(90, { genre_ids: [16], original_language: 'ja' })] }
      : { results: [item(50, { genre_ids: [16], original_language: 'ja' })] };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const catalog = await loadTmdbCatalog('test-secret', request);
  assert.equal(catalog.length, 11);
  assert.ok(calls.every((c) => c.auth === 'Bearer test-secret' && !c.url.includes('test-secret')));
  assert.ok(catalog.every((c) => c.id.startsWith('tmdb:') && c.watchProviders.length > 0 && c.watchUrl));
  assert.ok(!catalog.some((c) => c.id === 'tmdb:movie:1'));
  assert.ok(calls.filter((c) => c.url.includes('/discover/')).every((c) => c.url.includes('watch_region=BR') && c.url.includes('with_watch_providers=')));
});
