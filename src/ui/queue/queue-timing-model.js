(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.queueViewModel;
  if (!app || !base) throw new Error("R34MF Queue view model must load before timing estimates.");

  function number(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function formatDuration(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value < 1000) return `${Math.max(0.1, value / 1000).toFixed(1)}s`;
    const seconds = value / 1000;
    if (seconds < 60) return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      const remainder = Math.round(seconds % 60);
      return remainder >= 10 ? `${minutes}m ${remainder}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }

  function estimateTiming({
    startedAt,
    sampleCompleted,
    completed,
    total,
    unit = "item",
    allowEta = true,
    now = Date.now()
  } = {}) {
    const start = Number(startedAt);
    const sample = Math.max(0, number(sampleCompleted));
    const done = Math.max(0, number(completed));
    const target = Math.max(0, number(total));
    const elapsedMs = Number.isFinite(start) && start > 0 ? Math.max(0, now - start) : 0;
    if (sample < 2 || elapsedMs < 1000) return null;

    const averageMs = elapsedMs / sample;
    if (!Number.isFinite(averageMs) || averageMs <= 0) return null;
    const unitLabel = unit === "page" ? "page" : unit === "video" ? "video" : unit;
    const remaining = target > 0 ? Math.max(0, target - done) : null;
    const etaMs = allowEta && remaining !== null ? averageMs * remaining : null;
    const averageText = `Avg ${formatDuration(averageMs)}/${unitLabel}`;
    return {
      averageMs,
      remaining,
      etaMs,
      averageText,
      etaText: etaMs === null ? null : remaining === 0 ? "finishing…" : `≈${formatDuration(etaMs)} remaining`,
      text: etaMs === null ? averageText : `${averageText} · ${remaining === 0 ? "finishing…" : `≈${formatDuration(etaMs)} remaining`}`
    };
  }

  function deriveQueueViewModel(raw = {}) {
    const model = base.deriveQueueViewModel(raw);
    const runtime = raw.runtime ?? { active: [] };
    const originals = new Map((runtime.active ?? []).map((job) => [job.id, job]));

    for (const item of model.active ?? []) {
      const original = originals.get(item.id);
      if (!original) continue;
      if (item.destination === "details") {
        if (item.phase !== "bulk") continue;
        item.timing = estimateTiming({
          startedAt: original.progress?.timingStartedAt ?? original.startedAt,
          sampleCompleted: original.progress?.timingCompleted ?? original.progress?.processed,
          completed: item.completed,
          total: item.total,
          unit: "video"
        });
      } else if (item.destination === "catalogue") {
        item.timing = estimateTiming({
          startedAt: original.progress?.timingStartedAt ?? original.startedAt,
          sampleCompleted: original.progress?.timingCompleted ?? original.progress?.completed,
          completed: item.completed,
          total: item.total,
          unit: "page",
          // Smart Update may finish as soon as ordered overlap is proven, so its
          // native page count is not a truthful remaining-work denominator.
          allowEta: item.kind !== "smart-update"
        });
      }
    }

    if (model.details?.active) {
      const timed = (model.active ?? []).find((item) => item.id === model.details.active.id);
      if (timed) model.details.active = timed;
    }
    if (model.catalogueActive) {
      const timed = (model.active ?? []).find((item) => item.id === model.catalogueActive.id);
      if (timed) model.catalogueActive = timed;
    }

    const refresh = model.maintenanceRows?.find?.((row) => row.title === "Refresh detailed metadata" && row.status === "Available");
    if (refresh) {
      refresh.subtitle = `Re-fetch all ${number(model.detailedCount).toLocaleString()} completed detail records · full metadata pass`;
    }

    return model;
  }

  app.modules.queueViewModel = Object.freeze({
    ...base,
    deriveQueueViewModel,
    formatDuration,
    estimateTiming
  });
})();