import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const T = require('../src/tonight.js');
const catalog = require('../data/tmdb-catalog-br.json');
const NUL = String.fromCharCode(0);

const item = (o) => ({ id: o.title, title: o.title, service: 'Netflix', genre: 'Drama', tags: [], watchProviders: [], tmdbRating: 0, minutes: null, ...o });
const rank = [
  item({ title: 'Risada', genre: 'Comédia', tags: ['comédia'], tmdbRating: 7.1 }),
  item({ title: 'Susto', genre: 'Terror', tags: ['terror', 'thriller'], service: 'Prime Video' }),
  item({ title: 'Lágrima', genre: 'Drama', tags: ['drama', 'romance'], service: 'Netflix +2', minutes: 95 }),
  item({ title: 'Aventura X', genre: 'Aventura', tags: ['aventura', 'ação'], service: 'Crunchyroll', minutes: 150 }),
  item({ title: 'Mistério', genre: 'Crime', tags: ['crime'], service: 'Prime Video', watchProviders: ['Netflix'] }),
];

test('plataforma: "Netflix +2" é Netflix; lista sem repetir e em ordem', () => {
  assert.equal(T.platformOf(item({ service: 'Netflix +2' })), 'Netflix');
  assert.equal(T.platformOf({}), '');
  assert.deepEqual(T.platformsOf(rank), ['Crunchyroll', 'Netflix', 'Prime Video']);
});

test('clima: casa por gênero ou tag; clima desconhecido não filtra nada', () => {
  assert.deepEqual(T.filterTitles(rank, { mood: 'rir' }).map((i) => i.title), ['Risada']);
  assert.deepEqual(T.filterTitles(rank, { mood: 'tensao' }).map((i) => i.title), ['Susto', 'Mistério']);
  assert.deepEqual(T.filterTitles(rank, { mood: 'emocao' }).map((i) => i.title), ['Lágrima']);
  assert.equal(T.filterTitles(rank, { mood: '__proto__' }).length, rank.length);
  assert.equal(T.filterTitles(rank, { mood: 'constructor' }).length, rank.length);
  assert.equal(T.filterTitles(rank, {}).length, rank.length);
});

test('plataforma e tempo: filtra, mantém a ordem; título sem duração não some por causa do tempo', () => {
  assert.deepEqual(T.filterTitles(rank, { platform: 'Netflix' }).map((i) => i.title), ['Risada', 'Lágrima', 'Mistério'], 'inclui quem também está na Netflix pelos provedores');
  assert.deepEqual(T.filterTitles(rank, { platform: 'Prime Video' }).map((i) => i.title), ['Susto', 'Mistério']);
  assert.deepEqual(T.filterTitles(rank, { maxMinutes: 100 }).map((i) => i.title), ['Risada', 'Susto', 'Lágrima', 'Mistério']);
  assert.deepEqual(T.filterTitles(rank, { mood: 'tensao', platform: 'Netflix' }).map((i) => i.title), ['Mistério']);
});

test('duração só vira filtro quando o catálogo realmente tem o dado', () => {
  assert.equal(T.durationUsable(rank), false);
  assert.equal(T.durationUsable(rank.map((i) => ({ ...i, minutes: 100 }))), true);
  assert.equal(T.durationUsable([]), false);
  assert.equal(T.durationUsable(catalog), false, 'o catálogo atual ainda não traz duração: o filtro fica escondido');
});

test('sugerir: os 3 melhores em ordem; "me surpreenda" sorteia entre os melhores sem repetir', () => {
  assert.deepEqual(T.pick(rank, {}).map((i) => i.title), ['Risada', 'Susto', 'Lágrima']);
  assert.deepEqual(T.pick(rank, { mood: 'rir' }).map((i) => i.title), ['Risada']);
  assert.equal(T.pick(rank, { mood: 'nada' }, { n: 2 }).length, 2);
  assert.deepEqual(T.pick([], {}), []);
  const low = T.pick(rank, {}, { surprise: true, rng: () => 0 }).map((i) => i.title);
  const high = T.pick(rank, {}, { surprise: true, rng: () => 0.999 }).map((i) => i.title);
  assert.equal(new Set(low).size, 3); assert.equal(new Set(high).size, 3);
  assert.notDeepEqual(low, high, 'o sorteio muda o resultado');
  for (const t of [...low, ...high]) assert.ok(rank.some((i) => i.title === t));
  assert.equal(T.pick(rank.slice(0, 2), {}, { surprise: true, rng: () => 0.5 }).length, 2, 'poucos títulos: devolve os que há');
});

