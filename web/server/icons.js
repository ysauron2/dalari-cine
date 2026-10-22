/* Ícones do Dalari Cine: um conjunto próprio, de traço fino e cantos arredondados, no mesmo estilo (grade 24x24, cor da fonte).
   Uso: DuoIcons.html('play') devolve o <svg> como texto (para templates) e DuoIcons.node(document, 'play') devolve o elemento.
   Em textos de botões/etiquetas da sala dá para escrever "@play Reproduzir": o "@nome " vira o ícone antes do texto. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoIcons = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Cada ícone é uma lista de formas. Texto = traço; { d, fill: true } = preenchido.
  const dot = (cx, cy, r = 1.2) => ({ d: `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`, fill: true });
  const ICONS = {
    home: ['M4 11.2 12 4.8l8 6.4', 'M6.2 10v8.6a.9.9 0 0 0 .9.9h9.8a.9.9 0 0 0 .9-.9V10', 'M10 19.5v-4.6h4v4.6'],
    discover: ['M12 3.8l1.9 5.5 5.5 1.9-5.5 1.9L12 18.6l-1.9-5.5-5.5-1.9 5.5-1.9z', 'M18.6 3.6v3.2M17 5.2h3.2'],
    heart: ['M12 19.4s-7-4.4-7-9.6a3.9 3.9 0 0 1 7-2.3 3.9 3.9 0 0 1 7 2.3c0 5.2-7 9.6-7 9.6z'],
    history: ['M4.6 12a7.4 7.4 0 1 0 2.2-5.2', 'M4.4 4.6v3.4h3.4', 'M12 8.2V12l2.6 1.7'],
    room: ['M9 11a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 9 11z', 'M3.6 18.6c.5-2.8 2.7-4.3 5.4-4.3s4.9 1.5 5.4 4.3', 'M16.4 10.4a2.2 2.2 0 1 0 0-4.3', 'M17.2 14.2c1.8.4 3 1.6 3.3 3.8'],
    user: ['M12 11.8a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4z', 'M5 19.4c.6-3.4 3.3-5.1 7-5.1s6.4 1.7 7 5.1'],
    play: ['M8.2 5.6v12.8l10.4-6.4z'],
    pause: ['M8.6 5.8v12.4', 'M15.4 5.8v12.4'],
    fullscreen: ['M4.8 9.4V4.8h4.6', 'M19.2 9.4V4.8h-4.6', 'M4.8 14.6v4.6h4.6', 'M19.2 14.6v4.6h-4.6'],
    mic: ['M12 14.6a3.1 3.1 0 0 0 3.1-3.1V6.9a3.1 3.1 0 0 0-6.2 0v4.6a3.1 3.1 0 0 0 3.1 3.1z', 'M6.4 11.4a5.6 5.6 0 0 0 11.2 0', 'M12 17v3.2'],
    headphones: ['M5 14.2v-2a7 7 0 0 1 14 0v2', 'M5 14.2h2.6v4.9H6.3a1.3 1.3 0 0 1-1.3-1.3z', 'M19 14.2h-2.6v4.9h1.3a1.3 1.3 0 0 0 1.3-1.3z'],
    check: ['M5.2 12.6l4.4 4.4 9.2-9.6'],
    circle: ['M12 5.4a6.6 6.6 0 1 0 0 13.2 6.6 6.6 0 0 0 0-13.2z'],
    invite: ['M7.4 16.6l9.2-9.2', 'M9.4 7.4h7.2v7.2'],
    dots: [dot(6, 12, 1.3), dot(12, 12, 1.3), dot(18, 12, 1.3)],
    sync: ['M5.2 12a6.9 6.9 0 0 1 11.8-4.8L19 9.2', 'M19 4.8v4.4h-4.4', 'M18.8 12a6.9 6.9 0 0 1-11.8 4.8L5 14.8', 'M5 19.2v-4.4h4.4'],
    film: ['M4.6 6.4h14.8v11.2H4.6z', 'M8.4 6.4v11.2', 'M15.6 6.4v11.2', 'M4.6 10.2h3.8', 'M4.6 13.8h3.8', 'M15.6 10.2h3.8', 'M15.6 13.8h3.8'],
    close: ['M6.4 6.4l11.2 11.2', 'M17.6 6.4 6.4 17.6'],
    gear: ['M12 14.9a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8z', 'M19 12a7 7 0 0 0-.1-1.2l1.7-1.3-1.7-3-2 .7a7 7 0 0 0-2-1.2L14.5 4h-3.4l-.4 2a7 7 0 0 0-2 1.2l-2-.7-1.7 3 1.7 1.3a7 7 0 0 0 0 2.4l-1.7 1.3 1.7 3 2-.7a7 7 0 0 0 2 1.2l.4 2h3.4l.4-2a7 7 0 0 0 2-1.2l2 .7 1.7-3-1.7-1.3c.1-.4.1-.8.1-1.2z'],
    moon: ['M19.2 14.6A7.6 7.6 0 0 1 9.4 4.8 7.6 7.6 0 1 0 19.2 14.6z'],
    sparkle: ['M12 4.4l1.5 4.6 4.6 1.5-4.6 1.5L12 16.6l-1.5-4.6L5.9 10.5 10.5 9z'],
  };
  const NAMES = Object.keys(ICONS);
  const NS = 'http://www.w3.org/2000/svg';
  const attrs = 'viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
  const has = (name) => Object.hasOwn(ICONS, name);

  function html(name, cls = '') {
    if (!has(name)) return '';
    const shapes = ICONS[name].map((s) => (typeof s === 'string' ? `<path d="${s}"/>` : `<path d="${s.d}" fill="currentColor" stroke="none"/>`)).join('');
    return `<svg class="ico ico-${name}${cls ? ' ' + cls : ''}" ${attrs}>${shapes}</svg>`;
  }
  function node(doc, name, cls = '') {
    if (!has(name)) return null;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', `ico ico-${name}${cls ? ' ' + cls : ''}`);
    for (const [k, v] of [['viewBox', '0 0 24 24'], ['width', '1em'], ['height', '1em'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.8'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['focusable', 'false']]) svg.setAttribute(k, v);
    for (const s of ICONS[name]) {
      const p = doc.createElementNS(NS, 'path');
      p.setAttribute('d', typeof s === 'string' ? s : s.d);
      if (typeof s !== 'string') { p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'none'); }
      svg.append(p);
    }
    return svg;
  }
  /** "@play Reproduzir" -> { icon: 'play', text: 'Reproduzir' }; sem marcador (ou nome desconhecido) devolve o texto como veio. */
  function split(text) {
    const m = /^@([a-z0-9-]+)(?: (.*))?$/s.exec(String(text ?? ''));
    return m && has(m[1]) ? { icon: m[1], text: m[2] ?? '' } : { icon: null, text: String(text ?? '') };
  }
  const css = '.ico{width:1.1em;height:1.1em;vertical-align:-.2em;flex:none}.ico+*{margin-left:.45em}button>.ico:only-child{margin:0}';

  return { html, node, split, has, names: () => NAMES.slice(), css };
});
