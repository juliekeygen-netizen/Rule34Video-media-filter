(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const manager = app?.modules.jobManager;
  if (!app || !controller || !manager) {
    throw new Error("R34MF subscriptions controller and Job Manager must load before runtime presentation performance support.");
  }

  const PROGRESS_UI_INTERVAL_MS = 120;
  let runtimeUiTimer = null;
  let runtimeUiFrame = null;
  let lastTopology = "";

  function topology(snapshot = manager.snapshot()) {
    return JSON.stringify({
      active: (snapshot.active ?? []).map((job) => [job.id, job.kind]),
      waiting: (snapshot.waiting ?? []).map((job) => [job.id, job.kind])
    });
  }

  function cancelRuntimeUi() {
    if (runtimeUiTimer !== null) globalThis.clearTimeout?.(runtimeUiTimer);
    runtimeUiTimer = null;
    if (runtimeUiFrame !== null && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(runtimeUiFrame);
    }
    runtimeUiFrame = null;
  }

  function flushRuntimeUi(instance = controller) {
    runtimeUiTimer = null;
    runtimeUiFrame = null;
    if (!instance?.root?.isConnected) return;
    // updateShell already renders an open Queue and repositions open tools. The
    // old JobManager subscriber rendered Queue once, then updateShell rendered it
    // again for every progress tick.
    instance.updateShell?.();
  }

  function scheduleRuntimeUi(instance = controller, snapshot = manager.snapshot()) {
    if (!instance?.root?.isConnected) return;
    const nextTopology = topology(snapshot);
    const topologyChanged = nextTopology !== lastTopology;
    lastTopology = nextTopology;

    if (topologyChanged && runtimeUiTimer !== null) {
      globalThis.clearTimeout?.(runtimeUiTimer);
      runtimeUiTimer = null;
    }
    if (runtimeUiTimer !== null || runtimeUiFrame !== null) return;

    const queueFrame = () => {
      runtimeUiTimer = null;
      if (typeof globalThis.requestAnimationFrame === "function") {
        runtimeUiFrame = globalThis.requestAnimationFrame(() => flushRuntimeUi(instance));
      } else {
        flushRuntimeUi(instance);
      }
    };

    if (topologyChanged) queueFrame();
    else runtimeUiTimer = globalThis.setTimeout?.(queueFrame, PROGRESS_UI_INTERVAL_MS) ?? null;
  }

  // subscriptions-controller installs exactly one presentation-only JobManager
  // listener during its base start. Intercept that subscription before it is made
  // so durable JobManager state and Queue persistence keep receiving every event,
  // while shell/Queue DOM updates are coalesced to a browser-friendly cadence.
  const baseStart = controller.start;
  controller.start = async function startWithCoalescedRuntimePresentation(...args) {
    if (this.__r34mfRuntimePresentationBound || this.started) return baseStart.apply(this, args);

    const originalManagerModule = app.modules.jobManager;
    let presentationSubscriptionIntercepted = false;
    const facade = Object.freeze({
      ...manager,
      subscribe(listener) {
        if (presentationSubscriptionIntercepted) return manager.subscribe(listener);
        presentationSubscriptionIntercepted = true;
        return manager.subscribe((snapshot) => scheduleRuntimeUi(controller, snapshot));
      }
    });

    app.modules.jobManager = facade;
    try {
      const result = await baseStart.apply(this, args);
      this.__r34mfRuntimePresentationBound = presentationSubscriptionIntercepted;
      return result;
    } finally {
      app.modules.jobManager = originalManagerModule;
    }
  };

  // Scanner progress updates catalogue status frequently, but Local records only
  // change through DB catalogue/detail notifications. Do not restart a 7k-record
  // Local filter pass for a current-page/progress-only catalogue state emission.
  const baseOnCatalogueState = controller.onCatalogueState;
  controller.onCatalogueState = function onCatalogueStateWithoutRedundantLocalRender(catalogue) {
    const applyModeVisibility = this.applyModeVisibility;
    this.applyModeVisibility = function applyModeVisibilityForStateOnly(parts, options = {}) {
      return applyModeVisibility.call(this, parts, { ...options, refreshLocal: false });
    };
    try {
      return baseOnCatalogueState.call(this, catalogue);
    } finally {
      this.applyModeVisibility = applyModeVisibility;
    }
  };

  const baseCleanup = controller.cleanup;
  controller.cleanup = function cleanup(...args) {
    cancelRuntimeUi();
    lastTopology = "";
    this.__r34mfRuntimePresentationBound = false;
    return baseCleanup.apply(this, args);
  };

  app.modules.runtimePresentationPerformance = Object.freeze({
    PROGRESS_UI_INTERVAL_MS,
    topology,
    scheduleRuntimeUi,
    flushRuntimeUi,
    cancelRuntimeUi
  });
})();