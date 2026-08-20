(() => {
  "use strict";

  const app = globalThis.R34MF;
  const baseScanner = app?.modules.catalogueScanner;
  const db = app?.modules.db;
  if (!app || !baseScanner || !db) {
    throw new Error("R34MF catalogue scanner and database must load before catalogue maintenance.");
  }

  // Tests and older isolated harnesses may load this wrapper without the optional
  // cancellation-storage module. Production manifests load the real module first.
  const cancelStorage = app.modules.catalogueCancelStorage ?? Object.freeze({
    async captureFullRescanBaseline() { return { captured: false, reason: "unavailable" }; },
    async restoreFullRescanBaseline() { return { restored: false, reason: "baseline-unavailable" }; },
    async hasFullRescanBaseline() { return false; },
    async clearFullRescanBaseline() {},
    async cancelSmartUpdate() { return { cancelled: false, reason: "unavailable" }; },
    async cancelInitialScan() { return { cancelled: false, reason: "unavailable" }; }
  });

  function freshSmartUpdateState() {
    return { ...db.defaultCatalogueState().smartUpdate };
  }

  function timedProgress(onProgress, counterField = "completed") {
    if (typeof onProgress !== "function") return undefined;
    let baseline = null;
    const timingStartedAt = Date.now();
    return (value = {}) => {
      const current = Math.max(0, Number(value[counterField] ?? value.completed) || 0);
      if (baseline === null && current > 0) baseline = current - 1;
      onProgress({
        ...value,
        timingStartedAt,
        timingCompleted: baseline === null ? 0 : Math.max(0, current - baseline)
      });
    };
  }

  async function abandonSmartUpdateForFullRescan({ clearStages = true } = {}) {
    const state = await db.getCatalogueState();
    if (clearStages) await db.clearSmartUpdateStage();
    else if (state.smartUpdate?.sessionId) await db.clearSmartUpdateStage(state.smartUpdate.sessionId);
    await db.putCatalogueState({ smartUpdate: freshSmartUpdateState() });
  }

  async function run(options = {}) {
    const before = await db.getCatalogueState();
    const hasResumableFullRescan = ["paused", "failed"].includes(before.scanStatus)
      && before.scanKind === "full-rescan"
      && Boolean(before.sessionId);
    if (options.fullRescan === true && hasResumableFullRescan) {
      const error = new Error("Resume or cancel the interrupted Full catalogue rescan before starting another Full rescan.");
      error.code = "full-rescan-resumable";
      throw error;
    }

    const resumingFullRescan = options.fullRescan !== true && hasResumableFullRescan;
    const isFullRescan = options.fullRescan === true || resumingFullRescan;

    if (options.fullRescan === true) {
      await abandonSmartUpdateForFullRescan({ clearStages: true });
      await cancelStorage.captureFullRescanBaseline();
    } else if (resumingFullRescan) {
      // Keep the reserved pre-rescan baseline intact so Cancel can restore it.
      await abandonSmartUpdateForFullRescan({ clearStages: false });
    }

    const result = await baseScanner.run({
      ...options,
      onProgress: timedProgress(options.onProgress, "completed")
    });
    if (!isFullRescan || result?.scanStatus !== "complete") return result;

    if (resumingFullRescan) {
      const pageCount = Number(result.discoveredPageCount ?? before.discoveredPageCount);
      if (Number.isInteger(pageCount) && pageCount > 0) {
        await db.finalizeFullRescan({ sessionId: before.sessionId, pageCount });
      }
    }

    await cancelStorage.clearFullRescanBaseline();
    await db.putCatalogueState({
      ...db.authoritativeCountChanges(await db.countVideos(), await db.countDetailedVideos()),
      smartUpdate: freshSmartUpdateState()
    });
    await db.clearSmartUpdateStage();
    return baseScanner.refresh();
  }

  async function runSmartUpdate(options = {}) {
    const state = await db.getCatalogueState();
    if (state.scanKind === "full-rescan" && ["paused", "failed"].includes(state.scanStatus)) {
      const error = new Error("Resume or cancel the interrupted Full catalogue rescan before starting Smart Update.");
      error.code = "full-rescan-resumable";
      throw error;
    }
    return baseScanner.runSmartUpdate({
      ...options,
      onProgress: timedProgress(options.onProgress, "pagesChecked")
    });
  }

  async function runRecentUpdate(options = {}) {
    const state = await db.getCatalogueState();
    if (state.scanKind === "full-rescan" && ["paused", "failed"].includes(state.scanStatus)) {
      throw Object.assign(new Error("Resume or cancel the interrupted Full catalogue rescan before starting Recent Update."), { code: "full-rescan-resumable" });
    }
    return baseScanner.runRecentUpdate({ ...options, onProgress: timedProgress(options.onProgress, "pagesChecked") });
  }

  async function cancelCurrent() {
    const state = await db.getCatalogueState();
    const smartStatus = String(state.smartUpdate?.status ?? "").toLowerCase();
    if (["paused", "failed"].includes(smartStatus) && state.smartUpdate?.sessionId) {
      await cancelStorage.cancelSmartUpdate();
      return { cancelled: true, kind: "smart-update", state: await baseScanner.refresh() };
    }

    if (state.scanKind === "full-rescan" && ["paused", "failed"].includes(state.scanStatus)) {
      const restored = await cancelStorage.restoreFullRescanBaseline();
      return {
        cancelled: restored.restored === true,
        kind: "full-rescan",
        reason: restored.reason ?? null,
        state: await baseScanner.refresh()
      };
    }

    if (["paused", "failed"].includes(state.scanStatus) && state.sessionId) {
      const cancelled = await cancelStorage.cancelInitialScan();
      return {
        cancelled: cancelled.cancelled === true,
        kind: "initial-scan",
        reason: cancelled.reason ?? null,
        state: await baseScanner.refresh()
      };
    }

    return { cancelled: false, reason: "nothing-to-cancel", state };
  }

  app.modules.catalogueScanner = Object.freeze({
    ...baseScanner,
    run,
    runSmartUpdate,
    runRecentUpdate,
    cancelCurrent,
    abandonSmartUpdateForFullRescan,
    hasFullRescanBaseline: cancelStorage.hasFullRescanBaseline
  });
})();