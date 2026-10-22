/* Catálogo de mídia do Dalari Cine: escolhe uma imagem por categoria sem repetir as últimas, e confere o manifesto (licença obrigatória).
   Só lógica pura; a interface (hero, salas) chama daqui. As imagens ficam em /media e o manifesto em /media/manifest.json. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoMedia = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CATEGORIES = ['amigos', 'romance', 'aventura', 'cinema', 'cozy', 'noite', 'ficcao-cientifica', 'terror', 'anime'];
  const TYPES = ['image', 'loop'];
  const ID_RE = /^[a-z0-9-]{2,60}$/, FILE_RE = /^[a-z0-9-]+\.(svg|webp|png|jpg|mp4|webm)$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const REMEMBER = 3;

  /** Problemas do manifesto (lista vazia = ok). Cada item precisa de categoria conhecida, arquivo simples, cor, texto alternativo, crédito, licença e fonte. */
  function validateManifest(m) {
    const problems = [];
    if (!m || m.v !== 1 || !Array.isArray(m.items)) return ['manifesto inválido'];
    const ids = new Set();
    m.items.forEach((it, i) => {
      const at = 'item ' + i + (it && it.id ? ' (' + it.id + ')' : '');
      if (!it || typeof it !== 'object') { problems.push(at + ': não é um objeto'); return; }
      if (!ID_RE.test(it.id || '')) problems.push(at + ': id inválido');
      else if (ids.has(it.id)) problems.push(at + ': id repetido'); else ids.add(it.id);
      if (!CATEGORIES.includes(it.category)) problems.push(at + ': categoria desconhecida');
      if (!TYPES.includes(it.type)) problems.push(at + ': tipo desconhecido');
      if (!FILE_RE.test(it.file || '')) problems.push(at + ': arquivo inválido');
      if (!Number.isInteger(it.width) || !Number.isInteger(it.height) || it.width < 100 || it.height < 100) problems.push(at + ': tamanho inválido');
      if (!COLOR_RE.test(it.color || '')) problems.push(at + ': cor inválida');
      for (const f of ['alt', 'credit', 'license', 'source']) if (typeof it[f] !== 'string' || it[f].trim().length < 3) problems.push(at + ': falta ' + f);
    });
    return problems;
  }

  const inCategory = (m, category) => (m.items || []).filter((it) => it.category === category);

  /** Escolhe uma mídia da categoria, evitando as últimas `keep` já mostradas (se houver alternativa). Devolve o item ou null. */
  function pick(manifest, category, { recent = [], rng = Math.random, keep = REMEMBER } = {}) {
    const all = inCategory(manifest, category);
    if (!all.length) return null;
    const avoid = new Set(recent.slice(-keep));
    const fresh = all.filter((it) => !avoid.has(it.id));
    const pool = fresh.length ? fresh : all.filter((it) => it.id !== recent[recent.length - 1] || all.length === 1);
    const list = pool.length ? pool : all;
    return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
  }
  /** Acrescenta o id ao histórico (mantendo só os últimos `keep` * 2, sem repetir em sequência). */
  function remember(recent, id, keep = REMEMBER) {
    const out = recent.filter((x) => x !== id).concat(id);
    return out.slice(-keep * 2);
  }
  /** Caminho da mídia para uso na interface. */
  const urlOf = (item) => '/media/' + item.file;

  return { CATEGORIES, validateManifest, pick, remember, inCategory, urlOf, REMEMBER };
});
