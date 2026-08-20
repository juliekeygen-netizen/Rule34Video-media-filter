(() => {
  "use strict";

  const app = globalThis.R34MF;
  const db = app?.modules.db;
  const baseCreateDetailScanner = app?.modules.createDetailScanner;
  const baseMaintenance = app?.modules.detailMaintenance;
  if (!app || !db || !baseCreateDetailScanner || !baseMaintenance) {
    throw new Error("R34MF detail scanner and maintenance modules must load before operation lifecycle support.");
  }

  const MODES = Object.freeze({ missing: "missing", failed: "failed", refreshFailed: "refreshFailed", refresh: "refresh", outdated: "outdated" });
  const RESUMABLE = new Set(["paused", "failed"]);
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

  function lastAttemptAt(detail) {
    return Math.max(
      0,
      Number(detail?.lastAttemptAt) || 0,
      Number(detail?.attemptedAt) || 0,
      Number(detail?.fetchedAt) || 0
    );
  }

  function selectTargetsFromSource(records, detailsLike, mode = MODES.missing, limit = null, options = {}) {
    const normalizedMode = normalizeMode(mode);
    const details = detailMap(detailsLike);
    const cutoffAt = Number(options?.cutoffAt);
    const useCutoff = Number.isFinite(cutoffAt) && cutoffAt > 0;
    const bounded = limit !== null && Number.isInteger(Number(limit)) && Number(limit) >= 0 ? Number(limit) : null;
    const seen = new Set();
    const targets = [];
    if (bounded === 0) return targets;

    for (const video of records ?? []) {
      const id = String(video?.videoId ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const detail = details.get(id) ?? null;
      const status = detail?.status ?? null;
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
      // Resume intentionally skips every target already attempted during this
      // logical operation. Successful refreshes remain complete; failed refresh
      // attempts also receive lastAttemptAt, so neither is re-requested.
      if (useCutoff && lastAttemptAt(detail) >= cutoffAt) continue;
      targets.push(video);
      if (bounded !== null && targets.length >= bounded) break;
    }
    return targets;
  }

  async function selectTargets(mode = MODES.missing, { limit = null, cutoffAt = null } = {}) {
    const source = await db.getAllLocalRecords();
    return selectTargetsFromSource(source.records, source.detailsById, mode, limit, { cutoffAt });
  }

  function planOperation(catalogue, mode = MODES.missing, now = Date.now()) {
    const normalizedMode = normalizeMode(mode);
    const durable = catalogue?.detailsState ?? {};
    const legacyCutoff = Number(durable.operationCutoffAt) || Number(durable.startedAt) || 0;
    const resuming = RESUMABLE.has(String(durable.status ?? "").toLowerCase())
      && durable.mode === normalizedMode
      && legacyCutoff > 0;
    return {
      mode: normalizedMode,
      resuming,
      cutoffAt: resuming ? legacyCutoff : now,
      startedAt: resuming ? Number(durable.startedAt) || now : now,
      baseProcessed: resuming ? Math.max(0, Number(durable.processedCount) || 0) : 0,
      baseCompleted: resuming ? Math.max(0, Number(durable.completedCount) || 0) : 0,
      baseFailed: resuming ? Math.max(0, Number(durable.failedCount) || 0) : 0,
      targetCount: 0,
      bulkProcessedBaseline: null,
      timingStartedAt: null
    };
  }

  function boundedTargets(targets, limit) {
    if (limit === null || !Number.isInteger(Number(limit)) || Number(limit) < 0) return [...targets];
    return targets.slice(0, Number(limit));
  }

  function createScopedDb(mode, { plan = null, initialTargets = null } = {}) {
    const normalizedMode = normalizeMode(mode);
    if (!plan) return baseMaintenance.createScopedDb(normalizedMode);
    let firstRead = true;
    const fixedTargets = normalizedMode === MODES.missing ? null : [...(initialTargets ?? [])];

    async function scopedTargets({ limit = null } = {}) {
      if (firstRead && initialTargets) {
        firstRead = false;
        return boundedTargets(initialTargets, limit);
      }
      firstRead = false;
      if (fixedTargets) return boundedTargets(fixedTargets, limit);
      return selectTargets(normalizedMode, {
        limit,
        cutoffAt: plan.resuming ? plan.cutoffAt : null
      });
    }

    return {
      ...db,
      getMissingDetailTargets: scopedTargets,
      async updateDetailsState(changes) {
        const status = String(changes?.status ?? "running").toLowerCase();
        const segmentTarget = Math.max(0, Number(changes?.targetCount) || 0);
        const logicalTarget = plan.baseProcessed + segmentTarget;
        if (logicalTarget > 0) plan.targetCount = logicalTarget;
        const mapped = {
          ...changes,
          mode: normalizedMode,
          targetCount: plan.targetCount,
          processedCount: plan.baseProcessed + Math.max(0, Number(changes?.processedCount) || 0),
          completedCount: plan.baseCompleted + Math.max(0, Number(changes?.completedCount) || 0),
          failedCount: plan.baseFailed + Math.max(0, Number(changes?.failedCount) || 0),
          startedAt: plan.startedAt,
          operationCutoffAt: status === "complete" ? null : plan.cutoffAt
        };
        return db.updateDetailsState(mapped);
      },
      async appendHistory(entry) {
        return db.appendHistory({
          ...entry,
          kind: HISTORY_KIND[normalizedMode],
          summary: { ...(entry?.summary ?? {}), mode: normalizedMode }
        });
      }
    };
  }

  function mapProgress(plan, value = {}, now = Date.now()) {
    const phase = value.phase ?? null;
    if (phase !== "bulk") {
      return { ...value, detailMode: plan.mode, timingCompleted: 0, timingStartedAt: null };
    }

    const segmentProcessed = Math.max(0, Number(value.processed) || 0);
    if (plan.bulkProcessedBaseline === null) {
      plan.bulkProcessedBaseline = segmentProcessed;
      plan.timingStartedAt = now;
    }
    const segmentTarget = Math.max(0, Number(value.total) || 0);
    const logicalTarget = plan.baseProcessed + segmentTarget;
    if (logicalTarget > 0) plan.targetCount = logicalTarget;
    const processed = plan.baseProcessed + segmentProcessed;
    return {
      ...value,
      detailMode: plan.mode,
      timingStartedAt: plan.timingStartedAt,
      timingCompleted: Math.max(0, segmentProcessed - plan.bulkProcessedBaseline),
      completed: processed,
      processed,
      total: plan.targetCount,
      runCompleted: plan.baseCompleted + Math.max(0, Number(value.runCompleted) || 0),
      failedCount: plan.baseFailed + Math.max(0, Number(value.failedCount) || 0)
    };
  }

  let activeScanner = null;

  async function runMode(mode = MODES.missing, options = {}) {
    const normalizedMode = normalizeMode(mode);
    if (activeScanner) {
      const error = new Error("Detailed metadata work is already running.");
      error.code = "detail-run-active";
      throw error;
    }

    const catalogue = await db.getCatalogueState();
    const plan = planOperation(catalogue, normalizedMode);
    const initialTargets = await selectTargets(normalizedMode, {
      limit: options.limit ?? null,
      cutoffAt: plan.resuming ? plan.cutoffAt : null
    });
    plan.targetCount = plan.baseProcessed + initialTargets.length;

    const scopedDb = createScopedDb(normalizedMode, { plan, initialTargets });
    const scanner = baseCreateDetailScanner({ db: scopedDb });
    const externalProgress = options.onProgress;
    activeScanner = scanner;
    try {
      const result = await scanner.run({
        ...options,
        onProgress(value) {
          externalProgress?.(mapProgress(plan, value));
        }
      });
      const persisted = (await db.getCatalogueState()).detailsState;
      return { ...result, detailsState: persisted };
    } finally {
      if (activeScanner === scanner) activeScanner = null;
    }
  }

  function stop() {
    activeScanner?.stop?.();
  }

  async function abandon() {
    if (activeScanner) {
      const error = new Error("Pause the active detail operation before cancelling it.");
      error.code = "detail-cancel-active";
      throw error;
    }
    const reset = typeof db.defaultDetailsState === "function" ? db.defaultDetailsState() : {};
    return db.updateDetailsState({
      ...reset,
      status: "idle",
      mode: MODES.missing,
      sessionId: null,
      operationCutoffAt: null,
      lastError: null,
      systemicReason: null
    });
  }

  async function countTargets(mode = MODES.missing) {
    const catalogue = await db.getCatalogueState();
    const plan = planOperation(catalogue, mode);
    return (await selectTargets(mode, { cutoffAt: plan.resuming ? plan.cutoffAt : null })).length;
  }

  const utilityScanner = baseCreateDetailScanner();
  app.modules.detailScanner = Object.freeze({
    ...utilityScanner,
    run: (options) => runMode(MODES.missing, options),
    stop
  });

  app.modules.detailMaintenance = Object.freeze({
    ...baseMaintenance,
    MODES,
    normalizeMode,
    selectTargetsFromSource,
    selectTargets,
    planOperation,
    createScopedDb,
    mapProgress,
    countTargets,
    run: runMode,
    stop,
    abandon
  });
})();
