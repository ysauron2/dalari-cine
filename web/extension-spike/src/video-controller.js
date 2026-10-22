// Controlador puro: recebe mensagens e age sobre o <video> atual.
// Sem rede, sem armazenamento. Carregado como script classico no navegador
// (expoe globalThis.SessaoADoisVideoController) e via require() nos testes.
(function (root) {
  "use strict";

  const MESSAGE_TYPES = Object.freeze({
    GET_STATE: "GET_STATE",
    PLAY: "PLAY",
    PAUSE: "PAUSE",
    SEEK_TO_SECONDS: "SEEK_TO_SECONDS",
  });

  const ERROR_CODES = Object.freeze({
    NO_VIDEO: "NO_VIDEO",
    INVALID_MESSAGE: "INVALID_MESSAGE",
    UNKNOWN_MESSAGE_TYPE: "UNKNOWN_MESSAGE_TYPE",
    INVALID_SEEK_SECONDS: "INVALID_SEEK_SECONDS",
    DURATION_UNKNOWN: "DURATION_UNKNOWN",
    PLAY_BLOCKED_BY_BROWSER: "PLAY_BLOCKED_BY_BROWSER",
    PLAY_INTERRUPTED: "PLAY_INTERRUPTED",
    PLAY_FAILED: "PLAY_FAILED",
    PAUSE_FAILED: "PAUSE_FAILED",
    SEEK_FAILED: "SEEK_FAILED",
    INTERNAL_ERROR: "INTERNAL_ERROR",
  });

  // Player principal primeiro; previews de hover da home usam outros containers.
  const VIDEO_SELECTORS = Object.freeze([
    "#movie_player video.html5-main-video",
    "video.html5-main-video",
    "#movie_player video",
    "video",
  ]);

  const NETFLIX_PLAYER_CONTAINER = ".watch-video--player-view, [data-uia='video-canvas']";

  function success(state) {
    return { ok: true, state };
  }

  function failure(code, message, state) {
    const response = { ok: false, error: { code, message } };
    if (state) response.state = state;
    return response;
  }

  function isNetflixHost(hostname) {
    return hostname === "www.netflix.com";
  }

  // Netflix: so o ID numerico da rota /watch/<id>. Nao e convertido em titulo.
  function readNetflixWatchId(url) {
    const match = url.pathname.match(/^\/watch\/(\d+)\/?$/);
    return match ? match[1] : null;
  }

  function readVideoIdFromLocation(location) {
    if (!location) return null;
    try {
      const url = new URL(location.href);
      if (isNetflixHost(url.hostname)) return readNetflixWatchId(url);
      const watchId = url.searchParams.get("v");
      if (watchId) return watchId;
      const shortsMatch = url.pathname.match(/^\/shorts\/([\w-]+)/);
      return shortsMatch ? shortsMatch[1] : null;
    } catch (_error) {
      return null;
    }
  }

  function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
  }

  function describeVideo(video, location) {
    return {
      hasVideo: true,
      videoId: readVideoIdFromLocation(location),
      isPlaying: !video.paused && !video.ended,
      isEnded: Boolean(video.ended),
      currentTimeSeconds: finiteOrNull(video.currentTime),
      durationSeconds: finiteOrNull(video.duration),
      readyState: video.readyState,
    };
  }

  function describeNoVideo(location) {
    return {
      hasVideo: false,
      videoId: readVideoIdFromLocation(location),
      isPlaying: false,
      isEnded: false,
      currentTimeSeconds: null,
      durationSeconds: null,
      readyState: null,
    };
  }

  function createDomVideoFinder(documentRef) {
    return function findCurrentVideo() {
      for (const selector of VIDEO_SELECTORS) {
        const video = documentRef.querySelector(selector);
        if (video) return video;
      }
      return null;
    };
  }

  function isVisibleBox(video) {
    if (typeof video.getBoundingClientRect !== "function") return false;
    const box = video.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  // Netflix: so age em /watch/<id>. Entre varios <video>, descarta os invisiveis
  // (trailers/previas fora de tela ou com tamanho zero), prefere os dentro do
  // container do player e, a seguir, o de maior area visivel. Sem candidato, null.
  // Sem cache: a Netflix e SPA e recria o <video> ao trocar de titulo.
  function createNetflixVideoFinder(documentRef, getLocation) {
    const readLocation = typeof getLocation === "function" ? getLocation : () => null;
    return function findCurrentVideo() {
      if (!readVideoIdFromLocation(readLocation())) return null;
      let best = null;
      let bestScore = null;
      for (const video of Array.from(documentRef.querySelectorAll("video"))) {
        if (!isVisibleBox(video)) continue;
        const box = video.getBoundingClientRect();
        const inPlayer = typeof video.closest === "function" && video.closest(NETFLIX_PLAYER_CONTAINER) ? 1 : 0;
        const score = [inPlayer, box.width * box.height];
        if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
          best = video;
          bestScore = score;
        }
      }
      return best;
    };
  }

  // Escolhe o localizador pelo host da pagina; fora da Netflix, comportamento do YouTube.
  function createPageVideoFinder(documentRef, getLocation) {
    let hostname = null;
    try {
      const location = typeof getLocation === "function" ? getLocation() : null;
      hostname = location ? new URL(location.href).hostname : null;
    } catch (_error) {
      hostname = null;
    }
    return isNetflixHost(hostname)
      ? createNetflixVideoFinder(documentRef, getLocation)
      : createDomVideoFinder(documentRef);
  }

  // Valida seek: so numero primitivo finito e >= 0. Strings, NaN, Infinity,
  // objetos e negativos sao rejeitados (nao convertidos). Retorna o valor
  // limitado a duracao do video.
  function validateSeekSeconds(requestedSeconds, durationSeconds) {
    if (typeof requestedSeconds !== "number" || !Number.isFinite(requestedSeconds) || requestedSeconds < 0) {
      return { ok: false, code: ERROR_CODES.INVALID_SEEK_SECONDS, message: "seconds deve ser um numero finito >= 0." };
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return { ok: false, code: ERROR_CODES.DURATION_UNKNOWN, message: "Duracao desconhecida (video carregando ou ao vivo); seek recusado." };
    }
    return { ok: true, seconds: Math.min(requestedSeconds, durationSeconds) };
  }

  // findCurrentVideo e getLocation sao chamados a cada mensagem, sem cache:
  // assim a navegacao SPA do YouTube (troca de video sem recarregar a pagina)
  // nunca deixa o controlador preso a um elemento antigo.
  function createVideoController({ findCurrentVideo, getLocation }) {
    if (typeof findCurrentVideo !== "function") throw new TypeError("findCurrentVideo e obrigatorio");
    const readLocation = typeof getLocation === "function" ? getLocation : () => null;

    async function playVideo(video) {
      try {
        const playResult = video.play();
        if (playResult && typeof playResult.then === "function") await playResult;
      } catch (error) {
        const state = describeVideo(video, readLocation());
        const errorName = error && error.name;
        if (errorName === "NotAllowedError") {
          return failure(ERROR_CODES.PLAY_BLOCKED_BY_BROWSER, "O navegador bloqueou play sem gesto do usuario. Clique no video ou interaja com a pagina e tente de novo.", state);
        }
        if (errorName === "AbortError") {
          return failure(ERROR_CODES.PLAY_INTERRUPTED, "O play foi interrompido (ex.: troca de video).", state);
        }
        return failure(ERROR_CODES.PLAY_FAILED, "Falha ao iniciar a reproducao.", state);
      }
      return success(describeVideo(video, readLocation()));
    }

    // Estado para anexar a uma falha; nunca lanca (o proprio video pode estar quebrado).
    function safeDescribe(video) {
      try {
        return describeVideo(video, readLocation());
      } catch (_error) {
        return undefined;
      }
    }

    async function handleMessage(message) {
      try {
        return await dispatchMessage(message);
      } catch (_error) {
        return failure(ERROR_CODES.INTERNAL_ERROR, "Erro inesperado ao processar a mensagem.");
      }
    }

    async function dispatchMessage(message) {
      if (message === null || typeof message !== "object" || typeof message.type !== "string") {
        return failure(ERROR_CODES.INVALID_MESSAGE, "Mensagem deve ser um objeto com campo type (string).");
      }
      if (!Object.prototype.hasOwnProperty.call(MESSAGE_TYPES, message.type)) {
        return failure(ERROR_CODES.UNKNOWN_MESSAGE_TYPE, "Tipo de mensagem nao suportado.");
      }

      const video = findCurrentVideo();
      if (!video) {
        if (message.type === MESSAGE_TYPES.GET_STATE) return success(describeNoVideo(readLocation()));
        return failure(ERROR_CODES.NO_VIDEO, "Nenhum video encontrado nesta pagina.", describeNoVideo(readLocation()));
      }

      switch (message.type) {
        case MESSAGE_TYPES.GET_STATE:
          return success(describeVideo(video, readLocation()));
        case MESSAGE_TYPES.PLAY:
          return playVideo(video);
        case MESSAGE_TYPES.PAUSE:
          try {
            video.pause();
          } catch (_error) {
            return failure(ERROR_CODES.PAUSE_FAILED, "Falha ao pausar o video.", safeDescribe(video));
          }
          return success(describeVideo(video, readLocation()));
        case MESSAGE_TYPES.SEEK_TO_SECONDS: {
          const seek = validateSeekSeconds(message.seconds, video.duration);
          if (!seek.ok) return failure(seek.code, seek.message, describeVideo(video, readLocation()));
          try {
            video.currentTime = seek.seconds;
          } catch (_error) {
            return failure(ERROR_CODES.SEEK_FAILED, "Falha ao mover o video para o tempo pedido.", safeDescribe(video));
          }
          return success(describeVideo(video, readLocation()));
        }
        default:
          return failure(ERROR_CODES.UNKNOWN_MESSAGE_TYPE, "Tipo de mensagem nao suportado.");
      }
    }

    return { handleMessage };
  }

  const api = Object.freeze({
    MESSAGE_TYPES,
    ERROR_CODES,
    createVideoController,
    createDomVideoFinder,
    createNetflixVideoFinder,
    createPageVideoFinder,
    validateSeekSeconds,
    readVideoIdFromLocation,
  });

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SessaoADoisVideoController = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
