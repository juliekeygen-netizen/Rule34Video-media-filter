(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const engine = app?.modules.filterEngine;
  const phase10 = app?.modules.phase10HardeningController;
  if (!app || !controller || !engine || !phase10) {
    throw new Error("R34MF Phase 10 subscriptions controller must load before Local filter context hardening.");
  }

  const EVALUATION_SLICE_MS = 12;
  const RESULT_CACHE_TIME_MS = 60_000;
  let resultCache = null;
  let cacheHits = 0;
  let cacheMisses = 0;
  let localRenderPromise = null;
  let localRenderPending = false;
  const clockNow = () => globalThis.performance?.now?.() ?? Date.now();
  const yieldToBrowser = () => new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  function needsMembership(filters) {
    if (filters?.detailed?.subscriptionsOnly?.enabled === true) return true;
    const inspect = (items) => (items ?? []).some((item) => item?.enabled !== false
      && (item.kind === "group" ? inspect(item.items) : item.field === "subscriptionsOnly"));
    return filters?.advanced?.enabled === true && inspect(filters.advanced.items);
  }

  function contextSignature() {
    const membership = app.modules.subscriptionMembership?.publicState?.()?.snapshot;
    const seen = app.modules.seenStore?.evaluationContext?.();
    const favorited = app.modules.favoriteStore?.evaluationContext?.();
    return `${Number(membership?.refreshedAt) || 0}|${Number(seen?.updatedAt) || 0}|${Number(favorited?.updatedAt) || 0}`;
  }

  function resultCacheKey(source, filters, sort, now) {
    return {
      records: source.records,
      detailsById: source.detailsById,
      filters: JSON.stringify(filters),
      sort: JSON.stringify(sort ?? {}),
      context: contextSignature(),
      timeBucket: Math.floor(Number(now) / RESULT_CACHE_TIME_MS)
    };
  }

  function sameResultCacheKey(left, right) {
    return Boolean(left && right
      && left.records === right.records
      && left.detailsById === right.detailsById
      && left.filters === right.filters
      && left.sort === right.sort
      && left.context === right.context
      && left.timeBucket === right.timeBucket);
  }

  async function renderLocalOnce(instance) {
    if (!instance.root?.isConnected || instance.state.mode !== "local" || instance.phase10PageHidden) return;
    const epoch = ++instance.phase10LocalRenderEpoch;
    const snapshot = { generation: instance.phase10Generation, revision: instance.revision, root: instance.root };
    const current = () => phase10.current(instance, snapshot) && epoch === instance.phase10LocalRenderEpoch && instance.state.mode === "local";

    try {
      const source = await app.modules.db.getAllLocalRecords();
      if (!current()) return;

      const filters = engine.prepareEvaluation?.(instance.state.filters ?? engine.createEmpty())
        ?? engine.normalize(instance.state.filters ?? engine.createEmpty());
      if (needsMembership(filters)) {
        await app.modules.subscriptionMembership?.ensureFresh?.({ documentLike: document });
        if (!current()) return;
      }
      try { await app.modules.seenStore?.load?.(); } catch (error) {
        app.modules.logger?.warn?.("seen-state-load-failed", { message: error?.message ?? String(error) });
      }
      try { await app.modules.favoriteStore?.load?.(); } catch (error) {
        app.modules.logger?.warn?.("favorite-state-load-failed", { message: error?.message ?? String(error) });
      }
      if (!current()) return;

      const membership = app.modules.subscriptionMembership?.evaluationContext?.()
        ?? { status: "unavailable", keys: new Set(), names: new Set() };
      const seen = app.modules.seenStore?.evaluationContext?.()
        ?? { status: "unavailable", ids: new Set() };
      const favorited = app.modules.favoriteStore?.evaluationContext?.()
        ?? { status: "unavailable", ids: new Set() };
      const now = Date.now();
      const cacheKey = resultCacheKey(source, filters, instance.state.sort, now);
      let sortedMatches;
      let unknownCount;

      if (sameResultCacheKey(resultCache?.key, cacheKey)) {
        cacheHits += 1;
        sortedMatches = resultCache.sortedMatches;
        unknownCount = resultCache.unknownCount;
      } else {
        cacheMisses += 1;
        const evaluationContext = engine.createEvaluationContext?.(source.records, source.detailsById, { membership, seen, favorited })
          ?? { membership, seen, favorited, records: source.records, detailsById: source.detailsById };
        const evaluate = engine.evaluatePrepared ?? engine.evaluate;
        const matches = [];
        unknownCount = 0;
        let sliceStarted = clockNow();

        for (let index = 0; index < source.records.length; index += 1) {
          const record = source.records[index];
          const result = evaluate(record, source.detailsById.get(record.videoId), filters, now, evaluationContext);
          if (result === engine.TRUE) matches.push(record);
          else if (result === engine.UNKNOWN) unknownCount += 1;

          if (index + 1 < source.records.length && clockNow() - sliceStarted >= EVALUATION_SLICE_MS) {
            await yieldToBrowser();
            if (!current()) return;
            sliceStarted = clockNow();
          }
        }

        sortedMatches = app.modules.sorter.sort(matches, source.detailsById, instance.state.sort);
        if (!current()) return;
        resultCache = { key: cacheKey, sortedMatches, unknownCount };
      }

      const result = await app.modules.localGrid.render(snapshot.root, {
        page: instance.state.localPage,
        pageSize: app.modules.settings.value.videosPerPage,
        previews: app.modules.settings.value.animatedHoverPreviews,
        columns: app.modules.settings.value.videoColumns,
        aspectRatio: app.modules.settings.value.thumbnailAspectRatio,
        onPage: (localPage) => instance.setUiState({ localPage }),
        records: sortedMatches,
        detailsById: source.detailsById,
        guard: current
      });
      if (!current()) return;
      if (result.page !== instance.state.localPage) {
        await instance.setUiState({ localPage: result.page });
        return;
      }
      instance.state = {
        ...instance.state,
        showingCount: result.total,
        unknownCount,
        localRendererActive: true,
        filterCount: engine.countApplied(filters)
      };
      instance.updateShell();
    } catch (error) {
      if (!current()) return;
      instance.state = { ...instance.state, localRendererActive: false };
      instance.updateShell();
      app.modules.logger?.warn?.("local-filter-context-render-failed", { message: error?.message ?? String(error) });
    }
  }

  controller.renderLocal = function renderLocalWithEvaluationContext() {
    if (!this.root?.isConnected || this.state.mode !== "local" || this.phase10PageHidden) return Promise.resolve();

    // A catalogue/detail/membership burst used to start several complete 7k-record
    // filter passes at once. Newer requests now invalidate the current pass and
    // collapse into one latest rerun, keeping taps/settings/filter UI responsive.
    localRenderPending = true;
    if (localRenderPromise) {
      this.phase10LocalRenderEpoch += 1;
      return localRenderPromise;
    }

    const instance = this;
    localRenderPromise = (async () => {
      do {
        localRenderPending = false;
        await renderLocalOnce(instance);
      } while (localRenderPending && instance.root?.isConnected && instance.state.mode === "local" && !instance.phase10PageHidden);
    })().finally(() => {
      localRenderPromise = null;
      if (localRenderPending && instance.root?.isConnected && instance.state.mode === "local" && !instance.phase10PageHidden) {
        queueMicrotask(() => instance.renderLocal());
      }
    });
    return localRenderPromise;
  };

  app.modules.localFilterContext = Object.freeze({
    needsMembership,
    EVALUATION_SLICE_MS,
    RESULT_CACHE_TIME_MS,
    resultCacheKey,
    sameResultCacheKey,
    clearResultCache() { resultCache = null; },
    cacheStats: () => ({ hits: cacheHits, misses: cacheMisses }),
    renderState: () => ({ inFlight: Boolean(localRenderPromise), pending: localRenderPending })
  });
})();