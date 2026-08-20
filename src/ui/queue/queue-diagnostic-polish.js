(() => {
  "use strict";

  const app = globalThis.R34MF;
  const baseQueue = app?.modules.queue;
  const viewModels = app?.modules.queueViewModel;
  if (!app || !baseQueue || !viewModels) throw new Error("R34MF Queue must load before diagnostic visibility polish.");

  function hasDetailDiagnosticIssue(state) {
    const status = String(state?.status ?? "").toLowerCase();
    const failedCanary = state?.lastCanary?.passed === false;
    const failedSample = (state?.lastCanary?.samples ?? []).some((sample) => sample?.ok === false);
    return status === "failed"
      || Number(state?.failedCount ?? 0) > 0
      || Boolean(state?.lastError?.code || state?.lastError?.message)
      || Boolean(state?.systemicReason?.code || state?.systemicReason?.message)
      || failedCanary
      || failedSample;
  }

  function polishDetails(rootNode, raw, page) {
    if (page !== "details") return;
    const panel = rootNode?.querySelector?.(":scope > .r34mf-queue-host .r34mf-queue-panel");
    if (!panel) return;

    const state = viewModels.deriveQueueViewModel(raw).details;
    const exportButton = panel.querySelector("[data-r34mf-action='details-export-diagnostic']");
    if (exportButton && !hasDetailDiagnosticIssue(state)) {
      const hadFocus = document.activeElement === exportButton;
      exportButton.remove();
      if (hadFocus) panel.querySelector("[data-r34mf-action='details-resume']")?.focus?.({ preventScroll: true });
    }

    if (state.status === "Failed") {
      const lead = panel.querySelector(".r34mf-queue-lead");
      if (lead?.textContent === "Detailed metadata paused") lead.textContent = "Detailed metadata failed";
    }
  }

  function render(rootNode, raw, page = "root", restoreState, onIntent) {
    const result = baseQueue.render(rootNode, raw, page, restoreState, onIntent);
    polishDetails(rootNode, raw, page);
    return result;
  }

  app.modules.queue = Object.freeze({
    ...baseQueue,
    render,
    hasDetailDiagnosticIssue,
    polishDetails
  });
})();