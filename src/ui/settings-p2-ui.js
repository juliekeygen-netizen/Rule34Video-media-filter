(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.settingsUi;
  const bridge = app?.modules.settingsDraftBridge;
  if (!app || !base || !bridge) throw new Error("R34MF Settings UI and draft bridge must load before Part 2 Settings additions.");

  let observer = null;
  let decorateQueued = false;

  function setTextIfChanged(node, value) {
    if (!node) return false;
    const wanted = String(value);
    if (node.textContent === wanted) return false;
    node.textContent = wanted;
    return true;
  }

  function scheduleDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    queueMicrotask(() => {
      decorateQueued = false;
      decorate();
    });
  }

  function findSection(dialog, pageTitle, sectionTitle) {
    const page = [...dialog.querySelectorAll(".r34mf-settings-page")].find((node) => node.querySelector(":scope > h3")?.textContent.trim() === pageTitle);
    return [...page?.querySelectorAll?.(".r34mf-settings-section") ?? []].find((node) => node.querySelector(":scope > .r34mf-settings-section-title")?.textContent.trim() === sectionTitle) ?? null;
  }

  function refreshFooter() {
    const dialog = document.querySelector(".r34mf-settings-dialog");
    if (!dialog) return;
    const dirty = base.isDirty();
    const status = dialog.querySelector(".r34mf-settings-footer-status");
    if (status) {
      setTextIfChanged(status, dirty ? "Unsaved changes" : "All changes saved");
      status.classList.toggle("is-dirty", dirty);
    }
    const save = [...dialog.querySelectorAll("button")].find((node) => node.textContent.trim() === "Save changes");
    if (save && !dialog.querySelector(".r34mf-settings-confirm-layer")) save.disabled = !dirty;
  }

  function syncArtistSizeDisabled(dialog = document.querySelector(".r34mf-settings-dialog")) {
    if (!dialog) return;
    base.normalizedDraft();
    const draft = bridge.current();
    const size = dialog.querySelector("[data-r34mf-settings-p2='artistThumbnailLabelSize'] select");
    if (size) size.disabled = draft?.artistThumbnailLabels === false;
  }

  function syncAutoUpdateFrequencyDisabled(dialog = document.querySelector(".r34mf-settings-dialog")) {
    if (!dialog) return;
    base.normalizedDraft();
    const draft = bridge.current();
    const frequency = dialog.querySelector("[data-r34mf-settings-p2='autoUpdateRecentVideosFrequency'] select");
    if (frequency) frequency.disabled = draft?.autoUpdateRecentVideos !== true;
  }

  function customSwitch(key, label) {
    base.normalizedDraft();
    const draft = bridge.current();
    const button = document.createElement("button");
    button.className = "r34mf-settings-switch";
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-checked", String(draft?.[key] === true));
    button.addEventListener("click", () => {
      base.normalizedDraft();
      const liveDraft = bridge.current();
      if (!liveDraft) return;
      liveDraft[key] = liveDraft[key] !== true;
      button.setAttribute("aria-checked", String(liveDraft[key] === true));
      if (key === "artistThumbnailLabels") syncArtistSizeDisabled();
      if (key === "autoUpdateRecentVideos") syncAutoUpdateFrequencyDisabled();
      refreshFooter();
    });
    return button;
  }

  function customSelect(key, label, choices) {
    base.normalizedDraft();
    const draft = bridge.current();
    const select = document.createElement("select");
    select.className = "r34mf-settings-select";
    select.setAttribute("aria-label", label);
    for (const [value, text] of choices) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = text;
      option.selected = String(draft?.[key] ?? "") === String(value);
      select.append(option);
    }
    select.addEventListener("change", () => {
      base.normalizedDraft();
      const liveDraft = bridge.current();
      if (!liveDraft) return;
      const numeric = /^\d+$/.test(select.value) ? Number(select.value) : null;
      liveDraft[key] = numeric ?? select.value;
      refreshFooter();
    });
    return select;
  }

  function rowWithControl(key, title, description, control) {
    const node = document.createElement("div");
    node.className = "r34mf-settings-row r34mf-settings-p2-row";
    node.dataset.r34mfSettingsP2 = key;
    const copy = document.createElement("div");
    copy.className = "r34mf-settings-copy";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const small = document.createElement("small");
    small.textContent = description;
    copy.append(strong, small);
    node.append(copy, control);
    return node;
  }

  function row(key, title, description) {
    return rowWithControl(key, title, description, customSwitch(key, title));
  }

  function findSettingsRow(section, title) {
    return [...section?.querySelectorAll?.(".r34mf-settings-row") ?? []]
      .find((node) => node.querySelector(".r34mf-settings-copy > strong")?.textContent.trim() === title) ?? null;
  }

  function rewriteBaseLabels(dialog) {
    const display = findSection(dialog, "Local display", "Video grid");
    const videosPerPage = findSettingsRow(display, "Videos per page");
    const defaultPage = [...videosPerPage?.querySelectorAll?.("option") ?? []].find((option) => option.value === "24");
    setTextIfChanged(defaultPage, "24 — Default");
    const pageDescription = videosPerPage?.querySelector(".r34mf-settings-copy > small");
    setTextIfChanged(pageDescription, "24 is the default Local page size.");

    const requestBehavior = findSection(dialog, "Scanning & queue", "Request behavior");
    const autoRecent = findSettingsRow(requestBehavior, "Auto-update recent videos");
    const autoRecentDescription = autoRecent?.querySelector(".r34mf-settings-copy > small");
    setTextIfChanged(autoRecentDescription, "Automatically run Recent Update using the schedule below. Each successful run scans the configured newest subscription pages from page 1.");

    const advanced = findSection(dialog, "Advanced", "Network & recovery");
    const threshold = findSettingsRow(advanced, "Known-content stop threshold");
    if (threshold) {
      const title = threshold.querySelector(".r34mf-settings-copy > strong");
      const description = threshold.querySelector(".r34mf-settings-copy > small");
      setTextIfChanged(title, "Smart Update known-page threshold");
      setTextIfChanged(description, "Consecutive known pages full Smart Update uses as ordered-overlap evidence before it may stop. (pages)");
      threshold.querySelector("input")?.setAttribute("aria-label", "Smart Update known-page threshold");
    }
  }

  function decorate() {
    if (!base.isOpen()) return;
    const dialog = document.querySelector(".r34mf-settings-dialog");
    if (!dialog) return;
    base.normalizedDraft();
    rewriteBaseLabels(dialog);

    const queue = findSection(dialog, "Scanning & queue", "Queue");
    const queueList = queue?.querySelector(".r34mf-settings-list");
    if (queueList && !queue.querySelector("[data-r34mf-settings-p2='recentUpdatePageLimit']")) {
      const choices = Array.from({ length: 20 }, (_, index) => {
        const value = index + 1;
        return [value, value === 3 ? "3 — Default" : String(value)];
      });
      const recentRow = rowWithControl(
        "recentUpdatePageLimit",
        "Recent Update pages",
        "How many newest subscription pages Recent Update scans from page 1 on every run.",
        customSelect("recentUpdatePageLimit", "Recent Update pages", choices)
      );
      const detailRequests = findSettingsRow(queue, "Concurrent detail requests");
      detailRequests?.after(recentRow);
      if (!detailRequests) queueList.append(recentRow);
    }

    const requestBehavior = findSection(dialog, "Scanning & queue", "Request behavior");
    const requestBehaviorList = requestBehavior?.querySelector(".r34mf-settings-list");
    if (requestBehaviorList && !requestBehavior.querySelector("[data-r34mf-settings-p2='autoUpdateRecentVideosFrequency']")) {
      const frequencyControl = customSelect(
        "autoUpdateRecentVideosFrequency",
        "Auto-update frequency",
        [
          ["session", "Once per browser session — Current"],
          ["1h", "Every 1 hour"],
          ["3h", "Every 3 hours"],
          ["6h", "Every 6 hours"],
          ["12h", "Every 12 hours"],
          ["24h", "Every 24 hours"]
        ]
      );
      const frequencyRow = rowWithControl(
        "autoUpdateRecentVideosFrequency",
        "Auto-update frequency",
        "Choose the minimum time between successful automatic Recent Updates. Hour-based schedules only run while My Subscriptions is open and visible; missed intervals run on the next eligible visit.",
        frequencyControl
      );
      const autoRecent = findSettingsRow(requestBehavior, "Auto-update recent videos");
      autoRecent?.after(frequencyRow);
      if (!autoRecent) requestBehaviorList.append(frequencyRow);
    }

    const display = findSection(dialog, "Local display", "Video grid");
    const displayList = display?.querySelector(".r34mf-settings-list");
    if (displayList && !display.querySelector("[data-r34mf-settings-p2='artistThumbnailLabels']")) {
      displayList.append(row(
        "artistThumbnailLabels",
        "Artist label/s on video thumbnails",
        "Show detailed Artist metadata as compact labels in the top-left of Local thumbnails."
      ));
    }
    if (displayList && !display.querySelector("[data-r34mf-settings-p2='artistThumbnailLabelSize']")) {
      displayList.append(rowWithControl(
        "artistThumbnailLabelSize",
        "Artist label text size",
        "Choose the text size used by Artist labels. Larger labels may fit fewer artists on one thumbnail row.",
        customSelect("artistThumbnailLabelSize", "Artist label text size", [
          ["small", "Small"],
          ["medium", "Medium — Default"],
          ["big", "Big"]
        ])
      ));
    }

    const advanced = findSection(dialog, "Advanced", "Automatic sign-in");
    if (advanced && !advanced.querySelector("[data-r34mf-settings-p2='openSubscriptionsAfterAutomaticSignIn']")) {
      advanced.querySelector(".r34mf-settings-list")?.append(row(
        "openSubscriptionsAfterAutomaticSignIn",
        "Open my subscriptions on automatic sign in",
        "Return this tab to My Subscriptions after automatic sign-in when it was previously there."
      ));
    }
    syncAutoUpdateFrequencyDisabled(dialog);
    syncArtistSizeDisabled(dialog);
    refreshFooter();
  }

  const originalOpen = base.open;
  const originalClose = base.close;

  async function open(args) {
    const layer = await originalOpen(args);
    observer?.disconnect();
    observer = null;
    decorateQueued = false;
    if (layer) {
      observer = new MutationObserver(scheduleDecorate);
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

  app.modules.settingsUi = Object.freeze({ ...base, open, close, decoratePart2: decorate });
})();