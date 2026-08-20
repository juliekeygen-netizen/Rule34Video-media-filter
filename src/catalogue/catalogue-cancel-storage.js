(() => {
  "use strict";

  const app = globalThis.R34MF;
  const db = app?.modules.db;
  if (!app || !db) throw new Error("R34MF database must load before catalogue cancellation storage.");

  const BASELINE_SESSION_ID = "__r34mf-full-rescan-baseline__";
  const BASELINE_KEY = `${BASELINE_SESSION_ID}:0`;

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    });
  }

  function freshSmartUpdateState() {
    return { ...db.defaultCatalogueState().smartUpdate };
  }

  async function readBaseline() {
    const rows = await db.listSmartUpdateStage(BASELINE_SESSION_ID);
    return rows.find((row) => row?.key === BASELINE_KEY && row?.kind === "full-rescan-baseline") ?? null;
  }

  async function hasFullRescanBaseline() {
    return Boolean(await readBaseline());
  }

  async function clearFullRescanBaseline() {
    await db.clearSmartUpdateStage(BASELINE_SESSION_ID);
  }

  async function captureFullRescanBaseline() {
    const state = await db.getCatalogueState();
    if (state.catalogueReady !== true) return { captured: false, reason: "catalogue-unavailable" };
    const [manifests, orderedVideoIds] = await Promise.all([db.listPageCheckpoints(), db.getOrderedVideoIds()]);
    await clearFullRescanBaseline();
    const database = await db.open();
    const transaction = database.transaction(db.STORES.smartUpdatePages, "readwrite");
    transaction.objectStore(db.STORES.smartUpdatePages).put({
      key: BASELINE_KEY,
      sessionId: BASELINE_SESSION_ID,
      pageNumber: 0,
      kind: "full-rescan-baseline",
      manifests,
      orderedVideoIds,
      catalogueState: state,
      stagedAt: Date.now()
    });
    await transactionDone(transaction);
    return { captured: true, videoCount: orderedVideoIds.length, pageCount: manifests.length };
  }

  async function restoreFullRescanBaseline() {
    const baseline = await readBaseline();
    if (!baseline) return { restored: false, reason: "baseline-unavailable" };

    const ids = [...new Set([...(baseline.orderedVideoIds ?? [])].map(String).filter(Boolean))];
    const idSet = new Set(ids);
    const manifests = [...(baseline.manifests ?? [])];
    const baselineState = baseline.catalogueState ?? {};
    const database = await db.open();
    const transaction = database.transaction([
      db.STORES.videos,
      db.STORES.videoDetails,
      db.STORES.cataloguePages,
      db.STORES.catalogueState
    ], "readwrite");
    const videos = transaction.objectStore(db.STORES.videos);
    const details = transaction.objectStore(db.STORES.videoDetails);
    const pages = transaction.objectStore(db.STORES.cataloguePages);
    const states = transaction.objectStore(db.STORES.catalogueState);

    pages.clear();
    for (const manifest of manifests) pages.put(manifest);

    const allVideos = videos.getAll();
    allVideos.onsuccess = () => {
      for (const video of allVideos.result ?? []) {
        if (!idSet.has(String(video?.videoId ?? ""))) videos.delete(video.videoId);
      }
    };
    const allDetails = details.getAll();
    allDetails.onsuccess = () => {
      for (const detail of allDetails.result ?? []) {
        if (!idSet.has(String(detail?.videoId ?? ""))) details.delete(detail.videoId);
      }
    };
    const stateRequest = states.get(db.STATE_KEY);
    stateRequest.onsuccess = () => {
      const current = db.deriveCatalogueState(stateRequest.result);
      states.put(db.deriveCatalogueState(current, {
        ...baselineState,
        detailsState: current.detailsState,
        smartUpdate: freshSmartUpdateState(),
        scanStatus: "complete",
        catalogueReady: true,
        currentPage: null,
        activeRunStartedAt: null,
        lastError: null
      }));
    };

    await transactionDone(transaction);
    await clearFullRescanBaseline();
    db.invalidateCatalogueOrder();
    return { restored: true, videoCount: ids.length, pageCount: manifests.length };
  }

  async function cancelSmartUpdate() {
    const state = await db.getCatalogueState();
    const sessionId = state.smartUpdate?.sessionId ?? null;
    if (sessionId) await db.clearSmartUpdateStage(sessionId);
    const next = await db.putCatalogueState({
      smartUpdate: freshSmartUpdateState(),
      scanStatus: state.catalogueReady === true ? "complete" : state.scanStatus,
      currentPage: null,
      activeRunStartedAt: null
    });
    return { cancelled: true, state: next };
  }

  async function cancelInitialScan() {
    const state = await db.getCatalogueState();
    if (state.catalogueReady === true) return { cancelled: false, reason: "completed-baseline-present" };
    const database = await db.open();
    const transaction = database.transaction([
      db.STORES.videos,
      db.STORES.videoDetails,
      db.STORES.cataloguePages,
      db.STORES.catalogueState
    ], "readwrite");
    transaction.objectStore(db.STORES.videos).clear();
    transaction.objectStore(db.STORES.videoDetails).clear();
    transaction.objectStore(db.STORES.cataloguePages).clear();
    transaction.objectStore(db.STORES.catalogueState).put(db.defaultCatalogueState());
    await transactionDone(transaction);
    await db.clearSmartUpdateStage();
    db.invalidateCatalogueOrder();
    return { cancelled: true };
  }

  app.modules.catalogueCancelStorage = Object.freeze({
    BASELINE_SESSION_ID,
    captureFullRescanBaseline,
    restoreFullRescanBaseline,
    hasFullRescanBaseline,
    clearFullRescanBaseline,
    cancelSmartUpdate,
    cancelInitialScan
  });
})();