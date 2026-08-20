(() => {
  "use strict";

  const app = globalThis.R34MF;
  const viewModels = app?.modules.queueViewModel;
  if (!app || !viewModels) throw new Error("R34MF Queue view model must load before Queue UI.");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function actionButton(label, action, options = {}) {
    const button = el("button", `r34mf-queue-button${options.primary ? " is-primary" : ""}${options.quiet ? " is-quiet" : ""}`, label);
    button.type = "button";
    button.dataset.r34mfAction = action;
    button.disabled = options.disabled === true;
    return button;
  }

  function arrow() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "r34mf-queue-arrow");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m6 3 5 5-5 5");
    svg.append(path);
    return svg;
  }

  function heading(title) {
    const header = el("header", "r34mf-queue-child-header");
    const button = el("button", "r34mf-queue-breadcrumb");
    button.type = "button";
    button.dataset.r34mfAction = "queue-back";
    button.setAttribute("aria-label", "Back to Queue");
    const backArrow = arrow();
    backArrow.classList.add("r34mf-queue-back-arrow");
    button.append(backArrow, el("span", "", "Queue"));
    header.append(button, el("h2", "r34mf-queue-title", title));
    return header;
  }

  function sectionLabel(label) { return el("h3", "r34mf-queue-section-label", label); }

  function footer(...buttons) {
    const node = el("footer", "r34mf-queue-footer");
    node.append(...buttons);
    return node;
  }

  function failureLabel(code) { return ({ "network-error": "Network error", "authentication-required": "Authentication", "unexpected-detail-structure": "Unexpected structure", "video-id-mismatch": "Identity mismatch", "detail-parse-failed": "Parser failure", "invalid-video-url": "Invalid video URL" })[code] ?? String(code ?? "Unknown failure").replace(/^detail-/, "").replace(/-/g, " ").replace(/^./, (value) => value.toUpperCase()); }
  function canaryFailureRows(canary) {
    const counts = new Map();
    for (const sample of canary?.samples ?? []) if (!sample.ok) { const label = Number(sample.httpStatus) ? `HTTP ${Number(sample.httpStatus)}` : failureLabel(sample.code); counts.set(label, (counts.get(label) ?? 0) + 1); }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function queueRow({ title, subtitle, status = "", action = null, navigable = false, className = "" }) {
    const button = el("button", `r34mf-queue-row${className ? ` ${className}` : ""}`);
    button.type = "button";
    button.disabled = !navigable;
    if (action && navigable) button.dataset.r34mfAction = action;
    const copy = el("span", "r34mf-queue-row-copy");
    copy.append(el("strong", "", title), el("small", "", subtitle));
    const right = el("span", "r34mf-queue-row-right");
    if (status) right.append(el("small", `r34mf-queue-row-status is-${status.toLowerCase().replace(/\s+/g, "-")}`, status));
    if (navigable) right.append(arrow());
    button.append(copy, right);
    return button;
  }

  function operationRow(row) {
    return queueRow({
      title: row.title,
      subtitle: row.subtitle,
      status: row.status,
      action: `queue-${row.id}`,
      navigable: row.navigable
    });
  }

  function progressBar(value) {
    const progress = el("div", "r34mf-queue-progress");
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    if (value !== null) {
      progress.setAttribute("aria-valuenow", String(value));
      progress.append(el("span", "", ""));
      progress.firstChild.style.width = `${value}%`;
    } else progress.setAttribute("aria-valuetext", "Progress is being calculated");
    return progress;
  }

  function root(model) {
    const panel = el("section", "r34mf-queue-panel");
    const header = el("header", "r34mf-queue-root-header");
    header.append(el("h2", "r34mf-queue-title", "QUEUE"), el("span", "r34mf-queue-header-status", model.headerStatus));
    panel.append(header, sectionLabel("OPERATIONS"));
    const operations = el("div", "r34mf-queue-operations");
    (model.hasCatalogue ? model.operations : model.operations.slice(0, 1)).forEach((row) => operations.append(operationRow(row)));
    panel.append(operations);
    if (!model.hasCatalogue && !model.scanRunning && !model.resumable) panel.append(el("p", "r34mf-queue-empty-note", "Detailed metadata and maintenance become available after videos have been indexed."));
    if (model.active.length || model.waiting.length) {
      panel.append(sectionLabel("CURRENT QUEUE"));
      const jobs = el("div", "r34mf-current-queue");
      model.active.forEach((job) => {
        const row = el("button", "r34mf-queue-job is-active");
        row.type = "button";
        row.dataset.r34mfAction = job.action;
        const percentage = job.total ? Math.round(job.completed / job.total * 100) : null;
        const meta = job.destination === "details"
          ? job.phase === "canary" ? `${job.canaryVerified} / ${job.canaryRequired} verified · ${job.failedCount.toLocaleString()} failed` : `${job.runCompleted.toLocaleString()} completed this run · ${job.detailedCount.toLocaleString()} total detailed${percentage !== null ? ` · ${percentage}%` : ""}`
          : job.kind === "smart-update" ? `${job.pagesChecked} pages checked · ${job.newVideos.toLocaleString()} new · overlap ${job.knownStreak}/${job.knownThreshold}` : `${job.indexedCount.toLocaleString()} indexed${percentage !== null ? ` · ${percentage}%` : ""}`;
        const phaseLabel = job.phase === "preflight" ? "PREFLIGHT" : job.phase === "canary" ? "CANARY" : "RUNNING";
        row.append(el("strong", "", job.title), el("small", "", `${phaseLabel} · ${job.scope}`), progressBar(percentage), el("small", "", `${meta}${viewModels.elapsed(job.startedAt) ? ` · ${viewModels.elapsed(job.startedAt)}` : ""}`));
        jobs.append(row);
      });
      model.waiting.forEach((job) => {
        const row = el("button", "r34mf-queue-job");
        row.type = "button";
        row.dataset.r34mfAction = job.action ?? "queue-details";
        row.append(el("span", "r34mf-queue-position", job.position), el("span", "r34mf-queue-job-copy", job.title), el("small", "", job.scope), arrow());
        jobs.append(row);
      });
      panel.append(jobs);
    } else if (model.hasCatalogue) panel.append(el("p", "r34mf-queue-empty-note", "No jobs running or waiting."));
    if (model.recent.length) {
      panel.append(sectionLabel("RECENT"));
      const recent = el("div", "r34mf-queue-recent");
      model.recent.forEach((entry) => recent.append(el("div", "", `${entry.title} · ${entry.displayStatus}`)));
      panel.append(recent);
    }
    return panel;
  }

  function catalogue(model) {
    const panel = el("section", "r34mf-queue-panel r34mf-queue-child");
    panel.append(heading("CATALOGUE"));
    const state = model.catalogue;
    if (model.scanRunning) {
      const activeKind = model.catalogueActive?.title;
      panel.append(el("h3", "r34mf-queue-lead", activeKind ?? (state.scanKind === "full-rescan" ? "Full catalogue rescan" : state.scanKind === "smart-update" ? "Smart Update" : "Scan subscriptions")));
      const progress = el("div", "r34mf-queue-scan-progress");
      const status = el("div", "r34mf-queue-running");
      const smart = state.smartUpdate ?? {};
      const page = state.scanKind === "smart-update" ? smart.currentPage ?? smart.nextPage : state.currentPage ?? state.nextPage;
      const hasPage = Number(page) > 0;
      const pageTotal = state.scanKind === "smart-update" ? smart.nativePageCount ?? state.discoveredPageCount : state.discoveredPageCount;
      status.append(el("small", "", hasPage ? "RUNNING" : "STARTING"), el("small", "", hasPage ? `Page ${page}${pageTotal ? ` of ${pageTotal}` : ""}` : "Preparing subscription scan…"));
      progress.append(status, progressBar(model.progress));
      if (state.scanKind === "smart-update") progress.append(el("p", "r34mf-queue-copy", `${Number(smart.pagesChecked ?? 0).toLocaleString()} pages checked · ${Number(smart.newVideos ?? 0).toLocaleString()} new videos`), el("p", "r34mf-queue-meta", `Known overlap ${Number(smart.consecutiveKnownPages ?? 0)} / ${Number(smart.knownOverlapThreshold ?? 3)}`));
      progress.append(el("p", "r34mf-queue-meta", `${model.indexedCount.toLocaleString()} videos indexed${model.elapsed ? ` · ${model.elapsed}` : ""}`));
      panel.append(progress, el("p", "r34mf-queue-copy", "Committed pages are saved as the scan progresses."), footer(actionButton("Stop", "scan-stop", { quiet: true })));
      return panel;
    }
    if (model.resumable) {
      panel.append(el("h3", "r34mf-queue-lead", "Resume subscription scan"), el("p", "r34mf-queue-copy", `${state.pagesCompleted.toLocaleString()}${state.discoveredPageCount ? ` of ${state.discoveredPageCount.toLocaleString()}` : ""} pages scanned. Committed pages will be retained.`));
      if (state.lastError?.message) panel.append(el("p", "r34mf-queue-error", state.lastError.message));
      panel.append(footer(actionButton("Resume scan", "scan-resume", { primary: true })));
      return panel;
    }
    if (!model.hasCatalogue) {
      panel.append(el("h3", "r34mf-queue-lead", "Scan subscriptions"));
      const scale = state.discoveredNativeTotal ? `About ${state.discoveredNativeTotal.toLocaleString()} videos${state.discoveredPageCount ? ` across ${state.discoveredPageCount.toLocaleString()} subscription pages` : ""}.` : "Build a local catalogue from your subscription feed.";
      panel.append(el("p", "r34mf-queue-copy", scale), sectionLabel("THE INITIAL SCAN STORES"), el("p", "r34mf-queue-copy", "Title · Duration · Views · Rating · Upload age · HD · Thumbnail"), el("p", "r34mf-queue-meta", "Artists, uploader, tags, categories and exact dates are fetched through Detailed metadata separately."), footer(actionButton("Start scan", "scan-start", { primary: true })));
      return panel;
    }
    panel.append(sectionLabel("CATALOGUE READY"));
    const summary = el("div", "r34mf-queue-summary");
    summary.append(el("strong", "", `${model.indexedCount.toLocaleString()} videos indexed`));
    if (state.discoveredPageCount) summary.append(el("small", "", `${state.discoveredPageCount.toLocaleString()} subscription pages`));
    if (model.updatedText) summary.append(el("small", "", model.updatedText));
    panel.append(summary, sectionLabel("SMART UPDATE"), el("p", "r34mf-queue-copy", "Checks the newest subscription pages for new or changed videos. Existing detailed metadata is preserved."), footer(actionButton("Start update", "smart-update", { primary: true, disabled: !model.capabilities.smartUpdate })));
    return panel;
  }

  function details(model) {
    const panel = el("section", "r34mf-queue-panel r34mf-queue-child");
    panel.append(heading("DETAILED METADATA"));
    if (!model.hasCatalogue) {
      panel.append(el("p", "r34mf-queue-empty-note", "Detailed metadata is available after the catalogue scan finishes."));
      return panel;
    }
    const state = model.details;
    if (state.status === "Waiting") {
      panel.append(el("h3", "r34mf-queue-lead", "Waiting in queue"), el("p", "r34mf-queue-meta", `Position ${state.position ?? 1} · Missing details · ${model.missingCount.toLocaleString()} videos`), el("p", "r34mf-queue-copy", "Starts automatically when an execution slot becomes free."), footer(actionButton("Remove from queue", "details-remove", { quiet: true })));
      return panel;
    }
    if (state.status === "Running") {
      const active = state.active ?? {};
      const percentage = active.total ? Math.round(active.completed / active.total * 100) : null;
      const phaseLabel = active.phase === "preflight" ? "PREFLIGHT" : active.phase === "canary" ? "CANARY" : "RUNNING";
      const lead = active.phase === "preflight" ? "Checking detail targets" : active.phase === "canary" ? "Verifying Rule34Video details" : "Fetching detailed metadata";
      panel.append(
        el("h3", "r34mf-queue-lead", lead),
        el("p", "r34mf-queue-meta", `${phaseLabel} · ${active.scope ?? "Preparing missing details…"}`),
        progressBar(percentage),
        el("p", "r34mf-queue-copy", active.phase === "canary" ? `${active.canaryVerified} / ${active.canaryRequired} verified · ${Number(active.failedCount ?? 0).toLocaleString()} failed` : active.phase === "bulk" ? `${Number(active.runCompleted ?? 0).toLocaleString()} completed this run · ${Number(active.failedCount ?? 0).toLocaleString()} failed` : "Stored targets are being checked locally."),
        el("p", "r34mf-queue-meta", `${Number(active.detailedCount ?? 0).toLocaleString()} / ${model.indexedCount.toLocaleString()} total catalogue videos detailed${percentage !== null && active.phase === "bulk" ? ` · ${percentage}% run progress` : ""}${viewModels.elapsed(active.startedAt) ? ` · ${viewModels.elapsed(active.startedAt)}` : ""}`),
        footer(actionButton("Stop", "details-stop", { quiet: true }))
      );
      return panel;
    }
    if (["Paused", "Failed"].includes(state.status)) {
      const canary = state.lastCanary; const canaryFailed = canary && canary.passed === false; const rows = canaryFailureRows(canary);
      panel.append(
        el("h3", "r34mf-queue-lead", state.status === "Failed" ? "Detailed metadata paused" : "Resume detailed metadata"),
        el("p", "r34mf-queue-copy", canaryFailed ? `${Number(canary.attemptedCount).toLocaleString()} attempted · ${Number(canary.successCount).toLocaleString()} verified · ${Number(canary.failedCount).toLocaleString()} failed` : `${Number(state.processedCount ?? 0).toLocaleString()} processed in this run · ${Number(state.completedCount ?? 0).toLocaleString()} completed · ${Number(state.failedCount ?? 0).toLocaleString()} failed.`),
        el("p", "r34mf-queue-meta", `${model.missingCount.toLocaleString()} videos still need details.`)
      );
      if (state.lastError?.message) panel.append(el("p", "r34mf-queue-error", state.lastError.message));
      if (rows.length) { panel.append(sectionLabel("CANARY FAILURE SUMMARY")); rows.forEach(([label, count]) => panel.append(el("p", "r34mf-queue-meta", `${label} · ${count}`))); }
      panel.append(el("p", "r34mf-queue-meta", "Completed data was preserved."), footer(actionButton("Export diagnostic", "details-export-diagnostic", { quiet: true }), actionButton("Resume", "details-resume", { primary: true })));
      return panel;
    }
    const percentage = model.indexedCount ? Math.round(model.detailedCount / model.indexedCount * 100) : 0;
    const coverage = el("div", "r34mf-queue-coverage");
    coverage.append(el("strong", "", `${model.detailedCount.toLocaleString()} / ${model.indexedCount.toLocaleString()} videos detailed`), el("small", "", `${percentage}%`));
    panel.append(sectionLabel("COVERAGE"), coverage, progressBar(percentage), el("p", "r34mf-queue-meta", `${model.missingCount.toLocaleString()} videos still need detailed metadata.`), sectionLabel("ADDS INFORMATION"), el("p", "r34mf-queue-copy", "Artist · Uploader · Tags · Categories · Description · Exact upload date"), footer(actionButton("Fetch missing details", "details-fetch", { primary: true, disabled: !model.capabilities.fetchDetails })));
    return panel;
  }

  function maintenance(model, page) {
    if (page === "rescan") {
      const panel = el("section", "r34mf-queue-panel r34mf-queue-child");
      panel.append(heading("FULL CATALOGUE RESCAN"), el("h3", "r34mf-queue-lead", "Recheck every subscription page"), el("p", "r34mf-queue-copy", "This scans every subscription page from start to finish. Existing records remain in place until each replacement page has been committed."));
      if (model.capabilities.fullRescan) panel.append(footer(actionButton("Start full rescan", "full-rescan-start", { primary: true })));
      return panel;
    }
    const panel = el("section", "r34mf-queue-panel r34mf-queue-child");
    panel.append(heading("MAINTENANCE"));
    const rows = model.future.maintenanceRows ?? [
      ["Retry failed details", "Unavailable", "No failed detailed metadata", null, false],
      ["Refresh detailed metadata", "Unavailable", "No detailed metadata available", null, false],
      ["Retry catalogue scan errors", model.resumable ? "Available" : "Unavailable", model.resumable ? "Continue the incomplete catalogue scan" : "No catalogue scan errors", "scan-resume", model.resumable],
      ["Full catalogue rescan", model.capabilities.fullRescan ? "Available" : "Unavailable", "Recheck every subscription page, even after the current catalogue", "queue-full-rescan", model.capabilities.fullRescan]
    ];
    const list = el("div", "r34mf-queue-maintenance-list");
    rows.forEach(([title, status, subtitle, action, navigable]) => list.append(queueRow({ title, status, subtitle, action, navigable })));
    panel.append(list);
    return panel;
  }

  function capture(rootNode) {
    const panel = rootNode.querySelector(":scope > .r34mf-queue-host .r34mf-queue-panel");
    if (!panel) return null;
    const active = document.activeElement;
    return { currentQueueScrollTop: panel.querySelector(".r34mf-current-queue")?.scrollTop ?? 0, activeAction: active instanceof Element && panel.contains(active) ? active.dataset?.r34mfAction ?? null : null };
  }

  function intentFromEvent(event, panel) {
    const button = event.target?.closest?.("[data-r34mf-action]");
    if (!button || !panel.contains(button) || button.disabled) return null;
    return { action: button.dataset.r34mfAction, button };
  }

  function render(rootNode, raw, page = "root", restoreState = capture(rootNode), onIntent) {
    const model = viewModels.deriveQueueViewModel(raw);
    const nextPage = page === "root" ? root(model) : page === "catalogue" ? catalogue(model) : page === "details" ? details(model) : maintenance(model, page === "rescan" ? "rescan" : "maintenance");
    let host = rootNode.querySelector(":scope > .r34mf-queue-host");
    let panel = host?.querySelector(".r34mf-queue-panel") ?? null;
    if (panel) {
      panel.className = nextPage.className;
      panel.replaceChildren(...nextPage.childNodes);
    } else {
      host = el("div", "r34mf-queue-host");
      host.dataset.r34mfOwned = "true";
      panel = nextPage;
      host.append(panel);
      const localHost = rootNode.querySelector(":scope > .r34mf-local-host");
      if (rootNode.insertBefore) rootNode.insertBefore(host, localHost ?? null);
      else rootNode.append(host);
    }
    panel.id = "r34mf-queue-panel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Queue");
    if (!panel.dataset.r34mfIntentBound) {
      panel.dataset.r34mfIntentBound = "true";
      panel.addEventListener("click", (event) => {
        const intent = intentFromEvent(event, panel);
        if (intent) onIntent?.(intent.action, intent.button);
      });
    }
    if (restoreState) {
      const currentQueue = panel.querySelector(".r34mf-current-queue");
      if (currentQueue) currentQueue.scrollTop = restoreState.currentQueueScrollTop ?? 0;
      const action = restoreState.activeAction;
      const target = action ? panel.querySelector(`[data-r34mf-action="${action}"]:not(:disabled)`) : null;
      (target ?? panel.querySelector("[data-r34mf-action]:not(:disabled)"))?.focus({ preventScroll: true });
    }
    return capture(rootNode);
  }

  app.modules.queue = Object.freeze({ render, capture, intentFromEvent, canaryFailureRows });
})();
