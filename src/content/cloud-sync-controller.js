(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const cloud = app?.modules.cloudSync;
  const cloudUi = app?.modules.cloudSyncUi;
  if (!app || !controller || !cloud || !cloudUi) {
    throw new Error("R34MF subscriptions controller and Cloud sync must load before Cloud sync integration.");
  }

  const CLOUD_START_DELAY_MS = 3200;
  const CLOUD_IDLE_TIMEOUT_MS = 4000;

  async function refreshAfterPull(instance = controller) {
    await instance.restoreState?.();
    await instance.refreshCatalogueState?.();
    if (instance.state?.catalogue?.catalogueReady !== true && instance.state?.mode === "local") {
      await instance.setUiState?.({ mode: "native", localPage: 1 });
    } else if (instance.state?.mode === "local") {
      await instance.renderLocal?.();
    }
    instance.renderQueue?.();
    instance.updateShell?.();
  }

  const originalHandleIntent = controller.handleIntent;
  controller.handleIntent = async function (action, trigger) {
    if (action !== "cloud-push" && action !== "cloud-pull") {
      return originalHandleIntent.call(this, action, trigger);
    }

    this.closeFilters?.();
    this.closeSort?.();
    if (this.queueOpen) this.closeQueue?.({ returnFocus: false });
    return cloudUi.open(action === "cloud-pull" ? "pull" : "push", {
      returnFocus: trigger,
      onComplete: async ({ action: completed }) => {
        if (completed === "pull") await refreshAfterPull(this);
      }
    });
  };

  document.addEventListener("r34mf:cloud-pulled", () => {
    refreshAfterPull(controller).catch((error) => {
      app.modules.logger?.warn?.("cloud-pull-ui-refresh-failed", { message: error?.message ?? String(error) });
    });
  });

  // Passive check only: never auto-pull or auto-push. Keep this away from initial
  // Local rendering / Queue restoration / automatic Recent Update so a configured
  // Cloud connection cannot add another startup task to an already busy page.
  const startupCheck = () => {
    if (!controller.isTargetPage?.()) return;
    window.setTimeout(() => {
      if (!controller.isTargetPage?.() || document.visibilityState === "hidden") return;
      const run = () => {
        if (!controller.isTargetPage?.()) return;
        cloud.checkForRemoteUpdate({ maxAgeMs: 15 * 60 * 1000 }).catch(() => {});
      };
      if (typeof globalThis.requestIdleCallback === "function") {
        globalThis.requestIdleCallback(run, { timeout: CLOUD_IDLE_TIMEOUT_MS });
      } else run();
    }, CLOUD_START_DELAY_MS);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startupCheck, { once: true });
  else startupCheck();

  app.modules.cloudSyncController = Object.freeze({
    refreshAfterPull,
    CLOUD_START_DELAY_MS,
    CLOUD_IDLE_TIMEOUT_MS
  });
})();