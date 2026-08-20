(() => {
  "use strict";

  const app = globalThis.R34MF;
  const db = app?.modules.db;
  const base = app?.modules.detailMaintenance;
  const createDetailScanner = app?.modules.createDetailScanner;
  if (!app || !db || !base || !createDetailScanner) {
    throw new Error("R34MF detail lifecycle must load before schema-6 maintenance migration.");
  }

  const CURRENT_DETAIL_SCHEMA = 6;
  const OUTDATED = "outdated";
  let activeOutdatedScanner = null;

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

  function isOutdatedDetail(detail) {
    return detail?.status === "complete" && Number(detail?.schemaVersion || 1) < CURRENT_DETAIL_SCHEMA;
  }

  function selectOutdatedFromSource(records, detailsLike, limit = null, options = {}) {
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
      if (!isOutdatedDetail(detail)) continue;
      if (useCutoff && lastAttemptAt(detail) >= cutoffAt) continue;
      targets.push(video);
      if (bounded !== null && targets.length >= bounded) break;
    }
    return targets;
  }

  function selectTargetsFromSource(records, detailsLike, mode = "missing", limit = null, options = {}) {
    if (base.normalizeMode(mode) !== OUTDATED) {
      return base.selectTargetsFromSource(records, detailsLike, mode, limit, options);
    }
    return selectOutdatedFromSource(records, detailsLike, limit, options);
  }

  async function selectTargets(mode = "missing", { limit = null, cutoffAt = null } = {}) {
    if (base.normalizeMode(mode) !== OUTDATED) return base.selectTargets(mode, { limit, cutoffAt });
    const source = await db.getAllLocalRecords();
    return selectOutdatedFromSource(source.records, source.detailsById, limit, { cutoffAt });
  }

  async function countOutdatedDetails() {
    const source = await db.getAllLocalRecords();
    return selectOutdatedFromSource(source.records, source.detailsById).length;
  }

  // maintenance-controller loads after this module and therefore receives the
  // schema-6-aware count without requiring an IndexedDB schema/version change.
  app.modules.db = Object.freeze({ ...db, countOutdatedDetails });

  function boundedTargets(targets, limit) {
    if (limit === null || !Number.isInteger(Number(limit)) || Number(limit) < 0) return [...targets];
    return targets.slice(0, Number(limit));
  }

  function createScopedDb(plan, initialTargets) {
    const fixedTargets = [...(initialTargets ?? [])];
    return {
      ...db,
      async getMissingDetailTargets({ limit = null } = {}) {
        return boundedTargets(fixedTargets, limit);
      },
      async updateDetailsState(changes) {
        const status = String(changes?.status ?? "running").toLocaleLowerCase();
        const segmentTarget = Math.max(0, Number(changes?.targetCount) || 0);
        const logicalTarget = plan.baseProcessed + segmentTarget;
        if (logicalTarget > 0) plan.targetCount = logicalTarget;
        return db.updateDetailsState({
          ...changes,
          mode: OUTDATED,
          targetCount: plan.targetCount,
          processedCount: plan.baseProcessed + Math.max(0, Number(changes?.processedCount) || 0),
          completedCount: plan.baseCompleted + Math.max(0, Number(changes?.completedCount) || 0),
          failedCount: plan.baseFailed + Math.max(0, Number(changes?.failedCount) || 0),
          startedAt: plan.startedAt,
          operationCutoffAt: status === "complete" ? null : plan.cutoffAt
        });
      },
      async appendHistory(entry) {
        return db.appendHistory({
          ...entry,
          kind: "detail-repair-outdated",
          summary: { ...(entry?.summary ?? {}), mode: OUTDATED }
        });
      }
    };
  }

  async function run(mode = "missing", options = {}) {
    const normalizedMode = base.normalizeMode(mode);
    if (normalizedMode !== OUTDATED) return base.run(normalizedMode, options);
    if (activeOutdatedScanner) {
      const error = new Error("Detailed metadata work is already running.");
      error.code = "detail-run-active";
      throw error;
    }

    const catalogue = await db.getCatalogueState();
    const plan = base.planOperation(catalogue, OUTDATED);
    const initialTargets = await selectTargets(OUTDATED, {
      limit: options.limit ?? null,
      cutoffAt: plan.resuming ? plan.cutoffAt : null
    });
    plan.targetCount = plan.baseProcessed + initialTargets.length;

    const scanner = createDetailScanner({ db: createScopedDb(plan, initialTargets) });
    const externalProgress = options.onProgress;
    activeOutdatedScanner = scanner;
    try {
      const result = await scanner.run({
        ...options,
        onProgress(value) {
          externalProgress?.(base.mapProgress(plan, value));
        }
      });
      const persisted = (await db.getCatalogueState()).detailsState;
      return { ...result, detailsState: persisted };
    } finally {
      if (activeOutdatedScanner === scanner) activeOutdatedScanner = null;
    }
  }

  function stop() {
    if (activeOutdatedScanner) activeOutdatedScanner.stop?.();
    else base.stop?.();
  }

  async function countTargets(mode = "missing") {
    if (base.normalizeMode(mode) === OUTDATED) return countOutdatedDetails();
    return base.countTargets(mode);
  }

  app.modules.detailMaintenance = Object.freeze({
    ...base,
    CURRENT_DETAIL_SCHEMA,
    isOutdatedDetail,
    selectTargetsFromSource,
    selectTargets,
    countTargets,
    run,
    stop
  });
})();
