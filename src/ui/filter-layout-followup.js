(() => {
  "use strict";

  const app = globalThis.R34MF;
  const baseFiltersUi = app?.modules.filtersUi;
  const baseShell = app?.modules.shell;
  if (!app || !baseFiltersUi || !baseShell) {
    throw new Error("R34MF Filters UI and shell must load before the filter layout follow-up.");
  }

  const CHIP_LABELS = Object.freeze({
    title: "Title",
    duration: "Duration",
    views: "Views",
    rating: "Rating",
    ratingVotes: "Rating votes",
    favorited: "Favorited",
    hideSeenVideos: "Hide seen videos",
    uploadDate: "Upload date",
    artist: "Artist",
    uploader: "Uploader",
    categories: "Categories",
    tags: "Tags",
    subscriptionsOnly: "Subscriptions only",
    advanced: "Advanced"
  });

  function decorateFilterParent(host) {
    const detailed = host?.querySelector?.(".r34mf-filter-column-detailed");
    if (!detailed) return host;

    // Advanced is part of Detailed metadata now. Remove the obsolete third
    // section heading while leaving the Advanced row directly after
    // Subscriptions only in the same column on desktop and mobile.
    for (const heading of detailed.querySelectorAll?.(".r34mf-filter-section") ?? []) {
      if ((heading.textContent ?? "").trim().toUpperCase() === "ADVANCED") heading.remove();
    }
    return host;
  }

  function decorateSortControl(shell, state = {}) {
    const sortControl = shell?.querySelector?.("[data-r34mf-action='sort']");
    if (!sortControl) return sortControl;

    const renderedText = String(sortControl.textContent ?? "").trim();
    const existingDirection = sortControl.classList.contains("is-sort-asc") ? "asc"
      : sortControl.classList.contains("is-sort-desc") ? "desc"
        : renderedText.endsWith("↑") ? "asc" : "desc";
    const direction = state?.sort?.direction === "asc" || state?.sort?.direction === "desc"
      ? state.sort.direction
      : existingDirection;
    const label = renderedText.replace(/\s+[↑↓]\s*$/, "").trim();

    // Direction belongs to the right-side chevron instead of a second text
    // arrow beside the label. This remains defensive for older rendered shells,
    // while the base shell now emits the final label/classes directly.
    sortControl.textContent = label;
    sortControl.classList.toggle("is-sort-asc", direction === "asc");
    sortControl.classList.toggle("is-sort-desc", direction !== "asc");
    sortControl.setAttribute("aria-label", `${label}, ${direction === "asc" ? "ascending" : "descending"}`);
    return sortControl;
  }

  function decorateShell(shell, state = {}) {
    if (!shell) return shell;
    const title = shell.querySelector?.(".r34mf-shell-title");
    if (title) title.textContent = "SUBSCRIPTION FILTER";
    shell.setAttribute?.("aria-label", "Subscription filter");
    decorateSortControl(shell, state);

    for (const chip of shell.querySelectorAll?.(".r34mf-filter-chip") ?? []) {
      const action = chip.dataset?.r34mfAction ?? "";
      const parts = action.split(":");
      const field = parts[2] ?? "";
      const label = parts[1] === "advanced" ? CHIP_LABELS.advanced : CHIP_LABELS[field];
      if (label) chip.textContent = `${label} ×`;
    }
    return shell;
  }

  function chipContextAction(action) {
    const [kind, source, field] = String(action ?? "").split(":");
    if (kind !== "filter-chip-remove") return null;
    if (source === "advanced") return "advanced";
    if (!["quick", "detailed"].includes(source)) return null;
    if (["favorited", "hideSeenVideos", "hdAvailable"].includes(field)) return null;
    return `edit:${source}:${field}`;
  }

  function bindChipContext(root, onIntent) {
    if (!root || root.dataset.r34mfFilterChipContextBound === "true") return;
    root.dataset.r34mfFilterChipContextBound = "true";
    root.addEventListener("contextmenu", (event) => {
      const chip = event.target.closest?.(".r34mf-filter-chip[data-r34mf-action^='filter-chip-remove:']");
      if (!chip || !root.contains(chip)) return;
      event.preventDefault();
      event.stopPropagation();
      const action = chipContextAction(chip.dataset.r34mfAction);
      if (action) onIntent?.(action, chip);
    });
  }

  const filtersUi = Object.freeze({
    ...baseFiltersUi,
    render(...args) {
      return decorateFilterParent(baseFiltersUi.render(...args));
    }
  });

  const shell = Object.freeze({
    ...baseShell,
    TITLE: "SUBSCRIPTION FILTER",
    render(state) {
      return decorateShell(baseShell.render(state), state);
    },
    mount(root, state, onIntent) {
      const mounted = baseShell.mount(root, state, onIntent);
      decorateShell(mounted.querySelector?.(":scope > .r34mf-shell"), state);
      bindChipContext(root, onIntent);
      return mounted;
    },
    update(root, state) {
      baseShell.update(root, state);
      decorateShell(root.querySelector?.(":scope > .r34mf-shell"), state);
    }
  });

  app.modules.filtersUi = filtersUi;
  app.modules.shell = shell;
  app.modules.filterLayoutFollowup = Object.freeze({
    CHIP_LABELS,
    decorateFilterParent,
    decorateSortControl,
    decorateShell,
    chipContextAction
  });
})();
