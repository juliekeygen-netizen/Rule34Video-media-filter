(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) {
    throw new Error("R34MF namespace must load before browser API adapter.");
  }

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime || !api?.storage?.local) {
    throw new Error("A compatible WebExtension API is required.");
  }

  function runtimeSendMessage(message) {
    if (globalThis.browser?.runtime?.sendMessage) return globalThis.browser.runtime.sendMessage(message);
    return new Promise((resolve, reject) => api.runtime.sendMessage(message, (response) => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    }));
  }

  app.modules.browserApi = Object.freeze({
    api,
    runtime: api.runtime,
    runtimeSendMessage,
    storage: api.storage,
    storageLocal: api.storage.local
  });
})();
