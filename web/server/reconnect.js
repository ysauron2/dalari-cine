/* Reconexão automática da sala. Quando a conexão direta com o Host cai (queda de internet, troca de Wi-Fi), o convidado e o Host
   voltam a se encontrar sozinhos, com o mesmo serviço de encontro do código curto, e a sala continua de onde estava.
   Este módulo é só o controlador de tentativas (repete com intervalos crescentes até um limite de tempo); quem sabe religar
   a conexão é o online-ui, que entrega a função "attempt". Sem dependências do navegador, para poder ser testado. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoReconnect = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GUEST_MAX_MS = 10 * 60 * 1000;     // o convidado desiste depois de 10 minutos
  const HOST_MAX_MS = 30 * 60 * 1000;      // o Host espera mais, para quem volta tarde
  const BACKOFF_MS = [2000, 4000, 8000, 15000];

  /** attempt(n) -> true quando religou; lança ou devolve false quando não deu. shouldContinue() corta antes (sala encerrada, saiu...). */
  function createReconnector({ attempt, shouldContinue, onState, maxMs = GUEST_MAX_MS, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), backoff = BACKOFF_MS } = {}) {
    if (typeof attempt !== 'function') throw new TypeError('attempt é obrigatório');
    let stopped = false, running = false;
    const emit = (state) => { try { onState?.(state); } catch { /* o aviso não pode derrubar a reconexão */ } };

    async function run() {
      if (running) return false;                       // já existe uma rodada: não abre outra em paralelo
      running = true; stopped = false;
      const t0 = now();
      let n = 0;
      emit({ phase: 'start' });
      try {
        while (!stopped && now() - t0 < maxMs && (!shouldContinue || shouldContinue())) {
          n++;
          emit({ phase: 'try', n });
          try {
            if (await attempt(n)) { emit({ phase: 'ok', n }); return true; }
          } catch (error) { emit({ phase: 'fail', n, error }); }
          if (stopped) break;
          await sleep(backoff[Math.min(n - 1, backoff.length - 1)]);
        }
        emit({ phase: stopped ? 'stopped' : 'giveup', n });
        return false;
      } finally { running = false; }
    }
    return { run, stop() { stopped = true; }, get running() { return running; } };
  }

  return { createReconnector, GUEST_MAX_MS, HOST_MAX_MS, BACKOFF_MS };
});
