(() => {
  "use strict";

  const app = globalThis.R34MF;
  const db = app?.modules.db;
  if (!app || !db) throw new Error("R34MF DB must load before Local data cache.");

  let generation = 0;
  let cached = null;
  let pending = null;
  let hits = 0;
  let misses = 0;

  function invalidate() {
    generation += 1;
    cached = null;
    pending = null;
  }

  const unsubscribeCatalogue = db.subscribeCatalogueChanges?.(invalidate);
  const unsubscribeDetails = db.subscribeDetailChanges?.(invalidate);

  async function getAllLocalRecords() {
    if (cached) {
      hits += 1;
      return cached;
    }
    if (pending) {
      hits += 1;
      return pending;
    }

    misses += 1;
    const requestGeneration = generation;
    const request = Promise.resolve(db.getAllLocalRecords()).then((value) => {
      if (requestGeneration === generation) cached = value;
      return value;
    }).finally(() => {
      if (pending === request) pending = null;
    });
    pending = request;
    return request;
  }

  app.modules.db = Object.freeze({ ...db, getAllLocalRecords });
  app.modules.localDataCache = Object.freeze({
    invalidate,
    stats: () => ({ generation, hits, misses, cached: Boolean(cached), pending: Boolean(pending) }),
    dispose: () => {
      unsubscribeCatalogue?.();
      unsubscribeDetails?.();
      invalidate();
    }
  });
})();
