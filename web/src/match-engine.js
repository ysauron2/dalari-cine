/* Motor determinístico de recomendação e match do Dalari Cine.
   Funções puras: nada de Math.random, Date, localStorage ou DOM. A "sorte" vem de um hash
   de (seed, rodada, id), então o mesmo estado sempre produz as mesmas sugestões.
   Formato UMD: <script src> no navegador (funciona em file://) e require() no Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MatchEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PEOPLE = ['you', 'partner'];
  const ALL_PEOPLE = ['you', 'partner', 'p3', 'p4']; // até 4 pessoas; o padrão continua sendo a dupla
  const peopleOf = (round) => (round && Array.isArray(round.people) ? round.people : PEOPLE);
  const DEFAULT_SEED = 20261015;
  const ROUND_SIZE = 3;
  const RECOMMEND_LIMIT = 5;
  const ROUND_VERSION = 1;
  const SOURCES = ['surprise', 'recommend', 'manual'];
  const RECOMMENDED = 'Para nós';
  const CATEGORIES = ['Todos', RECOMMENDED, 'Filmes', 'Séries', 'Curtos', 'Romance', 'Drama', 'Ficção científica', 'Comédia', 'Suspense', 'Animação', 'Fantasia', 'Documentário'];
  const SHORT_MINUTES = 60;

  // ---------- dados salvos (esquema v1 inalterado) ----------
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const rating = (v) => (v === 1 || v === -1 ? v : 0);

  function sanitizeSaved(raw) {
    const out = {};
    if (!isObj(raw)) return out;
    for (const id of Object.keys(raw)) {
      const s = raw[id];
      if (!isObj(s)) continue;
      const entry = { ...s };
      const p = Number(s.progress);
      entry.progress = Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0;
      entry.listed = s.listed === true;
      entry.liked = s.liked === true;
      if (isObj(s.ratings)) entry.ratings = { you: rating(s.ratings.you), partner: rating(s.ratings.partner) };
      else delete entry.ratings;
      out[id] = entry;
    }
    return out;
  }

  function stateOf(saved, id) {
    const s = saved && isObj(saved[id]) ? saved[id] : null;
    if (!s) return { progress: 0, listed: false, liked: false };
    const p = Number(s.progress);
    return { ...s, progress: Number.isFinite(p) ? p : 0, listed: s.listed === true, liked: s.liked === true };
  }

  function ratingsOf(s) {
    if (isObj(s.ratings)) return { you: rating(s.ratings.you), partner: rating(s.ratings.partner) };
    return { you: s.liked ? 1 : 0, partner: s.liked ? 1 : 0 };
  }

  const isWatched = (saved, id) => stateOf(saved, id).progress >= 100;
  const isVetoed = (saved, id) => { const r = ratingsOf(stateOf(saved, id)); return r.you < 0 || r.partner < 0; };

  /** Há algo salvo que permita falar em preferência (avaliação, lista ou progresso)? */
  function hasPreferences(catalog, saved) {
    return catalog.some((item) => {
      const s = stateOf(saved, item.id), r = ratingsOf(s);
      return r.you !== 0 || r.partner !== 0 || s.listed || s.progress > 0;
    });
  }

  // ---------- pontuação ----------
  function affinity(item, person, catalog, saved) {
    let value = 0;
    for (const other of catalog) {
      if (other.id === item.id) continue;
      const s = stateOf(saved, other.id);
      const shared = item.tags.filter((t) => other.tags.includes(t)).length;
      value += shared * ratingsOf(s)[person] * 2;
      if (s.progress >= 100) value += shared * 0.5;
    }
    return value;
  }

  /** Pontuação "bruta" a partir do que está salvo. Assistido completo vale -1 (fora das indicações). */
  function scoreTitle(item, catalog, saved) {
    const s = stateOf(saved, item.id);
    if (s.progress >= 100) return -1;
    const r = ratingsOf(s);
    const you = r.you * 3 + affinity(item, 'you', catalog, saved);
    const partner = r.partner * 3 + affinity(item, 'partner', catalog, saved);
    let value = Math.min(you, partner) * 2 + (you + partner) * 0.3 + item.warmth * 0.5 + item.adventure * 0.2;
    if (Number.isFinite(item.tmdbRating)) value += item.tmdbRating * 0.1;
    if (r.you < 0 || r.partner < 0) value -= 12;
    if (s.listed) value += 2;
    if (s.progress > 0) value += 1;
    return value;
  }

  function explain(item, catalog, saved) {
    const s = stateOf(saved, item.id), r = ratingsOf(s);
    if (s.progress >= 100) return 'Já assistido por vocês';
    if (r.you > 0 && r.partner > 0) return 'Os dois marcaram que gostaram';
    if (r.you < 0 || r.partner < 0) return 'Um de vocês marcou que não gostou';
    if (s.listed) return 'Já está na lista de vocês';
    const match = catalog.find((x) => {
      if (x.id === item.id) return false;
      const xr = ratingsOf(stateOf(saved, x.id));
      return (xr.you > 0 || xr.partner > 0) && x.tags.some((t) => item.tags.includes(t));
    });
    if (match) return 'Compartilha temas com ' + match.title;
    return 'Ainda não visto · ' + item.genre.toLowerCase();
  }

  /** Ordem estável: pontuação decrescente, empate pela ordem do catálogo. */
  function rankTitles(catalog, saved) {
    // Sem sinais da dupla, preservar a ordem do catálogo e não fingir personalização.
    if (!hasPreferences(catalog, saved)) return catalog.map((item, index) => ({ item, index, score: 0 }));
    return catalog
      .map((item, index) => ({ item, index, score: scoreTitle(item, catalog, saved) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }

  // ---------- categorias ----------
  function recommendedIds(catalog, saved) {
    return rankTitles(catalog, saved)
      .filter((r) => !isWatched(saved, r.item.id) && !isVetoed(saved, r.item.id))
      .slice(0, RECOMMEND_LIMIT)
      .map((r) => r.item.id);
  }

  function filterByCategory(catalog, category, saved) {
    switch (category) {
      case 'Todos': case undefined: case null: return catalog.slice();
      case RECOMMENDED: { const ids = recommendedIds(catalog, saved); return catalog.filter((i) => ids.includes(i.id)); }
      case 'Filmes': return catalog.filter((i) => i.kind === 'Filme');
      case 'Séries': return catalog.filter((i) => i.kind === 'Série');
      case 'Animes': return catalog.filter((i) => i.kind === 'Anime');
      case 'Curtos': return catalog.filter((i) => Number.isFinite(i.minutes) && i.minutes > 0 && i.minutes <= SHORT_MINUTES);
      default: return catalog.filter((i) => i.genre === category);
    }
  }

  // ---------- sorteio determinístico ----------
  function hash32(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13;
    return h >>> 0;
  }
  const unit = (seed, round, id) => hash32(`${seed}|${round}|${id}`) / 4294967296;

  /**
   * Escolhe até `size` títulos distintos.
   *  - Fora: assistidos por inteiro (sempre) e vetados por alguém (a menos que faltem títulos).
   *  - Rodízio: ninguém é oferecido de novo antes de todos os elegíveis terem sido oferecidos
   *    (usa `offered`, contagem por id, vinda do estado da rodada).
   *  - Variedade: dentro do mesmo "degrau" de rodízio, repetir gênero custa pontos.
   *  - Sem preferências salvas: pontuação neutra (0); só rodízio, variedade e o desempate por hash.
   */
  function pickRound(catalog, saved, opts) {
    const o = opts || {};
    const mode = o.mode === 'recommend' ? 'recommend' : 'surprise';
    const size = o.size || ROUND_SIZE;
    const seed = Number.isFinite(o.seed) ? o.seed : DEFAULT_SEED;
    const round = Number.isFinite(o.round) ? o.round : 1;
    const offered = isObj(o.offered) ? o.offered : {};
    const prefs = hasPreferences(catalog, saved);

    const fresh = catalog.filter((i) => !isWatched(saved, i.id));
    const open = fresh.filter((i) => !isVetoed(saved, i.id));
    const pool = open.length >= size ? open : fresh;
    const count = (id) => offered[id] > 0 ? offered[id] : 0;

    const picked = [];
    const left = pool.slice();
    const weight = mode === 'recommend' ? 1 : 0.35;
    const jitter = mode === 'recommend' ? 0.6 : 4;
    while (picked.length < size && left.length) {
      const minCount = Math.min(...left.map((i) => count(i.id)));
      const tier = left.filter((i) => count(i.id) === minCount);
      let best = null;
      for (const item of tier) {
        const base = prefs ? scoreTitle(item, catalog, saved) * weight : 0;
        const genreHits = picked.filter((p) => p.genre === item.genre).length;
        const kindHits = picked.filter((p) => p.kind === item.kind).length;
        const adj = base + unit(seed, round, item.id) * jitter - genreHits * 8 - (picked.length === ROUND_SIZE - 1 ? kindHits * 1.5 : 0);
        if (!best || adj > best.adj) best = { item, adj };
      }
      picked.push(best.item);
      left.splice(left.indexOf(best.item), 1);
    }

    const picks = picked.map((item) => ({
      id: item.id,
      reason: prefs ? explain(item, catalog, saved) : 'Sugestão neutra · ' + item.genre.toLowerCase() + ', sem supor gosto de ninguém'
    }));
    const genres = [...new Set(picked.map((p) => p.genre))];
    let summary;
    if (!picks.length) summary = 'Vocês já assistiram todos os títulos de exemplo. Escolham manualmente algo para rever.';
    else if (!prefs) summary = 'Ainda não há avaliações, lista ou histórico salvos, então não suponho nada sobre vocês: são títulos de gêneros variados (' + genres.join(', ').toLowerCase() + '), em rodízio para todos aparecerem.';
    else if (mode === 'recommend') summary = 'Ordenado pelas avaliações, lista e histórico salvos de vocês, com gêneros variados e rodízio dos que ainda não apareceram.';
    else summary = 'Surpresa guiada pelo que vocês salvaram: gêneros variados e rodízio dos que ainda não apareceram, com um toque de acaso fixado pela rodada.';
    return { picks, neutral: !prefs, summary, poolSize: pool.length };
  }

  // ---------- rodada de decisão ----------
  function emptyVotes(people) { const v = {}; for (const p of people || PEOPLE) v[p] = {}; return v; }
  const normalizePeople = (list) => {
    if (!Array.isArray(list)) return null;
    const ordered = ALL_PEOPLE.filter((p) => list.includes(p));
    return ordered.length >= 1 && ordered.length === list.length ? ordered : null;      // uma pessoa só também vale (Host sozinho na sala)
  };
  const sameAsPair = (people) => people.length === 2 && people[0] === 'you' && people[1] === 'partner';

  function createRound(prev, catalog, saved, opts) {
    const o = opts || {};
    const mode = o.mode === 'recommend' ? 'recommend' : 'surprise';
    const roundNumber = prev && Number.isInteger(prev.roundNumber) ? prev.roundNumber + 1 : 1;
    const seed = Number.isFinite(o.seed) ? o.seed : prev && Number.isFinite(prev.seed) ? prev.seed : DEFAULT_SEED;
    const offered = { ...(prev && prev.offered) };
    const result = pickRound(catalog, saved, { mode, seed, round: roundNumber, offered });
    for (const p of result.picks) offered[p.id] = (offered[p.id] || 0) + 1;
    const people = normalizePeople(o.people) || PEOPLE;
    const round = { v: ROUND_VERSION, seed, roundNumber, source: mode, picks: result.picks.map((p) => p.id), offered, votes: emptyVotes(people), neutral: result.neutral, summary: result.summary };
    if (!sameAsPair(people)) round.people = people.slice();
    return round;
  }

  /** Indicação manual: um único título, com o "sim" de quem indicou já registrado. */
  function manualRound(prev, catalog, id, person, peopleList) {
    const people = normalizePeople(peopleList) || PEOPLE;
    if (!catalog.some((i) => i.id === id) || !people.includes(person)) return prev || null;
    const votes = emptyVotes(people);
    votes[person][id] = 'yes';
    const others = people.length - 1;
    const made = {
      v: ROUND_VERSION,
      seed: prev && Number.isFinite(prev.seed) ? prev.seed : DEFAULT_SEED,
      roundNumber: prev && Number.isInteger(prev.roundNumber) ? prev.roundNumber + 1 : 1,
      source: 'manual', picks: [id], offered: { ...(prev && prev.offered) }, votes, neutral: false,
      summary: people.length === 2
        ? 'Indicação manual: ' + (person === 'you' ? 'Pessoa 1' : 'Pessoa 2') + ' já disse que quer ver. Falta a outra pessoa responder.'
        : 'Indicação manual: ' + (people.indexOf(person) + 1 > 0 ? 'Pessoa ' + (people.indexOf(person) + 1) : 'Alguém') + ' já disse que quer ver. Faltam ' + others + ' respostas.'
    };
    if (!sameAsPair(people)) made.people = people.slice();
    return made;
  }

  /** Reinicia a mesma seleção com votos limpos e uma nova lista de pessoas (a composição da sala mudou). */
  function restartRound(round, peopleList, summary) {
    const people = normalizePeople(peopleList);
    if (!round || !people) return round || null;
    const next = { ...round, roundNumber: round.roundNumber + 1, votes: emptyVotes(people), summary: typeof summary === 'string' ? summary.slice(0, 400) : round.summary };
    delete next.people;
    if (!sameAsPair(people)) next.people = people.slice();
    return next;
  }

  /** Estado derivado: só há match com "sim" das DUAS pessoas no mesmo título. */
  function resolveRound(round) {
    if (!round || !round.picks.length) return { status: 'empty', matchId: null };
    const people = peopleOf(round);
    const matchId = round.picks.find((id) => people.every((p) => round.votes[p] && round.votes[p][id] === 'yes')) || null;
    if (matchId) return { status: 'match', matchId };
    if (round.picks.every((id) => people.some((p) => round.votes[p] && round.votes[p][id] === 'no'))) return { status: 'no-match', matchId: null };
    return { status: 'voting', matchId: null };
  }

  /** Registra um voto (imutável). Depois do match a rodada fica travada. */
  function castVote(round, person, id, vote) {
    if (!round || !peopleOf(round).includes(person) || (vote !== 'yes' && vote !== 'no') || !round.picks.includes(id)) return round;
    if (resolveRound(round).status === 'match') return round;
    return { ...round, votes: { ...round.votes, [person]: { ...round.votes[person], [id]: vote } } };
  }

  /** Quem quis o quê, para a conversa quando não há match. */
  function discussionNotes(round) {
    return round.picks.map((id) => ({
      id,
      yes: peopleOf(round).filter((p) => round.votes[p][id] === 'yes'),
      no: peopleOf(round).filter((p) => round.votes[p][id] === 'no'),
      pending: peopleOf(round).filter((p) => !round.votes[p][id])
    }));
  }

  /** Valida uma rodada vinda do localStorage; devolve null se não for confiável. */
  function sanitizeRound(raw, catalog) {
    if (!isObj(raw) || (raw.v !== undefined && raw.v !== ROUND_VERSION)) return null;
    const known = new Set(catalog.map((i) => i.id));
    if (!Array.isArray(raw.picks)) return null;
    const picks = [...new Set(raw.picks.filter((id) => typeof id === 'string' && known.has(id)))].slice(0, ROUND_SIZE);
    if (!picks.length || picks.length !== raw.picks.length) return null;
    if (!SOURCES.includes(raw.source)) return null;
    if (raw.source === 'manual' && picks.length !== 1) return null;
    const people = raw.people === undefined ? PEOPLE : normalizePeople(raw.people);
    if (!people) return null;
    const votes = emptyVotes(people);
    for (const p of people) {
      const src = isObj(raw.votes) && isObj(raw.votes[p]) ? raw.votes[p] : {};
      for (const id of picks) if (src[id] === 'yes' || src[id] === 'no') votes[p][id] = src[id];
    }
    const offered = {};
    if (isObj(raw.offered)) for (const id of Object.keys(raw.offered)) {
      const n = raw.offered[id];
      if (known.has(id) && Number.isInteger(n) && n > 0 && n < 1000) offered[id] = n;
    }
    const clean = {
      v: ROUND_VERSION,
      seed: Number.isFinite(raw.seed) ? raw.seed : DEFAULT_SEED,
      roundNumber: Number.isInteger(raw.roundNumber) && raw.roundNumber > 0 ? raw.roundNumber : 1,
      source: raw.source, picks, offered, votes,
      neutral: raw.neutral === true,
      summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 400) : ''
    };
    if (!sameAsPair(people)) clean.people = people.slice();
    return clean;
  }

  return {
    PEOPLE, ALL_PEOPLE, peopleOf, DEFAULT_SEED, ROUND_SIZE, RECOMMEND_LIMIT, RECOMMENDED, CATEGORIES,
    sanitizeSaved, sanitizeRound, hasPreferences, isWatched, isVetoed,
    scoreTitle, explain, rankTitles, recommendedIds, filterByCategory,
    pickRound, createRound, manualRound, restartRound, castVote, resolveRound, discussionNotes
  };
});
