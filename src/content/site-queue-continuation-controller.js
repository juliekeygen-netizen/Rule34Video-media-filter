(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const manager = app?.modules.jobManager;
  const db = app?.modules.db;
  const scanner = app?.modules.catalogueScanner;
  const maintenance = app?.modules.maintenanceController;
  const runtime = app?.modules.siteQueueRuntime;
  const persistence = app?.modules.queuePersistence;
  if (!app || !controller || !manager || !db || !scanner || !maintenance || !runtime || !persistence) {
    throw new Error("R34MF queue continuation dependencies must load before the site-wide continuation controller.");
  }

  const DETAIL_MODE_BY_KIND = Object.freeze({
    "detail-enrichment": "missing",
    "detail-retry-failed": "failed",
    "detail-retry-failed-refreshes": "refreshFailed",
    "detail-refresh": "refresh",
    "detail-repair-outdated": "outdated"
  });
  const DETAIL_KINDS = new Set(Object.keys(DETAIL_MODE_BY_KIND));
  const CATALOGUE_KINDS = new Set(["initial-scan", "full-rescan", "full-rescan-resume", "smart-update"]);
  let ownershipUnsubscribe = null;
  let activationPromise = null;

  function allRuntimeJobs() {
    const snapshot = manager.snapshot();
    return [...(snapshot.active ?? []), ...(snapshot.waiting ?? [])];
  }

  function hasKind(kind) {
    return allRuntimeJobs().some((job) => job.kind === kind || job.scopeKey === kind);
  }

  function activeDescriptorStillNeeded(job, catalogue) {
    if (job.bucket !== "active") return true;
    if (DETAIL_KINDS.has(job.kind)) {
      const state = catalogue?.detailsState ?? {};
      return !["complete", "idle"].includes(String(state.status ?? "").toLowerCase());
    }
    if (job.kind === "smart-update") {
      return String(catalogue?.smartUpdate?.status ?? "").toLowerCase() !== "complete";
    }
    if (["initial-scan", "full-rescan", "full-rescan-resume"].includes(job.kind)) {
      return String(catalogue?.scanStatus ?? "").toLowerCase() !== "complete";
    }
    return true;
  }

  function restoredInput(job, catalogue) {
    let kind = job.kind;
    if (kind === "full-rescan" && catalogue?.scanKind === "full-rescan"
      && ["paused", "failed"].includes(String(catalogue?.scanStatus ?? "").toLowerCase())
      && catalogue?.sessionId) {
      kind = "full-rescan-resume";
    }
    return {
      id: job.id,
      kind,
      scopeKey: kind === "full-rescan-resume" ? "full-rescan" : job.scopeKey,
      requestedAt: job.requestedAt,
      resourceKeys: [...(job.resourceKeys ?? [])],
      coverage: [...(job.coverage ?? [])],
      progress: { ...(job.progress ?? {}) }
    };
  }

  async function restorePersistedQueue(catalogue) {
    const stored = await persistence.read();
    let restored = 0;
    let discarded = 0;
    // Active work goes first so a waiting dependent cannot jump ahead after a navigation.
    const ordered = [...stored.jobs].sort((a, b) => (a.bucket === b.bucket ? 0 : a.bucket === "active" ? -1 : 1)
      || Number(a.requestedAt) - Number(b.requestedAt));
    for (const job of ordered) {
      if (!activeDescriptorStillNeeded(job, catalogue)) {
        discarded += 1;
        continue;
      }
      const outcome = manager.enqueue(restoredInput(job, catalogue));
      if (outcome?.accepted === true) restored += 1;
    }
    app.modules.logger?.debug?.("site-queue-restored", { restored, discarded, persisted: stored.jobs.length });
    return { restored, discarded, persisted: stored.jobs.length };
  }

  function runtimeInterrupted(value) {
    return String(value?.lastError?.code ?? "") === "runtime-interrupted";
  }

  function enqueueInterruptedFallback(catalogue) {
    const outcomes = [];
    const details = catalogue?.detailsState ?? {};
    if (String(details.status).toLowerCase() === "paused" && runtimeInterrupted(details)) {
      const mode = ["missing", "failed", "refreshFailed", "refresh", "outdated"].includes(details.mode) ? details.mode : "missing";
      const kind = Object.entries(DETAIL_MODE_BY_KIND).find(([, value]) => value === mode)?.[0] ?? "detail-enrichment";
      if (!allRuntimeJobs().some((job) => DETAIL_KINDS.has(job.kind))) {
        outcomes.push(controller.enqueueDetails({ automatic: true, mode }));
        app.modules.logger?.debug?.("site-queue-interrupted-detail-resume", { mode, kind });
      }
    }

    const smart = catalogue?.smartUpdate ?? {};
    if (String(smart.status).toLowerCase() === "paused" && runtimeInterrupted(smart)
      && !allRuntimeJobs().some((job) => job.kind === "smart-update")) {
      outcomes.push(manager.enqueue({
        kind: "smart-update",
        scopeKey: "smart-update",
        resourceKeys: ["catalogue-write"],
        progress: { updateMode: smart.updateMode === "recent" ? "recent" : "smart" }
      }));
      app.modules.logger?.debug?.("site-queue-interrupted-smart-resume", { updateMode: smart.updateMode === "recent" ? "recent" : "smart" });
    }

    if (String(catalogue?.scanStatus).toLowerCase() === "paused" && runtimeInterrupted(catalogue)
      && !allRuntimeJobs().some((job) => CATALOGUE_KINDS.has(job.kind))) {
      if (catalogue?.scanKind === "full-rescan" && catalogue?.sessionId) {
        outcomes.push(maintenance.enqueueFullRescanResume());
        app.modules.logger?.debug?.("site-queue-interrupted-catalogue-resume", { kind: "full-rescan-resume" });
      } else {
        outcomes.push(manager.enqueue({
          kind: "initial-scan",
          scopeKey: "catalogue-initial",
          resourceKeys: ["catalogue-write", "catalogue-reconcile"]
        }));
        app.modules.logger?.debug?.("site-queue-interrupted-catalogue-resume", { kind: "initial-scan" });
      }
    }
    return outcomes;
  }

  async function activate(target = controller, { refresh = true } = {}) {
    if (!runtime.isOwner() || !target.started) return { activated: false, reason: "not-owner" };
    if (activationPromise) return activationPromise;
    activationPromise = (async () => {
      // controller.start() already performs one authoritative catalogue refresh.
      // Repeating the same counts/page-checkpoint pass immediately afterwards was
      // especially expensive on large catalogues and mobile devices. Only refresh
      // here when ownership was acquired later by an already-running page.
      if (refresh) await target.refreshCatalogueState();
      const catalogue = target.state.catalogue ?? await db.getCatalogueState();
      manager.setExecutionEnabled(false);
      manager.setAcceptingEnabled(true);
      const restored = await restorePersistedQueue(catalogue);
      enqueueInterruptedFallback(catalogue);
      persistence.start();
      app.modules.detailRateLimitRecovery?.restorePaused?.().catch?.(() => {});
      runtime.setExecutionReady(true);
      manager.pump();
      target.renderQueue?.();
      target.updateShell?.();
      return { activated: true, ...restored };
    })().finally(() => { activationPromise = null; });
    return activationPromise;
  }

  // CatalogueScanner.initialize() intentionally normalizes an interrupted running
  // operation. Only the elected executor may do that; any other Rule34Video tab
  // reads state without mutating the active owner's operation.
  const ownerRefreshCatalogueState = controller.refreshCatalogueState;
  controller.refreshCatalogueState = async function refreshCatalogueState(...args) {
    if (runtime.isOwner()) return ownerRefreshCatalogueState.apply(this, args);
    const catalogue = await scanner.refresh();
    this.recentHistory = await db.readRecentHistory();
    this.onCatalogueState(catalogue);
    // Maintenance diagnostics must not hold a non-owner tab's UI startup hostage.
    // They are derived from one cached Local snapshot and update the Queue later.
    maintenance.scheduleMaintenanceCounts?.(this);
    return catalogue;
  };

  const baseStart = controller.start;
  controller.start = async function start(...args) {
    const result = await baseStart.apply(this, args);
    if (!ownershipUnsubscribe) {
      ownershipUnsubscribe = runtime.subscribe((state) => {
        if (state.owner === true) {
          activate(this, { refresh: true }).catch((error) => app.modules.logger?.warn?.("site-queue-activation-failed", { message: error?.message ?? String(error) }));
        }
      });
    }
    // The base start path has just refreshed catalogue state, so the initial owner
    // can restore its persisted queue without doing the same large DB pass twice.
    if (runtime.isOwner()) await activate(this, { refresh: false });
    return result;
  };

  const baseCleanup = controller.cleanup;
  controller.cleanup = function cleanup(...args) {
    ownershipUnsubscribe?.();
    ownershipUnsubscribe = null;
    persistence.stop();
    runtime.setExecutionReady(false);
    return baseCleanup.apply(this, args);
  };

  app.modules.siteQueueContinuation = Object.freeze({
    DETAIL_MODE_BY_KIND,
    DETAIL_KINDS,
    CATALOGUE_KINDS,
    activeDescriptorStillNeeded,
    restoredInput,
    restorePersistedQueue,
    runtimeInterrupted,
    enqueueInterruptedFallback,
    activate
  });
})();