(() => {
  "use strict";
  const app = globalThis.R34MF;
  const baseQueue = app?.modules.queue;
  const viewModels = app?.modules.queueViewModel;
  if (!app || !baseQueue || !viewModels) throw new Error("R34MF Queue must load before maintenance UI integration.");

  function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
  function arrow() { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("class", "r34mf-queue-arrow"); svg.setAttribute("aria-hidden", "true"); const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "m6 3 5 5-5 5"); svg.append(path); return svg; }
  function actionButton(label, action, { primary = false, quiet = false } = {}) { const button = el("button", `r34mf-queue-button${primary ? " is-primary" : ""}${quiet ? " is-quiet" : ""}`, label); button.type = "button"; button.dataset.r34mfAction = action; return button; }
  function footer(...buttons) { const node = el("footer", "r34mf-queue-footer"); node.append(...buttons); return node; }
  function queueRow(row) { const button = el("button", "r34mf-queue-row"); button.type = "button"; button.disabled = row.navigable !== true; if (row.action && row.navigable) button.dataset.r34mfAction = row.action; const copy = el("span", "r34mf-queue-row-copy"); copy.append(el("strong", "", row.title), el("small", "", row.subtitle)); const right = el("span", "r34mf-queue-row-right"); if (row.status) right.append(el("small", `r34mf-queue-row-status is-${String(row.status).toLowerCase().replace(/\s+/g, "-")}`, row.status)); if (row.navigable) right.append(arrow()); button.append(copy, right); return button; }

  function replaceMaintenance(panel, model) { const list = panel?.querySelector?.(".r34mf-queue-maintenance-list"); if (list) list.replaceChildren(...model.maintenanceRows.map(queueRow)); }

  function replaceCatalogueWaiting(panel, model) {
    const waiting = model.catalogueWaiting; if (!panel || !waiting) return false;
    const header = panel.querySelector(".r34mf-queue-child-header"); if (!header) return false;
    const title = waiting.kind === "smart-update" ? "Smart Update" : waiting.kind === "full-rescan" || waiting.kind === "full-rescan-resume" ? "Full catalogue rescan" : "Catalogue scan";
    panel.replaceChildren(
      header,
      el("h3", "r34mf-queue-lead", "Waiting in queue"),
      el("p", "r34mf-queue-meta", `Position ${waiting.position} · ${title}`),
      el("p", "r34mf-queue-copy", "Starts automatically when an execution slot and its required catalogue resources are free."),
      footer(actionButton("Remove from queue", `job-remove:${waiting.id}`, { quiet: true }))
    );
    return true;
  }

  function replaceSmartResume(panel, model) {
    const smart = model.smartResume; if (!panel || !smart) return;
    const header = panel.querySelector(".r34mf-queue-child-header"); if (!header) return;
    const lead = smart.requiresFullRescan ? "Smart Update needs a full rescan" : smart.status === "Failed" ? "Retry Smart Update" : "Resume Smart Update";
    const copy = smart.requiresFullRescan ? "The previous catalogue was preserved because the update could not prove a safe final order." : `${smart.pagesChecked.toLocaleString()} pages checked · ${smart.newVideos.toLocaleString()} new videos staged${smart.nativePageCount ? ` · next page ${smart.nextPage} of ${smart.nativePageCount}` : ` · next page ${smart.nextPage}`}.`;
    const children = [header, el("h3", "r34mf-queue-lead", lead), el("p", "r34mf-queue-copy", copy)];
    if (smart.lastError?.message) children.push(el("p", "r34mf-queue-error", smart.lastError.message));
    children.push(el("p", "r34mf-queue-meta", "Committed catalogue data was preserved."));
    children.push(smart.requiresFullRescan ? footer(actionButton("Open Maintenance", "queue-maintenance", { primary: true })) : footer(actionButton(smart.status === "Failed" ? "Retry update" : "Resume update", "smart-update", { primary: true })));
    panel.replaceChildren(...children);
  }

  function polishNormalCatalogueResume(panel, model) { if (!panel || !model.resumable || model.catalogue?.scanKind !== "full-rescan") return; const lead = panel.querySelector(".r34mf-queue-lead"); if (lead?.textContent === "Resume subscription scan") lead.textContent = "Resume full catalogue rescan"; const button = panel.querySelector("[data-r34mf-action='scan-resume']"); if (button) button.textContent = "Resume full rescan"; }

  function detailLead(mode, status, phase) {
    if (mode === "failed") { if (status === "Waiting") return "Failed-detail retry waiting"; if (status === "Failed") return "Failed-detail retry failed"; if (status === "Paused") return "Resume failed-detail retry"; if (phase === "preflight") return "Checking failed detail targets"; if (phase === "canary") return "Verifying failed detail retries"; return "Retrying failed details"; }
    if (mode === "refresh") { if (status === "Waiting") return "Detail refresh waiting"; if (status === "Failed") return "Detail refresh failed"; if (status === "Paused") return "Resume detail refresh"; if (phase === "preflight") return "Checking refresh targets"; if (phase === "canary") return "Verifying detail refresh"; return "Refreshing detailed metadata"; }
    return null;
  }

  function polishDetails(panel, model) {
    if (!panel) return; const state = model.details; const mode = state.mode ?? "missing"; if (mode === "missing") return;
    const lead = panel.querySelector(".r34mf-queue-lead"); const replacement = detailLead(mode, state.status, state.active?.phase); if (lead && replacement) lead.textContent = replacement;
    if (["Paused", "Failed"].includes(state.status)) {
      const metas = [...panel.querySelectorAll(".r34mf-queue-meta")];
      const pending = metas.find((node) => /videos still need details\./i.test(node.textContent ?? ""));
      if (pending) pending.textContent = mode === "failed" ? `${model.failedDetailCount.toLocaleString()} failed detail record${model.failedDetailCount === 1 ? "" : "s"} still need retry.` : "Previously completed detail records remain available while refresh work is paused.";
      const actions = panel.querySelector(".r34mf-queue-footer");
      if (actions && model.missingCount > 0 && !actions.querySelector("[data-r34mf-action='details-fetch']")) actions.insertBefore(actionButton("Fetch missing details", "details-fetch", { quiet: true }), actions.lastElementChild ?? null);
    }
    if (state.status === "Waiting") { const meta = panel.querySelector(".r34mf-queue-meta"); const total = Number(state.waiting?.progress?.total ?? state.targetCount ?? 0); if (meta) meta.textContent = `Position ${state.position ?? 1} · ${mode === "failed" ? "Failed only" : "Completed details"}${total ? ` · ${total.toLocaleString()} videos` : ""}`; }
  }

  function render(rootNode, raw, page = "root", restoreState, onIntent) {
    baseQueue.render(rootNode, raw, page, restoreState, onIntent);
    const model = viewModels.deriveQueueViewModel(raw); const panel = rootNode?.querySelector?.(":scope > .r34mf-queue-host .r34mf-queue-panel");
    if (page === "maintenance") replaceMaintenance(panel, model);
    if (page === "catalogue" && !replaceCatalogueWaiting(panel, model)) { if (model.smartResume) replaceSmartResume(panel, model); else polishNormalCatalogueResume(panel, model); }
    if (page === "details") polishDetails(panel, model);
    return baseQueue.capture(rootNode);
  }

  app.modules.queue = Object.freeze({ ...baseQueue, render, replaceMaintenance, replaceCatalogueWaiting, replaceSmartResume, polishNormalCatalogueResume, polishDetails });
})();