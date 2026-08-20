(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const filterState = app?.modules.filterState;
  if (!app || !controller || !filterState) {
    throw new Error("R34MF subscriptions controller and filter state must load before filter UI hooks.");
  }

  const basePointerDown = controller.onDocumentPointerDown;
  controller.onDocumentPointerDown = function onDocumentPointerDown(event) {
    if (this.filterModal || event.target.closest?.(".r34mf-modal-layer")) {
      return;
    }
    return basePointerDown.call(this, event);
  };

  const basePlaceTool = controller.placeTool;
  controller.placeTool = function placeTool(host, anchor, wide = false) {
    if (wide || !host || !this.root?.isConnected) {
      return basePlaceTool.call(this, host, anchor, wide);
    }

    const anchorAction = host.classList?.contains("r34mf-sort-surface") ? "sort" : "filters";
    const liveAnchor = this.resolveToolAnchor(anchorAction, anchor);
    const rootBox = this.root.getBoundingClientRect();
    const viewport = window.innerWidth || document.documentElement.clientWidth;
    const anchorBox = liveAnchor?.getBoundingClientRect?.();
    let width = null;

    if (host.classList?.contains("r34mf-tool-layer")) {
      const filterBox = this.root.querySelector("[data-r34mf-action='filters']")?.getBoundingClientRect?.();
      const sortBox = this.root.querySelector("[data-r34mf-action='sort']")?.getBoundingClientRect?.();
      if (filterBox && sortBox) width = Math.max(0, sortBox.right - filterBox.left);
    } else if (host.classList?.contains("r34mf-sort-surface")) {
      width = anchorBox?.width ?? null;
    }

    if (!Number.isFinite(width) || width <= 0) {
      return basePlaceTool.call(this, host, liveAnchor, wide);
    }

    width = Math.min(width, rootBox.width, viewport - 16);
    const wanted = (anchorBox?.left ?? rootBox.left) - rootBox.left;
    host.style.setProperty("width", `${Math.round(width)}px`, "important");
    if (host.classList?.contains("r34mf-tool-layer")) {
      host.style.setProperty("--r34mf-filter-popover-width", `${Math.round(width)}px`);
    }
    if (host.classList?.contains("r34mf-sort-surface")) {
      host.style.setProperty("--r34mf-sort-popover-width", `${Math.round(width)}px`);
    }
    host.style.left = `${Math.min(Math.max(0, wanted), Math.max(0, rootBox.width - width))}px`;
    host.style.top = `${Math.max(0, (anchorBox?.bottom ?? rootBox.top) - rootBox.top + 7)}px`;
  };

  async function refreshPresetModal(instance) {
    const active = filterState.active();
    instance.state = {
      ...instance.state,
      filters: active.filters,
      activePresetId: active.id
    };
    await instance.setUiState({ localPage: instance.state.localPage });
    instance.filterView = null;
    instance.filterModal = { type: "presets" };
    await instance.openFilters();
  }

  const baseHandleIntent = controller.handleIntent;
  controller.handleIntent = async function handleIntent(action, trigger) {
    if (action === "preset-create") {
      try {
        await filterState.create(trigger?.name);
        await refreshPresetModal(this);
      } catch (error) {
        app.modules.logger?.warn("preset-create-failed", { message: error?.message ?? String(error) });
      }
      return;
    }

    if (action.startsWith("preset-select:")) {
      await filterState.select(action.slice("preset-select:".length));
      await refreshPresetModal(this);
      return;
    }

    if (action.startsWith("preset-duplicate:")) {
      await filterState.duplicate(action.slice("preset-duplicate:".length));
      await refreshPresetModal(this);
      return;
    }

    if (action.startsWith("preset-delete:")) {
      await filterState.remove(action.slice("preset-delete:".length));
      await refreshPresetModal(this);
      return;
    }

    if (action === "preset-rename-submit") {
      try {
        await filterState.rename(trigger?.id, trigger?.name);
        await refreshPresetModal(this);
      } catch (error) {
        app.modules.logger?.warn("preset-rename-failed", { message: error?.message ?? String(error) });
      }
      return;
    }

    return baseHandleIntent.call(this, action, trigger);
  };

  app.modules.filterUiHooks = Object.freeze({ installed: true });
})();
