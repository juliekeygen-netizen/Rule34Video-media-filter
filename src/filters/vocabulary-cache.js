(() => {
  "use strict";

  const app = globalThis.R34MF;
  const engine = app?.modules.filterEngine;
  if (!app || !engine) throw new Error("R34MF filter engine must load before vocabulary cache.");

  const cache = new WeakMap();
  const MAX_FACETED_ENTRIES = 32;
  const MAX_FILTERED_ENTRIES = 16;
  const MAX_CONTEXT_ENTRIES = 4;
  let hits = 0;
  let misses = 0;
  let filterPasses = 0;

  function entryFor(records, detailsById) {
    let entry = cache.get(records);
    if (!entry || entry.detailsById !== detailsById) {
      entry = {
        detailsById,
        full: new Map(),
        faceted: new Map(),
        filtered: new Map(),
        contexts: new Map()
      };
      cache.set(records, entry);
    }
    return entry;
  }

  function lruGet(map, key) {
    if (!map.has(key)) return null;
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
    return value;
  }

  function lruSet(map, key, value, limit) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
    return value;
  }

  function fullVocabulary(records, detailsById, field) {
    if (!Array.isArray(records) || (!detailsById || (typeof detailsById !== "object" && typeof detailsById !== "function"))) {
      return engine.vocabulary(records, detailsById, field, "", Number.MAX_SAFE_INTEGER);
    }
    const entry = entryFor(records, detailsById);
    if (entry.full.has(field)) {
      hits += 1;
      return entry.full.get(field);
    }
    misses += 1;
    const value = engine.vocabulary(records, detailsById, field, "", Number.MAX_SAFE_INTEGER);
    entry.full.set(field, value);
    return value;
  }

  function stripAdvancedField(items, field) {
    const result = [];
    for (const item of items ?? []) {
      if (item?.kind === "group") {
        const children = stripAdvancedField(item.items, field);
        if (children.length) result.push({ ...item, items: children });
      } else if (item?.field !== field) result.push({ ...item });
    }
    return result;
  }

  function filtersWithoutFacet(filters, field) {
    const raw = engine.clone(filters ?? engine.createEmpty());
    if (raw.quick?.[field]) raw.quick[field].enabled = false;
    if (raw.detailed?.[field]) raw.detailed[field].enabled = false;
    if (raw.advanced) raw.advanced.items = stripAdvancedField(raw.advanced.items, field);
    return engine.normalize(raw);
  }

  function contextSignature() {
    const membership = app.modules.subscriptionMembership?.publicState?.()?.snapshot;
    const seen = app.modules.seenStore?.evaluationContext?.();
    const favorited = app.modules.favoriteStore?.evaluationContext?.();
    return `${Number(membership?.refreshedAt) || 0}|${Number(seen?.updatedAt) || 0}|${Number(favorited?.updatedAt) || 0}|${Math.floor(Date.now() / 60000)}`;
  }

  function evaluationContext(records, detailsById, entry, signature) {
    const cached = lruGet(entry.contexts, signature);
    if (cached) return cached;
    const membership = app.modules.subscriptionMembership?.evaluationContext?.()
      ?? { status: "unavailable", keys: new Set(), names: new Set() };
    const seen = app.modules.seenStore?.evaluationContext?.()
      ?? { status: "unavailable", ids: new Set() };
    const favorited = app.modules.favoriteStore?.evaluationContext?.()
      ?? { status: "unavailable", ids: new Set() };
    const value = engine.createEvaluationContext?.(records, detailsById, { membership, seen, favorited })
      ?? { records, detailsById, membership, seen, favorited };
    return lruSet(entry.contexts, signature, value, MAX_CONTEXT_ENTRIES);
  }

  function filteredRecords(records, detailsById, filters, entry, signature) {
    const filtersKey = JSON.stringify(filters);
    const key = `${filtersKey}|${signature}`;
    const cached = lruGet(entry.filtered, key);
    if (cached) {
      hits += 1;
      return cached;
    }

    misses += 1;
    filterPasses += 1;
    const now = Date.now();
    const context = evaluationContext(records, detailsById, entry, signature);
    const preparedFilters = engine.prepareEvaluation?.(filters) ?? filters;
    const evaluate = engine.evaluatePrepared ?? engine.evaluate;
    const value = records.filter((record) => evaluate(
      record,
      detailsById.get?.(record.videoId) ?? detailsById?.[record.videoId],
      preparedFilters,
      now,
      context
    ) === engine.TRUE);
    return lruSet(entry.filtered, key, value, MAX_FILTERED_ENTRIES);
  }

  function facetedVocabulary(records, detailsById, field) {
    const active = app.modules.filterState?.active?.();
    if (!active?.filters) return fullVocabulary(records, detailsById, field);
    const filters = filtersWithoutFacet(active.filters, field);
    if (engine.countApplied(filters) === 0) return fullVocabulary(records, detailsById, field);

    const entry = entryFor(records, detailsById);
    const signature = contextSignature();
    const filtersKey = JSON.stringify(filters);
    const facetKey = `${field}|${filtersKey}|${signature}`;
    const cached = lruGet(entry.faceted, facetKey);
    if (cached) {
      hits += 1;
      return cached;
    }

    const filtered = filteredRecords(records, detailsById, filters, entry, signature);
    misses += 1;
    const value = engine.vocabulary(filtered, detailsById, field, "", Number.MAX_SAFE_INTEGER);
    return lruSet(entry.faceted, facetKey, value, MAX_FACETED_ENTRIES);
  }

  function vocabulary(records, detailsById, field, query = "", limit = 60) {
    const full = facetedVocabulary(records, detailsById, field);
    const search = String(query ?? "").trim().toLocaleLowerCase();
    const boundedLimit = Math.max(1, Math.floor(Number(limit) || 60));
    return {
      covered: full.covered,
      values: full.values
        .filter(({ value }) => !search || String(value).toLocaleLowerCase().includes(search))
        .slice(0, boundedLimit)
    };
  }

  app.modules.filterEngine = Object.freeze({ ...engine, vocabulary });
  app.modules.vocabularyCache = Object.freeze({
    filtersWithoutFacet,
    fullVocabulary,
    facetedVocabulary,
    stats: () => ({ hits, misses, filterPasses })
  });
})();
