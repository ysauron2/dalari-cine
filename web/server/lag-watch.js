/* "O filme se perdeu": cada player diz à sala o quanto está adiantado (+) ou atrasado (-) em segundos, e quem está em dia mostra um
   aviso claro ("Larissa ficou 8 s atrás") com um botão para alinhar todos. Aqui fica só a lógica pura (testada à parte);
   a tela liga isso ao player em online-ui.js. Só um número por pessoa viaja, e ele some sozinho em poucos segundos. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoLagWatch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const THRESHOLD_SEC = 5;          // abaixo disso a diferença é normal (buffer, relógio) e ninguém precisa saber
  const HOLD_MS = 6000;             // a diferença precisa durar isso para o aviso aparecer (não pisca por um engasgo)
  const HEARTBEAT_MS = 8000;        // reenvia o mesmo valor a cada tanto; a sala esquece relatos com mais de 20 s
  const MIN_CHANGE_SEC = 2;

  /** Quanto o meu player está adiantado (+) ou atrasado (-) em relação à sala, em segundos inteiros; null se não faz sentido medir. */
  function myLag({ playing, dur, blocked, local, wanted }) {
    if (!playing || blocked || !(dur > 0) || !Number.isFinite(local) || !Number.isFinite(wanted)) return null;
    return Math.max(-3600, Math.min(3600, Math.round(local - wanted))) || 0;
  }

  /** Decide quando enviar o meu atraso: quando muda (2 s ou mais), de tempos em tempos e uma vez ao voltar a "sem medida". */
  function createReporter() {
    let lastSent = null, lastAt = 0;
    return {
      /** Devolve o número a enviar agora ou null (nada a enviar). `lag` null = não estou medindo. */
      next(lag, now) {
        if (lag === null) {
          if (lastSent !== null && lastSent !== 0) { lastSent = null; lastAt = now; return 0; }   // zera o que a sala sabia sobre mim
          lastSent = null; return null;
        }
        if (lastSent === null || Math.abs(lag - lastSent) >= MIN_CHANGE_SEC || now - lastAt >= HEARTBEAT_MS) { lastSent = lag; lastAt = now; return lag; }
        return null;
      },
    };
  }

  const secs = (n) => Math.abs(n) + ' s';
  /** O aviso para quem está em dia, a partir dos relatos da sala. Só aparece depois de HOLD_MS acima do limite. */
  function createBanner({ thresholdSec = THRESHOLD_SEC, holdMs = HOLD_MS } = {}) {
    const since = {};
    return {
      /** lags: { papel: segundos }, you: meu papel, nameOf: papel → nome. Devolve { text, roles } ou null. */
      update(lags, you, nameOf, now) {
        const off = [];
        for (const [role, lag] of Object.entries(lags || {})) {
          if (role === you || !Number.isFinite(lag) || Math.abs(lag) < thresholdSec) { delete since[role]; continue; }
          if (since[role] === undefined) since[role] = now;
          if (now - since[role] >= holdMs) off.push([role, lag]);
        }
        for (const role of Object.keys(since)) if (!(role in (lags || {}))) delete since[role];
        if (!off.length) return null;
        const parts = off.map(([role, lag]) => `${nameOf(role)} ${lag < 0 ? 'ficou ' + secs(lag) + ' atrás' : 'está ' + secs(lag) + ' na frente'}`);
        return { text: parts.length === 1 ? parts[0] + '.' : parts.slice(0, -1).join(', ') + ' e ' + parts[parts.length - 1] + '.', roles: off.map(([r]) => r) };
      },
    };
  }

  return { myLag, createReporter, createBanner, THRESHOLD_SEC, HOLD_MS, HEARTBEAT_MS, MIN_CHANGE_SEC };
});
