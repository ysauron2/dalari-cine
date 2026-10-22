// ==UserScript==
// @name         Sessão a Dois - controle local da Netflix
// @namespace    sessao-a-dois-prototipo
// @version      0.1.0
// @description  Painel mínimo com Play, Pause, Atualizar e +30 s para o vídeo da Netflix aberto nesta aba (/watch/<id>). Local, sem rede, sem sincronização.
// @match        https://www.netflix.com/watch/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  if (window.top !== window.self) return;

  var OVERLAY_ID = "sessao-a-dois-overlay";
  var SEEK_STEP_SECONDS = 30;
  var REFRESH_INTERVAL_MS = 1000;
  var PLAYER_CONTAINER = ".watch-video--player-view, [data-uia='video-canvas']";

  // Somente o ID numerico da rota /watch/<id>; nao e convertido em titulo.
  function readWatchId() {
    var match = /^\/watch\/(\d+)\/?$/.exec(window.location.pathname);
    return match ? match[1] : null;
  }

  function isVisible(video) {
    if (typeof video.getBoundingClientRect !== "function") return false;
    var box = video.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  // Sem cache: a Netflix e SPA e recria o <video> ao trocar de titulo. Entre
  // varios <video>, ignora os invisiveis (previas/trailers), prefere os dentro
  // do container do player e, depois, o de maior area.
  function findCurrentVideo() {
    if (!readWatchId()) return null;
    var videos = document.querySelectorAll("video");
    var best = null;
    var bestInPlayer = 0;
    var bestArea = 0;
    for (var i = 0; i < videos.length; i += 1) {
      var video = videos[i];
      if (!isVisible(video)) continue;
      var box = video.getBoundingClientRect();
      var area = box.width * box.height;
      var inPlayer = typeof video.closest === "function" && video.closest(PLAYER_CONTAINER) ? 1 : 0;
      if (!best || inPlayer > bestInPlayer || (inPlayer === bestInPlayer && area > bestArea)) {
        best = video;
        bestInPlayer = inPlayer;
        bestArea = area;
      }
    }
    return best;
  }

  function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    var total = Math.floor(seconds);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var ss = (s < 10 ? "0" : "") + s;
    if (h > 0) return h + ":" + (m < 10 ? "0" : "") + m + ":" + ss;
    return m + ":" + ss;
  }

  function describeState(video) {
    if (!video) return "Sem vídeo nesta página.";
    var id = readWatchId();
    var prefix = "Título " + id + ": ";
    var loading = Number.isFinite(video.readyState) && video.readyState < 2;
    var status = video.ended ? "Terminou" : loading ? "Carregando" : video.paused ? "Pausado" : "Tocando";
    return prefix + status + " — " + formatClock(video.currentTime) + " / " + formatClock(video.duration);
  }

  function createOverlay() {
    var root = document.createElement("div");
    root.setAttribute("id", OVERLAY_ID);
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Sessão a Dois: controle do vídeo");
    var rootStyle = root.style;
    rootStyle.position = "fixed";
    rootStyle.right = "8px";
    rootStyle.bottom = "8px";
    rootStyle.zIndex = "2147483647";
    rootStyle.display = "flex";
    rootStyle.flexDirection = "column";
    rootStyle.gap = "6px";
    rootStyle.padding = "8px";
    rootStyle.maxWidth = "calc(100vw - 16px)";
    rootStyle.boxSizing = "border-box";
    rootStyle.background = "#111";
    rootStyle.color = "#fff";
    rootStyle.border = "1px solid #fff";
    rootStyle.borderRadius = "8px";
    rootStyle.font = "14px/1.3 -apple-system, system-ui, sans-serif";

    var status = document.createElement("div");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("data-role", "state");
    root.appendChild(status);

    var message = document.createElement("div");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    message.setAttribute("data-role", "message");
    root.appendChild(message);

    var row = document.createElement("div");
    row.style.display = "flex";
    row.style.flexWrap = "wrap";
    row.style.gap = "6px";
    root.appendChild(row);

    function setMessage(text) {
      message.textContent = text;
    }

    function refresh() {
      status.textContent = describeState(findCurrentVideo());
    }

    function addButton(action, label, ariaLabel, onClick) {
      var button = document.createElement("button");
      button.setAttribute("type", "button");
      button.setAttribute("data-action", action);
      button.setAttribute("aria-label", ariaLabel);
      button.textContent = label;
      var s = button.style;
      s.minHeight = "44px";
      s.minWidth = "44px";
      s.padding = "0 12px";
      s.font = "inherit";
      s.color = "#000";
      s.background = "#fff";
      s.border = "2px solid #fff";
      s.borderRadius = "6px";
      s.cursor = "pointer";
      button.addEventListener("click", function () {
        setMessage("");
        try {
          var video = findCurrentVideo();
          if (!video) {
            setMessage("Nenhum vídeo encontrado.");
          } else {
            onClick(video);
          }
        } catch (_error) {
          setMessage("Não foi possível executar a ação.");
        }
        try {
          refresh();
        } catch (_error) {
          // estado indisponível; a próxima atualização tenta de novo
        }
      });
      row.appendChild(button);
    }

    addButton("play", "Play", "Tocar vídeo", function (video) {
      try {
        var result = video.play();
        if (result && typeof result.then === "function") {
          result.then(refresh, function (error) {
            setMessage(error && error.name === "NotAllowedError"
              ? "O navegador bloqueou o play. Clique no vídeo e tente de novo."
              : "Não foi possível tocar.");
            refresh();
          });
        }
      } catch (_error) {
        setMessage("Não foi possível tocar.");
      }
    });
    addButton("pause", "Pause", "Pausar vídeo", function (video) {
      try {
        video.pause();
      } catch (_error) {
        setMessage("Não foi possível pausar.");
      }
    });
    addButton("refresh", "Atualizar", "Atualizar estado", function () {});
    addButton("seek", "+30 s", "Avançar 30 segundos", function (video) {
      var duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        setMessage("Duração desconhecida (carregando).");
        return;
      }
      try {
        var current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        video.currentTime = Math.min(current + SEEK_STEP_SECONDS, duration);
      } catch (_error) {
        setMessage("Não foi possível avançar 30 s.");
      }
    });

    root.refresh = refresh;
    return root;
  }

  function mount() {
    var existing = document.getElementById(OVERLAY_ID);
    if (existing) return existing;
    var parent = document.body || document.documentElement;
    if (!parent) return null;
    var overlay = createOverlay();
    parent.appendChild(overlay);
    return overlay;
  }

  function tick() {
    var overlay = mount();
    if (overlay) overlay.refresh();
  }

  tick();
  window.setInterval(tick, REFRESH_INTERVAL_MS);
  window.addEventListener("popstate", tick);
})();
