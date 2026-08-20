(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before accessibility hardening.");

  function hasAccessibleName(node) {
    return Boolean(
      node?.getAttribute?.("aria-label")
      || node?.getAttribute?.("aria-labelledby")
      || (node?.id && document.querySelector?.(`label[for="${globalThis.CSS?.escape ? globalThis.CSS.escape(node.id) : String(node.id).replace(/["\\]/g, "\\$&")}"]`))
      || node?.closest?.("label")
    );
  }

  function explicitInputNames(scope, fallback = "Filter value") {
    for (const control of scope?.querySelectorAll?.("input, select, textarea") ?? []) {
      if (hasAccessibleName(control) || control.type === "hidden") continue;
      const title = scope.querySelector?.(".r34mf-modal-title, h2, h3")?.textContent?.trim();
      const placeholder = control.getAttribute("placeholder")?.trim();
      control.setAttribute("aria-label", placeholder ? `${title || fallback}: ${placeholder}` : title ? `${title} value` : fallback);
    }
  }

  function decorateShell(root) {
    const status = root?.querySelector?.(".r34mf-status");
    if (status) {
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.setAttribute("aria-atomic", "true");
    }
    const showing = root?.querySelector?.(".r34mf-showing");
    if (showing) showing.setAttribute("aria-live", "polite");
  }

  function decorateFilters(root) {
    const host = root?.querySelector?.(":scope > .r34mf-tool-layer");
    if (host) {
      host.setAttribute("role", "region");
      host.setAttribute("aria-label", "Filters");
    }
    const sort = root?.querySelector?.(":scope > .r34mf-sort-surface");
    if (sort) {
      sort.setAttribute("role", "region");
      sort.setAttribute("aria-label", "Sort local catalogue");
    }
    const layer = root?.querySelector?.(":scope > .r34mf-modal-layer");
    if (layer) decorateFilterModal(layer);
  }

  function decorateFilterModal(layer) {
    const dialog = layer?.querySelector?.(".r34mf-modal");
    if (!dialog) return layer;
    explicitInputNames(dialog);
    for (const menu of layer.querySelectorAll("[role='menu']")) {
      for (const item of menu.querySelectorAll(":scope > button")) item.setAttribute("role", "menuitem");
    }
    for (const error of dialog.querySelectorAll(".is-error, .r34mf-filter-error, .r34mf-advanced-error")) {
      if (!error.getAttribute("role")) error.setAttribute("role", "alert");
    }
    return layer;
  }

  function decorateQueue(root) {
    const panel = root?.querySelector?.(":scope > .r34mf-queue-host .r34mf-queue-panel");
    if (!panel) return;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Queue");
    const headerStatus = panel.querySelector(".r34mf-queue-header-status");
    if (headerStatus) {
      headerStatus.setAttribute("role", "status");
      headerStatus.setAttribute("aria-live", "polite");
      headerStatus.setAttribute("aria-atomic", "true");
    }
    for (const progress of panel.querySelectorAll("[role='progressbar']")) {
      if (!progress.getAttribute("aria-label") && !progress.getAttribute("aria-labelledby")) progress.setAttribute("aria-label", "Operation progress");
    }
    for (const error of panel.querySelectorAll(".r34mf-queue-error")) error.setAttribute("role", "alert");
  }

  function bindSettingsTabKeys(nav) {
    if (!nav || nav.dataset.r34mfA11yTabsBound === "true") return;
    nav.dataset.r34mfA11yTabsBound = "true";
    nav.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const target = event.target?.closest?.("[role='tab']");
      if (!target || !nav.contains(target)) return;
      const tabs = [...nav.querySelectorAll("[role='tab']")];
      const index = tabs.indexOf(target);
      if (index < 0 || tabs.length < 2) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      else nextIndex = (index + 1) % tabs.length;
      const nextId = tabs[nextIndex].id;
      tabs[nextIndex].click();
      queueMicrotask(() => document.getElementById(nextId)?.focus({ preventScroll: true }));
    });
  }

  function decorateSettings(layer) {
    const dialog = layer?.querySelector?.(".r34mf-settings-dialog");
    if (!dialog) return layer;
    explicitInputNames(dialog, "Settings value");
    const nav = dialog.querySelector(".r34mf-settings-nav");
    const content = dialog.querySelector(".r34mf-settings-content");
    if (nav) {
      nav.setAttribute("role", "tablist");
      for (const button of nav.querySelectorAll("button")) {
        const key = button.dataset.settingsFocusKey?.replace(/^nav:/, "") || button.textContent.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-");
        const selected = button.classList.contains("is-active");
        button.id = `r34mf-settings-tab-${key}`;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(selected));
        button.setAttribute("aria-controls", "r34mf-settings-tabpanel");
        button.tabIndex = selected ? 0 : -1;
        if (!selected) button.removeAttribute("aria-current");
      }
      bindSettingsTabKeys(nav);
    }
    if (content) {
      content.id = "r34mf-settings-tabpanel";
      content.setAttribute("role", "tabpanel");
      const activeTab = nav?.querySelector(".is-active");
      if (activeTab?.id) content.setAttribute("aria-labelledby", activeTab.id);
      content.setAttribute("tabindex", "-1");
    }
    const footerStatus = dialog.querySelector(".r34mf-settings-footer-status");
    if (footerStatus) {
      footerStatus.setAttribute("role", "status");
      footerStatus.setAttribute("aria-live", "polite");
      footerStatus.setAttribute("aria-atomic", "true");
    }
    for (const error of dialog.querySelectorAll(".is-error, .r34mf-settings-form-error")) error.setAttribute("role", "alert");
    for (const success of dialog.querySelectorAll(".is-success")) {
      success.setAttribute("role", "status");
      success.setAttribute("aria-live", "polite");
    }
    return layer;
  }

  function decorateRoot(root) {
    decorateShell(root);
    decorateFilters(root);
    decorateQueue(root);
    return root;
  }

  if (app.modules.shell) {
    const base = app.modules.shell;
    app.modules.shell = Object.freeze({
      ...base,
      mount(root, state, onIntent) {
        const result = base.mount(root, state, onIntent);
        decorateShell(root);
        return result;
      },
      update(root, state) {
        const result = base.update(root, state);
        decorateShell(root);
        return result;
      }
    });
  }

  if (app.modules.filtersUi) {
    const base = app.modules.filtersUi;
    app.modules.filtersUi = Object.freeze({
      ...base,
      render(state, onIntent) {
        const result = base.render(state, onIntent);
        decorateFilters(state.root);
        return result;
      }
    });
  }

  if (app.modules.filterModals) {
    const base = app.modules.filterModals;
    app.modules.filterModals = Object.freeze({
      ...base,
      render(state, send) {
        const result = base.render(state, send);
        if (result) decorateFilterModal(result);
        return result;
      }
    });
  }

  if (app.modules.queue) {
    const base = app.modules.queue;
    app.modules.queue = Object.freeze({
      ...base,
      render(root, raw, page, restoreState, onIntent) {
        const result = base.render(root, raw, page, restoreState, onIntent);
        decorateQueue(root);
        return result;
      }
    });
  }

  if (app.modules.settingsUi) {
    const base = app.modules.settingsUi;
    let observedLayer = null;
    let observer = null;

    function disconnectSettingsObserver() {
      observer?.disconnect?.();
      observer = null;
      observedLayer = null;
    }

    app.modules.settingsUi = Object.freeze({
      ...base,
      async open(options) {
        const layer = await base.open(options);
        if (!layer?.isConnected) return layer;
        decorateSettings(layer);
        if (observedLayer !== layer) {
          disconnectSettingsObserver();
          observedLayer = layer;
          if (typeof globalThis.MutationObserver === "function") {
            observer = new globalThis.MutationObserver(() => {
              if (!observedLayer?.isConnected) {
                disconnectSettingsObserver();
                return;
              }
              decorateSettings(observedLayer);
            });
            observer.observe(layer, { childList: true, subtree: true });
          }
        }
        return layer;
      },
      close(options) {
        const result = base.close(options);
        if (observedLayer && !observedLayer.isConnected) disconnectSettingsObserver();
        return result;
      }
    });
  }

  app.modules.accessibilityHardening = Object.freeze({
    explicitInputNames,
    decorateShell,
    decorateFilters,
    decorateFilterModal,
    decorateQueue,
    bindSettingsTabKeys,
    decorateSettings,
    decorateRoot
  });
})();