test('"por que para vocês": só com fatos que temos, em português', () => {
  assert.equal(T.why(rank[0], { mood: 'rir' }), 'Combina com o clima rir · está na Netflix · nota 7.1 no TMDB');
  assert.equal(T.why(rank[2], {}), 'Está na Netflix · dura 1h35');
  assert.equal(T.why(rank[3], {}), 'Está na Crunchyroll · dura 2h30');
  assert.equal(T.why({}, {}), '');
  assert.equal(T.hours(45), '45 min'); assert.equal(T.hours(120), '2h'); assert.equal(T.hours(61), '1h01');
});

test('busca da Netflix: nome codificado, nada de caractere de controle, só para o que está na Netflix', () => {
  assert.equal(T.netflixSearchUrl('Tom & Jerry: O Filme'), 'https://www.netflix.com/search?q=Tom%20%26%20Jerry%3A%20O%20Filme');
  assert.equal(T.netflixSearchUrl('a\nb' + NUL + 'c'), 'https://www.netflix.com/search?q=a%20b%20c');
  assert.equal(T.netflixSearchUrl('   '), null); assert.equal(T.netflixSearchUrl(null), null);
  assert.equal(T.canSearchNetflix(rank[0]), true);
  assert.equal(T.canSearchNetflix(rank[1]), false);
  assert.equal(T.canSearchNetflix(rank[4]), true, 'também vale se a Netflix aparece entre os provedores');
});

test('catálogo real: todo clima encontra títulos e toda plataforma aparece', () => {
  for (const mood of Object.keys(T.MOODS)) assert.ok(T.filterTitles(catalog, { mood }).length > 0, mood);
  assert.ok(T.platformsOf(catalog).includes('Netflix'));
});

test('a página carrega o módulo, tem o bloco "Noite de hoje" e os filtros de Descobrir; o serviço entrega o arquivo', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="src\/tonight\.js"><\/script>/);
  assert.ok(html.indexOf('src/tonight.js') < html.indexOf('(()=>{'), 'o módulo carrega antes do script da página');
  for (const id of ['rec-filters', 'rec-title', 'rec-sub', 'recommend-cards', 'pf-filters']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.ok(html.includes('data-tonight="surprise"') && html.includes('data-tonight="clear"'));
  assert.match(readFileSync(new URL('../server/room-service.js', import.meta.url), 'utf8'), /'\/src\/tonight\.js', 'src\/tonight\.js'/);
  assert.match(readFileSync(new URL('../../app/src/duotela-preload.cjs', import.meta.url), 'utf8'), /openNetflixSearch/);
  assert.match(readFileSync(new URL('../../app/main.cjs', import.meta.url), 'utf8'), /duotela:netflix-search/);
});

test('Início tem uma lista só de sugestões: os ajustes (clima, plataforma, me surpreenda) mexem nela e não existe uma segunda lista', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="tonight"|tonight-results|Sugerir 3 para/, 'sem o bloco separado');
  assert.equal((html.match(/id="recommend-cards"/g) || []).length, 1);
  assert.ok(html.includes('renderRecommend(ranked);'));
  assert.ok(html.includes('tonight.picks=Tonight.pick('), 'me surpreenda sorteia na própria lista');
  assert.ok(html.includes("if(b.dataset.tonight==='clear'){tonight.mood='';tonight.platform='';tonight.minutes=0;tonight.picks=null}"), 'Limpar volta ao normal');
});
