// ==UserScript==
// @name         Sessão a Dois - controle local do YouTube
// @namespace    sessao-a-dois-prototipo
// @version      0.1.0
// @description  Painel mínimo com Play, Pause, Atualizar e +30 s para o vídeo do YouTube aberto nesta aba. Local, sem rede, sem sincronização.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
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
  // Player principal primeiro; previews de hover da home usam outros containers.
  var VIDEO_SELECTORS = [
    "#movie_player video.html5-main-video",
    "video.html5-main-video",
    "#movie_player video",
    "video"
  ];

  // Sem cache: o <video> e relido a cada uso, assim a navegacao SPA do
  // YouTube nunca deixa o painel preso a um elemento antigo.
  function findCurrentVideo() {
    for (var i = 0; i < VIDEO_SELECTORS.length; i += 1) {
      var video = document.querySelector(VIDEO_SELECTORS[i]);
      if (video) return video;
    }
    return null;
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
    var status = video.ended ? "Terminou" : video.paused ? "Pausado" : "Tocando";
    return status + " — " + formatClock(video.currentTime) + " / " + formatClock(video.duration);
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
        var video = findCurrentVideo();
        if (!video) {
          setMessage("Nenhum vídeo encontrado.");
        } else {
          onClick(video);
        }
        refresh();
      });
      row.appendChild(button);
    }

    addButton("play", "Play", "Tocar vídeo", function (video) {
      try {
        var result = video.play();
        if (result && typeof result.then === "function") {
          result.then(refresh, function (error) {
            setMessage(error && error.name === "NotAllowedError"
              ? "O navegador bloqueou o play. Toque no vídeo e tente de novo."
              : "Não foi possível tocar.");
            refresh();
          });
        }
      } catch (_error) {
        setMessage("Não foi possível tocar.");
      }
    });
    addButton("pause", "Pause", "Pausar vídeo", function (video) {
      video.pause();
    });
    addButton("refresh", "Atualizar", "Atualizar estado", function () {});
    addButton("seek", "+30 s", "Avançar 30 segundos", function (video) {
      var duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        setMessage("Duração desconhecida (ao vivo ou carregando).");
        return;
      }
      var current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      video.currentTime = Math.min(current + SEEK_STEP_SECONDS, duration);
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
  document.addEventListener("yt-navigate-finish", tick);
  window.addEventListener("popstate", tick);
})();
