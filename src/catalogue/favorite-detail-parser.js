(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.detailParser;
  const favorites = app?.modules.favoriteStore;
  if (!app || !base || !favorites) throw new Error("R34MF detail parser and Favorites storage must load before Favorites detail sync.");

  function parseDocument(documentLike, options = {}) {
    const result = base.parseDocument(documentLike, options);
    if (result?.ok) {
      const videoId = String(options.expectedVideoId ?? result?.detail?.videoId ?? "").trim();
      if (videoId) favorites.syncFromDocument?.(videoId, documentLike)?.catch?.(() => {});
    }
    return result;
  }

  app.modules.detailParser = Object.freeze({ ...base, parseDocument });
  app.modules.favoriteDetailParser = Object.freeze({ installed: true });
})();
