(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.catalogueScanner;
  const db = app?.modules.db;
  const discovery = app?.modules.feedDiscovery;
  const cardParser = app?.modules.cardParser;
  const parsing = app?.modules.catalogueParsing;
  const scheduler = app?.modules.requestScheduler;
  const browserApi = app?.modules.browserApi;
  const settings = app?.modules.settings;
  if (!app || !base || !db || !discovery || !cardParser || !parsing || !scheduler || !browserApi || !settings) {
    throw new Error("R34MF catalogue scanner must load before bounded Recent Update.");
  }

  const MIN_PAGES = 1;
  const MAX_PAGES = 20;

  const configuredPageLimit = () => Math.max(
    MIN_PAGES,
    Math.min(MAX_PAGES, Math.round(Number(settings.value?.recentUpdatePageLimit) || 3))
  );

  const createSessionId = () => globalThis.crypto?.randomUUID?.()
    ?? `recent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const safeError = (error, pageNumber = null) => ({
    code: error?.code ?? "recent-update-request-failed",
    pageNumber,
    message: String(error?.message ?? error ?? "Recent Update could not read a subscription page.").slice(0, 180)
  });

  const isAbort = (error) => error?.name === "AbortError";
  const networkFetchFailure = (error) => error instanceof TypeError
    || /failed to fetch|networkerror|network request|load failed/i.test(String(error?.message ?? error ?? ""));

  function proxyResponse(payload) {
    return {
      ok: payload?.ok === true,
      status: Number(payload?.status) || 0,
      headers: {
        get(name) {
          return String(name).toLocaleLowerCase() === "retry-after" ? payload?.retryAfter ?? null : null;
        }
      },
      async text() { return String(payload?.text ?? ""); }
    };
  }

  async function backgroundFetch(url, signal) {
    await scheduler.waitTurn({ signal });
    if (signal?.aborted) throw scheduler.abortError();
    const payload = await browserApi.runtimeSendMessage({ type: "r34mf:fetch-subscriptions-page", url });
    if (!payload || (!Number(payload.status) && payload.ok !== true)) {
      const error = new Error(payload?.error?.message ?? "Rule34Video could not be reached from either request context.");
      error.code = payload?.error?.code ?? "network-fetch-failed";
      throw error;
    }
    if (Number(payload.status) === 429) scheduler.applyRetryAfter(payload.retryAfter);
    return proxyResponse(payload);
  }

  function parsePage(html, pageNumber) {
    const documentLike = new DOMParser().parseFromString(html, "text/html");
    const structure = discovery.findSubscriptionsGrid(documentLike);
    if (!structure.structureValid) {
      const error = new Error(`Subscription page ${pageNumber} did not contain the expected subscription grid.`);
      error.code = "missing-subscription-grid";
      throw error;
    }
    const cards = discovery.extractCards(documentLike);
    const parsed = cards.map((card, index) => cardParser.parseCard(card, {
      pageNumber,
      nativeOrder: index + 1
    }));
    const failures = parsed.filter((result) => !result.ok);
    if (failures.length) {
      const error = new Error(`Could not identify ${failures.length} video card${failures.length === 1 ? "" : "s"} on subscription page ${pageNumber}.`);
      error.code = "partial-video-identity";
      throw error;
    }
    return parsing.dedupeByVideoId(parsed.map((result, index) => ({
      ...result.record,
      nativePage: pageNumber,
      nativeOrder: index + 1
    })));
  }

  async function fetchFreshPage(pageNumber, context, signal) {
    const url = discovery.buildKvsPageUrl({
      pageNumber,
      origin: globalThis.location?.origin ?? "https://rule34video.com",
      blockId: context.blockId
    });
    let response;
    try {
      response = await scheduler.runWithPolicy({
        signal,
        request: () => fetch(url, { credentials: "include", cache: "no-store", signal })
      });
    } catch (error) {
      if (!networkFetchFailure(error)) throw error;
      response = await backgroundFetch(url, signal);
    }
    if (!response?.ok) {
      const error = new Error(Number(response?.status) === 429
        ? "Rule34Video temporarily limited requests. Recent Update can retry on a later page load."
        : `Could not read subscription page ${pageNumber} (HTTP ${Number(response?.status) || 0}).`);
      error.code = Number(response?.status) === 429 ? "http-429" : `http-${Number(response?.status) || 0}`;
      throw error;
    }
    return parsePage(await response.text(), pageNumber);
  }

  function mergeRecentPrefix(scannedIds, oldIds) {
    const result = [];
    const seen = new Set();
    for (const id of [...(scannedIds ?? []), ...(oldIds ?? [])]) {
      const key = String(id ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(key);
    }
    return result;
  }

  function reconcileRecentOrder(scannedIds, oldIds, { pagesChecked = 0, livePageCount = null, nativeTotal = null } = {}) {
    const conservativeOrder = mergeRecentPrefix(scannedIds, oldIds);
    const scanned = [...new Set([...(scannedIds ?? [])].map(String).filter(Boolean))];
    const verifiedPages = Number.isInteger(Number(livePageCount)) && Number(livePageCount) > 0
      ? Number(livePageCount)
      : null;
    const fullFeedScanned = Boolean(verifiedPages && Number(pagesChecked) >= verifiedPages);
    const total = Number.isInteger(Number(nativeTotal)) && Number(nativeTotal) > 0 ? Number(nativeTotal) : null;
    const totalConsistent = total === null || scanned.length === total;
    const authoritative = fullFeedScanned && totalConsistent;
    return {
      authoritative,
      orderedIds: authoritative ? scanned : conservativeOrder,
      nativeTotal: authoritative ? (total ?? scanned.length) : null,
      pageCount: authoritative ? verifiedPages : null
    };
  }

  async function appendHistory(status, state, summary = {}) {
    try {
      await db.appendHistory?.({
        kind: "catalogue-recent-update",
        status,
        startedAt: state?.smartUpdate?.startedAt ?? null,
        finishedAt: Date.now(),
        summary
      });
    } catch {
      // History must never turn a completed catalogue reconciliation into a failure.
    }
  }

  async function runRecentUpdate({ documentLike = document, signal, onProgress } = {}) {
    const existing = await base.refresh();
    if (!existing.catalogueReady) throw new Error("A completed catalogue is required before Recent Update.");

    const context = discovery.discoverFeed(documentLike);
    const oldIds = await db.getOrderedVideoIds();
    const oldSet = new Set(oldIds.map(String));
    const nativeTotal = Number(context.nativeTotal) || null;
    const livePageSize = Number(context.pageSize) || null;
    let pageSize = livePageSize || Number(existing.discoveredPageSize) || 24;
    // Stored page count is useful as a conservative scan bound, but it is not
    // current-feed evidence and must never authorize deletion of older Local IDs.
    const livePageCount = Number(context.pageCount)
      || (nativeTotal && livePageSize ? parsing.calculatePageCount(nativeTotal, livePageSize) : null)
      || null;
    const configuredLimit = configuredPageLimit();
    // If the current page does not expose a verified end, honor the configured
    // depth instead of capping it to a possibly stale page count from an older run.
    const limit = Math.max(1, Math.min(configuredLimit, livePageCount || configuredLimit));
    const sessionId = createSessionId();
    const startedAt = Date.now();
    const scannedIds = [];
    let pagesChecked = 0;
    let currentPage = null;

    await db.clearSmartUpdateStage();
    let smart = {
      status: "running",
      updateMode: "recent",
      sessionId,
      currentPage: null,
      nextPage: 1,
      pagesChecked: 0,
      consecutiveKnownPages: 0,
      newVideos: 0,
      pageLimit: limit,
      startedAt,
      activeRunStartedAt: startedAt,
      completedAt: null,
      lastError: null
    };
    await db.putCatalogueState({
      scanStatus: "complete",
      scanKind: "recent-update",
      smartUpdate: smart,
      lastError: null
    });

    try {
      for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
        if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
        currentPage = pageNumber;
        smart = { ...smart, currentPage: pageNumber, nextPage: pageNumber };
        await db.putCatalogueState({ smartUpdate: smart });

        const records = await fetchFreshPage(pageNumber, context, signal);
        if (!records.length) {
          if (pageNumber === 1) {
            const error = new Error("The newest subscription page did not contain readable video cards.");
            error.code = "no-readable-video-cards";
            throw error;
          }
          break;
        }
        if (!Number(context.pageSize) && !Number(existing.discoveredPageSize) && pageNumber === 1) {
          pageSize = Math.max(1, records.length);
        }
        await db.stageSmartUpdatePage({ sessionId, pageNumber, records });
        scannedIds.push(...records.map((record) => String(record.videoId)));
        pagesChecked += 1;
        smart = {
          ...smart,
          currentPage: null,
          nextPage: pageNumber + 1,
          pagesChecked,
          newVideos: new Set(scannedIds.filter((id) => !oldSet.has(id))).size
        };
        await db.putCatalogueState({ smartUpdate: smart });
        onProgress?.({
          updateMode: "recent",
          completed: pagesChecked,
          total: limit,
          pageNumber,
          pagesChecked,
          pageLimit: limit,
          newVideos: smart.newVideos
        });
        currentPage = null;
        if (livePageCount && pageNumber >= livePageCount) break;
      }

      if (!pagesChecked) {
        const error = new Error("Recent Update did not scan any subscription pages.");
        error.code = "recent-update-empty";
        throw error;
      }

      // A partial Recent Update is conservative: refreshed pages replace only the
      // newest prefix and older Local IDs stay behind it. If the *current live*
      // paginator proves that every native page was scanned, the result becomes
      // authoritative and stale/deleted Local IDs may safely be removed.
      const order = reconcileRecentOrder(scannedIds, oldIds, {
        pagesChecked,
        livePageCount,
        nativeTotal
      });
      const orderedIds = order.orderedIds;
      const exactNativeTotal = order.nativeTotal;
      const completedAt = Date.now();
      smart = {
        ...smart,
        status: "complete",
        currentPage: null,
        nextPage: pagesChecked + 1,
        activeRunStartedAt: null,
        completedAt,
        lastError: null
      };
      const counts = await db.finalizeSmartUpdateReconciliation({
        sessionId,
        orderedVideoIds: orderedIds,
        pageSize,
        nativeTotal: exactNativeTotal,
        pageCount: order.pageCount,
        smartUpdate: smart,
        completedAt
      });
      await appendHistory("complete", { smartUpdate: smart }, {
        indexed: counts.indexedCount,
        pagesChecked,
        configuredPageLimit: configuredLimit,
        newVideos: smart.newVideos,
        updateMode: "recent"
      });
      return base.refresh();
    } catch (error) {
      const stopped = isAbort(error);
      smart = {
        ...smart,
        status: stopped ? "paused" : "failed",
        currentPage: null,
        activeRunStartedAt: null,
        lastError: stopped ? null : safeError(error, currentPage)
      };
      await db.putCatalogueState({ smartUpdate: smart, catalogueReady: true });
      await db.clearSmartUpdateStage(sessionId).catch(() => {});
      await appendHistory(stopped ? "stopped" : "failed", { smartUpdate: smart }, {
        pagesChecked,
        configuredPageLimit: configuredLimit,
        error: smart.lastError?.code ?? null,
        updateMode: "recent"
      });
      return base.refresh();
    }
  }

  app.modules.catalogueScanner = Object.freeze({
    ...base,
    runRecentUpdate,
    recentPageLimit: () => configuredPageLimit()
  });
  app.modules.boundedRecentUpdate = Object.freeze({
    MIN_PAGES,
    MAX_PAGES,
    configuredPageLimit,
    mergeRecentPrefix,
    reconcileRecentOrder,
    runRecentUpdate,
    fetchFreshPage,
    parsePage
  });
})();
