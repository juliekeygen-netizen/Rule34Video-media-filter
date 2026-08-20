(() => {
  "use strict";

  const app = globalThis.R34MF;
  const dbModule = app?.modules.db;
  const constants = app?.modules.constants;
  const browserApi = app?.modules.browserApi;
  const settings = app?.modules.settings;
  if (!app || !dbModule || !constants || !browserApi || !settings) {
    throw new Error("R34MF Settings data dependencies must load first.");
  }

  const BACKUP_FORMAT = "r34mf-backup";
  const BACKUP_VERSION = 1;
  const STORE_NAMES = Object.freeze(Object.values(dbModule.STORES));

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    });
  }

  function queueBusy() {
    const snapshot = app.modules.jobManager?.snapshot?.() ?? { active: [], waiting: [] };
    return (snapshot.active?.length ?? 0) > 0 || (snapshot.waiting?.length ?? 0) > 0;
  }

  function ensureQueueIdle() {
    if (queueBusy()) {
      const error = new Error("Pause, cancel, or remove active/queued extension work before changing stored catalogue data.");
      error.code = "queue-not-idle";
      throw error;
    }
  }

  async function readStore(name) {
    const database = await dbModule.open();
    const transaction = database.transaction(name, "readonly");
    const done = transactionDone(transaction);
    const records = await requestPromise(transaction.objectStore(name).getAll());
    await done;
    return records;
  }

  async function readStores(names = STORE_NAMES) {
    const list = [...new Set(names)];
    if (!list.length) return {};
    const database = await dbModule.open();
    const transaction = database.transaction(list, "readonly");
    const done = transactionDone(transaction);
    const requests = Object.fromEntries(list.map((name) => [name, requestPromise(transaction.objectStore(name).getAll())]));
    const entries = await Promise.all(list.map(async (name) => [name, await requests[name]]));
    await done;
    return Object.fromEntries(entries);
  }

  async function storagePayload() {
    const keys = [constants.storageKeys.settings, constants.storageKeys.uiState, constants.storageKeys.filterState];
    const stored = await browserApi.storageLocal.get(keys);
    const safeSettings = settings.normalize(stored?.[constants.storageKeys.settings] ?? settings.value);
    safeSettings.automaticSignIn = false;
    return {
      settings: safeSettings,
      uiState: stored?.[constants.storageKeys.uiState] ?? null,
      filterState: stored?.[constants.storageKeys.filterState] ?? null
    };
  }

  async function buildBackup() {
    const [storage, database] = await Promise.all([storagePayload(), readStores()]);
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: String(app.version ?? "0.1.0"),
      storage,
      database
    };
  }

  function byteLength(value) {
    try { return new TextEncoder().encode(JSON.stringify(value)).length; }
    catch { return JSON.stringify(value).length; }
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / (1024 ** 2)).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  }

  function currentMembership(databasePayload = {}) {
    return new Set((databasePayload[dbModule.STORES.videos] ?? []).map((video) => String(video?.videoId ?? "")).filter(Boolean));
  }

  function detailedCountFor(databasePayload = {}) {
    const membership = currentMembership(databasePayload);
    const details = mergeByKey(
      [],
      (databasePayload[dbModule.STORES.videoDetails] ?? [])
        .filter((detail) => membership.has(String(detail?.videoId ?? ""))),
      (record) => record?.videoId,
      mergeDetailRecord
    );
    return details.filter((detail) => detail?.status === "complete").length;
  }

  function summaryFromBackup(backup = {}) {
    const database = backup?.database ?? {};
    const indexed = currentMembership(database).size;
    const detailed = detailedCountFor(database);
    const bytes = byteLength(backup);
    return {
      indexed,
      detailed,
      coverage: indexed ? detailed / indexed : 0,
      approximateBytes: bytes,
      approximateStorage: formatBytes(bytes)
    };
  }

  async function summary() {
    return summaryFromBackup(await buildBackup());
  }

  function validateBackup(input) {
    const backup = input && typeof input === "object" ? input : null;
    if (!backup || backup.format !== BACKUP_FORMAT) throw new Error("This file is not a Rule34Video Media Filter backup.");
    if (!Number.isInteger(Number(backup.version)) || Number(backup.version) < 1) throw new Error("The backup version is missing or invalid.");
    if (Number(backup.version) > BACKUP_VERSION) throw new Error("This backup was created by a newer extension version and cannot be imported safely.");
    if (!backup.database || typeof backup.database !== "object") throw new Error("The backup database payload is missing.");
    for (const name of STORE_NAMES) {
      if (backup.database[name] !== undefined && !Array.isArray(backup.database[name])) throw new Error(`Backup store ${name} is invalid.`);
    }
    const indexed = currentMembership(backup.database).size;
    const detailed = detailedCountFor(backup.database);
    return {
      backup,
      meta: {
        exportedAt: backup.exportedAt ?? null,
        appVersion: String(backup.appVersion ?? "Unknown"),
        indexed,
        detailed,
        version: Number(backup.version)
      }
    };
  }

  async function readBackupFile(file) {
    if (!file || typeof file.text !== "function") throw new Error("Choose a backup file first.");
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch { throw new Error("The selected backup is not valid JSON."); }
    return validateBackup(parsed);
  }

  function normalizeKey(record, storeName) {
    if (storeName === dbModule.STORES.catalogueState) return record?.key ?? dbModule.STATE_KEY;
    if (storeName === dbModule.STORES.cataloguePages) return record?.pageNumber;
    if (storeName === dbModule.STORES.smartUpdatePages) return record?.key;
    if (storeName === dbModule.STORES.jobHistory) return record?.id;
    return record?.videoId;
  }

  function newestBy(existing, incoming, fields) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const time = (item) => Math.max(...fields.map((field) => Number(item?.[field]) || 0));
    return time(incoming) >= time(existing) ? { ...existing, ...incoming } : existing;
  }

  function detailAttemptTime(record) {
    return Math.max(
      Number(record?.lastAttemptAt) || 0,
      Number(record?.attemptedAt) || 0,
      Number(record?.fetchedAt) || 0
    );
  }

  // A later failed refresh must never erase already-complete metadata. This mirrors
  // db.mergeDetailFailure(), which records the failed attempt on a complete row
  // instead of downgrading that row back to failed.
  function mergeDetailRecord(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;

    const existingComplete = existing?.status === "complete";
    const incomingComplete = incoming?.status === "complete";
    const failureCount = Math.max(Number(existing?.failureCount) || 0, Number(incoming?.failureCount) || 0);

    if (existingComplete !== incomingComplete) {
      const complete = existingComplete ? existing : incoming;
      const failed = existingComplete ? incoming : existing;
      const completeAttempt = detailAttemptTime(complete);
      const failedAttempt = detailAttemptTime(failed);
      return {
        ...complete,
        status: "complete",
        failureCount,
        ...(failedAttempt > completeAttempt ? {
          lastAttemptAt: failedAttempt,
          lastAttemptError: failed?.lastAttemptError ?? failed?.lastError ?? complete?.lastAttemptError ?? null
        } : {}),
        lastError: null
      };
    }

    if (existingComplete && incomingComplete) {
      const existingFetchedAt = Number(existing?.fetchedAt) || 0;
      const incomingFetchedAt = Number(incoming?.fetchedAt) || 0;
      const primary = incomingFetchedAt >= existingFetchedAt ? { ...existing, ...incoming } : { ...existing };
      const latestAttempt = detailAttemptTime(incoming) >= detailAttemptTime(existing) ? incoming : existing;
      return {
        ...primary,
        status: "complete",
        failureCount,
        lastAttemptAt: Math.max(detailAttemptTime(existing), detailAttemptTime(incoming)),
        lastAttemptError: latestAttempt?.lastAttemptError ?? primary?.lastAttemptError ?? null,
        lastError: null
      };
    }

    return newestBy(existing, incoming, ["lastAttemptAt", "attemptedAt"]);
  }

  function mergeByKey(current = [], incoming = [], keyOf, merge) {
    const map = new Map();
    for (const item of current) {
      const key = keyOf(item);
      if (key !== null && key !== undefined && key !== "") map.set(String(key), item);
    }
    for (const item of incoming) {
      const key = keyOf(item);
      if (key === null || key === undefined || key === "") continue;
      const normalizedKey = String(key);
      map.set(normalizedKey, merge(map.get(normalizedKey), item));
    }
    return [...map.values()];
  }

  function planMergeDatasets({ currentState = {}, currentVideos = [], currentDetails = [], currentHistory = [], backupState = {}, databasePayload = {} } = {}) {
    const backupVideos = databasePayload[dbModule.STORES.videos] ?? [];
    const backupDetails = databasePayload[dbModule.STORES.videoDetails] ?? [];
    const backupHistory = databasePayload[dbModule.STORES.jobHistory] ?? [];
    const currentReady = currentState?.catalogueReady === true;
    const backupReady = backupState?.catalogueReady === true;
    const adoptBackupCatalogue = !currentReady && backupReady;

    let membership;
    if (currentReady) membership = new Set(currentVideos.map((video) => String(video?.videoId ?? "")).filter(Boolean));
    else if (adoptBackupCatalogue) membership = new Set(backupVideos.map((video) => String(video?.videoId ?? "")).filter(Boolean));
    else membership = new Set([...currentVideos, ...backupVideos].map((video) => String(video?.videoId ?? "")).filter(Boolean));

    const mergedVideos = mergeByKey(
      currentReady ? currentVideos : adoptBackupCatalogue ? backupVideos : currentVideos,
      currentReady
        ? backupVideos.filter((video) => membership.has(String(video?.videoId ?? "")))
        : adoptBackupCatalogue
          ? currentVideos.filter((video) => membership.has(String(video?.videoId ?? "")))
          : backupVideos,
      (record) => record?.videoId,
      (oldValue, newValue) => newestBy(oldValue, newValue, ["listingUpdatedAt", "lastSeenAt", "firstSeenAt"])
    ).filter((video) => membership.has(String(video?.videoId ?? "")));

    const mergedDetails = mergeByKey(
      currentDetails.filter((detail) => membership.has(String(detail?.videoId ?? ""))),
      backupDetails.filter((detail) => membership.has(String(detail?.videoId ?? ""))),
      (record) => record?.videoId,
      mergeDetailRecord
    ).filter((detail) => membership.has(String(detail?.videoId ?? "")));

    const mergedHistory = mergeByKey(
      currentHistory,
      backupHistory,
      (record) => record?.id,
      (oldValue, newValue) => newestBy(oldValue, newValue, ["finishedAt", "startedAt"])
    ).sort((a, b) => Number(b?.finishedAt) - Number(a?.finishedAt)).slice(0, dbModule.HISTORY_LIMIT ?? 12);

    const detailedCount = mergedDetails.filter((detail) => detail?.status === "complete").length;
    const stateSource = adoptBackupCatalogue ? backupState : currentState;
    const catalogueState = dbModule.deriveCatalogueState
      ? dbModule.deriveCatalogueState(stateSource, { indexedCount: mergedVideos.length, detailedCount })
      : { ...stateSource, key: dbModule.STATE_KEY, indexedCount: mergedVideos.length, detailedCount };

    return {
      currentReady,
      backupReady,
      adoptBackupCatalogue,
      videos: mergedVideos,
      details: mergedDetails,
      history: mergedHistory,
      cataloguePages: adoptBackupCatalogue ? (databasePayload[dbModule.STORES.cataloguePages] ?? []) : null,
      catalogueState,
      clearSmartUpdateStage: adoptBackupCatalogue
    };
  }

  function prepareReplacementDatabase(databasePayload = {}) {
    const next = Object.fromEntries(STORE_NAMES.map((name) => [name, [...(databasePayload[name] ?? [])]]));
    next[dbModule.STORES.videos] = mergeByKey(
      [],
      next[dbModule.STORES.videos],
      (record) => record?.videoId,
      (oldValue, newValue) => newestBy(oldValue, newValue, ["listingUpdatedAt", "lastSeenAt", "firstSeenAt"])
    );
    const membership = currentMembership(next);
    next[dbModule.STORES.videoDetails] = mergeByKey(
      [],
      next[dbModule.STORES.videoDetails]
        .filter((detail) => membership.has(String(detail?.videoId ?? ""))),
      (record) => record?.videoId,
      mergeDetailRecord
    );
    const state = next[dbModule.STORES.catalogueState].find((item) => item?.key === dbModule.STATE_KEY) ?? dbModule.defaultCatalogueState();
    const detailedCount = next[dbModule.STORES.videoDetails].filter((detail) => detail?.status === "complete").length;
    next[dbModule.STORES.catalogueState] = [dbModule.deriveCatalogueState(state, { indexedCount: membership.size, detailedCount })];
    return next;
  }

  async function replaceDatabase(databasePayload) {
    const replacement = prepareReplacementDatabase(databasePayload);
    const database = await dbModule.open();
    const transaction = database.transaction(STORE_NAMES, "readwrite");
    const done = transactionDone(transaction);
    for (const name of STORE_NAMES) {
      const store = transaction.objectStore(name);
      store.clear();
      for (const record of replacement[name] ?? []) store.put(record);
    }
    await done;
    return replacement;
  }

  async function mergeDatabase(databasePayload, { currentDatabase = null } = {}) {
    const currentState = currentDatabase
      ? ((currentDatabase[dbModule.STORES.catalogueState] ?? []).find((item) => item?.key === dbModule.STATE_KEY) ?? dbModule.defaultCatalogueState())
      : await dbModule.getCatalogueState();
    const current = currentDatabase ?? await readStores([dbModule.STORES.videos, dbModule.STORES.videoDetails, dbModule.STORES.jobHistory]);
    const backupState = (databasePayload[dbModule.STORES.catalogueState] ?? []).find((item) => item?.key === dbModule.STATE_KEY) ?? null;
    const plan = planMergeDatasets({
      currentState,
      currentVideos: current[dbModule.STORES.videos] ?? [],
      currentDetails: current[dbModule.STORES.videoDetails] ?? [],
      currentHistory: current[dbModule.STORES.jobHistory] ?? [],
      backupState: backupState ?? {},
      databasePayload
    });

    const database = await dbModule.open();
    const transaction = database.transaction(STORE_NAMES, "readwrite");
    const done = transactionDone(transaction);
    const videosStore = transaction.objectStore(dbModule.STORES.videos);
    const detailsStore = transaction.objectStore(dbModule.STORES.videoDetails);
    const historyStore = transaction.objectStore(dbModule.STORES.jobHistory);
    const stateStore = transaction.objectStore(dbModule.STORES.catalogueState);

    videosStore.clear();
    plan.videos.forEach((record) => videosStore.put(record));
    detailsStore.clear();
    plan.details.forEach((record) => detailsStore.put(record));
    historyStore.clear();
    plan.history.forEach((record) => historyStore.put(record));
    stateStore.put(plan.catalogueState);

    if (plan.adoptBackupCatalogue) {
      const pagesStore = transaction.objectStore(dbModule.STORES.cataloguePages);
      pagesStore.clear();
      plan.cataloguePages.forEach((record) => pagesStore.put(record));
      transaction.objectStore(dbModule.STORES.smartUpdatePages).clear();
    }

    await done;
    return plan;
  }

  async function applyBackupStorage(storagePayload = {}, { replace = false } = {}) {
    const entries = [
      [constants.storageKeys.settings, storagePayload.settings],
      [constants.storageKeys.uiState, storagePayload.uiState],
      [constants.storageKeys.filterState, storagePayload.filterState]
    ];
    const updates = {};
    const removals = [];
    for (const [storageKey, value] of entries) {
      if (value !== null && value !== undefined) {
        if (storageKey === constants.storageKeys.settings) {
          const safeSettings = settings.normalize(value);
          safeSettings.automaticSignIn = false;
          updates[storageKey] = safeSettings;
        } else {
          updates[storageKey] = value;
        }
      } else if (replace) removals.push(storageKey);
    }
    if (removals.length) await browserApi.storageLocal.remove(removals);
    if (Object.keys(updates).length) await browserApi.storageLocal.set(updates);
    await settings.load();
  }

  async function importBackup(input, mode = "merge") {
    ensureQueueIdle();
    const { backup, meta } = validateBackup(input);
    if (!["merge", "replace"].includes(mode)) throw new Error("Choose Merge or Replace before importing.");
    if (mode === "replace") await replaceDatabase(backup.database);
    else await mergeDatabase(backup.database);
    await applyBackupStorage(backup.storage ?? {}, { replace: mode === "replace" });
    dbModule.invalidateCatalogueOrder?.();
    return { mode, meta, summary: await summary() };
  }

  async function clearDetailedMetadata() {
    ensureQueueIdle();
    const database = await dbModule.open();
    const transaction = database.transaction([dbModule.STORES.videoDetails, dbModule.STORES.catalogueState], "readwrite");
    transaction.objectStore(dbModule.STORES.videoDetails).clear();
    const stateStore = transaction.objectStore(dbModule.STORES.catalogueState);
    const request = stateStore.get(dbModule.STATE_KEY);
    request.onsuccess = () => stateStore.put(dbModule.deriveCatalogueState(request.result, { detailedCount: 0, detailsState: dbModule.defaultDetailsState() }));
    await transactionDone(transaction);
    app.modules.db.invalidateCatalogueOrder?.();
    return summary();
  }

  async function clearEntireCatalogue() {
    ensureQueueIdle();
    const database = await dbModule.open();
    const transaction = database.transaction(STORE_NAMES, "readwrite");
    for (const name of STORE_NAMES) transaction.objectStore(name).clear();
    transaction.objectStore(dbModule.STORES.catalogueState).put(dbModule.defaultCatalogueState());
    await transactionDone(transaction);
    dbModule.invalidateCatalogueOrder?.();
    return summary();
  }

  async function exportBackup() {
    ensureQueueIdle();
    const backup = await buildBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.href = url;
    anchor.download = `rule34video-media-filter-${stamp}.r34mfbackup`;
    anchor.hidden = true;
    document.body.append(anchor);
    try { anchor.click(); }
    finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
    return backup;
  }

  app.modules.settingsData = Object.freeze({
    BACKUP_FORMAT,
    BACKUP_VERSION,
    STORE_NAMES,
    queueBusy,
    ensureQueueIdle,
    readStore,
    readStores,
    storagePayload,
    buildBackup,
    byteLength,
    formatBytes,
    currentMembership,
    detailedCountFor,
    summaryFromBackup,
    summary,
    validateBackup,
    readBackupFile,
    normalizeKey,
    newestBy,
    detailAttemptTime,
    mergeDetailRecord,
    mergeByKey,
    planMergeDatasets,
    prepareReplacementDatabase,
    replaceDatabase,
    mergeDatabase,
    applyBackupStorage,
    importBackup,
    clearDetailedMetadata,
    clearEntireCatalogue,
    exportBackup
  });
})();
