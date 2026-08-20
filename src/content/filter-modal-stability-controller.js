(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  if (!app || !controller) {
    throw new Error("R34MF subscriptions controller must load before filter modal stability support.");
  }

  let deferredShellUpdate = false;
  let deferredQueueUpdate = false;
  let deferredLocalRender = false;

  function modalIsMounted(instance = controller) {
    return Boolean(
      instance?.filterModal
      && instance?.root?.isConnected
      && instance.root.querySelector?.(":scope > .r34mf-modal-layer")?.isConnected
    );
  }

  const baseRenderQueue = controller.renderQueue;
  controller.renderQueue = function renderQueue(...args) {
    if (modalIsMounted(this)) {
      deferredQueueUpdate = true;
      return this.queueUiState ?? null;
    }
    deferredQueueUpdate = false;
    return baseRenderQueue.apply(this, args);
  };

  const baseRenderLocal = controller.renderLocal;
  controller.renderLocal = async function renderLocal(...args) {
    if (modalIsMounted(this)) {
      deferredLocalRender = true;
      return null;
    }
    deferredLocalRender = false;
    return baseRenderLocal.apply(this, args);
  };

  const baseUpdateShell = controller.updateShell;
  controller.updateShell = function updateShell(...args) {
    // Chromium native <select> popups can collapse when unrelated page DOM is
    // replaced. Job progress normally replaces the shell and Queue frequently,
    // so keep all extension-owned presentation DOM quiet while a transactional
    // filter modal is mounted. Network/jobs/storage continue normally.
    if (modalIsMounted(this)) {
      deferredShellUpdate = true;
      return this.root;
    }
    deferredShellUpdate = false;
    return baseUpdateShell.apply(this, args);
  };

  async function flushDeferred(instance = controller) {
    if (!instance?.root?.isConnected || modalIsMounted(instance)) return false;
    const shell = deferredShellUpdate;
    const queue = deferredQueueUpdate;
    const local = deferredLocalRender;
    deferredShellUpdate = false;
    deferredQueueUpdate = false;
    deferredLocalRender = false;

    // updateShell already renders Queue, so do not render it twice.
    if (shell) baseUpdateShell.call(instance);
    else if (queue) baseRenderQueue.call(instance);

    // Do not immediately run a potentially catalogue-sized Local evaluation in
    // the same task that restores the parent filter UI. Scheduling it lets the
    // browser paint the modal close / parent popover first.
    if (local && instance.state?.mode === "local") {
      const schedule = app.modules.filterPagePreservation?.scheduleLocalRefresh;
      if (typeof schedule === "function") schedule(instance);
      else globalThis.setTimeout?.(() => {
        if (instance?.root?.isConnected && !modalIsMounted(instance) && instance.state?.mode === "local") {
          baseRenderLocal.call(instance);
        }
      }, 0);
    }
    return shell || queue || local;
  }

  const baseOpenFilters = controller.openFilters;
  controller.openFilters = async function openFilters(...args) {
    const result = await baseOpenFilters.apply(this, args);
    if (!this.filterModal) await flushDeferred(this);
    return result;
  };

  const baseCleanup = controller.cleanup;
  controller.cleanup = function cleanup(...args) {
    deferredShellUpdate = false;
    deferredQueueUpdate = false;
    deferredLocalRender = false;
    return baseCleanup.apply(this, args);
  };

  app.modules.filterModalStabilityController = Object.freeze({
    modalIsMounted,
    flushDeferred,
    snapshot: () => ({ deferredShellUpdate, deferredQueueUpdate, deferredLocalRender })
  });
})();
