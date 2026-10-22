/* "Noite de hoje": escolher o que ver em poucos toques (clima, plataforma e, se o catálogo trouxer a duração, quanto tempo vocês têm).
   Só lógica pura (filtrar, sortear, explicar o porquê, montar o link de busca da Netflix); a tela fica em index.html. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoTonight = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // O clima vira um conjunto de gêneros/tags do catálogo
  const MOODS = {
    leve: { label: 'Leve', tags: ['família', 'animação', 'comédia', 'romance', 'kids'] },
    rir: { label: 'Rir', tags: ['comédia'] },
    tensao: { label: 'Tensão', tags: ['thriller', 'terror', 'crime', 'mistério'] },
    emocao: { label: 'Emoção', tags: ['drama', 'romance', 'história', 'guerra'] },
    aventura: { label: 'Aventura', tags: ['aventura', 'ação', 'ficção científica', 'fantasia'] },
  };
  const TIMES = [[0, 'Sem pressa'], [100, 'Até 1h40'], [130, 'Até 2h10']];   // minutos; 0 = sem limite

  const lower = (s) => String(s || '').toLocaleLowerCase('pt-BR');
  /** "Netflix +2" e "Netflix" são a mesma plataforma. */
  const platformOf = (item) => String((item && item.service) || '').replace(/\s*\+\d+$/, '').trim();
  const platformsOf = (catalog) => [...new Set(catalog.map(platformOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const hasMinutes = (item) => Number.isFinite(item && item.minutes) && item.minutes > 0;
  /** Só oferece o filtro de duração se o catálogo tem esse dado para boa parte dos títulos (senão o filtro esconderia quase tudo). */
  const durationUsable = (catalog) => catalog.length > 0 && catalog.filter(hasMinutes).length / catalog.length >= 0.5;

  function moodMatch(item, mood) {
    if (!mood) return true;
    const m = Object.hasOwn(MOODS, mood) ? MOODS[mood] : null;
    if (!m) return true;
    const have = new Set([...(item.tags || []).map(lower), lower(item.genre)]);
    return m.tags.some((t) => have.has(t));
  }
  const platformMatch = (item, platform) => !platform || platformOf(item) === platform || (item.watchProviders || []).some((p) => platformOf({ service: p }) === platform);
  const timeMatch = (item, maxMinutes) => !maxMinutes || !hasMinutes(item) || item.minutes <= maxMinutes;

  /** Filtra mantendo a ordem de quem chamou (já vem ordenada por afinidade). */
  const filterTitles = (items, { mood = '', platform = '', maxMinutes = 0 } = {}) => items.filter((i) => moodMatch(i, mood) && platformMatch(i, platform) && timeMatch(i, maxMinutes));

  /** Os n melhores; com `surprise`, n sorteados entre os 8 melhores (rng injetável para testar). */
  function pick(items, filters = {}, { n = 3, surprise = false, rng = Math.random } = {}) {
    const list = filterTitles(items, filters);
    if (!surprise) return list.slice(0, n);
    const pool = list.slice(0, Math.max(n, 8));
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.min(pool.length - 1, Math.floor(rng() * pool.length)), 1)[0]);
    return out;
  }

  const hours = (min) => (min >= 60 ? Math.floor(min / 60) + 'h' + (min % 60 ? String(min % 60).padStart(2, '0') : '') : min + ' min');
  /** "Por que para vocês": frases curtas, só com o que sabemos de verdade. */
  function why(item, { mood = '' } = {}, extra = '') {
    const parts = [];
    if (mood && Object.hasOwn(MOODS, mood)) parts.push('combina com o clima ' + MOODS[mood].label.toLocaleLowerCase('pt-BR'));
    if (platformOf(item)) parts.push('está na ' + platformOf(item));
    if (hasMinutes(item)) parts.push('dura ' + hours(item.minutes));
    if (Number.isFinite(item.tmdbRating) && item.tmdbRating > 0) parts.push('nota ' + item.tmdbRating + ' no TMDB');
    if (extra) parts.push(extra);
    return parts.length ? parts[0].charAt(0).toLocaleUpperCase('pt-BR') + parts.join(' · ').slice(1) : '';
  }

  /** Busca da Netflix já com o nome do título (o TMDB não informa o id da Netflix, então a pessoa escolhe na busca). */
  function netflixSearchUrl(title) {
    const t = String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    return t ? 'https://www.netflix.com/search?q=' + encodeURIComponent(t) : null;
  }
  const canSearchNetflix = (item) => platformOf(item) === 'Netflix' || (item.watchProviders || []).some((p) => platformOf({ service: p }) === 'Netflix');

  return { MOODS, TIMES, platformOf, platformsOf, durationUsable, moodMatch, platformMatch, timeMatch, filterTitles, pick, why, netflixSearchUrl, canSearchNetflix, hours };
});
