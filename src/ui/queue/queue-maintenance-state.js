(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.queueViewModel;
  if (!app || !base) throw new Error("R34MF Queue maintenance model must load before maintenance state polish.");

  const DETAIL_MODES = Object.freeze({
    "detail-enrichment": "missing",
    "detail-retry-failed": "failed",
    "detail-retry-failed-refreshes": "refreshFailed",
    "detail-refresh": "refresh",
    "detail-repair-outdated": "outdated"
  });

  function modeForJob(job) {
    return DETAIL_MODES[job?.kind] ?? null;
  }

  function scopeForActive(item) {
    const mode = item?.detailMode ?? modeForJob(item);
    if (!mode || mode === "missing") return item?.scope;
    const phase = item?.phase;
    if (phase === "preflight") {
      return mode === "failed" ? "Validating failed detail records" : mode === "refreshFailed" ? "Validating failed refresh attempts" : "Validating completed detail records";
    }
    if (phase === "canary") {
      return `${Number(item.canaryAttempted ?? item.completed ?? 0).toLocaleString()} of ${Number(item.canaryMaximum ?? item.total ?? 10).toLocaleString()} attempted`;
    }
    const processed = Number(item?.completed ?? item?.progress?.processed ?? 0);
    const total = Number(item?.total ?? item?.progress?.total ?? 0);
    if (mode === "failed") return total ? `${processed.toLocaleString()} of ${total.toLocaleString()} failed details checked` : "Retrying failed details…";
    if (mode === "refreshFailed") return total ? `${processed.toLocaleString()} of ${total.toLocaleString()} failed refreshes retried` : "Retrying failed refreshes…";
    return total ? `${processed.toLocaleString()} of ${total.toLocaleString()} completed details refreshed` : "Refreshing completed details…";
  }

  function scopeForWaiting(item) {
    const mode = item?.detailMode ?? modeForJob(item);
    if (!mode || mode === "missing") return item?.scope;
    const total = Number(item?.progress?.total ?? item?.total ?? 0);
    const suffix = total > 0 ? ` · ${total.toLocaleString()} videos` : "";
    return mode === "failed" ? `Failed only${suffix}` : mode === "refreshFailed" ? `Failed refreshes only${suffix}` : mode === "outdated" ? `Outdated metadata${suffix}` : `Completed details${suffix}`;
  }

  function deriveQueueViewModel(raw = {}) {
    const model = base.deriveQueueViewModel(raw);
    const runtime = raw.runtime ?? { active: [], waiting: [] };
    const originals = new Map([...(runtime.active ?? []), ...(runtime.waiting ?? [])].map((job) => [job.id, job]));

    for (const item of model.active ?? []) {
      const original = originals.get(item.id);
      const mode = modeForJob(original);
      if (!mode) continue;
      item.detailMode = mode;
      item.scope = scopeForActive(item);
    }
    for (const item of model.waiting ?? []) {
      const original = originals.get(item.id);
      const mode = modeForJob(original);
      if (!mode) continue;
      item.detailMode = mode;
      item.scope = scopeForWaiting(item);
    }

    const activeMode = modeForJob((runtime.active ?? []).find((job) => modeForJob(job)));
    const waitingMode = modeForJob((runtime.waiting ?? []).find((job) => modeForJob(job)));
    if (activeMode || waitingMode) {
      model.details.mode = activeMode ?? waitingMode;
    } else if (!["Paused", "Failed"].includes(model.details.status)) {
      // A completed maintenance run must not permanently turn the normal Details
      // child into a "refresh" or "failed retry" screen. Only a resumable durable
      // maintenance failure/pause keeps its mode after the runtime job is gone.
      model.details.mode = "missing";
    }

    if (model.details.active) {
      const matching = (model.active ?? []).find((item) => item.id === model.details.active.id);
      if (matching) model.details.active = matching;
    }
    if (model.details.waiting) {
      const matching = (model.waiting ?? []).find((item) => item.id === model.details.waiting.id);
      if (matching) model.details.waiting = matching;
    }

    return model;
  }

  app.modules.queueViewModel = Object.freeze({
    ...base,
    deriveQueueViewModel,
    modeForJob,
    scopeForActive,
    scopeForWaiting
  });
})();
