(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.settingsData;
  const browserApi = app?.modules.browserApi;
  const constants = app?.modules.constants;
  const settings = app?.modules.settings;
  const seenStore = app?.modules.seenStore;
  const favoriteStore = app?.modules.favoriteStore;
  if (!app || !base || !browserApi || !constants || !settings || !seenStore || !favoriteStore) {
    throw new Error("R34MF Settings data and local Seen/Favorites stores must load before backup local-state integration.");
  }

  async function storagePayload() {
    const [storage, local] = await Promise.all([
      base.storagePayload(),
      browserApi.storageLocal.get([seenStore.KEY, favoriteStore.KEY])
    ]);
    return {
      ...storage,
      seenVideos: seenStore.normalize(local?.[seenStore.KEY]),
      favoriteVideos: favoriteStore.normalize(local?.[favoriteStore.KEY])
    };
  }

  async function buildBackup() {
    const [storage, database] = await Promise.all([storagePayload(), base.readStores()]);
    return {
      format: base.BACKUP_FORMAT,
      version: base.BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: String(app.version ?? "0.1.0"),
      storage,
      database
    };
  }

  async function summary() {
    return base.summaryFromBackup(await buildBackup());
  }

  function mergedSetState(currentRaw, incomingRaw, normalize) {
    const current = normalize(currentRaw);
    const incoming = normalize(incomingRaw);
    const ids = [...new Set([...(current.ids ?? []), ...(incoming.ids ?? [])].map(String).filter(Boolean))];
    return {
      version: 1,
      ids,
      updatedAt: Math.max(Date.now(), Number(current.updatedAt) || 0, Number(incoming.updatedAt) || 0)
    };
  }

  async function applyBackupStorage(storagePayload = {}, { replace = false } = {}) {
    await base.applyBackupStorage(storagePayload, { replace });

    const current = replace
      ? {}
      : await browserApi.storageLocal.get([seenStore.KEY, favoriteStore.KEY]);
    const updates = {};
    const removals = [];

    if (Object.hasOwn(storagePayload, "seenVideos")) {
      if (storagePayload.seenVideos === null) {
        if (replace) removals.push(seenStore.KEY);
      } else if (storagePayload.seenVideos !== undefined) {
        updates[seenStore.KEY] = replace
          ? seenStore.normalize(storagePayload.seenVideos)
          : mergedSetState(current?.[seenStore.KEY], storagePayload.seenVideos, seenStore.normalize);
      }
    }
    if (Object.hasOwn(storagePayload, "favoriteVideos")) {
      if (storagePayload.favoriteVideos === null) {
        if (replace) removals.push(favoriteStore.KEY);
      } else if (storagePayload.favoriteVideos !== undefined) {
        updates[favoriteStore.KEY] = replace
          ? favoriteStore.normalize(storagePayload.favoriteVideos)
          : mergedSetState(current?.[favoriteStore.KEY], storagePayload.favoriteVideos, favoriteStore.normalize);
      }
    }

    if (removals.length) await browserApi.storageLocal.remove(removals);
    if (Object.keys(updates).length) await browserApi.storageLocal.set(updates);

    // Force both facades to reflect imported state immediately rather than waiting
    // for a storage-change echo. Older v1 backups that lack these fields leave the
    // current Seen/Favorites state untouched, including in Replace mode. Merge
    // unions the two sets so importing a backup cannot erase Seen/Favorites that
    // were added on this device after that backup was created.
    await Promise.all([
      seenStore.load({ force: true }),
      favoriteStore.load({ force: true })
    ]);
  }

  app.modules.settingsData = Object.freeze({
    ...base,
    storagePayload,
    buildBackup,
    summary,
    mergedSetState,
    applyBackupStorage
  });
})();