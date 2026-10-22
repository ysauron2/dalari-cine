/* Cor do ambiente da sala: tira do cartaz (ou da miniatura) do que estão assistindo a cor mais viva e a usa como brilho no fundo
   e ao redor do palco. Se a imagem não puder ser lida (alguns servidores não permitem), usa uma cor estável gerada do título,
   então a sala sempre muda de clima, sem falhar. Nada sai do computador: a amostragem é feita num canvas local. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoAmbient = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT = { r: 255, g: 172, b: 143 };      // coral do Dalari Cine
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: ((h * 60) + 360) % 360, s: max ? d / max : 0, v: max };
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }

  /** Cor estável a partir de um texto (id do título): mesmo texto, mesma cor; vivas, nunca quase pretas nem lavadas. */
  function hashColor(seed) {
    let h = 2166136261;
    for (const ch of String(seed ?? '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return hsvToRgb(h % 360, 0.55 + ((h >>> 9) % 25) / 100, 0.75 + ((h >>> 17) % 15) / 100);
  }

  /** A cor mais "viva" de uma imagem: agrupa por matiz, pondera por saturação e brilho e ignora quase preto, quase branco e cinza. */
  function vibrant(rgba) {
    const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i + 3 < rgba.length; i += 4) {
      if (rgba[i + 3] < 200) continue;
      const { h, s, v } = rgbToHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (v < 0.18 || s < 0.22 || (v > 0.96 && s < 0.35)) continue;
      const w = s * s * (0.4 + v);
      const k = buckets[Math.floor(h / 30) % 12];
      k.w += w; k.r += rgba[i] * w; k.g += rgba[i + 1] * w; k.b += rgba[i + 2] * w;
    }
    const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
    if (best.w <= 0) return null;
    return { r: Math.round(best.r / best.w), g: Math.round(best.g / best.w), b: Math.round(best.b / best.w) };
  }

  /** Garante uma cor agradável no fundo escuro: nunca escura demais nem estourada. */
  function tune({ r, g, b }) {
    const { h, s, v } = rgbToHsv(r, g, b);
    return hsvToRgb(h, clamp(s, 0.45, 0.9), clamp(v, 0.7, 0.95));
  }
  const css = ({ r, g, b }, alpha) => (alpha === undefined ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`);

  /** Lê a imagem num canvas pequeno. Rejeita se não puder (CORS, rede). */
  function sample(win, url, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const img = new win.Image();
      const timer = win.setTimeout(() => reject(new Error('timeout')), timeoutMs);
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        win.clearTimeout(timer);
        try {
          const c = win.document.createElement('canvas'); c.width = 24; c.height = 36;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 24, 36);
          resolve(ctx.getImageData(0, 0, 24, 36).data);
        } catch (e) { reject(e); }
      };
      img.onerror = () => { win.clearTimeout(timer); reject(new Error('image')); };
      img.src = url;
    });
  }

  /** Cor do ambiente para um título: do cartaz se der, senão a cor estável do id. Sempre resolve. */
  async function colorFor(win, { url, seed }) {
    if (url) {
      try { const c = vibrant(await sample(win, url)); if (c) return tune(c); } catch { /* cai na cor estável */ }
    }
    return tune(hashColor(seed));
  }

  return { colorFor, vibrant, hashColor, tune, css, rgbToHsv, hsvToRgb, DEFAULT };
});
