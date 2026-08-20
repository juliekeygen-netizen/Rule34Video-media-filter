(() => {
  "use strict";

  const app = globalThis.R34MF;
  const engine = app?.modules.filterEngine;
  if (!app || !engine) throw new Error("R34MF filter engine must load before evaluation performance support.");

  const preparedFilters = new WeakSet();

  function isPreparedEvaluation(filters) {
    return Boolean(filters && typeof filters === "object" && preparedFilters.has(filters));
  }

  function prepareEvaluation(filters) {
    const normalized = engine.normalize(filters);
    preparedFilters.add(normalized);
    return normalized;
  }

  function evaluatePrepared(video, details, filters, now = Date.now(), context = {}) {
    const prepared = isPreparedEvaluation(filters) ? filters : prepareEvaluation(filters);
    const currentNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return engine.triAnd(
      engine.evaluateSimple(video, details, prepared, currentNow, context),
      prepared.advanced.enabled
        ? engine.evaluateItems(video, details, prepared.advanced.items, currentNow, context)
        : engine.TRUE
    );
  }

  app.modules.filterEngine = Object.freeze({
    ...engine,
    isPreparedEvaluation,
    prepareEvaluation,
    evaluatePrepared
  });
})();
