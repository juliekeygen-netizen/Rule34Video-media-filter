(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const manager = app?.modules.jobManager;
  const db = app?.modules.db;
  const detailMaintenance = app?.modules.detailMaintenance;
  if (!app || !controller || !manager || !db || !detailMaintenance) {
    throw new Error("R34MF controller dependencies must load before maintenance integration.");
  }

  const DETAIL_KINDS = new Set(["detail-enrichment", "detail-retry-failed", "detail-retry-failed-refreshes", "detail-refresh", "detail-repair-outdated"]);
  const CATALOGUE_KINDS = new Set(["initial-scan", "full-rescan", "full-rescan-resume", "smart-update"]);
  const MODE_KIND = Object.freeze({ missing: "detail-enrichment", failed: "detail-retry-failed", refreshFailed: "detail-retry-failed-refreshes", refresh: "detail-refresh", outdated: "detail-repair-outdated" });
  const MAINTENANCE_COUNT_DELAY_MS = 350;
  let maintenanceCountTimer = null;
  let maintenanceCountPromise = null;
  let maintenanceCountPending = false;
  let maintenanceCountsReady = false;

  function targetCount(mode, catalogue = {}) {
    if (mode === "failed") return Math.max(0, Number(catalogue.failedDetailCount) || 0);
    if (mode === "refreshFailed") return Math.max(0, Number(catalogue.failedRefreshDetailCount) || 0);
    if (mode === "refresh") return Math.max(0, Number(catalogue.detailedCount) || 0);
    if (mode === "outdated") return Math.max(0, Number(catalogue.outdatedDetailCount) || 0);
    return Math.max(0, (Number(catalogue.indexedCount) || 0) - (Number(catalogue.detailedCount) || 0));
  }

  function detailJobInput(mode, catalogue = {}) {
    const normalizedMode = detailMaintenance.normalizeMode(mode);
    return {
      kind: MODE_KIND[normalizedMode],
      scopeKey: normalizedMode === "missing" ? "details-missing" : normalizedMode === "failed" ? "details-failed" : normalizedMode === "refreshFailed" ? "details-refresh-failed" : normalizedMode === "outdated" ? "details-outdated" : "details-refresh",
      resourceKeys: ["detail-write", "catalogue-reconcile"],
      coverage: normalizedMode === "missing"
        ? ["detail-retry-failed"]
        : normalizedMode === "refresh"
          ? ["detail-retry-failed-refreshes", "detail-repair-outdated"]
          : [],
      progress: {
        phase: "preflight",
        detailMode: normalizedMode,
        completed: 0,
        processed: 0,
        total: targetCount(normalizedMode, catalogue),
        detailedCount: Number(catalogue.detailedCount) || 0,
        failedCount: 0
      }
    };
  }

  function resumeCatalogueKind(catalogue = {}) {
    if (catalogue.scanKind === "full-rescan" && ["paused", "failed"].includes(catalogue.scanStatus) && catalogue.sessionId) return "full-rescan-resume";
    return "initial-scan";
  }

  function maintenanceCountsFromSource(records = [], detailsById = new Map()) {
    let failedDetailCount = 0;
    let failedRefreshDetailCount = 0;
    let outdatedDetailCount = 0;
    for (const video of records ?? []) {
      const id = String(video?.videoId ?? "");
      if (!id) continue;
      const detail = detailsById?.get?.(id) ?? detailsById?.[id] ?? null;
      if (detail?.status === "failed") failedDetailCount += 1;
      if (detail?.status !== "complete") continue;
      if (detail.lastAttemptError) failedRefreshDetailCount += 1;
      if (Number(detail.schemaVersion || 1) < 5) outdatedDetailCount += 1;
    }
    return { failedDetailCount, failedRefreshDetailCount, outdatedDetailCount };
  }

  async function refreshMaintenanceCountsOnce(target = controller) {
    // One cached Local snapshot is enough to derive every maintenance count. The
    // previous implementation opened three overlapping catalogue/detail scans.
    const source = await db.getAllLocalRecords();
    const counts = maintenanceCountsFromSource(source.records, source.detailsById);
    target.state = { ...target.state, catalogue: { ...(target.state.catalogue ?? {}), ...counts } };
    maintenanceCountsReady = true;
    if (target.root?.isConnected) target.updateShell();
    return counts.failedDetailCount;
  }

  function refreshMaintenanceCounts(target = controller) {
    if (maintenanceCountPromise) {
      maintenanceCountPending = true;
      return maintenanceCountPromise;
    }
    maintenanceCountPromise = (async () => {
      let result = 0;
      do {
        maintenanceCountPending = false;
        result = await refreshMaintenanceCountsOnce(target);
      } while (maintenanceCountPending);
      return result;
    })().finally(() => {
      maintenanceCountPromise = null;
    });
    return maintenanceCountPromise;
  }

  function scheduleMaintenanceCounts(target = controller, { delay = MAINTENANCE_COUNT_DELAY_MS } = {}) {
    if (maintenanceCountTimer !== null) globalThis.clearTimeout?.(maintenanceCountTimer);
    maintenanceCountTimer = globalThis.setTimeout?.(() => {
      maintenanceCountTimer = null;
      const run = () => refreshMaintenanceCounts(target).catch((error) => {
        app.modules.logger?.debug?.("maintenance-count-refresh-failed", { message: error?.message ?? String(error) });
      });
      if (typeof globalThis.requestIdleCallback === "function") globalThis.requestIdleCallback(run, { timeout: 1500 });
      else run();
    }, Math.max(0, Number(delay) || 0)) ?? null;
  }

  controller.enqueueDetails = function enqueueDetails({ automatic = false, mode = "missing" } = {}) {
    const catalogue = this.state.catalogue ?? {};
    const normalizedMode = detailMaintenance.normalizeMode(mode);
    if (catalogue.catalogueReady !== true) return { accepted: false, reason: "catalogue-unavailable" };
    const knownTarget = targetCount(normalizedMode, catalogue);
    // Missing/refresh counts come directly from authoritative catalogue counts.
    // Failed/outdated counts are intentionally lazy now; do not reject a real job
    // merely because the background maintenance snapshot has not finished yet.
    const countIsAuthoritative = normalizedMode === "missing" || normalizedMode === "refresh" || maintenanceCountsReady;
    if (countIsAuthoritative && knownTarget <= 0) return { accepted: false, reason: "nothing-to-do" };
    const outcome = manager.enqueue(detailJobInput(normalizedMode, catalogue));
    if (!outcome.accepted && !automatic) app.modules.logger?.warn("detail-job-not-enqueued", { mode: normalizedMode, outcome });
    return outcome;
  };

  controller.runDetailMaintenance = async function runDetailMaintenance(mode, context) {
    const result = await detailMaintenance.run(mode, { signal: context.signal, onProgress: context.updateProgress });
    await this.refreshDetailData();
    return result;
  };

  const baseStart = controller.start;
  controller.start = async function start(...args) {
    if (!this.phase8HandlersBound) {
      this.phase8HandlersBound = true;
      manager.registerHandler("detail-retry-failed", (_job, context) => this.runDetailMaintenance("failed", context));
      manager.registerHandler("detail-retry-failed-refreshes", (_job, context) => this.runDetailMaintenance("refreshFailed", context));
      manager.registerHandler("detail-refresh", (_job, context) => this.runDetailMaintenance("refresh", context));
      manager.registerHandler("detail-repair-outdated", (_job, context) => this.runDetailMaintenance("outdated", context));
      manager.registerHandler("full-rescan-resume", async (_job, context) => {
        const result = await app.modules.catalogueScanner.run({ documentLike: document, fullRescan: false, signal: context.signal, onProgress: context.updateProgress });
        if (result?.scanStatus === "complete") await this.maybeAutoFetchDetails();
        return result;
      });
    }
    return baseStart.apply(this, args);
  };

  const baseOnCatalogueState = controller.onCatalogueState;
  controller.onCatalogueState = function onCatalogueState(catalogue) {
    const cached = this.state.catalogue ?? {};
    const merged = { ...catalogue };
    for (const key of ["failedDetailCount", "failedRefreshDetailCount", "outdatedDetailCount"]) {
      const value = Number(cached[key]);
      if (Number.isFinite(value)) merged[key] = value;
    }
    return baseOnCatalogueState.call(this, merged);
  };

  const baseRefreshCatalogueState = controller.refreshCatalogueState;
  controller.refreshCatalogueState = async function refreshCatalogueState(...args) {
    const result = await baseRefreshCatalogueState.apply(this, args);
    // Counts are useful Queue diagnostics, not a prerequisite for mounting the UI.
    // Keep initial startup responsive and calculate them after the page can paint.
    scheduleMaintenanceCounts(this);
    return result;
  };

  const baseRefreshDetailData = controller.refreshDetailData;
  controller.refreshDetailData = async function refreshDetailData(...args) {
    const result = await baseRefreshDetailData.apply(this, args);
    scheduleMaintenanceCounts(this);
    return result;
  };

  const baseRunCatalogueJob = controller.runCatalogueJob;
  controller.runCatalogueJob = async function runCatalogueJob(...args) {
    const result = await baseRunCatalogueJob.apply(this, args);
    scheduleMaintenanceCounts(this);
    return result;
  };

  function showOutcome(target, outcome, page) {
    target.queueOpen = true;
    target.queuePage = page;
    target.state = {
      ...target.state,
      queueOpen: true,
      queueNotice: outcome?.accepted ? null : outcome?.reason === "nothing-to-do" ? "There is no matching maintenance work to run." : "This work is already queued, running, or covered by another job."
    };
    target.updateShell();
    target.renderQueue();
  }

  function enqueueFullRescanResume() {
    const runtime = manager.snapshot();
    const existing = [...runtime.active, ...runtime.waiting].find((job) => ["full-rescan", "full-rescan-resume"].includes(job.kind));
    if (existing) return { accepted: false, reason: "duplicate", job: existing };
    return manager.enqueue({
      kind: "full-rescan-resume",
      scopeKey: "full-rescan",
      resourceKeys: ["catalogue-write", "catalogue-reconcile"],
      coverage: ["smart-update"]
    });
  }

  const baseHandleIntent = controller.handleIntent;
  controller.handleIntent = async function handleIntent(action, trigger) {
    if (action === "queue-maintenance") {
      const result = await baseHandleIntent.call(this, action, trigger);
      // Opening Maintenance should refresh its lazy counts immediately, while the
      // already-rendered Queue remains interactive during the IndexedDB read.
      refreshMaintenanceCounts(this).catch(() => {});
      return result;
    }
    if (action === "maintenance-retry-failed-details") {
      showOutcome(this, this.enqueueDetails({ mode: "failed" }), "maintenance");
      return;
    }
    if (action === "maintenance-retry-failed-refreshes") {
      showOutcome(this, this.enqueueDetails({ mode: "refreshFailed" }), "maintenance");
      return;
    }
    if (action === "maintenance-refresh-details") {
      showOutcome(this, this.enqueueDetails({ mode: "refresh" }), "maintenance");
      return;
    }
    if (action === "maintenance-repair-outdated-details") {
      showOutcome(this, this.enqueueDetails({ mode: "outdated" }), "maintenance");
      return;
    }
    if (action === "details-stop") {
      const active = manager.snapshot().active.find((job) => DETAIL_KINDS.has(job.kind));
      if (active) manager.stop(active.id);
      return;
    }
    if (action === "details-remove") {
      const waiting = manager.snapshot().waiting.find((job) => DETAIL_KINDS.has(job.kind));
      if (waiting) manager.remove(waiting.id);
      return;
    }
    if (action === "details-resume") {
      const mode = ["failed", "refreshFailed", "refresh", "outdated"].includes(this.state.catalogue?.detailsState?.mode) ? this.state.catalogue.detailsState.mode : "missing";
      if (mode !== "missing") {
        showOutcome(this, this.enqueueDetails({ mode }), "details");
        return;
      }
    }
    if (action === "scan-stop") {
      const active = manager.snapshot().active.find((job) => CATALOGUE_KINDS.has(job.kind));
      if (active) manager.stop(active.id);
      return;
    }
    if (action === "scan-resume" && resumeCatalogueKind(this.state.catalogue) === "full-rescan-resume") {
      showOutcome(this, enqueueFullRescanResume(), "catalogue");
      return;
    }
    return baseHandleIntent.call(this, action, trigger);
  };

  const baseCleanup = controller.cleanup;
  controller.cleanup = function cleanup(...args) {
    if (maintenanceCountTimer !== null) globalThis.clearTimeout?.(maintenanceCountTimer);
    maintenanceCountTimer = null;
    maintenanceCountPending = false;
    return baseCleanup.apply(this, args);
  };

  app.modules.maintenanceController = Object.freeze({
    DETAIL_KINDS,
    CATALOGUE_KINDS,
    MAINTENANCE_COUNT_DELAY_MS,
    targetCount,
    detailJobInput,
    resumeCatalogueKind,
    maintenanceCountsFromSource,
    refreshMaintenanceCounts,
    scheduleMaintenanceCounts,
    enqueueFullRescanResume,
    countsReady: () => maintenanceCountsReady
  });
})();