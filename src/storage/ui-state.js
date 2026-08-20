(() => {
  "use strict";

  const app = globalThis.R34MF;
  const constants = app?.modules.constants;
  const browserApi = app?.modules.browserApi;
  if (!app || !constants || !browserApi) {
    throw new Error("R34MF constants and browser API adapter must load before UI state.");
  }

  const defaults = Object.freeze({
    mode: "native",
    collapsed: false,
    localPage: 1,
    sort: { field: "uploadDate", direction: "desc" }
  });

  function normalizeMode(value) {
    return value === "local" ? "local" : "native";
  }

  function normalizeCollapsed(value) {
    return value === true;
  }

  function normalizeLocalPage(value) { return Math.max(1, Math.floor(Number(value) || 1)); }

  function normalize(raw = {}) {
    return {
      mode: normalizeMode(raw?.mode),
      collapsed: normalizeCollapsed(raw?.collapsed),
      localPage: normalizeLocalPage(raw?.localPage),
      sort: globalThis.R34MF?.modules?.sorter?.normalize(raw?.sort) ?? { field: "uploadDate", direction: "desc" }
    };
  }

  const uiState = {
    value: { ...defaults },

    async load() {
      const result = await browserApi.storageLocal.get(constants.storageKeys.uiState);
      this.value = normalize(result[constants.storageKeys.uiState]);
      return this.value;
    },

    async save(value) {
      const normalized = normalize(value);
      await browserApi.storageLocal.set({
        [constants.storageKeys.uiState]: normalized
      });
      this.value = normalized;
      return this.value;
    },

    normalize,
    normalizeMode,
    normalizeCollapsed
    , normalizeLocalPage
  };

  app.modules.uiState = uiState;
})();
