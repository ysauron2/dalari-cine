// Texto exibido no popup, separado do DOM para ser testavel em Node.
(function (root) {
  "use strict";

  function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = String(whole % 60).padStart(2, "0");
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
  }

  function describeResponse(response) {
    if (!response) return "Sem resposta. Abra uma aba do YouTube ou uma pagina netflix.com/watch/... e recarregue-a.";
    const prefix = response.ok ? "" : `Erro (${response.error.code}): ${response.error.message}\n`;
    const state = response.state;
    if (!state) return prefix.trim();
    if (!state.hasVideo) return `${prefix}Nenhum video nesta pagina.`;
    const loading = Number.isFinite(state.readyState) && state.readyState < 2;
    const status = state.isEnded ? "terminado" : loading ? "carregando" : state.isPlaying ? "tocando" : "pausado";
    const position = `${formatClock(state.currentTimeSeconds)} / ${formatClock(state.durationSeconds)}`;
    return `${prefix}Video ${state.videoId || "(id desconhecido)"}: ${status}, ${position}`;
  }

  // Campo vazio ou nao numerico vira NaN, que o controlador tambem rejeita.
  function parseSecondsInput(text) {
    const trimmed = String(text).trim();
    return /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : NaN;
  }

  const api = Object.freeze({ formatClock, describeResponse, parseSecondsInput });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SessaoADoisPopupModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
