(() => {
  "use strict";

  const app = globalThis.R34MF;
  const baseQueue = app?.modules.queue;
  const viewModels = app?.modules.queueViewModel;
  if (!app || !baseQueue || !viewModels) throw new Error("R34MF Queue must load before operation controls.");

  function actionButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "r34mf-queue-button is-quiet";
    button.dataset.r34mfAction = action;
    button.textContent = label;
    return button;
  }

  function insertBeforeAction(panel, existingAction, newAction, label = "Cancel") {
    const existing = panel?.querySelector?.(`[data-r34mf-action='${existingAction}']`);
    if (!existing || panel.querySelector(`[data-r34mf-action='${newAction}']`)) return null;
    const button = actionButton(label, newAction);
    existing.parentNode?.insertBefore(button, existing);
    return button;
  }

  function runningControls(panel, page, model = {}) {
    if (!panel) return;
    if (page === "details") {
      const pause = panel.querySelector("[data-r34mf-action='details-stop']");
      if (pause && model.details?.status === "Running") {
        pause.textContent = "Pause";
        insertBeforeAction(panel, "details-stop", "details-cancel");
      } else if (["Paused", "Failed"].includes(model.details?.status)) {
        insertBeforeAction(panel, "details-resume", "details-cancel");
      }
      return;
    }
    if (page === "catalogue") {
      const pause = panel.querySelector("[data-r34mf-action='scan-stop']");
      if (pause) {
        pause.textContent = "Pause";
        insertBeforeAction(panel, "scan-stop", "scan-cancel");
        return;
      }
      if (model.resumable && panel.querySelector("[data-r34mf-action='scan-resume']")) {
        insertBeforeAction(panel, "scan-resume", "scan-cancel");
        return;
      }
      if (model.catalogueCancellable && panel.querySelector("[data-r34mf-action='smart-update']")) {
        insertBeforeAction(panel, "smart-update", "scan-cancel");
        return;
      }
      // A reconciliation-required Smart Update cannot itself resume, but Cancel
      // still clears that failed checkpoint before the user chooses Maintenance.
      if (model.scanFailed && model.resumable && panel.querySelector("[data-r34mf-action='queue-maintenance']")) {
        insertBeforeAction(panel, "queue-maintenance", "scan-cancel");
      }
    }
  }

  function appendTiming(node, timing) {
    if (!node || !timing?.text || node.dataset.r34mfTiming === timing.text) return;
    node.textContent = `${node.textContent ?? ""} · ${timing.text}`;
    node.dataset.r34mfTiming = timing.text;
  }

  function timingCopy(rootNode, model, page) {
    if (!rootNode) return;
    if (page === "root") {
      const rows = [...rootNode.querySelectorAll(":scope > .r34mf-queue-host .r34mf-queue-job.is-active")];
      (model.active ?? []).forEach((job, index) => {
        if (!job.timing) return;
        const meta = rows[index]?.querySelector("small:last-of-type");
        appendTiming(meta, job.timing);
      });
      return;
    }
    if (page === "details" && model.details?.status === "Running") {
      const metas = [...rootNode.querySelectorAll(":scope > .r34mf-queue-host .r34mf-queue-panel > .r34mf-queue-meta")];
      appendTiming(metas.at(-1), model.details.active?.timing);
      return;
    }
    if (page === "catalogue" && model.scanRunning) {
      const metas = [...rootNode.querySelectorAll(":scope > .r34mf-queue-host .r34mf-queue-scan-progress .r34mf-queue-meta")];
      appendTiming(metas.at(-1), model.catalogueActive?.timing);
    }
  }

  function render(rootNode, raw, page = "root", restoreState, onIntent) {
    baseQueue.render(rootNode, raw, page, restoreState, onIntent);
    const model = viewModels.deriveQueueViewModel(raw);
    const panel = rootNode?.querySelector?.(":scope > .r34mf-queue-host .r34mf-queue-panel");
    runningControls(panel, page, model);
    timingCopy(rootNode, model, page);
    return baseQueue.capture(rootNode);
  }

  app.modules.queue = Object.freeze({
    ...baseQueue,
    render,
    runningControls,
    timingCopy,
    appendTiming
  });
})();
