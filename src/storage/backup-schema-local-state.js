(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.backupSchema;
  const seenStore = app?.modules.seenStore;
  const favoriteStore = app?.modules.favoriteStore;
  if (!app || !base || !seenStore || !favoriteStore) {
    throw new Error("R34MF backup schema and local Seen/Favorites stores must load before backup local-state schema integration.");
  }

  function normalizeStorage(raw) {
    // Let the Phase 10 schema reject malformed storage containers before this
    // additive layer inspects the two new optional local-state fields.
    const normalized = base.normalizeStorage(raw);
    const source = raw ?? {};
    if (Object.hasOwn(source, "seenVideos")) {
      normalized.seenVideos = source.seenVideos === null ? null : seenStore.normalize(source.seenVideos);
    }
    if (Object.hasOwn(source, "favoriteVideos")) {
      normalized.favoriteVideos = source.favoriteVideos === null ? null : favoriteStore.normalize(source.favoriteVideos);
    }
    return normalized;
  }

  function normalizeBackup(backup) {
    const normalized = base.normalizeBackup(backup);
    normalized.storage = normalizeStorage(backup?.storage ?? {});
    return normalized;
  }

  app.modules.backupSchema = Object.freeze({
    ...base,
    normalizeStorage,
    normalizeBackup
  });
})();
