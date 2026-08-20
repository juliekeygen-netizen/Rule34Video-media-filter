(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  if (!app || !controller) throw new Error("R34MF subscriptions controller must load before filter page preservation.");

  let localRefreshTimer = null;

  function needsMembership(filters) {
    if (filters?.detailed?.subscriptionsOnly?.enabled === true) return true;
    const inspect = (items) => (items ?? []).some((item) => item?.enabled !== false
      && (item.kind === "group" ? inspect(item.items) : item.field === "subscriptionsOnly"));
    return filters?.advanced?.enabled === true && inspect(filters.advanced.items);
  }

  function scheduleLocalRefresh(instance = controller) {
    if (localRefreshTimer !== null) globalThis.clearTimeout?.(localRefreshTimer);
    localRefreshTimer = globalThis.setTimeout?.(() => {
      localRefreshTimer = null;
      if (!instance?.root?.isConnected || instance.state?.mode !== "local") return;
      instance.renderLocal?.();
    }, 0) ?? null;
  }

  controller.commitFilters = async function commitFiltersWithoutPageReset(filters) {
    const normalized = app.modules.filterEngine.normalize(filters);
    await app.modules.filterState.commitFilters(normalized);
    this.state = { ...this.state, filters: normalized, activePresetId: app.modules.filterState.value.activePresetId };
    if (needsMembership(normalized)) app.modules.subscriptionMembership?.ensureFresh?.({ documentLike: document })?.catch(() => {});

    // localPage did not change, so avoid a redundant uiState write and the
    // synchronous applyModeVisibility -> renderLocal path. Repaint the shell now
    // and let the expensive Local refresh begin on the next task instead.
    if (this.root?.isConnected) this.updateShell?.();
    scheduleLocalRefresh(this);
  };

  controller.useActivePreset = async function useActivePresetWithoutPageReset() {
    const active = app.modules.filterState.active();
    this.state = { ...this.state, filters: active.filters, activePresetId: active.id };
    if (this.root?.isConnected) this.updateShell?.();
    scheduleLocalRefresh(this);
    this.filterView = null;
    this.filterModal = null;
    this.openFilters();
  };

  const baseCleanup = controller.cleanup;
  controller.cleanup = function cleanup(...args) {
    if (localRefreshTimer !== null) globalThis.clearTimeout?.(localRefreshTimer);
    localRefreshTimer = null;
    return baseCleanup.apply(this, args);
  };

  app.modules.filterPagePreservation = Object.freeze({ needsMembership, scheduleLocalRefresh });
})();
