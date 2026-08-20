(() => {
  "use strict";

  const app = globalThis.R34MF;
  const db = app?.modules.db;
  const discovery = app?.modules.feedDiscovery;
  const cardParser = app?.modules.cardParser;
  const parsing = app?.modules.catalogueParsing;
  const scheduler = app?.modules.requestScheduler;
  const reconciliation = app?.modules.catalogueReconciliation;
  const browserApi = app?.modules.browserApi;
  if (!app || !db || !discovery || !cardParser || !parsing || !scheduler || !reconciliation) {
    throw new Error("R34MF catalogue dependencies must load before catalogue scanner.");
  }

  const listeners = new Set();
  let activeController = null;
  let snapshot = db.defaultCatalogueState();

  function safeError(error, pageNumber = null) {
    return {
      code: error?.code ?? "scan-request-failed",
      pageNumber,
      message: String(error?.message ?? error ?? "Could not read the subscription page.").slice(0, 180)
    };
  }

  function isAbort(error) {
    return error?.name === "AbortError";
  }

  function createSessionId() {
    return globalThis.crypto?.randomUUID?.() ?? `scan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function emit(state = snapshot) {
    snapshot = { ...state };
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  async function refresh() {
    const state = await db.getCatalogueState();
    const [indexedCount, detailedCount, pages] = await Promise.all([db.countVideos(), db.countDetailedVideos(), db.listPageCheckpoints()]);
    const reconciled = reconciliation.reconcileCatalogueState(state, { indexedCount, detailedCount, pages });
    const changed = ["indexedCount", "detailedCount", "catalogueReady", "scanStatus", "pagesCompleted"].some((key) => state[key] !== reconciled[key]);
    const synchronized = changed ? await db.putCatalogueState({
      indexedCount: reconciled.indexedCount,
      detailedCount: reconciled.detailedCount,
      catalogueReady: reconciled.catalogueReady,
      scanStatus: reconciled.scanStatus,
      pagesCompleted: reconciled.pagesCompleted
    }) : state;
    return emit({ ...reconciled, ...synchronized, availability: reconciled.availability, usable: reconciled.usable, resumable: reconciled.resumable, hasCatalogue: reconciled.catalogueReady === true });
  }

  async function initialize() {
    await db.normalizeInterruptedState();
    return refresh();
  }

  function planResume(state, pages) {
    const complete = new Set(pages
      .filter((page) => page.status === "complete" && page.sessionId === state.sessionId)
      .map((page) => page.pageNumber));
    const pageCount = Number(state.discoveredPageCount) || null;
    const nextPage = pageCount
      ? Array.from({ length: pageCount }, (_, index) => index + 1).find((page) => !complete.has(page)) ?? pageCount + 1
      : Math.max(1, Number(state.nextPage) || 1);
    return { complete, nextPage, pagesCompleted: complete.size };
  }

  function inspectResponseDocument(documentLike, pageNumber) {
    const structure = discovery.findSubscriptionsGrid(documentLike);
    if (!structure.structureValid) {
      return { structureValid: false, gridChildCount: 0, cards: [], records: [], parseFailures: [], duplicateVideoIds: [] };
    }
    const cards = discovery.extractCards(documentLike);
    const parsed = cards.map((card, index) => ({
      nativeOrder: index + 1,
      ...cardParser.parseCard(card, { pageNumber, nativeOrder: index + 1 })
    }));
    const parseFailures = parsed.filter((result) => !result.ok)
      .map(({ nativeOrder, reason }) => ({ nativeOrder, reason: reason ?? "unreadable-video-identity" }));
    const identities = parsed.filter((result) => result.ok).map((result) => result.record);
    const counts = new Map();
    identities.forEach((record) => counts.set(record.videoId, (counts.get(record.videoId) ?? 0) + 1));
    const duplicateVideoIds = [...counts].filter(([, count]) => count > 1).map(([videoId]) => videoId);
    return {
      structureValid: true,
      gridChildCount: structure.grid.children?.length ?? 0,
      cards,
      records: parsing.dedupeByVideoId(identities),
      parseFailures,
      duplicateVideoIds
    };
  }

  function parseResponse(html, pageNumber) {
    const documentLike = new DOMParser().parseFromString(html, "text/html");
    return inspectResponseDocument(documentLike, pageNumber);
  }

  function responseError(parsed, pageNumber) {
    if (!parsed.structureValid) {
      const error = new Error(`Subscription page ${pageNumber} did not contain the expected subscription grid.`);
      error.code = "missing-subscription-grid";
      return error;
    }
    if (parsed.parseFailures.length) {
      const error = new Error(`Could not identify ${parsed.parseFailures.length} video card${parsed.parseFailures.length === 1 ? "" : "s"} on subscription page ${pageNumber}.`);
      error.code = "partial-video-identity";
      return error;
    }
    return null;
  }

  function listingDiagnostics(parsed, pageNumber) {
    return {
      pageNumber,
      expectedGridPresent: parsed.structureValid,
      gridChildCount: parsed.gridChildCount,
      candidateVideoCount: parsed.cards.length,
      parsedIdentityCount: parsed.records.length,
      parseFailureCount: parsed.parseFailures.length,
      duplicateCount: parsed.duplicateVideoIds.length
    };
  }

  function isTerminalEmptyPage(parsed, pageNumber, knownPageCount) {
    return parsed.structureValid
      && parsed.cards.length === 0
      && parsed.parseFailures.length === 0
      && pageNumber > 1
      && (!knownPageCount || pageNumber > knownPageCount);
  }

  function networkFetchFailure(error) {
    return error instanceof TypeError || /failed to fetch|networkerror|network request|load failed/i.test(String(error?.message ?? error ?? ""));
  }

  function proxyResponse(payload) {
    return {
      ok: payload?.ok === true,
      status: Number(payload?.status) || 0,
      headers: { get(name) { return String(name).toLowerCase() === "retry-after" ? payload?.retryAfter ?? null : null; } },
      async text() { return String(payload?.text ?? ""); }
    };
  }

  async function backgroundFetch(url, signal) {
    if (typeof browserApi?.runtimeSendMessage !== "function") {
      const error = new Error("Direct catalogue request failed and no extension fetch fallback is available.");
      error.code = "network-fetch-failed";
      throw error;
    }
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

  function currentDocumentSnapshot(pageNumber, context, documentLike) {
    if (!documentLike || pageNumber !== 1) return null;
    try {
      const currentPage = Number(context?.currentPageNumber)
        || (typeof discovery.pageFromText === "function" ? discovery.pageFromText(globalThis.location?.search ?? "") : 1)
        || 1;
      if (currentPage !== 1) return null;
      const parsed = inspectResponseDocument(documentLike, 1);
      return !responseError(parsed, 1) && parsed.records.length ? parsed : null;
    } catch {
      // Native page reuse is only an optimization. Incomplete DOM/discovery
      // evidence must fall through to the normal authenticated request path.
      return null;
    }
  }

  async function fetchPage(pageNumber, context, signal, documentLike = null) {
    const current = currentDocumentSnapshot(pageNumber, context, documentLike);
    if (current) return current;
    const url = discovery.buildKvsPageUrl({ pageNumber, origin: globalThis.location?.origin ?? "https://rule34video.com", blockId: context.blockId });
    let response;
    try {
      response = await scheduler.runWithPolicy({ signal, request: () => fetch(url, { credentials: "include", cache: "no-store", signal }) });
    } catch (error) {
      if (!networkFetchFailure(error)) throw error;
      response = await backgroundFetch(url, signal);
    }
    if (!response.ok) {
      const error = new Error(response.status === 429
        ? "Rule34Video temporarily limited requests. Resume the scan after waiting."
        : `Could not read subscription page ${pageNumber} (HTTP ${response.status}).`);
      error.code = response.status === 429 ? "http-429" : `http-${response.status}`;
      throw error;
    }
    return parseResponse(await response.text(), pageNumber);
  }

  async function recordTerminal(status, state, summary = {}) {
    const finishedAt = Date.now();
    await db.appendHistory({
      kind: state.scanKind === "full-rescan" ? "full-catalogue-rescan" : state.scanKind === "recent-update" ? "catalogue-recent-update" : state.scanKind === "smart-update" ? "catalogue-update" : "initial-catalogue-scan",
      status,
      startedAt: state.startedAt,
      finishedAt,
      summary
    });
  }

  async function runSmartUpdate({ documentLike = document, signal: suppliedSignal, onProgress } = {}) {
    if (activeController && !suppliedSignal) return snapshot;
    const existing = await refresh();
    if (!existing.catalogueReady) throw new Error("A completed catalogue is required before Smart Update.");
    const context = discovery.discoverFeed(documentLike);
    const previous = existing.smartUpdate ?? {};
    const resume = previous.updateMode !== "recent" && (previous.status === "paused" || (previous.status === "failed" && previous.lastError?.code !== "smart-update-reconciliation-required")) && previous.sessionId;
    const sessionId = resume ? previous.sessionId : createSessionId();
    const now = Date.now();
    if (!resume) await db.clearSmartUpdateStage();
    const staged = resume ? await db.listSmartUpdateStage(sessionId) : [];
    const oldIds = await db.getOrderedVideoIds();
    const scannedIds = staged.flatMap((page) => page.records ?? []).map((record) => String(record.videoId));
    const pageSize = Number(context.pageSize) || Number(existing.discoveredPageSize) || 24;
    const nativeTotal = Number(context.nativeTotal) || null;
    const currentNativePageCount = Number(context.pageCount) || (nativeTotal ? parsing.calculatePageCount(nativeTotal, pageSize) : null) || null;
    const nativePageCount = currentNativePageCount || Number(existing.discoveredPageCount) || null;
    const oldSet = new Set(oldIds.map(String));
    let smart = {
      status: "running", updateMode: "smart", sessionId, currentPage: null, nextPage: staged.length ? staged.at(-1).pageNumber + 1 : 1,
      pagesChecked: staged.length, consecutiveKnownPages: resume ? Number(previous.consecutiveKnownPages) || 0 : 0,
      newVideos: new Set(scannedIds.filter((id) => !oldSet.has(id))).size,
      nativePageCount, knownOverlapThreshold: Math.max(1, Number(app.modules.settings?.value?.advanced?.smartUpdateKnownPageThreshold) || 3),
      startedAt: resume ? previous.startedAt ?? now : now, activeRunStartedAt: now, completedAt: null, lastError: null
    };
    const scale = {
      ...(nativeTotal ? { discoveredNativeTotal: nativeTotal } : {}),
      ...(nativePageCount ? { discoveredPageCount: nativePageCount } : {}),
      ...(pageSize ? { discoveredPageSize: pageSize } : {})
    };
    const running = await db.putCatalogueState({ scanStatus: "complete", scanKind: "smart-update", smartUpdate: smart, lastError: null, ...scale });
    emit({ ...running, hasCatalogue: true });
    const controller = suppliedSignal ? null : new AbortController();
    activeController = controller; const signal = suppliedSignal ?? controller.signal;
    const threshold = smart.knownOverlapThreshold;
    const safetyPageCount = nativePageCount || 1000;
    try {
      for (let pageNumber = smart.nextPage; pageNumber <= safetyPageCount; pageNumber += 1) {
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        smart = { ...smart, currentPage: pageNumber, nextPage: pageNumber, activeRunStartedAt: smart.activeRunStartedAt };
        emit({ ...(await db.putCatalogueState({ smartUpdate: smart })), hasCatalogue: true });
        const parsed = await fetchPage(pageNumber, context, signal, documentLike); const parsingError = responseError(parsed, pageNumber);
        if (parsingError || !parsed.records.length) throw parsingError ?? Object.assign(new Error("Subscription page did not contain readable video cards."), { code: "no-readable-video-cards" });
        await db.stageSmartUpdatePage({ sessionId, pageNumber, records: parsed.records });
        scannedIds.push(...parsed.records.map((record) => String(record.videoId)));
        const minimumRun = Math.max(3, threshold * pageSize);
        const reachedEnd = Boolean(currentNativePageCount && pageNumber >= currentNativePageCount);
        const order = reconciliation.smartUpdateOrder({ scannedIds, oldIds, nativeTotal, minimumRun, reachedEnd });
        const streak = Math.floor(Number(order.overlap?.runLength ?? 0) / pageSize);
        smart = { ...smart, currentPage: null, nextPage: pageNumber + 1, pagesChecked: smart.pagesChecked + 1, consecutiveKnownPages: streak, newVideos: new Set(scannedIds.filter((id) => !oldSet.has(id))).size };
        const updated = await db.putCatalogueState({ smartUpdate: smart, ...scale }); emit({ ...updated, hasCatalogue: true });
        onProgress?.({ completed: pageNumber, total: nativePageCount, pageNumber, nativePageCount, pagesChecked: smart.pagesChecked, indexedCount: existing.indexedCount, knownStreak: streak, knownThreshold: threshold, newVideos: smart.newVideos });
        if (order.ready) {
          const completedAt = Date.now(); smart = { ...smart, status: "complete", currentPage: null, activeRunStartedAt: null, completedAt };
          const counts = await db.finalizeSmartUpdateReconciliation({ sessionId, orderedVideoIds: order.orderedIds, pageSize, nativeTotal, pageCount: nativePageCount, smartUpdate: smart, completedAt });
          const complete = await db.getCatalogueState(); await recordTerminal("complete", complete, { indexed: counts.indexedCount, pagesChecked: smart.pagesChecked, newVideos: smart.newVideos }); return refresh();
        }
        if (reachedEnd) {
          const error = new Error(order.reason === "native-total-mismatch" ? "Smart Update could not reconcile the canonical order to the current native video total. Run a Full catalogue rescan." : "Smart Update could not prove a stable ordered overlap. Run a Full catalogue rescan.");
          error.code = "smart-update-reconciliation-required"; throw error;
        }
      }
      throw new Error("Smart Update reached its safety page limit.");
    } catch (error) {
      const stopped = isAbort(error); const status = stopped ? "paused" : "failed";
      smart = { ...smart, status, currentPage: null, activeRunStartedAt: null, lastError: stopped ? null : safeError(error, smart.currentPage) };
      const state = await db.putCatalogueState({ smartUpdate: smart, catalogueReady: true });
      await recordTerminal(stopped ? "stopped" : "failed", state, { pagesChecked: smart.pagesChecked, error: smart.lastError?.code }); return refresh();
    } finally { if (activeController === controller) activeController = null; }
  }

  function recentPageLimit({ nativeTotal, oldCount, pageSize, nativePageCount }) {
    const cap = Math.max(1, Math.min(25, Number(nativePageCount) || 25));
    if (!Number.isInteger(Number(nativeTotal)) || Number(nativeTotal) <= 0) return Math.min(cap, 10);
    const delta = Math.max(0, Number(nativeTotal) - Math.max(0, Number(oldCount) || 0));
    return Math.min(cap, Math.max(2, Math.ceil((delta + 1) / Math.max(1, Number(pageSize) || 24)) + 1));
  }

  async function runRecentUpdate({ documentLike = document, signal: suppliedSignal, onProgress } = {}) {
    const existing = await refresh();
    if (!existing.catalogueReady) throw new Error("A completed catalogue is required before Recent Update.");
    const context = discovery.discoverFeed(documentLike);
    const previous = existing.smartUpdate ?? {};
    const resume = previous.updateMode === "recent" && ["paused", "failed"].includes(previous.status) && previous.sessionId;
    const sessionId = resume ? previous.sessionId : createSessionId();
    if (!resume) await db.clearSmartUpdateStage();
    const staged = resume ? await db.listSmartUpdateStage(sessionId) : [];
    const oldIds = await db.getOrderedVideoIds();
    const scannedIds = staged.flatMap((page) => page.records ?? []).map((record) => String(record.videoId));
    const pageSize = Number(context.pageSize) || Number(existing.discoveredPageSize) || 24;
    const nativeTotal = Number(context.nativeTotal) || null;
    const nativePageCount = Number(context.pageCount) || (nativeTotal ? parsing.calculatePageCount(nativeTotal, pageSize) : null) || Number(existing.discoveredPageCount) || null;
    const limit = resume && Number(previous.recentPageLimit) > 0
      ? Math.min(25, Number(previous.recentPageLimit))
      : recentPageLimit({ nativeTotal, oldCount: oldIds.length, pageSize, nativePageCount });
    const oldSet = new Set(oldIds.map(String));
    const now = Date.now();
    let smart = {
      status: "running", updateMode: "recent", recentPageLimit: limit, sessionId,
      currentPage: null, nextPage: staged.length ? staged.at(-1).pageNumber + 1 : 1,
      pagesChecked: staged.length, consecutiveKnownPages: 0,
      newVideos: new Set(scannedIds.filter((id) => !oldSet.has(id))).size,
      nativePageCount, knownOverlapThreshold: 1,
      startedAt: resume ? previous.startedAt ?? now : now,
      activeRunStartedAt: now, completedAt: null, lastError: null
    };
    const scale = {
      ...(nativeTotal ? { discoveredNativeTotal: nativeTotal } : {}),
      ...(nativePageCount ? { discoveredPageCount: nativePageCount } : {}),
      ...(pageSize ? { discoveredPageSize: pageSize } : {})
    };
    emit({ ...(await db.putCatalogueState({ scanStatus: "complete", scanKind: "recent-update", smartUpdate: smart, lastError: null, ...scale })), hasCatalogue: true });
    const controller = suppliedSignal ? null : new AbortController();
    activeController = controller;
    const signal = suppliedSignal ?? controller.signal;

    try {
      for (let pageNumber = smart.nextPage; pageNumber <= limit; pageNumber += 1) {
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        smart = { ...smart, currentPage: pageNumber, nextPage: pageNumber };
        emit({ ...(await db.putCatalogueState({ smartUpdate: smart })), hasCatalogue: true });
        const parsed = await fetchPage(pageNumber, context, signal, documentLike);
        const parsingError = responseError(parsed, pageNumber);
        if (parsingError || !parsed.records.length) throw parsingError ?? Object.assign(new Error("Subscription page did not contain readable video cards."), { code: "no-readable-video-cards" });
        await db.stageSmartUpdatePage({ sessionId, pageNumber, records: parsed.records });
        scannedIds.push(...parsed.records.map((record) => String(record.videoId)));
        const reachedEnd = Boolean(nativePageCount && pageNumber >= nativePageCount);
        const order = reconciliation.recentUpdateOrder({ scannedIds, oldIds, nativeTotal, reachedEnd });
        smart = {
          ...smart,
          currentPage: null,
          nextPage: pageNumber + 1,
          pagesChecked: smart.pagesChecked + 1,
          consecutiveKnownPages: order.anchorIndex >= 0 ? 1 : 0,
          newVideos: new Set(scannedIds.filter((id) => !oldSet.has(id))).size
        };
        emit({ ...(await db.putCatalogueState({ smartUpdate: smart, ...scale })), hasCatalogue: true });
        onProgress?.({
          updateMode: "recent", completed: pageNumber, total: limit, pageNumber,
          recentPageLimit: limit, nativePageCount, pagesChecked: smart.pagesChecked,
          indexedCount: existing.indexedCount, newVideos: smart.newVideos
        });
        if (order.ready) {
          const completedAt = Date.now();
          smart = { ...smart, status: "complete", currentPage: null, activeRunStartedAt: null, completedAt };
          const counts = await db.finalizeSmartUpdateReconciliation({
            sessionId, orderedVideoIds: order.orderedIds, pageSize, nativeTotal,
            pageCount: nativePageCount, smartUpdate: smart, completedAt
          });
          const complete = await db.getCatalogueState();
          await recordTerminal("complete", complete, { indexed: counts.indexedCount, pagesChecked: smart.pagesChecked, newVideos: smart.newVideos, updateMode: "recent" });
          return refresh();
        }
        if (reachedEnd) break;
      }
      const error = new Error(`Recent Update did not find the newest Local video within the first ${limit} pages. Run Smart Update manually for a deeper reconciliation.`);
      error.code = "recent-anchor-not-found";
      throw error;
    } catch (error) {
      const stopped = isAbort(error);
      const status = stopped ? "paused" : "failed";
      smart = { ...smart, status, currentPage: null, activeRunStartedAt: null, lastError: stopped ? null : safeError(error, smart.currentPage) };
      const state = await db.putCatalogueState({ smartUpdate: smart, catalogueReady: true });
      await recordTerminal(stopped ? "stopped" : "failed", state, { pagesChecked: smart.pagesChecked, updateMode: "recent", error: smart.lastError?.code });
      return refresh();
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  async function run({ documentLike = document, fullRescan = false, smartUpdate = false, signal: suppliedSignal, onProgress } = {}) {
    if (smartUpdate) return runSmartUpdate({ documentLike, signal: suppliedSignal, onProgress });
    if (activeController) return snapshot;
    const existing = await refresh();
    const shouldResume = !fullRescan && ["paused", "failed"].includes(existing.scanStatus) && existing.sessionId;
    const context = discovery.discoverFeed(documentLike);
    const sessionId = shouldResume ? existing.sessionId : createSessionId();
    const pages = await db.listPageCheckpoints();
    const planned = shouldResume ? planResume(existing, pages) : { complete: new Set(), nextPage: 1, pagesCompleted: 0 };
    const initial = await db.putCatalogueState({
      scanStatus: "running",
      scanKind: fullRescan ? "full-rescan" : (shouldResume ? existing.scanKind ?? "initial" : "initial"),
      catalogueReady: existing.catalogueReady === true,
      sessionId,
      discoveredPageCount: context.pageCount,
      discoveredNativeTotal: context.nativeTotal,
      discoveredPageSize: context.pageSize,
      pagesCompleted: planned.pagesCompleted,
      currentPage: null,
      nextPage: planned.nextPage,
      indexedCount: existing.indexedCount,
      detailedCount: existing.detailedCount,
      startedAt: shouldResume ? existing.startedAt ?? Date.now() : Date.now(),
      activeRunStartedAt: Date.now(),
      completedAt: null,
      lastError: null
    });
    emit({ ...initial, hasCatalogue: initial.catalogueReady === true });
    const controller = suppliedSignal ? null : new AbortController();
    activeController = controller;
    const signal = suppliedSignal ?? controller.signal;
    const knownPageCount = Number(initial.discoveredPageCount) || null;
    const safetyLimit = knownPageCount ?? 1000;

    try {
      for (let pageNumber = planned.nextPage; pageNumber <= safetyLimit; pageNumber += 1) {
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        if (planned.complete.has(pageNumber)) continue;
        const running = await db.putCatalogueState({ currentPage: pageNumber, nextPage: pageNumber });
        emit({ ...running, hasCatalogue: running.catalogueReady === true });
        const parsed = await fetchPage(pageNumber, context, signal, documentLike);
        const parsingError = responseError(parsed, pageNumber);
        if (parsingError) {
          app.modules.logger?.warn("subscription-listing-parse-failed", listingDiagnostics(parsed, pageNumber));
          throw parsingError;
        }
        if (!parsed.records.length) {
          if (isTerminalEmptyPage(parsed, pageNumber, knownPageCount)) {
            const complete = await db.putCatalogueState({
              scanStatus: "complete", currentPage: null, nextPage: pageNumber, discoveredPageCount: pageNumber - 1,
              pagesCompleted: pageNumber - 1, completedAt: Date.now(), activeRunStartedAt: null, lastFullScanAt: Date.now(), catalogueReady: true, lastError: null
            });
            await recordTerminal("complete", complete, { indexed: await db.countVideos() });
            return refresh();
          }
          const error = new Error(`Subscription page ${pageNumber} did not contain readable video cards.`);
          error.code = "no-readable-video-cards";
          app.modules.logger?.warn("subscription-listing-parse-failed", listingDiagnostics(parsed, pageNumber));
          throw error;
        }
        const committed = await db.commitCompletedPage({
          pageNumber,
          records: parsed.records,
          sessionId,
          stateChanges: { currentPage: null, nextPage: pageNumber + 1, pagesCompleted: planned.pagesCompleted + 1 }
        });
        planned.pagesCompleted += 1;
        const indexedCount = await db.countVideos();
        const current = await db.putCatalogueState(db.authoritativeCountChanges(indexedCount, snapshot.detailedCount));
        emit({ ...current, hasCatalogue: current.catalogueReady === true, lastPageRecordCount: committed.indexedOnPage });
        onProgress?.({ completed: planned.pagesCompleted, total: knownPageCount, pageNumber, indexedCount });
        if (knownPageCount && pageNumber >= knownPageCount) {
          if (fullRescan) await db.finalizeFullRescan({ sessionId, pageCount: knownPageCount });
          const finalCounts = db.authoritativeCountChanges(await db.countVideos(), await db.countDetailedVideos());
          const complete = await db.putCatalogueState({
            scanStatus: "complete", currentPage: null, nextPage: pageNumber + 1, pagesCompleted: planned.pagesCompleted,
            ...finalCounts, completedAt: Date.now(), activeRunStartedAt: null, lastFullScanAt: Date.now(), catalogueReady: true, lastError: null
          });
          await recordTerminal("complete", complete, { indexed: finalCounts.indexedCount });
          return refresh();
        }
      }
      throw new Error("Subscription scan reached its safety page limit before finding an end.");
    } catch (error) {
      if (isAbort(error)) {
        const paused = await db.putCatalogueState({ scanStatus: "paused", currentPage: null, activeRunStartedAt: null, lastProgressAt: Date.now() });
        await recordTerminal("stopped", paused, { indexed: await db.countVideos(), pagesCompleted: paused.pagesCompleted });
        return refresh();
      }
      const pageNumber = (await db.getCatalogueState()).currentPage;
      const errorInfo = safeError(error, pageNumber);
      await db.markPageFailure(pageNumber ?? 0, errorInfo, { scanStatus: "failed", currentPage: null, activeRunStartedAt: null, lastError: errorInfo, sessionId });
      const failed = await db.getCatalogueState();
      await recordTerminal("failed", failed, { pagesCompleted: failed.pagesCompleted, error: errorInfo.code });
      return refresh();
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  function stop() {
    activeController?.abort();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  app.modules.catalogueScanner = Object.freeze({
    initialize,
    refresh,
    run,
    runSmartUpdate,
    runRecentUpdate,
    recentPageLimit,
    stop,
    subscribe,
    snapshot: () => ({ ...snapshot }),
    planResume,
    parseResponse,
    inspectResponseDocument,
    listingDiagnostics,
    isTerminalEmptyPage
  });
})();
