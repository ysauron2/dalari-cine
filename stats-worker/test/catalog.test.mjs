import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../src/index.js';
import { refreshCatalog, readCatalog, catalogNote, pickTrailer, runtimeOf, providerRules, enrichment, buildCandidates, DETAIL_BUDGET, FRESH_S, DETAIL_TTL_S } from '../src/catalog.js';

function makeDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    raw,
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return { bind: (...args) => ({ run: () => stmt.run(...args), first: async () => { const r = stmt.get(...args); return r ? { ...r } : null; }, all: async () => ({ results: stmt.all(...args).map((r) => ({ ...r })) }) }) };
    },
    async batch(list) { for (const s of list) s.run(); },
  };
}
const T0 = 1_800_000_000;
const ENV = (db, extra = {}) => ({ DB: db, TMDB_READ_ACCESS_TOKEN: 'tok_en-123.abc', ...extra });

// ---------- TMDB de mentira ----------
const GENRES = { genres: [{ id: 28, name: 'Ação' }, { id: 35, name: 'Comédia' }, { id: 16, name: 'Animação' }, { id: 53, name: 'Thriller' }] };
const PROVIDERS = { results: [{ provider_id: 8, provider_name: 'Netflix' }, { provider_id: 119, provider_name: 'Amazon Prime Video' }, { provider_id: 283, provider_name: 'Crunchyroll' }, { provider_id: 999, provider_name: 'Outro Canal' }] };
const raw = (id, name, extra = {}) => ({ id, title: name, name, poster_path: '/p' + id + '.jpg', overview: 'Sinopse de ' + name, genre_ids: [28], vote_average: 7.4, vote_count: 500, release_date: '2025-05-01', first_air_date: '2025-05-01', ...extra });
function fakeTmdb({ movies = 6, tvs = 4, animes = 3, unavailable = [], failIds = [], hits = [] } = {}) {
  const list = (prefix, n, extra) => ({ results: Array.from({ length: n }, (_, i) => raw(prefix + i, 'Título ' + prefix + i, extra)) });
  return async (url, init) => {
    const u = new URL(url); hits.push(u.pathname + (u.searchParams.get('append_to_response') ? '+' : ''));
    assert.equal(init.headers.Authorization, 'Bearer tok_en-123.abc');
    assert.equal(u.searchParams.get('language'), 'pt-BR');
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    const p = u.pathname;
    if (p.startsWith('/3/watch/providers')) return ok(PROVIDERS);
    if (p.startsWith('/3/genre')) return ok(GENRES);
    if (p === '/3/discover/movie') return ok(list(100, movies));
    if (p === '/3/discover/tv') return ok(u.searchParams.get('with_genres') === '16' ? list(300, animes, { genre_ids: [16], original_language: 'ja', origin_country: ['JP'] }) : list(200, tvs, { genre_ids: [35] }));
    const m = /^\/3\/(movie|tv)\/(\d+)$/.exec(p);
    if (m) {
      const id = Number(m[2]);
      if (failIds.includes(id)) return new Response('x', { status: 500 });
      const flatrate = unavailable.includes(id) ? [] : [{ provider_id: id >= 300 ? 283 : id >= 200 ? 119 : 8 }];
      return ok({ id, runtime: m[1] === 'movie' ? 90 + (id % 50) : undefined, episode_run_time: m[1] === 'tv' ? [24] : undefined,
        'watch/providers': { results: { BR: { flatrate }, US: { flatrate: [{ provider_id: 8 }] } } },
        videos: { results: [{ site: 'YouTube', type: 'Teaser', key: 'TEASER12345', official: true }, { site: 'YouTube', type: 'Trailer', key: 'TRAILER1234', official: true }, { site: 'Vimeo', type: 'Trailer', key: 'VIMEO123456' }] } });
    }
    return new Response('not found', { status: 404 });
  };
}

