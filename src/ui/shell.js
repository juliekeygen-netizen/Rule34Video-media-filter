(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) {
    throw new Error("R34MF namespace must load before shell UI.");
  }

  const TITLE = "SUBSCRIPTION FILTER";
  const SORT_LABELS = Object.freeze({
    uploadDate: "Upload date",
    views: "Views",
    rating: "Rating",
    ratingVotes: "Rating votes",
    duration: "Duration",
    title: "Title"
  });

  function normalizeMode(value) {
    return value === "local" ? "local" : "native";
  }

  function normalizeCollapsed(value) {
    return value === true;
  }

  function updatedLabel(timestamp, now = Date.now()) {
    if (!timestamp) return null;
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 60) return "Updated just now";
    if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
    return `Updated ${Math.floor(seconds / 3600)}h ago`;
  }

  function deriveState(raw = {}) {
    const mode = normalizeMode(raw.mode);
    const collapsed = normalizeCollapsed(raw.collapsed);
    const catalogue = raw.catalogue ?? {};
    const filterCount = Number.isInteger(raw.filterCount) && raw.filterCount > 0 ? raw.filterCount : 0;
    const hasCatalogue = catalogue.hasCatalogue === true;
    const canFilter = raw.canFilter === true;
    const canSort = raw.canSort === true;
    const queueOpen = raw.queueOpen === true;

    return {
      mode,
      collapsed,
      hasCatalogue,
      canFilter,
      canSort,
      queueOpen,
      filterCount,
      showLocalControls: !collapsed && mode === "local",
      showNativeControls: !collapsed && mode === "native",
      collapsedLabel: mode === "local" && filterCount > 0
        ? `LOCAL · ${filterCount} FILTERS`
        : mode.toUpperCase(),
      statusText: catalogue.scanStatus === "running"
        ? `Scanning page ${catalogue.currentPage ?? catalogue.nextPage ?? 1}${catalogue.discoveredPageCount ? ` of ${catalogue.discoveredPageCount}` : ""}`
        : catalogue.availability === "partial"
        ? `${catalogue.indexedCount ?? 0} indexed · Scan can resume`
        : hasCatalogue
        ? `${catalogue.indexedCount ?? 0} indexed${updatedLabel(catalogue.lastFullScanAt) ? ` · ${updatedLabel(catalogue.lastFullScanAt)}` : ""}`
        : "No local catalogue yet"
    };
  }

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = String(text);
    }
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", name === "settings" ? "r34mf-settings-icon" : "r34mf-chevron");
    svg.setAttribute("viewBox", name === "settings" ? "0 0 24 24" : "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (name === "settings") {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M10.2 2.7h3.6l.5 2.1c.5.2 1 .5 1.5.9l2-.6 1.8 3.1-1.5 1.5c.1.3.1.7.1 1s0 .7-.1 1l1.5 1.5-1.8 3.1-2-.6c-.5.4-1 .7-1.5.9l-.5 2.1h-3.6l-.5-2.1c-.5-.2-1-.5-1.5-.9l-2 .6-1.8-3.1 1.5-1.5a8 8 0 0 1 0-2L4.4 8.2l1.8-3.1 2 .6c.5-.4 1-.7 1.5-.9l.5-2.1ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z");
      svg.append(path);
    } else {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const outer = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const inner = document.createElementNS("http://www.w3.org/2000/svg", "path");
      outer.setAttribute("class", "r34mf-chevron-outer");
      outer.setAttribute("d", "m2 10 6-6 6 6");
      inner.setAttribute("class", "r34mf-chevron-inner");
      inner.setAttribute("d", "m4.8 11 3.2-3.2 3.2 3.2");
      group.append(outer, inner);
      svg.append(group);
    }
    return svg;
  }

  function control(label, action, options = {}) {
    const button = element("button", ["r34mf-control", options.className, options.selected ? "is-selected" : ""].filter(Boolean).join(" "), label);
    button.type = "button";
    button.dataset.r34mfAction = action;
    if (typeof options.selected === "boolean") {
      button.setAttribute("aria-pressed", String(options.selected));
    }
    if (typeof options.expanded === "boolean") {
      button.setAttribute("aria-expanded", String(options.expanded));
    }
    if (options.controls) {
      button.setAttribute("aria-controls", options.controls);
    }
    button.disabled = options.disabled === true;
    return button;
  }

  function render(rawState) {
    const state = deriveState(rawState);
    const shell = element("section", `r34mf-shell${state.collapsed ? " is-collapsed" : ""}`);
    shell.dataset.r34mfOwned = "true";
    shell.setAttribute("aria-label", "Subscription filter");

    const toggle = element("button", "r34mf-shell-toggle");
    toggle.type = "button";
    toggle.dataset.r34mfAction = "toggle-collapse";
    toggle.setAttribute("aria-expanded", String(!state.collapsed));
    toggle.append(
      element("span", "r34mf-shell-title", TITLE),
      element("span", "r34mf-shell-summary", state.collapsedLabel),
      icon("chevron")
    );
    if (state.collapsed) {
      toggle.querySelector(".r34mf-chevron g").setAttribute("transform", "rotate(180 8 8)");
    }
    shell.append(toggle);

    const body = element("div", "r34mf-shell-body");
    body.hidden = state.collapsed;
    const modeGroup = element("div", "r34mf-mode-group");
    const modeControls = element("div", "r34mf-mode-controls");
    modeControls.setAttribute("role", "group");
    modeControls.setAttribute("aria-label", "Catalogue mode");
    modeControls.append(
      control("Native", "set-native", { selected: state.mode === "native" }),
      control("Local", "set-local", { selected: state.mode === "local" })
    );
    modeGroup.append(element("span", "r34mf-field-label", "MODE"), modeControls);
    body.append(modeGroup);

    if (state.showLocalControls) {
      const localTools = element("div", "r34mf-local-tools");
      localTools.setAttribute("aria-label", "Local catalogue tools");
      const sortField = SORT_LABELS[rawState.sort?.field] ?? SORT_LABELS.uploadDate;
      const sortDirection = rawState.sort?.direction === "asc" ? "asc" : "desc";
      const sortControl = control(`Sort: ${sortField}`, "sort", {
        className: `r34mf-sort-control is-sort-${sortDirection}`,
        disabled: !state.canSort
      });
      sortControl.setAttribute("aria-label", `Sort: ${sortField}, ${sortDirection === "asc" ? "ascending" : "descending"}`);
      localTools.append(
        control("Filters", "filters", { disabled: !state.canFilter }),
        sortControl
      );
      body.append(localTools);
      const chips = [];
      for (const [source, fields] of [["quick", rawState.filters?.quick ?? {}], ["detailed", rawState.filters?.detailed ?? {}]]) {
        for (const [field, value] of Object.entries(fields)) if (value?.enabled === true) chips.push([source, field, ({ title: "Title", duration: "Duration", views: "Views", rating: "Rating", ratingVotes: "Rating votes", hdAvailable: "HD", uploadDate: "Upload date", artist: "Artist", uploader: "Uploader", tags: "Tags", categories: "Categories", subscriptionsOnly: "Subscriptions only" })[field] ?? field]);
      }
      if (rawState.filters?.advanced?.enabled && rawState.filters.advanced.items?.length) chips.push(["advanced", "advanced", "Advanced"]);
      if (chips.length) { const chipHost = element("div", "r34mf-active-filter-chips"); chipHost.setAttribute("aria-label", "Active filters"); chips.forEach(([source, field, text]) => chipHost.append(control(`${text} ×`, `filter-chip-remove:${source}:${field}`, { className: "r34mf-filter-chip" }))); body.append(chipHost); }
    }

    const footer = element("div", "r34mf-shell-footer");
    const statusArea = element("div", "r34mf-status-area");
    if (state.showLocalControls && state.hasCatalogue && rawState.localRendererActive === true) {
      const showing = element("span", "r34mf-showing");
      showing.append(
        "Showing ",
        element("strong", "", rawState.showingCount ?? 0),
        " of ",
        element("strong", "", rawState.catalogue?.indexedCount ?? 0)
      );
      statusArea.append(showing);
    }
    statusArea.append(element("span", "r34mf-status", state.statusText));
    const actions = element("div", "r34mf-actions");
    const settings = element("button", "r34mf-icon-control");
    settings.type = "button";
    settings.dataset.r34mfAction = "settings";
    settings.disabled = true;
    settings.setAttribute("aria-label", "Open settings");
    settings.title = "Settings";
    settings.append(icon("settings"));
    actions.append(control("Queue", "queue", {
      className: "r34mf-queue-control",
      expanded: state.queueOpen,
      controls: "r34mf-queue-panel"
    }), settings);
    footer.append(statusArea, actions);
    body.append(footer);
    shell.append(body);
    return shell;
  }

  function mount(root, state, onIntent) {
    root.dataset.r34mfOwned = "true";
    root.dataset.r34mfShellBound = "true";
    update(root, state);
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-r34mf-action]");
      if (!button || !root.contains(button) || button.closest(".r34mf-queue-host") || button.disabled) {
        return;
      }

      const action = button.dataset.r34mfAction;
      root.dispatchEvent(new CustomEvent("r34mf:intent", {
        bubbles: true,
        detail: { action }
      }));
      onIntent?.(action, button);
    });
    return root;
  }

  function update(root, state) {
    const next = render(state);
    const current = root.querySelector(":scope > .r34mf-shell");
    if (current) current.replaceWith(next);
    else root.prepend(next);
  }

  function isOwned(node) {
    return node?.nodeType === Node.ELEMENT_NODE
      && (node.dataset?.r34mfOwned === "true" || Boolean(node.closest?.("[data-r34mf-owned='true']")));
  }

  app.modules.shell = Object.freeze({
    TITLE,
    SORT_LABELS,
    deriveState,
    normalizeMode,
    normalizeCollapsed,
    updatedLabel,
    render,
    mount,
    update,
    isOwned
  });
})();
