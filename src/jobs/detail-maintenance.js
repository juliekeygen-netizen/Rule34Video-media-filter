(() => {
  "use strict";

  const app = globalThis.R34MF;
  const db = app?.modules.db;
  const createDetailScanner = app?.modules.createDetailScanner;
  if (!app || !db || !createDetailScanner) {
    throw new Error("R34MF database and detail scanner must load before detail maintenance.");
  }

  const MODES = Object.freeze({
    missing: "missing",
    failed: "failed",
    refreshFailed: "refreshFailed",
    refresh: "refresh",
    outdated: "outdated"
  });

  const HISTORY_KIND = Object.freeze({
    missing: "detailed-metadata",
    failed: "detailed-metadata-retry",
    refreshFailed: "detailed-metadata-refresh-retry",
    refresh: "detailed-metadata-refresh",
    outdated: "detail-repair-outdated"
  });

  function normalizeMode(mode) {
    return Object.values(MODES).includes(mode) ? mode : MODES.missing;
  }

  function detailMap(detailsLike) {
    if (detailsLike instanceof Map) return detailsLike;
    return new Map([...(detailsLike ?? [])].filter(Boolean).map((detail) => [String(detail.videoId), detail]));
  }

  function selectTargetsFromSource(records, detailsLike, mode = MODES.missing, limit = null) {
    const normalizedMode = normalizeMode(mode);
    const details = detailMap(detailsLike);
    const seen = new Set();
    const targets = [];
    const bounded = limit !== null && Number.isInteger(Number(limit)) && Number(limit) >= 0 ? Number(limit) : null;
    if (bounded === 0) return targets;

    for (const video of records ?? []) {
      const id = String(video?.videoId ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const status = details.get(id)?.status ?? null;
      const detail = details.get(id);
      const include = normalizedMode === MODES.failed
        ? status === "failed"
        : normalizedMode === MODES.refreshFailed
          ? status === "complete" && Boolean(detail?.lastAttemptError)
          : normalizedMode === MODES.refresh
            ? status === "complete"
          : normalizedMode === MODES.outdated
            ? status === "complete" && Number(detail?.schemaVersion || 1) < 5
          : status !== "complete";
      if (!include) continue;
      targets.push(video);
      if (bounded !== null && targets.length >= bounded) break;
    }
    return targets;
  }

  async function selectTargets(mode = MODES.missing, { limit = null } = {}) {
    const source = await db.getAllLocalRecords();
    return selectTargetsFromSource(source.records, source.detailsById, mode, limit);
  }

  function historyKind(mode) {
    return HISTORY_KIND[normalizeMode(mode)];
  }

  function createScopedDb(mode = MODES.missing) {
    const normalizedMode = normalizeMode(mode);
    let snapshotPromise = null;

    async function scopedTargets({ limit = null } = {}) {
      if (normalizedMode === MODES.missing) return db.getMissingDetailTargets({ limit });
      if (!snapshotPromise) snapshotPromise = selectTargets(normalizedMode);
      const targets = await snapshotPromise;
      if (limit === null || !Number.isInteger(Number(limit)) || Number(limit) < 0) return [...targets];
      return targets.slice(0, Number(limit));
    }

    return {
      ...db,
      getMissingDetailTargets: scopedTargets,
      async updateDetailsState(changes) {
        return db.updateDetailsState({ ...changes, mode: normalizedMode });
      },
      async appendHistory(entry) {
        return db.appendHistory({
          ...entry,
          kind: historyKind(normalizedMode),
          summary: { ...(entry?.summary ?? {}), mode: normalizedMode }
        });
      }
    };
  }

  let activeScanner = null;

  async function run(mode = MODES.missing, options = {}) {
    const normalizedMode = normalizeMode(mode);
    if (activeScanner) {
      const error = new Error("Detailed metadata maintenance is already running.");
      error.code = "detail-run-active";
      throw error;
    }
    const scanner = createDetailScanner({ db: createScopedDb(normalizedMode) });
    activeScanner = scanner;
    try {
      const result = await scanner.run(options);
      return result?.detailsState
        ? { ...result, detailsState: { ...result.detailsState, mode: normalizedMode } }
        : result;
    } finally {
      if (activeScanner === scanner) activeScanner = null;
    }
  }

  function stop() {
    activeScanner?.stop?.();
  }

  async function countTargets(mode = MODES.missing) {
    const normalizedMode = normalizeMode(mode);
    if (normalizedMode === MODES.failed) return db.countFailedDetails();
    if (normalizedMode === MODES.refreshFailed) return (await selectTargets(MODES.refreshFailed)).length;
    if (normalizedMode === MODES.refresh) return db.countDetailedVideos();
    if (normalizedMode === MODES.outdated) return db.countOutdatedDetails();
    const state = await db.getCatalogueState();
    return Math.max(0, Number(state.indexedCount ?? 0) - Number(state.detailedCount ?? 0));
  }

  app.modules.detailMaintenance = Object.freeze({
    MODES,
    normalizeMode,
    selectTargetsFromSource,
    selectTargets,
    createScopedDb,
    historyKind,
    countTargets,
    run,
    stop
  });
})();