test('trailer, duração e disponibilidade: só o que é confiável entra', () => {
  assert.equal(pickTrailer({ results: [{ site: 'YouTube', type: 'Teaser', key: 'TEASER12345' }, { site: 'YouTube', type: 'Trailer', key: 'TRAILER1234', official: true }] }), 'TRAILER1234');
  assert.equal(pickTrailer({ results: [{ site: 'YouTube', type: 'Teaser', key: 'TEASER12345' }] }), 'TEASER12345');
  assert.equal(pickTrailer({ results: [{ site: 'YouTube', type: 'Clip', key: 'CLIP1234567' }, { site: 'Vimeo', type: 'Trailer', key: 'VIMEO123456' }, { site: 'YouTube', type: 'Trailer', key: 'curto' }, { site: 'YouTube', type: 'Trailer', key: 'ab"<script>' }] }), null);
  assert.equal(pickTrailer(undefined), null);
  assert.equal(runtimeOf({ runtime: 112 }, 'movie'), 112); assert.equal(runtimeOf({ runtime: 0 }, 'movie'), null); assert.equal(runtimeOf({ runtime: 5000 }, 'movie'), null);
  assert.equal(runtimeOf({ episode_run_time: [45, 50] }, 'tv'), 45); assert.equal(runtimeOf({ episode_run_time: [] }, 'tv'), null);
  const rules = providerRules(PROVIDERS);
  assert.equal(rules.size, 3, 'canais fora da lista são ignorados');
  const c = buildCandidates({ results: [raw(1, 'A')] }, { results: [] }, { results: [] }, new Map(), new Map())[0];
  assert.equal(enrichment(c, { 'watch/providers': { results: { US: { flatrate: [{ provider_id: 8 }] } } } }, rules), null, 'só vale o Brasil');
  assert.equal(enrichment(c, { 'watch/providers': { results: { BR: { rent: [{ provider_id: 8 }] } } } }, rules), null, 'aluguel não conta como assinatura');
  const e = enrichment(c, { runtime: 100, 'watch/providers': { results: { BR: { flatrate: [{ provider_id: 8 }, { provider_id: 119 }] } } }, videos: { results: [] } }, rules);
  assert.deepEqual(e, { watchProviders: ['Netflix', 'Prime Video'], service: 'Netflix +1', watchUrl: 'https://www.themoviedb.org/movie/1/watch?locale=BR', minutes: 100, trailer: null });
});

test('primeira atualização: monta o catálogo com duração, trailer e provedores, no formato que o app aceita', async () => {
  const db = makeDb(), hits = [];
  const r = await refreshCatalog(ENV(db), T0, fakeTmdb({ hits }));
  assert.deepEqual({ ok: r.ok, count: r.count, pending: r.pending }, { ok: true, count: 13, pending: 0 });
  const c = await readCatalog(db);
  assert.equal(c.titles.length, 13); assert.equal(c.updatedAt, T0);
  const movie = c.titles.find((t) => t.id === 'tmdb:movie:100');
  assert.deepEqual(movie.watchProviders, ['Netflix']);
  assert.equal(movie.watchUrl, 'https://www.themoviedb.org/movie/100/watch?locale=BR');
  assert.equal(movie.minutes, 90); assert.equal(movie.trailer, 'TRAILER1234');
  assert.equal(movie.image, 'https://image.tmdb.org/t/p/w342/p100.jpg');
  const anime = c.titles.find((t) => t.kind === 'Anime');
  assert.deepEqual(anime.watchProviders, ['Crunchyroll']); assert.equal(anime.minutes, 24);
  for (const t of c.titles) assert.match(t.id, /^tmdb:(movie|tv):[1-9][0-9]*$/);
  assert.ok(hits.length <= 50, 'cabe no limite de chamadas do plano grátis: ' + hits.length);
});

test('título sem assinatura confirmada no Brasil fica de fora, e falha de um título não derruba o resto', async () => {
  const db = makeDb();
  const r = await refreshCatalog(ENV(db), T0, fakeTmdb({ unavailable: [101, 200], failIds: [102] }));
  assert.equal(r.ok, true); assert.equal(r.count, 10); assert.equal(r.pending, 1, 'o que falhou fica para a próxima rodada');
  const ids = (await readCatalog(db)).titles.map((t) => t.id);
  assert.ok(!ids.includes('tmdb:movie:101') && !ids.includes('tmdb:tv:200') && !ids.includes('tmdb:movie:102'));
});

test('em dia: não chama o TMDB; incompleto: continua de onde parou; velho: renova', async () => {
  const db = makeDb(), hits = [];
  await refreshCatalog(ENV(db), T0, fakeTmdb({ hits, failIds: [102] }));              // fica 1 pendente
  hits.length = 0;
  const again = await refreshCatalog(ENV(db), T0 + 1800, fakeTmdb({ hits }));
  assert.equal(again.ok, true); assert.equal(again.pending, 0, 'completou na rodada seguinte');
  assert.equal(hits.filter((h) => h.endsWith('+')).length, 1, 'só buscou o detalhe que faltava');
  hits.length = 0;
  assert.deepEqual(await refreshCatalog(ENV(db), T0 + 3600, fakeTmdb({ hits })), { skipped: 'fresh' });
  assert.equal(hits.length, 0, 'catálogo em dia: nenhuma chamada');
  const old = await refreshCatalog(ENV(db), T0 + 1800 + FRESH_S + 60, fakeTmdb({ hits }));
  assert.equal(old.ok, true); assert.ok(hits.length >= 7, 'refez a lista de populares');
  assert.equal(hits.filter((h) => h.endsWith('+')).length, 0, 'mas não refez detalhes recentes');
  hits.length = 0;
  await refreshCatalog(ENV(db), T0 + DETAIL_TTL_S + 3 * 86400, fakeTmdb({ hits }));
  assert.ok(hits.filter((h) => h.endsWith('+')).length > 0, 'detalhes com mais de 7 dias são renovados');
});

