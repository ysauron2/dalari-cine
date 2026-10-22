// Liga o controlador puro ao runtime da extensao. Responde so a mensagens
// da propria extensao; nao abre conexoes de rede nem guarda dados.
(function () {
  "use strict";

  const extensionApi = globalThis.browser || globalThis.chrome;
  const { createVideoController, createPageVideoFinder } = globalThis.SessaoADoisVideoController;
  const getLocation = () => window.location;

  const controller = createVideoController({
    findCurrentVideo: createPageVideoFinder(document, getLocation),
    getLocation,
  });

  extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== extensionApi.runtime.id) return false;
    const fallback = { ok: false, error: { code: "INTERNAL_ERROR", message: "Erro inesperado ao processar a mensagem." } };
    let pending;
    try {
      pending = Promise.resolve(controller.handleMessage(message));
    } catch (_error) {
      pending = Promise.resolve(fallback);
    }
    pending
      .catch(() => fallback)
      .then((response) => {
        try {
          sendResponse(response);
        } catch (_error) {
          // canal ja fechado (popup fechou); nada a fazer
        }
      });
    return true; // resposta assincrona
  });
})();
