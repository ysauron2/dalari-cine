import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/match-engine.js');
const catalog = require('../src/catalog.js');
const ids = catalog.map((i) => i.id);

test('catálogo: 9 títulos fictícios, ids únicos, pôsteres locais e variedade', () => {
  assert.equal(catalog.length, 9);
  assert.equal(new Set(ids).size, 9);
  for (const i of catalog) assert.match(i.image, /^assets\/[\w-]+\.(png|svg)$/, i.id);
  assert.ok(new Set(catalog.map((i) => i.genre)).size >= 7);
  assert.ok(catalog.some((i) => i.kind === 'Série') && catalog.some((i) => i.kind === 'Filme'));
  assert.ok(Math.min(...catalog.map((i) => i.minutes)) <= 30 && Math.max(...catalog.map((i) => i.minutes)) >= 120);
});

test('sem preferências: 3 títulos distintos, neutro e explicado', () => {
  const r = E.pickRound(catalog, {}, { round: 1 });
  assert.equal(r.picks.length, 3);
  assert.equal(new Set(r.picks.map((p) => p.id)).size, 3);
  assert.equal(r.neutral, true);
  assert.match(r.summary, /não suponho nada/);
  assert.ok(r.picks.every((p) => /neutra/.test(p.reason)));
  assert.equal(new Set(r.picks.map((p) => catalog.find((c) => c.id === p.id).genre)).size, 3);
});

test('sem histórico, a lista inicial mantém ordem neutra e não inventa afinidade', () => {
  const ranked = E.rankTitles(catalog, {});
  assert.deepEqual(ranked.map((r) => r.item.id), ids);
  assert.ok(ranked.every((r) => r.score === 0));
});

test('determinismo: mesmo estado e seed dão o mesmo resultado; seed diferente pode mudar', () => {
  const a = E.pickRound(catalog, {}, { round: 4, seed: 7 });
  const b = E.pickRound(catalog, {}, { round: 4, seed: 7 });
  assert.deepEqual(a, b);
  const outcomes = new Set();
  for (let seed = 1; seed <= 20; seed++) outcomes.add(E.pickRound(catalog, {}, { round: 1, seed }).picks.map((p) => p.id).join());
  assert.ok(outcomes.size > 1, 'o seed precisa influenciar o sorteio');
  assert.deepEqual(E.createRound(null, catalog, {}, { seed: 5 }), E.createRound(null, catalog, {}, { seed: 5 }));
});

test('nunca sugere título assistido por inteiro, nem em modo recomendação', () => {
  const saved = { noite: { progress: 100 }, mar: { progress: 100 }, cafe: { progress: 100 } };
  for (const mode of ['surprise', 'recommend']) {
    let round = null;
    for (let n = 0; n < 8; n++) {
      round = E.createRound(round, catalog, saved, { mode });
      for (const id of round.picks) assert.ok(!['noite', 'mar', 'cafe'].includes(id), `${mode}: ${id}`);
    }
  }
});

test('progresso parcial não exclui; assistido vale -1 na pontuação', () => {
  const saved = { mar: { progress: 40 }, noite: { progress: 100 } };
  assert.equal(E.scoreTitle(catalog[0], catalog, saved), -1);
  assert.ok(E.scoreTitle(catalog[1], catalog, saved) > 0);
  assert.ok(E.recommendedIds(catalog, saved).includes('mar'));
});

test('ranking usa avaliações salvas: gosto dos dois sobe, rejeição afunda', () => {
  const saved = { horizonte: { ratings: { you: 1, partner: 1 } }, noite: { ratings: { you: -1, partner: 0 } } };
  const order = E.rankTitles(catalog, saved).map((r) => r.item.id);
  assert.equal(order[0], 'horizonte');
  assert.equal(order.at(-1), 'noite');
  assert.ok(E.explain(catalog[2], catalog, saved).includes('Os dois'));
  assert.ok(E.explain(catalog[0], catalog, saved).includes('não gostou'));
  // afinidade por tags: quem tem "aventura" em comum com o título amado sobe
  assert.ok(E.scoreTitle(catalog.find((c) => c.id === 'cartografo'), catalog, saved) > E.scoreTitle(catalog.find((c) => c.id === 'relogio'), catalog, saved));
});

test('com preferências, a rodada de recomendação traz o favorito e não é neutra', () => {
  const saved = { horizonte: { ratings: { you: 1, partner: 1 } } };
  const r = E.pickRound(catalog, saved, { mode: 'recommend', round: 1 });
  assert.equal(r.neutral, false);
  assert.ok(r.picks.some((p) => p.id === 'horizonte'));
  assert.ok(!/não suponho/.test(r.summary));
});