test('catálogo grande: cada rodada respeita o orçamento de chamadas e completa em poucas rodadas', async () => {
  const db = makeDb();
  let total = 0, rounds = 0, last = null;
  while (rounds < 6) {
    const hits = [];
    last = await refreshCatalog(ENV(db), T0 + rounds * 1800, fakeTmdb({ movies: 30, tvs: 30, animes: 20, hits }), { force: false });
    rounds++; total += hits.length;
    assert.ok(hits.length <= DETAIL_BUDGET + 7, 'rodada ' + rounds + ': ' + hits.length);
    if (last.skipped === 'fresh' || last.pending === 0) break;
  }
  assert.equal(last.skipped === 'fresh' || last.pending === 0, true);
  assert.equal((await readCatalog(db)).titles.length, 60, '24 filmes + 24 séries + 12 animes');
  assert.ok(rounds <= 3, 'completou em ' + rounds + ' rodadas');
});

test('erros: sem token nada acontece; erro do TMDB guarda o motivo e mantém o catálogo antigo', async () => {
  const db = makeDb();
  assert.deepEqual(await refreshCatalog({ DB: db }, T0, fakeTmdb()), { skipped: 'not_configured' });
  assert.deepEqual(await refreshCatalog(ENV(db, { TMDB_READ_ACCESS_TOKEN: 'tem espaço' }), T0, fakeTmdb()), { skipped: 'token_invalid' });
  assert.equal(await readCatalog(db), null);
  await refreshCatalog(ENV(db), T0, fakeTmdb());
  const before = (await readCatalog(db)).titles.length;
  const bad = await refreshCatalog(ENV(db), T0 + FRESH_S + 60, async () => new Response('x', { status: 401 }));
  assert.equal(bad.ok, false); assert.match(bad.error, /401/);
  assert.equal((await readCatalog(db)).titles.length, before, 'o catálogo antigo continua valendo');
  assert.match(db.raw.prepare("SELECT v FROM catalog_meta WHERE k = 'last_error'").get().v, /401/);
  const few = makeDb();
  const r = await refreshCatalog(ENV(few), T0, fakeTmdb({ unavailable: [100, 101, 102, 103, 104, 105, 200, 201, 202, 203, 300, 301, 302] }));
  assert.equal(r.ok, false); assert.match(r.error, /poucos/); assert.equal(await readCatalog(few), null);
});

test('GET /v1/catalog: entrega o catálogo com cache e CORS; sem catálogo responde 503 e começa a montar', async () => {
  const db = makeDb(), calls = [];
  const env = ENV(db);
  const original = globalThis.fetch; globalThis.fetch = fakeTmdb({ hits: calls });
  try {
    const res0 = await handle(new Request('https://stats.example/v1/catalog'), env, T0);
    assert.equal(res0.status, 503); assert.equal((await res0.json()).error, 'not_ready');
    assert.ok(calls.length > 0, 'o primeiro pedido começou a montar o catálogo');
    const res = await handle(new Request('https://stats.example/v1/catalog'), env, T0 + 10);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*'); assert.match(res.headers.get('Cache-Control'), /max-age=3600/);
    const body = await res.json();
    assert.equal(body.v, 1); assert.equal(body.titles.length, 13); assert.equal(typeof body.updatedAt, 'number');
    assert.equal((await handle(new Request('https://stats.example/v1/catalog', { method: 'POST' }), env, T0)).status, 405);
    assert.equal((await handle(new Request('https://stats.example/v1/catalog', { method: 'OPTIONS' }), env, T0)).status, 204);
    const text = JSON.stringify(body);
    assert.equal(text.includes('tok_en-123'), false, 'o token nunca aparece');
  } finally { globalThis.fetch = original; }
});

test('resumo do dia: avisa só se o catálogo está parado ou com erro', async () => {
  const db = makeDb();
  assert.equal(await catalogNote(db, T0), '', 'sem token e sem catálogo: nada a dizer');
  await refreshCatalog(ENV(db), T0, fakeTmdb());
  assert.equal(await catalogNote(db, T0 + 86400), '');
  assert.match(await catalogNote(db, T0 + 5 * 86400), /Catálogo sem atualizar há 5 dias/);
  await refreshCatalog(ENV(db), T0 + 5 * 86400, async () => new Response('x', { status: 429 }));
  assert.match(await catalogNote(db, T0 + 5 * 86400 + 60), /Catálogo parado há 5 dias: TMDB HTTP 429/);
});

test('agendamento e esquema: o catálogo é atualizado antes dos alertas e as tabelas existem', () => {
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /refreshCatalog\(env, now\)\.catch\(\(\) => \{\}\)\.then\(\(\) => runScheduled\(env, event\.cron, now\)\)/);
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS catalog_items/); assert.match(schema, /CREATE TABLE IF NOT EXISTS catalog_meta/);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /TMDB_READ_ACCESS_TOKEN/);
});
