(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.settingsUi;
  if (!app || !base) throw new Error("R34MF Settings UI must load before final Settings layout follow-up.");

  let observer = null;
  let decorateQueued = false;

  function setTextIfChanged(node, value) {
    if (!node) return false;
    const wanted = String(value);
    if (node.textContent === wanted) return false;
    node.textContent = wanted;
    return true;
  }

  function findPage(dialog, title) {
    return [...dialog?.querySelectorAll?.(".r34mf-settings-page") ?? []]
      .find((node) => node.querySelector(":scope > h3")?.textContent.trim() === title) ?? null;
  }

  function findSection(dialog, pageTitle, sectionTitle) {
    const page = findPage(dialog, pageTitle);
    return [...page?.querySelectorAll?.(".r34mf-settings-section") ?? []]
      .find((node) => node.querySelector(":scope > .r34mf-settings-section-title")?.textContent.trim() === sectionTitle) ?? null;
  }

  function findRow(section, title) {
    return [...section?.querySelectorAll?.(".r34mf-settings-row") ?? []]
      .find((node) => node.querySelector(".r34mf-settings-copy > strong")?.textContent.trim() === title) ?? null;
  }

  function marker(section, key, attr) {
    if (!section || section.querySelector(`[${attr}='${key}']`)) return null;
    const node = document.createElement("span");
    node.hidden = true;
    node.dataset.r34mfSettingsLayoutMarker = key;
    node.setAttribute(attr, key);
    section.append(node);
    return node;
  }

  function ensureOtherSection(dialog) {
    const page = findPage(dialog, "Local display");
    if (!page) return null;
    let section = findSection(dialog, "Local display", "Other");
    if (section) return section;
    section = document.createElement("section");
    section.className = "r34mf-settings-section r34mf-settings-other-section";
    const title = document.createElement("h4");
    title.className = "r34mf-settings-section-title";
    title.textContent = "Other";
    const list = document.createElement("div");
    list.className = "r34mf-settings-list";
    section.append(title, list);
    page.append(section);
    return section;
  }

  function arrangeLocalDisplay(dialog) {
    const grid = findSection(dialog, "Local display", "Video grid");
    if (!grid) return;
    findRow(grid, "Animated hover previews")?.remove();

    const gridList = grid.querySelector(".r34mf-settings-list");
    let previous = null;
    for (const title of [
      "Videos per page",
      "Video column amount",
      "Thumbnail aspect ratio",
      "Artist label/s on video thumbnails",
      "Artist label text size"
    ]) {
      const row = findRow(grid, title);
      if (!row || !gridList) continue;
      if (!previous) {
        const firstRow = gridList.querySelector(":scope > .r34mf-settings-row");
        if (firstRow !== row) gridList.insertBefore(row, firstRow ?? gridList.firstChild);
      } else if (previous.nextElementSibling !== row) {
        previous.after(row);
      }
      previous = row;
    }

    const other = ensureOtherSection(dialog);
    const otherList = other?.querySelector(".r34mf-settings-list");
    const playerRows = [...dialog.querySelectorAll("[data-r34mf-settings-followup='improvedPlayerPlaybackControls']")]
      .filter((node) => node.classList?.contains("r34mf-settings-row"));
    if (playerRows.length && otherList) {
      if (playerRows[0].parentElement !== otherList) otherList.append(playerRows[0]);
      playerRows.slice(1).forEach((node) => node.remove());
      // The older decorator only checks Video grid for this marker. Leave a hidden
      // marker there so moving the real row to Other cannot trigger duplicate rows.
      marker(gridList, "improvedPlayerPlaybackControls", "data-r34mf-settings-followup");
    }
  }

  function arrangeRecentUpdate(dialog) {
    const queue = findSection(dialog, "Scanning & queue", "Queue");
    const requestBehavior = findSection(dialog, "Scanning & queue", "Request behavior");
    const queueList = queue?.querySelector(".r34mf-settings-list");
    const recentPages = queue?.querySelector("[data-r34mf-settings-p2='recentUpdatePageLimit']") ?? null;
    const frequencyRows = [...dialog.querySelectorAll("[data-r34mf-settings-p2='autoUpdateRecentVideosFrequency']")]
      .filter((node) => node.classList?.contains("r34mf-settings-row"));
    if (frequencyRows.length && queueList) {
      const frequency = frequencyRows[0];
      if (recentPages) {
        if (recentPages.nextElementSibling !== frequency) recentPages.after(frequency);
      } else if (frequency.parentElement !== queueList) {
        queueList.append(frequency);
      }
      frequencyRows.slice(1).forEach((node) => node.remove());
      // The Part 2 decorator checks Request behavior before creating its row.
      marker(requestBehavior?.querySelector(".r34mf-settings-list"), "autoUpdateRecentVideosFrequency", "data-r34mf-settings-p2");
    }

    const automatic = findRow(requestBehavior, "Auto-update recent videos");
    // IMPORTANT: keep this identical to settings-p2-ui.js. These Settings layers
    // observe the same dialog; competing text values can otherwise trigger an
    // endless MutationObserver ping-pong and lock the page.
    setTextIfChanged(
      automatic?.querySelector(".r34mf-settings-copy > small"),
      "Automatically run Recent Update using the schedule below. Each successful run scans the configured newest subscription pages from page 1."
    );
  }

  function decorate() {
    if (!base.isOpen()) return;
    const dialog = document.querySelector(".r34mf-settings-dialog");
    if (!dialog) return;
    arrangeLocalDisplay(dialog);
    arrangeRecentUpdate(dialog);
  }

  function scheduleDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    queueMicrotask(() => {
      decorateQueued = false;
      decorate();
    });
  }

  function mutationReplacedSettingsDialog(mutations) {
    for (const mutation of mutations ?? []) {
      for (const node of mutation.addedNodes ?? []) {
        if (node?.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.(".r34mf-settings-dialog") || node.querySelector?.(".r34mf-settings-dialog")) return true;
      }
    }
    return false;
  }

  const originalOpen = base.open;
  const originalClose = base.close;

  async function open(args) {
    const layer = await originalOpen(args);
    observer?.disconnect();
    observer = null;
    decorateQueued = false;
    if (layer) {
      // Base Settings replaces the whole dialog when tabs/controls redraw. Only
      // react to that replacement; do not observe our own row moves/text edits.
      observer = new MutationObserver((mutations) => {
        if (mutationReplacedSettingsDialog(mutations)) scheduleDecorate();
      });
      observer.observe(layer, { childList: true, subtree: true });
      scheduleDecorate();
    }
    return layer;
  }

  function close(args) {
    observer?.disconnect();
    observer = null;
    decorateQueued = false;
    return originalClose(args);
  }

  app.modules.settingsUi = Object.freeze({
    ...base,
    open,
    close,
    decorateFinalLayout: decorate,
    arrangeLocalDisplay,
    arrangeRecentUpdate
  });
})();