test('título rejeitado por alguém só entra se faltarem opções', () => {
  const vetoed = Object.fromEntries(ids.slice(0, 5).map((id) => [id, { ratings: { you: 0, partner: -1 } }]));
  const r = E.pickRound(catalog, vetoed, { round: 1 });
  assert.ok(r.picks.every((p) => !(p.id in vetoed)));
  const allVetoed = Object.fromEntries(ids.map((id) => [id, { ratings: { you: -1, partner: 0 } }]));
  assert.equal(E.pickRound(catalog, allVetoed, { round: 1 }).picks.length, 3);
});

test('rodízio justo: ninguém repete antes de todos aparecerem; 3 rodadas cobrem os 9', () => {
  for (const mode of ['surprise', 'recommend']) {
    let round = null;
    const seen = [];
    for (let n = 0; n < 3; n++) { round = E.createRound(round, catalog, {}, { mode }); seen.push(...round.picks); }
    assert.equal(new Set(seen).size, 9, mode);
    round = E.createRound(round, catalog, {}, { mode });
    assert.ok(Object.values(round.offered).every((n) => n === 1 || n === 2));
  }
  // depois de muitas rodadas, a diferença de exposição nunca passa de 1
  let round = null;
  for (let n = 0; n < 20; n++) round = E.createRound(round, catalog, {}, { mode: 'surprise' });
  const counts = ids.map((id) => round.offered[id] || 0);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, counts.join());
});

test('variedade de gêneros nas primeiras rodadas e sempre 3 distintos', () => {
  let round = null;
  for (let n = 0; n < 9; n++) {
    round = E.createRound(round, catalog, {}, { mode: 'surprise' });
    assert.equal(new Set(round.picks).size, 3);
    const genres = new Set(round.picks.map((id) => catalog.find((c) => c.id === id).genre));
    assert.ok(genres.size >= 2, `rodada ${n + 1}`);
    if (n < 2) assert.equal(genres.size, 3);
  }
});

test('pool pequeno: devolve o que existe, sem duplicar', () => {
  const small = catalog.slice(0, 2);
  assert.equal(E.pickRound(small, {}, {}).picks.length, 2);
  const allWatched = Object.fromEntries(ids.map((id) => [id, { progress: 100 }]));
  const r = E.pickRound(catalog, allWatched, {});
  assert.deepEqual(r.picks, []);
  assert.equal(E.resolveRound(E.createRound(null, catalog, allWatched)).status, 'empty');
});

test('match só com "sim" das duas pessoas no mesmo título', () => {
  let r = E.createRound(null, catalog, {});
  const [a, b, c] = r.picks;
  assert.equal(E.resolveRound(r).status, 'voting');
  r = E.castVote(r, 'you', a, 'yes');
  assert.equal(E.resolveRound(r).status, 'voting');
  r = E.castVote(r, 'partner', b, 'yes'); // sim em títulos diferentes não é match
  assert.equal(E.resolveRound(r).status, 'voting');
  r = E.castVote(r, 'partner', a, 'no'); // um "não" nunca vira match
  assert.equal(E.resolveRound(r).status, 'voting');
  assert.equal(E.resolveRound(r).matchId, null);
  r = E.castVote(r, 'partner', a, 'yes');
  assert.deepEqual(E.resolveRound(r), { status: 'match', matchId: a });
  assert.ok(c);
});

test('sem match quando cada título tem ao menos um "não"; dá para mudar de ideia', () => {
  let r = E.createRound(null, catalog, {});
  for (const id of r.picks) r = E.castVote(r, 'you', id, 'no');
  assert.equal(E.resolveRound(r).status, 'no-match');
  r = E.castVote(r, 'you', r.picks[0], 'yes');
  assert.equal(E.resolveRound(r).status, 'voting');
  const notes = E.discussionNotes(r);
  assert.deepEqual(notes[0].yes, ['you']);
  assert.deepEqual(notes[1].no, ['you']);
});

test('depois do match a rodada trava e votos são imutáveis', () => {
  let r = E.createRound(null, catalog, {});
  const frozen = JSON.stringify(r);
  const next = E.castVote(r, 'you', r.picks[0], 'yes');
  assert.equal(JSON.stringify(r), frozen, 'castVote não muta o original');
  r = E.castVote(next, 'partner', r.picks[0], 'yes');
  const locked = E.castVote(r, 'partner', r.picks[0], 'no');
  assert.equal(locked, r);
});

