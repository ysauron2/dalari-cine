(function () {
  "use strict";

  const extensionApi = globalThis.browser || globalThis.chrome;
  const { describeResponse, parseSecondsInput } = globalThis.SessaoADoisPopupModel;
  const stateText = document.getElementById("state-text");
  const seekInput = document.getElementById("seek-input");

  async function sendToActiveTab(message) {
    try {
      const [activeTab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
      if (!activeTab || activeTab.id === undefined) return null;
      return await extensionApi.tabs.sendMessage(activeTab.id, message);
    } catch (_error) {
      return null; // aba sem content script (fora do YouTube) ou ainda nao recarregada
    }
  }

  async function sendAndShow(message) {
    stateText.textContent = describeResponse(await sendToActiveTab(message));
  }

  document.getElementById("play-button").addEventListener("click", () => sendAndShow({ type: "PLAY" }));
  document.getElementById("pause-button").addEventListener("click", () => sendAndShow({ type: "PAUSE" }));
  document.getElementById("refresh-button").addEventListener("click", () => sendAndShow({ type: "GET_STATE" }));
  document.getElementById("seek-button").addEventListener("click", () =>
    sendAndShow({ type: "SEEK_TO_SECONDS", seconds: parseSecondsInput(seekInput.value) }));

  sendAndShow({ type: "GET_STATE" });
})();
