import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadRemoteCatalog, sanitizeItem } = require('../server/catalog-source.js');
const { createRoomService } = require('../server/room-service.js');
const snapshot = require('../data/tmdb-catalog-br.json');

const good = (n, extra = {}) => ({
  id: 'tmdb:movie:' + (1000 + n), tmdbId: 1000 + n, mediaType: 'movie', title: 'Filme ' + n, kind: 'Filme', service: 'Netflix +1', genre: 'Ação', minutes: 100 + n,
  image: 'https://image.tmdb.org/t/p/w342/abc' + n + '.jpg', description: 'Sinopse ' + n, tags: ['ação', 'aventura'], tmdbRating: 7.3, warmth: 2, adventure: 4, year: '2025',
  tmdbUrl: 'https://www.themoviedb.org/movie/' + (1000 + n), watchProviders: ['Netflix', 'Prime Video'], watchUrl: 'https://www.themoviedb.org/movie/' + (1000 + n) + '/watch?locale=BR',
  trailer: 'abcdefghi' + String(n).padStart(2, '0'), ...extra,
});
const reply = (body, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const list = (n) => Array.from({ length: n }, (_, i) => good(i));

test('um título válido passa inteiro, com duração e trailer', () => {
  const item = sanitizeItem(good(1));
  assert.equal(item.minutes, 101); assert.equal(item.trailer, 'abcdefghi01'); assert.deepEqual(item.watchProviders, ['Netflix', 'Prime Video']);
  assert.equal(item.tmdbUrl, 'https://www.themoviedb.org/movie/1001');
});

test('campos fora do padrão: o essencial derruba o título; o resto vira vazio ou é cortado', () => {
  const bad = [null, [], 'x', {}, good(1, { id: 'tmdb:movie:0' }), good(1, { id: 'tmdb:movie:1001', tmdbId: 5 }), good(1, { mediaType: 'tv' }), good(1, { title: '' }), good(1, { title: ' espaço' }),
    good(1, { image: 'https://evil.example/a.jpg' }), good(1, { image: 'http://image.tmdb.org/t/p/w342/a.jpg' }), good(1, { watchProviders: [] }), good(1, { watchProviders: ['HBO'] }),
    good(1, { watchProviders: ['Netflix', 'Netflix', 'Netflix', 'Netflix', 'Netflix'] }), good(1, { watchUrl: 'https://evil.example/' }), good(1, { kind: 'Outro' }), good(1, { service: 'x'.repeat(41) }), good(1, { genre: 5 })];
  for (const b of bad) assert.equal(sanitizeItem(b), null, JSON.stringify(b)?.slice(0, 80));
  assert.equal(sanitizeItem(good(1, { trailer: 'curto' })).trailer, null);
  assert.equal(sanitizeItem(good(1, { trailer: '<script>123' })).trailer, null);
  assert.equal(sanitizeItem(good(1, { trailer: 'abc"def>ghi' })).trailer, null);
  assert.equal(sanitizeItem(good(1, { minutes: 0 })).minutes, null); assert.equal(sanitizeItem(good(1, { minutes: 5000 })).minutes, null); assert.equal(sanitizeItem(good(1, { minutes: '90' })).minutes, null);
  assert.equal(sanitizeItem(good(1, { tmdbRating: 11 })).tmdbRating, null);
  assert.equal(sanitizeItem(good(1, { year: '20x5' })).year, '');
  assert.equal(sanitizeItem(good(1, { description: 'a'.repeat(900) })).description.length, 500);
  assert.equal(sanitizeItem(good(1, { description: String.fromCharCode(0) + 'oi' })).description, 'oi');
  assert.equal(sanitizeItem(good(1, { description: 5 })).description, 'Sinopse ainda não disponível em português.');
  assert.deepEqual(sanitizeItem(good(1, { tags: 'x' })).tags, ['outros']);
  assert.equal(sanitizeItem(good(1, { tags: Array(20).fill('ação') })).tags.length, 8);
  assert.equal('extra' in sanitizeItem(good(1, { extra: 'x', __proto__: { y: 1 } })), false, 'só os campos conhecidos');
});

test('baixar o catálogo: chama o endereço certo, valida e devolve só os títulos bons', async () => {
  let called;
  const fetchImpl = async (url, init) => { called = { url, init }; return new Response(JSON.stringify({ v: 1, updatedAt: 1, titles: [...list(9), good(50, { image: 'https://evil.example/a.jpg' }), good(3)] })); };
  const got = await loadRemoteCatalog({ origin: 'https://dalari-stats.exemplo.workers.dev/', fetchImpl });
  assert.equal(called.url, 'https://dalari-stats.exemplo.workers.dev/v1/catalog');
  assert.equal(called.init.redirect, 'error'); assert.ok(called.init.signal);
  assert.equal(got.length, 9, 'o inválido e o repetido ficam de fora');
  assert.ok(!got.some((t) => t.id === 'tmdb:movie:1050'));
});

test('baixar o catálogo: qualquer problema devolve null e o app usa o catálogo local', async () => {
  const origin = 'https://dalari-stats.exemplo.workers.dev';
  assert.equal(await loadRemoteCatalog({ origin, fetchImpl: reply({ ok: false, error: 'not_ready' }, 503) }), null, 'serviço ainda sem catálogo');
  assert.equal(await loadRemoteCatalog({ origin, fetchImpl: reply('não é json') }), null);
  assert.equal(await loadRemoteCatalog({ origin, fetchImpl: reply({ v: 2, titles: list(12) }) }), null, 'versão desconhecida');
  assert.equal(await loadRemoteCatalog({ origin, fetchImpl: reply({ v: 1, titles: 'x' }) }), null);
  assert.equal(await loadRemoteCatalog({ origin, fetchImpl: reply({ v: 1, titles: list(7) }) }), null, 'poucos títulos válidos');
  assert.equal(await loadRemoteCatalog({ origin, fetchImpl: reply({ v: 1, titles: Array(201).fill(good(1)) }) }), null, 'lista grande demais');
  assert.equal(await loadRemoteCatalog({ origin, fetchImpl: reply('x'.repeat(700000)) }), null, 'resposta grande demais');
  assert.equal(await loadRemoteCatalog({ origin, fetchImpl: async () => { throw new TypeError('sem rede'); } }), null);
  assert.equal(await loadRemoteCatalog({ origin: '', fetchImpl: reply({ v: 1, titles: list(12) }) }), null, 'sem endereço configurado');
  assert.equal(await loadRemoteCatalog({ origin: 'javascript:alert(1)', fetchImpl: reply({ v: 1, titles: list(12) }) }), null);
  assert.equal(await loadRemoteCatalog({ origin, fetchImpl: null }), null);
});

test('o que passa pela validação é aceito pela sala (nunca derruba a abertura do app)', async () => {
  const got = await loadRemoteCatalog({ origin: 'https://dalari-stats.exemplo.workers.dev', fetchImpl: reply({ v: 1, titles: list(12) }) });
  const svc = createRoomService({ catalog: got, catalogSource: 'tmdb', servePrototype: true });
  const addr = await svc.listen(0, '127.0.0.1');
  try {
    const js = await (await fetch(`http://127.0.0.1:${addr.port}/src/catalog.js`)).text();
    assert.match(js, /"trailer":"abcdefghi01"/); assert.match(js, /"minutes":101/);
  } finally { await svc.close(); }
  // e o arquivo que vem com o app continua valendo como reserva
  const old = createRoomService({ catalog: snapshot, catalogSource: 'tmdb', servePrototype: true });
  await old.listen(0, '127.0.0.1'); await old.close();
});

test('ligações: o servidor usa o catálogo remoto antes do local, e o detalhe do título tem sala e trailer', () => {
  const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(index, /catalog = await loadRemoteCatalog\(\{ origin: statsOrigin\(\) \}\);\s*if \(catalog\) catalogMode = 'remote';/);
  assert.match(index, /else \{\s*const snapshotPath/, 'sem catálogo remoto cai no arquivo local');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const t of ["roomBtn.id='detail-room'", "trBtn.id='detail-trailer-btn'", 'youtube-nocookie.com/embed/', 'function closeModal()']) assert.ok(html.includes(t), t);
  assert.ok(html.includes("on.proposeTitle(it)"));
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /async proposeTitle\(item\)/); assert.match(ui, /await client\.pickManually\(item\.id\)/);
  assert.match(readFileSync(new URL('../server/first-run.js', import.meta.url), 'utf8'), /Catálogo de títulos e capas: o app baixa a lista/);
});
