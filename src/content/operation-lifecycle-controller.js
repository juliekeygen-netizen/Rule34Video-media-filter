(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const manager = app?.modules.jobManager;
  const detailMaintenance = app?.modules.detailMaintenance;
  const catalogueScanner = app?.modules.catalogueScanner;
  if (!app || !controller || !manager || !detailMaintenance || !catalogueScanner) {
    throw new Error("R34MF operation dependencies must load before lifecycle controls.");
  }

  const DETAIL_KINDS = new Set(["detail-enrichment", "detail-retry-failed", "detail-retry-failed-refreshes", "detail-refresh", "detail-repair-outdated"]);
  const CATALOGUE_KINDS = new Set(["initial-scan", "full-rescan", "full-rescan-resume", "smart-update"]);

  function activeJob(kinds) {
    return manager.snapshot().active.find((job) => kinds.has(job.kind)) ?? null;
  }

  function waitUntilInactive(jobId, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let finished = false;
      let unsubscribe = null;
      let timer = null;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        unsubscribe?.();
        if (timer !== null) globalThis.clearTimeout(timer);
        resolve(value);
      };
      const check = (snapshot = manager.snapshot()) => {
        if (!(snapshot.active ?? []).some((job) => job.id === jobId)) finish(true);
      };
      unsubscribe = manager.subscribe(check);
      timer = globalThis.setTimeout(() => finish(false), timeoutMs);
      check();
    });
  }

  async function stopThen(job, cleanup) {
    if (!job) return cleanup();
    const waiting = waitUntilInactive(job.id);
    manager.stop(job.id);
    const settled = await waiting;
    if (!settled) {
      const error = new Error("The running operation did not pause in time, so it was not cancelled.");
      error.code = "operation-cancel-timeout";
      throw error;
    }
    return cleanup();
  }

  const baseScheduleDetailRefresh = controller.scheduleDetailRefresh;
  controller.scheduleDetailRefresh = function scheduleDetailRefresh() {
    if (activeJob(DETAIL_KINDS)) {
      // Per-video detail commits are durable immediately, but rebuilding the entire
      // Local result grid every second is unnecessary and visibly disruptive.
      this.operationDetailRefreshDeferred = true;
      return;
    }
    return baseScheduleDetailRefresh.call(this);
  };

  const baseRefreshDetailData = controller.refreshDetailData;
  controller.refreshDetailData = async function refreshDetailData(...args) {
    this.operationDetailRefreshDeferred = false;
    return baseRefreshDetailData.apply(this, args);
  };

  const baseStart = controller.start;
  controller.start = async function start(...args) {
    const result = await baseStart.apply(this, args);
    if (!this.operationLifecycleSubscription) {
      this.operationLifecycleSubscription = manager.subscribe((snapshot) => {
        if (!this.operationDetailRefreshDeferred) return;
        if ((snapshot.active ?? []).some((job) => DETAIL_KINDS.has(job.kind))) return;
        this.refreshDetailData().catch((error) => app.modules.logger?.warn("detail-ui-final-refresh-failed", { message: error?.message }));
      });
    }
    return result;
  };

  const baseHandleIntent = controller.handleIntent;
  controller.handleIntent = async function handleIntent(action, trigger) {
    if (action === "details-cancel") {
      try {
        await stopThen(activeJob(DETAIL_KINDS), () => detailMaintenance.abandon());
        await this.refreshDetailData();
        this.queueOpen = true;
        this.queuePage = "details";
        this.renderQueue();
      } catch (error) {
        app.modules.logger?.warn("detail-cancel-failed", { code: error?.code ?? null, message: error?.message });
      }
      return;
    }

    if (action === "scan-cancel") {
      try {
        const outcome = await stopThen(activeJob(CATALOGUE_KINDS), () => catalogueScanner.cancelCurrent());
        if (outcome?.cancelled !== true) {
          app.modules.logger?.warn("catalogue-cancel-unavailable", { reason: outcome?.reason ?? "unknown" });
        }
        await this.refreshCatalogueState();
        this.queueOpen = true;
        this.queuePage = "catalogue";
        this.renderQueue();
      } catch (error) {
        app.modules.logger?.warn("catalogue-cancel-failed", { code: error?.code ?? null, message: error?.message });
      }
      return;
    }

    return baseHandleIntent.call(this, action, trigger);
  };

  const baseCleanup = controller.cleanup;
  controller.cleanup = function cleanup(...args) {
    this.operationLifecycleSubscription?.();
    this.operationLifecycleSubscription = null;
    this.operationDetailRefreshDeferred = false;
    return baseCleanup.apply(this, args);
  };

  app.modules.operationLifecycleController = Object.freeze({
    DETAIL_KINDS,
    CATALOGUE_KINDS,
    activeJob,
    waitUntilInactive,
    stopThen
  });
})();