test('votos inválidos são ignorados', () => {
  const r = E.createRound(null, catalog, {});
  assert.equal(E.castVote(r, 'outro', r.picks[0], 'yes'), r);
  assert.equal(E.castVote(r, 'you', 'inexistente', 'yes'), r);
  assert.equal(E.castVote(r, 'you', r.picks[0], 'talvez'), r);
});

test('escolha manual: indicação vira "sim" de quem indicou e precisa da outra pessoa', () => {
  let r = E.manualRound(E.createRound(null, catalog, {}), catalog, 'rotas', 'partner');
  assert.deepEqual(r.picks, ['rotas']);
  assert.equal(r.source, 'manual');
  assert.equal(E.resolveRound(r).status, 'voting');
  assert.equal(E.resolveRound(E.castVote(r, 'you', 'rotas', 'no')).status, 'no-match');
  assert.equal(E.resolveRound(E.castVote(r, 'you', 'rotas', 'yes')).matchId, 'rotas');
  assert.equal(r.roundNumber, 2);
  assert.equal(E.manualRound(null, catalog, 'nada', 'you'), null);
});

test('categorias: filtros por gênero, tipo, duração e "Para nós"', () => {
  const f = (c, s = {}) => E.filterByCategory(catalog, c, s).map((i) => i.id);
  assert.equal(f('Todos').length, 9);
  assert.deepEqual(f('Comédia').sort(), ['cafe', 'salelima']);
  assert.deepEqual(f('Séries').sort(), ['cartografo', 'horizonte', 'salelima']);
  assert.ok(f('Filmes').length === 6);
  assert.deepEqual(f('Curtos').sort(), ['cartografo', 'horizonte', 'salelima']);
  assert.equal(f('Para nós').length, E.RECOMMEND_LIMIT);
  assert.ok(!f('Para nós', { noite: { progress: 100 } }).includes('noite'));
  assert.ok(E.CATEGORIES.every((c) => c === 'Todos' || E.filterByCategory(catalog, c, {}).length > 0));
});

test('sanitizeSaved: entradas ruins viram dados seguros, esquema antigo preservado', () => {
  assert.deepEqual(E.sanitizeSaved(null), {});
  assert.deepEqual(E.sanitizeSaved([1, 2]), {});
  const clean = E.sanitizeSaved({ noite: { progress: '150', listed: 'sim', liked: true, ratings: { you: 5, partner: -1 } }, x: 'lixo', mar: { progress: NaN, ratings: 3 } });
  assert.equal(clean.noite.progress, 100);
  assert.equal(clean.noite.listed, false);
  assert.equal(clean.noite.liked, true);
  assert.deepEqual(clean.noite.ratings, { you: 0, partner: -1 });
  assert.equal(clean.x, undefined);
  assert.equal(clean.mar.progress, 0);
  assert.equal('ratings' in clean.mar, false);
  const legacy = { mar: { progress: 30, listed: true, liked: false } };
  assert.deepEqual(E.sanitizeSaved(legacy), legacy);
});

test('sanitizeRound: aceita rodada válida e rejeita dados adulterados', () => {
  const r = E.castVote(E.createRound(null, catalog, {}), 'you', E.createRound(null, catalog, {}).picks[0], 'yes');
  assert.deepEqual(E.sanitizeRound(JSON.parse(JSON.stringify(r)), catalog), r);
  for (const bad of [null, 'x', 5, [], {}, { picks: 'a' }, { ...r, picks: ['nope'] }, { ...r, picks: [] }, { ...r, v: 99 }, { ...r, source: 'hack' }, { ...r, picks: [r.picks[0], r.picks[0]] }, { ...r, source: 'manual' }]) {
    assert.equal(E.sanitizeRound(bad, catalog), null, JSON.stringify(bad));
  }
  const dirty = E.sanitizeRound({ ...r, votes: { you: { [r.picks[0]]: 'yes', zzz: 'yes' }, partner: { [r.picks[0]]: '<b>' } }, offered: { [r.picks[0]]: -3, zzz: 2 }, summary: 'a'.repeat(1000) }, catalog);
  assert.deepEqual(dirty.votes, { you: { [r.picks[0]]: 'yes' }, partner: {} });
  assert.deepEqual(dirty.offered, {});
  assert.equal(dirty.summary.length, 400);
});
