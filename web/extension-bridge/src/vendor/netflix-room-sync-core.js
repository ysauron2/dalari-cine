// Nucleo puro de sincronizacao Netflix da sala. Sem DOM, extensao, storage,
// fetch ou URL: tudo entra por injecao (player, sendAction, now). Ainda NAO esta
// ligado a nenhum navegador. Carregado via require() nos testes ou como script
// classico (globalThis.DuoTelaNetflixRoomSyncCore).
(function (root) {
  "use strict";

  const MAX_POSITION_SEC = 86400;
  const SEEK_THRESHOLD_SEC = 2;
  const MAX_ELAPSED_SEC = 4 * 3600; // limite defensivo da estimativa em reproducao
  const DEFAULT_ECHO_WINDOW_MS = 1500;
  const MAX_ECHO_WINDOW_MS = 10000;
  const MAX_ID_LENGTH = 128;
  const WATCH_ID_PATTERN = /^[0-9]{1,12}$/;
  const ACTIONS = Object.freeze(["play", "pause", "seek"]);

  const STATUS = Object.freeze({
    IDLE: "idle",
    APPLIED: "applied",
    INVALID: "invalid-snapshot",
    NOT_ACTIVE: "room-not-active",
    STALE: "stale",
    CONTEXT_CHANGED: "context-changed",
    NO_VIDEO: "blocked-no-video",
    WRONG_WATCH: "blocked-wrong-watch",
    AUTOPLAY_BLOCKED: "autoplay-blocked",
    PLAY_FAILED: "play-failed",
    PAUSE_FAILED: "pause-failed",
    SEEK_FAILED: "seek-failed",
    SENT: "sent",
    ECHO: "ignored-echo",
    REDUNDANT: "ignored-redundant",
    NO_CONTEXT: "ignored-no-context",
    INVALID_EVENT: "ignored-invalid-event",
    SEND_FAILED: "send-failed",
    NOTHING_PENDING: "ignored-nothing-pending",
    CANCELLED: "cancelled",
  });

  function isPlainString(value, max) {
    return typeof value === "string" && value.length > 0 && value.length <= max;
  }

  function isPosition(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_POSITION_SEC;
  }

  // Nunca repassa nome ou mensagem do erro: callbacks injetados podem carregar segredos.
  // Apenas um codigo fixo; detalhes ficam com o chamador.
  function describeError(_error, code) {
    return { code };
  }

  // Valida o snapshot sem lancar. Retorna {ok, reason} ou {ok, ctx}.
  function parseSnapshot(snapshot, roomCode, role) {
    try {
      if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return { ok: false, reason: "shape" };
      if (snapshot.v !== 1) return { ok: false, reason: "version" };
      if (snapshot.code !== roomCode) return { ok: false, reason: "room" };
      if (snapshot.you !== role) return { ok: false, reason: "role" };
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return { ok: false, reason: "revision" };
      if (typeof snapshot.serverTime !== "number" || !Number.isFinite(snapshot.serverTime)) return { ok: false, reason: "serverTime" };
      if (snapshot.status !== "active") return { ok: false, reason: "status", notActive: true, revision: snapshot.revision };
      if (snapshot.platform !== "netflix") return { ok: false, reason: "platform" };
      const media = snapshot.media;
      if (media === null || typeof media !== "object") return { ok: false, reason: "media" };
      if (media.provider !== "netflix") return { ok: false, reason: "provider" };
      if (!isPlainString(media.titleId, MAX_ID_LENGTH)) return { ok: false, reason: "titleId" };
      if (snapshot.selectedMatch !== media.titleId) return { ok: false, reason: "selectedMatch" };
      if (typeof media.watchId !== "string" || !WATCH_ID_PATTERN.test(media.watchId)) return { ok: false, reason: "watchId" };
      const pb = snapshot.playback;
      if (pb === null || typeof pb !== "object") return { ok: false, reason: "playback" };
      if (pb.titleId !== media.titleId || pb.watchId !== media.watchId) return { ok: false, reason: "playback-ids" };
      if (!Number.isSafeInteger(pb.version) || pb.version < 1) return { ok: false, reason: "playback-version" };
      if (pb.state !== "playing" && pb.state !== "paused") return { ok: false, reason: "playback-state" };
      if (!isPosition(pb.positionSec)) return { ok: false, reason: "positionSec" };
      if (typeof pb.updatedAt !== "number" || !Number.isFinite(pb.updatedAt)) return { ok: false, reason: "updatedAt" };
      return {
        ok: true,
        ctx: {
          titleId: media.titleId,
          watchId: media.watchId,
          revision: snapshot.revision,
          version: pb.version,
          state: pb.state,
          positionSec: pb.positionSec,
          // serverTime e updatedAt vem do MESMO relogio (servidor); so a diferenca importa.
          // Unidade assumida: milissegundos (ver CLAUDE-REPORT.md).
          elapsedSec: Math.min(Math.max((snapshot.serverTime - pb.updatedAt) / 1000, 0), MAX_ELAPSED_SEC),
        },
      };
    } catch (_error) {
      return { ok: false, reason: "shape" };
    }
  }

  // Posicao alvo: se pausado, a gravada; se tocando, gravada + tempo decorrido no servidor.
  function computeTargetPosition(state, positionSec, elapsedSec) {
    const raw = state === "playing" ? positionSec + elapsedSec : positionSec;
    return Math.min(Math.max(raw, 0), MAX_POSITION_SEC);
  }

  function createNetflixRoomSyncCore(options) {
    const opts = options || {};
    const { roomCode, role, player, sendAction } = opts;
    if (!isPlainString(roomCode, MAX_ID_LENGTH)) throw new TypeError("roomCode obrigatorio");
    if (!isPlainString(role, MAX_ID_LENGTH)) throw new TypeError("role obrigatorio");
    if (!player || ["getWatchId", "getCurrentTime", "play", "pause", "seek"].some((m) => typeof player[m] !== "function")) {
      throw new TypeError("player precisa de getWatchId/getCurrentTime/play/pause/seek");
    }
    if (typeof sendAction !== "function") throw new TypeError("sendAction obrigatorio");
    const now = typeof opts.now === "function" ? opts.now : Date.now;
    const echoWindowMs = Number.isFinite(opts.echoWindowMs) && opts.echoWindowMs >= 0
      ? Math.min(opts.echoWindowMs, MAX_ECHO_WINDOW_MS)
      : DEFAULT_ECHO_WINDOW_MS;

    let bound = null; // {titleId, watchId}: contexto fixado ate reset()
    let active = false; // ultimo snapshot do contexto foi aceito e a sala esta ativa
    let lastRevision = -1;
    let lastVersion = 0;
    let lastKnown = null; // {state|null, positionSec, at}: ultimo estado conhecido da sala
    let lastRemote = null; // comandos emitidos ao player pelo ultimo snapshot (para eco)
    let status = { state: STATUS.IDLE };
    let pending = null; // {ctx, receivedAt, reason}: ultimo snapshot cujo comando falhou
    let queue = Promise.resolve();
    // Geracao: reset(), snapshot inativo mais novo e troca de contexto a incrementam. Comando
    // assincrono iniciado numa geracao antiga nao toca em estado nem comanda o player depois de um await.
    let epoch = 0;

    function localNow() {
      try {
        const t = now();
        return Number.isFinite(t) ? t : 0;
      } catch (_error) {
        return 0;
      }
    }

    // Resultado de comando invalidado: NAO altera `status` (que pertence a geracao atual).
    function cancelledResult() {
      return { ok: false, state: STATUS.CANCELLED };
    }

    function setStatus(state, extra) {
      status = Object.assign({ state }, extra || {});
      return Object.assign({ ok: state === STATUS.APPLIED || state === STATUS.SENT }, status);
    }

    function readWatchId() {
      try {
        const id = player.getWatchId();
        return typeof id === "string" && id.length > 0 ? id : null;
      } catch (_error) {
        return null;
      }
    }

    // Retorna null se o player esta no video certo, ou o resultado de bloqueio.
    function checkPlayer(watchId) {
      const current = readWatchId();
      if (current === null) return setStatus(STATUS.NO_VIDEO);
      if (current !== watchId) return setStatus(STATUS.WRONG_WATCH);
      return null;
    }

    function expectedPosition() {
      if (!lastKnown) return null;
      const elapsed = lastKnown.state === "playing" ? Math.max((localNow() - lastKnown.at) / 1000, 0) : 0;
      return lastKnown.positionSec + elapsed;
    }

    // Executa o snapshot aceito. `retrying` reaproveita o mesmo ctx sem consumir revision/version:
    // posicao recomputada com o relogio local, seek so se ainda longe do alvo (um seek que ja deu
    // certo nao se repete) e watchId conferido de novo. Falha deixa `pending` para uma nova
    // tentativa EXPLICITA (resumePending/retryLast); nunca ha repeticao automatica.
    async function applyParsed(ctx, receivedAt, retrying) {
      const myEpoch = epoch;
      const blocked = checkPlayer(ctx.watchId);
      if (blocked) return blocked; // nao consome revision/version nem pendencia
      if (!retrying) {
        lastRevision = ctx.revision;
        lastVersion = ctx.version;
        active = true;
      }
      const fail = (state, error, code) => {
        lastRemote = null;
        pending = { ctx, receivedAt, reason: state };
        return setStatus(state, { error: describeError(error, code) });
      };

      const localElapsed = retrying ? Math.max((localNow() - receivedAt) / 1000, 0) : 0;
      const elapsed = Math.min(ctx.elapsedSec + localElapsed, MAX_ELAPSED_SEC);
      const target = computeTargetPosition(ctx.state, ctx.positionSec, elapsed);
      let current;
      try {
        current = player.getCurrentTime();
      } catch (_error) {
        current = NaN;
      }
      if (typeof current !== "number" || !Number.isFinite(current)) {
        pending = { ctx, receivedAt, reason: STATUS.NO_VIDEO };
        return setStatus(STATUS.NO_VIDEO, { reason: "time-unavailable" });
      }

      const seeking = Math.abs(target - current) > SEEK_THRESHOLD_SEC;
      // Marca antes de comandar: eventos do player podem chegar antes das promessas resolverem.
      lastRemote = { at: localNow(), play: ctx.state === "playing", pause: ctx.state === "paused", seek: seeking, target };

      if (seeking) {
        try {
          await player.seek(target);
        } catch (error) {
          if (epoch !== myEpoch) return cancelledResult();
          return fail(STATUS.SEEK_FAILED, error, "player-error");
        }
        if (epoch !== myEpoch) return cancelledResult(); // nao envia play/pause para sala encerrada
      }
      if (ctx.state === "playing") {
        try {
          await player.play();
        } catch (error) {
          if (epoch !== myEpoch) return cancelledResult();
          const blockedByPolicy = Boolean(error) && error.name === "NotAllowedError";
          return fail(blockedByPolicy ? STATUS.AUTOPLAY_BLOCKED : STATUS.PLAY_FAILED, error, blockedByPolicy ? "autoplay-blocked" : "player-error");
        }
      } else {
        try {
          await player.pause();
        } catch (error) {
          if (epoch !== myEpoch) return cancelledResult();
          return fail(STATUS.PAUSE_FAILED, error, "player-error");
        }
      }
      if (epoch !== myEpoch) return cancelledResult();
      pending = null;
      const at = localNow();
      lastRemote.at = at;
      lastKnown = { state: ctx.state, positionSec: target, at };
      return setStatus(STATUS.APPLIED, { seeked: seeking, targetSec: target });
    }

    // Trata o que nao comanda o player (invalido, inativo, contexto trocado). Sincrono, para poder
    // invalidar um comando em andamento sem esperar na fila. Sem `result`, o snapshot deve ser aplicado.
    function classifySnapshot(snapshot) {
      const parsed = parseSnapshot(snapshot, roomCode, role);
      if (!parsed.ok) {
        // Uma revisao nova da mesma sala/papel que deixa de ser Netflix/match
        // invalida o contexto atual. Outra sala/papel nao altera este nucleo.
        let sameRoom = false;
        let revision = -1;
        try {
          revision = snapshot?.revision;
          sameRoom = snapshot && typeof snapshot === "object" &&
            snapshot.code === roomCode && snapshot.you === role &&
            Number.isSafeInteger(revision) && revision >= 0;
        } catch (_error) {
          // Um Proxy malformado nao pode quebrar o contrato de resposta.
        }
        if (sameRoom) {
          if (revision <= lastRevision) return { result: setStatus(STATUS.STALE, { reason: "revision" }) };
          lastRevision = revision;
          active = false;
          pending = null;
          epoch += 1;
        }
        return { result: setStatus(parsed.notActive ? STATUS.NOT_ACTIVE : STATUS.INVALID, { reason: parsed.reason }) };
      }
      const ctx = parsed.ctx;
      if (bound && (bound.titleId !== ctx.titleId || bound.watchId !== ctx.watchId)) {
        // Uma mensagem antiga de outra mídia não pode interromper a mídia atual.
        if (ctx.revision <= lastRevision) return { result: setStatus(STATUS.STALE, { reason: "revision" }) };
        active = false;
        pending = null;
        epoch += 1;
        return { result: setStatus(STATUS.CONTEXT_CHANGED, { reason: "reset-required" }) };
      }
      return { ctx };
    }

    async function processSnapshot(snapshot, myEpoch) {
      if (epoch !== myEpoch) return cancelledResult();
      const classified = classifySnapshot(snapshot);
      if (classified.result) return classified.result;
      const ctx = classified.ctx;
      if (ctx.revision <= lastRevision || ctx.version <= lastVersion) {
        return setStatus(STATUS.STALE, { reason: ctx.revision <= lastRevision ? "revision" : "version" });
      }
      if (!bound) bound = { titleId: ctx.titleId, watchId: ctx.watchId };
      pending = null; // snapshot mais novo substitui qualquer pendencia
      const receivedAt = localNow();
      try {
        return await applyParsed(ctx, receivedAt, false);
      } catch (error) {
        if (epoch !== myEpoch) return cancelledResult();
        return setStatus(STATUS.PLAY_FAILED, { error: describeError(error, "player-error") });
      }
    }

    // Uma tentativa explicita sobre a pendencia atual, se ela for do tipo pedido.
    async function processRetry(wantAutoplay, myEpoch) {
      if (epoch !== myEpoch) return cancelledResult();
      const p = pending;
      if (!p || !bound || !active || (p.reason === STATUS.AUTOPLAY_BLOCKED) !== wantAutoplay) {
        return setStatus(STATUS.NOTHING_PENDING);
      }
      try {
        return await applyParsed(p.ctx, p.receivedAt, true);
      } catch (error) {
        if (epoch !== myEpoch) return cancelledResult();
        return setStatus(STATUS.PLAY_FAILED, { error: describeError(error, "player-error") });
      }
    }

    // Serializa: dois comandos em sequencia nunca comandam o player ao mesmo tempo.
    function enqueue(fn) {
      const run = queue.then(fn);
      queue = run.catch(() => undefined);
      return run;
    }

    function applySnapshot(snapshot) {
      // Inativo/contexto trocado agem na hora (invalidam comando em andamento); so o resto entra na fila.
      const early = classifySnapshot(snapshot);
      if (early.result) return Promise.resolve(early.result);
      const myEpoch = epoch;
      return enqueue(() => processSnapshot(snapshot, myEpoch));
    }

    // Retoma um play bloqueado pela politica de autoplay; chamar a partir de um gesto do usuario.
    function resumePending() {
      const myEpoch = epoch;
      return enqueue(() => processRetry(true, myEpoch));
    }

    // Nova tentativa explicita do ultimo snapshot que falhou por outro motivo (seek/play/pause/tempo).
    function retryLast() {
      const myEpoch = epoch;
      return enqueue(() => processRetry(false, myEpoch));
    }

    function isEcho(action, positionSec) {
      if (!lastRemote || localNow() - lastRemote.at > echoWindowMs) return false;
      if (action === "play") return lastRemote.play;
      if (action === "pause") return lastRemote.pause;
      return lastRemote.seek && Math.abs(positionSec - lastRemote.target) <= SEEK_THRESHOLD_SEC;
    }

    async function localEvent(action, positionSec) {
      const myEpoch = epoch;
      if (!ACTIONS.includes(action) || !isPosition(positionSec)) return setStatus(STATUS.INVALID_EVENT);
      if (!bound || !active) return setStatus(STATUS.NO_CONTEXT);
      const blocked = checkPlayer(bound.watchId);
      if (blocked) return blocked;
      if (isEcho(action, positionSec)) return setStatus(STATUS.ECHO);
      if (lastKnown) {
        const expected = expectedPosition();
        const near = Math.abs(positionSec - expected) <= SEEK_THRESHOLD_SEC;
        const sameState = action === "seek" || (action === "play" ? "playing" : "paused") === lastKnown.state;
        if (near && sameState) return setStatus(STATUS.REDUNDANT);
      }
      const payload = { titleId: bound.titleId, watchId: bound.watchId, action, positionSec };
      try {
        await sendAction(payload);
      } catch (error) {
        if (epoch !== myEpoch) return cancelledResult();
        // Nao atualiza lastKnown: o chamador pode reenviar e o evento nao fica "redundante".
        return setStatus(STATUS.SEND_FAILED, { error: describeError(error, "send-error"), action });
      }
      if (epoch !== myEpoch) return cancelledResult();
      const state = action === "seek" ? (lastKnown ? lastKnown.state : null) : action === "play" ? "playing" : "paused";
      lastKnown = { state, positionSec, at: localNow() };
      return setStatus(STATUS.SENT, { action });
    }

    // Reset explicito: nova sala/midia. Nao altera o player.
    function reset() {
      epoch += 1;
      bound = null;
      active = false;
      lastRevision = -1;
      lastVersion = 0;
      lastKnown = null;
      lastRemote = null;
      pending = null;
      status = { state: STATUS.IDLE };
    }

    function getStatus() {
      return Object.assign({}, status, {
        bound: bound ? Object.assign({}, bound) : null,
        active,
        pending: pending ? { reason: pending.reason, revision: pending.ctx.revision, version: pending.ctx.version } : null,
        lastRevision,
        lastVersion,
      });
    }

    return { applySnapshot, resumePending, retryLast, localEvent, reset, getStatus };
  }

  const api = Object.freeze({
    STATUS,
    SEEK_THRESHOLD_SEC,
    MAX_POSITION_SEC,
    MAX_ELAPSED_SEC,
    DEFAULT_ECHO_WINDOW_MS,
    computeTargetPosition,
    createNetflixRoomSyncCore,
  });

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DuoTelaNetflixRoomSyncCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
