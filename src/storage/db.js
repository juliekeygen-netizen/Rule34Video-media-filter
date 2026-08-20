(() => {
  "use strict";

  const app = globalThis.R34MF;
  const constants = app?.modules.constants;
  if (!app || !constants) {
    throw new Error("R34MF constants must load before database.");
  }

  const STORES = Object.freeze({
    videos: "videos",
    videoDetails: "videoDetails",
    cataloguePages: "cataloguePages",
    smartUpdatePages: "smartUpdatePages",
    catalogueState: "catalogueState",
    jobHistory: "jobHistory"
  });

  let openPromise = null;
  let orderedIdsCache = null;
  const catalogueListeners = new Set();
  const detailListeners = new Set();
  const STATE_KEY = constants.database.catalogueStateKey;
  const HISTORY_LIMIT = 12;

  function defaultDetailsState() {
    return {
      status: "idle",
      sessionId: null,
      mode: "missing",
      targetCount: 0,
      processedCount: 0,
      completedCount: 0,
      failedCount: 0,
      startedAt: null,
      activeRunStartedAt: null,
      lastProgressAt: null,
      completedAt: null,
      lastError: null,
      phase: null,
      lastPreflight: null,
      lastCanary: null,
      systemicReason: null
    };
  }

  function defaultCatalogueState() {
    return {
      key: STATE_KEY,
      scanStatus: "not-scanned",
      catalogueReady: false,
      indexedCount: 0,
      detailedCount: 0,
      discoveredPageCount: null,
      discoveredNativeTotal: null,
      discoveredPageSize: null,
      pagesCompleted: 0,
      currentPage: null,
      nextPage: 1,
      startedAt: null,
      activeRunStartedAt: null,
      lastProgressAt: null,
      completedAt: null,
      lastFullScanAt: null,
      lastSmartUpdateAt: null,
      lastCatalogueUpdateAt: null,
      smartUpdate: {
        status: "idle", sessionId: null, currentPage: null, nextPage: 1,
        pagesChecked: 0, consecutiveKnownPages: 0, newVideos: 0,
        startedAt: null, activeRunStartedAt: null, completedAt: null, lastError: null
      },
      detailsState: defaultDetailsState(),
      sessionId: null,
      lastError: null,
      schemaVersion: 1
    };
  }

  function mergeListingRecord(existing, incoming, now = Date.now()) {
    return {
      ...incoming,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      listingUpdatedAt: now
    };
  }

  function deriveCatalogueState(state, changes = {}) {
    const next = { ...defaultCatalogueState(), ...(state ?? {}), ...changes, key: STATE_KEY };
    next.detailsState = { ...defaultDetailsState(), ...(state?.detailsState ?? {}), ...(changes.detailsState ?? {}) };
    return next;
  }

  function authoritativeCountChanges(indexedCount, detailedCount) {
    return {
      indexedCount: Math.max(0, Number(indexedCount) || 0),
      detailedCount: Math.max(0, Number(detailedCount) || 0)
    };
  }

  function orderedVideoIdsFromManifests(manifests, videos = []) {
    const ids = []; const seen = new Set();
    for (const manifest of [...(manifests ?? [])].filter((item) => item?.status === "complete" && Number.isInteger(item.pageNumber)).sort((a, b) => a.pageNumber - b.pageNumber)) {
      for (const id of manifest.videoIds ?? []) if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    const orphans = [...(videos ?? []).filter((video) => video?.videoId && !seen.has(video.videoId))]
      .sort((a, b) => Number(a.nativePage ?? Infinity) - Number(b.nativePage ?? Infinity) || Number(a.nativeOrder ?? Infinity) - Number(b.nativeOrder ?? Infinity) || String(a.videoId).localeCompare(String(b.videoId)));
    return ids.concat(orphans.map((video) => video.videoId));
  }

  function invalidateCatalogueOrder() { orderedIdsCache = null; catalogueListeners.forEach((listener) => listener()); }
  function subscribeCatalogueChanges(listener) { catalogueListeners.add(listener); return () => catalogueListeners.delete(listener); }
  function notifyDetailChanges(change) { detailListeners.forEach((listener) => listener(change)); }
  function subscribeDetailChanges(listener) { detailListeners.add(listener); return () => detailListeners.delete(listener); }

  function normalizeCompleteDetail(record, now = Date.now()) {
    const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const formats = [...(Array.isArray(record?.formats) ? record.formats : [])].map((format) => ({
      ...(text(format?.name) ? { name: text(format.name) } : {}),
      ...(text(format?.format) ? { format: text(format.format) } : {}),
      ...(text(format?.quality) ? { quality: text(format.quality) } : {}),
      ...(text(format?.resolution) ? { resolution: text(format.resolution) } : {})
    })).filter((format) => Object.keys(format).length);
    const list = (values) => {
      const seen = new Set();
      return [...(Array.isArray(values) ? values : [])].map(text).filter((value) => {
        const key = value.toLocaleLowerCase();
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const artists = list(Array.isArray(record?.artists) && record.artists.length ? record.artists : record?.artist ? [record.artist] : []);
    const uploaders = list(Array.isArray(record?.uploaders) && record.uploaders.length ? record.uploaders : record?.uploader ? [record.uploader] : []);
    const artistRefs = [...(Array.isArray(record?.artistRefs) ? record.artistRefs : [])].map((ref) => ({ key: text(ref?.key).toLocaleLowerCase(), name: text(ref?.name), url: text(ref?.url) }))
      .filter((ref, index, all) => ref.key && ref.name && /^https?:\/\/(?:www\.)?rule34video\.com\/models\/[^/]+\/$/i.test(ref.url) && all.findIndex((item) => item.key === ref.key) === index);
    const entityTrust = Object.fromEntries(["artist", "uploader", "tags", "categories"].map((field) => [field, record?.entityTrust?.[field] === true]));
    return {
      videoId: String(record?.videoId ?? "").trim(),
      artist: artists[0] ?? null,
      artists,
      artistRefs,
      uploader: uploaders[0] ?? null,
      uploaders,
      tags: list(record?.tags),
      categories: list(record?.categories),
      entityTrust,
      description: String(record?.description ?? "").trim(),
      exactUploadDate: record?.exactUploadDate ? String(record.exactUploadDate) : null,
      commentsCount: record?.commentsCount === null || record?.commentsCount === undefined
        ? null
        : Number.isFinite(Number(record.commentsCount)) ? Math.max(0, Number(record.commentsCount)) : null,
      formats,
      status: "complete",
      fetchedAt: Number(record?.fetchedAt) || now,
      schemaVersion: Number(record?.schemaVersion) || 1,
      failureCount: Math.max(0, Number(record?.failureCount) || 0),
      lastAttemptAt: Number(record?.lastAttemptAt) || now,
      lastAttemptError: null,
      lastError: null
    };
  }

  function mergeDetailFailure(existing, error, now = Date.now()) {
    const safe = {
      code: String(error?.code ?? "detail-request-failed").slice(0, 80),
      message: String(error?.message ?? "Detailed metadata could not be fetched.").slice(0, 240),
      ...(Number.isFinite(Number(error?.httpStatus)) ? { httpStatus: Number(error.httpStatus) } : {})
    };
    if (existing?.status === "complete") {
      return { ...existing, lastAttemptAt: now, lastAttemptError: safe, failureCount: Math.max(0, Number(existing.failureCount) || 0) + 1 };
    }
    return {
      videoId: String(existing?.videoId ?? error?.videoId ?? ""),
      status: "failed",
      attemptedAt: now,
      lastAttemptAt: now,
      failureCount: Math.max(0, Number(existing?.failureCount) || 0) + 1,
      lastError: safe
    };
  }

  function mergeCompleteDetail(existing, record, now = Date.now()) {
    return normalizeCompleteDetail({
      ...record,
      failureCount: Math.max(0, Number(existing?.failureCount) || 0)
    }, now);
  }

  function missingDetailTargets(videos, details, limit = null) {
    if (limit !== null && Number.isInteger(Number(limit)) && Number(limit) === 0) return [];
    const complete = new Set([...(details ?? [])].filter((detail) => detail?.status === "complete").map((detail) => String(detail.videoId)));
    const seen = new Set();
    const targets = [];
    for (const video of videos ?? []) {
      const id = String(video?.videoId ?? "");
      if (!id || seen.has(id) || complete.has(id)) continue;
      seen.add(id);
      targets.push(video);
      if (limit !== null && Number.isInteger(Number(limit)) && Number(limit) >= 0 && targets.length >= Number(limit)) break;
    }
    return targets;
  }

  function interruptedStateChanges(state, now = Date.now()) {
    const scanInterrupted = state?.scanStatus === "running";
    const detailsInterrupted = state?.detailsState?.status === "running";
    const smartInterrupted = state?.smartUpdate?.status === "running";
    if (!scanInterrupted && !detailsInterrupted && !smartInterrupted) return null;
    return {
      ...(scanInterrupted ? {
        scanStatus: "paused",
        currentPage: null,
        activeRunStartedAt: null,
        lastProgressAt: now,
        lastError: { code: "runtime-interrupted", message: "Scan paused because the page runtime ended." }
      } : {}),
      ...(detailsInterrupted ? {
        detailsState: {
          ...state.detailsState,
          status: "paused",
          activeRunStartedAt: null,
          lastProgressAt: now,
          lastError: { code: "runtime-interrupted", message: "Detailed metadata paused because the page runtime ended." }
        }
      } : {}),
      ...(smartInterrupted ? { smartUpdate: { ...state.smartUpdate, status: "paused", currentPage: null, activeRunStartedAt: null, lastError: { code: "runtime-interrupted", message: "Smart Update paused because the page runtime ended." } } } : {})
    };
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    });
  }

  function upgrade(db) {
    if (!db.objectStoreNames.contains(STORES.videos)) {
      const store = db.createObjectStore(STORES.videos, { keyPath: "videoId" });
      store.createIndex("lastSeenAt", "lastSeenAt");
    }

    if (!db.objectStoreNames.contains(STORES.videoDetails)) {
      const store = db.createObjectStore(STORES.videoDetails, { keyPath: "videoId" });
      store.createIndex("status", "status");
      store.createIndex("fetchedAt", "fetchedAt");
    }

    if (!db.objectStoreNames.contains(STORES.cataloguePages)) {
      db.createObjectStore(STORES.cataloguePages, { keyPath: "pageNumber" });
    }

    if (!db.objectStoreNames.contains(STORES.catalogueState)) {
      db.createObjectStore(STORES.catalogueState, { keyPath: "key" });
    }

    if (!db.objectStoreNames.contains(STORES.jobHistory)) {
      const store = db.createObjectStore(STORES.jobHistory, { keyPath: "id" });
      store.createIndex("finishedAt", "finishedAt");
    }

    if (!db.objectStoreNames.contains(STORES.smartUpdatePages)) {
      const store = db.createObjectStore(STORES.smartUpdatePages, { keyPath: "key" });
      store.createIndex("sessionId", "sessionId");
    }
  }

  function open() {
    if (openPromise) {
      return openPromise;
    }

    openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(constants.database.name, constants.database.version);

      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        openPromise = null;
        reject(request.error ?? new Error("Failed to open IndexedDB."));
      };
      request.onblocked = () => {
        app.modules.logger?.warn("indexeddb-open-blocked");
      };
    });

    return openPromise;
  }

  async function getCatalogueState() {
    const db = await open();
    const transaction = db.transaction(STORES.catalogueState, "readonly");
    const record = await requestPromise(transaction.objectStore(STORES.catalogueState).get(STATE_KEY));
    await transactionDone(transaction);
    return deriveCatalogueState(record);
  }

  async function putCatalogueState(changes) {
    const db = await open();
    const transaction = db.transaction(STORES.catalogueState, "readwrite");
    const store = transaction.objectStore(STORES.catalogueState);
    let next;
    const request = store.get(STATE_KEY);
    request.onsuccess = () => {
      next = deriveCatalogueState(request.result, changes);
      store.put(next);
    };
    await transactionDone(transaction);
    return next;
  }

  async function normalizeInterruptedState() {
    const state = await getCatalogueState();
    const changes = interruptedStateChanges(state);
    return changes ? putCatalogueState(changes) : state;
  }

  async function listPageCheckpoints() {
    const db = await open();
    const transaction = db.transaction(STORES.cataloguePages, "readonly");
    const pages = await requestPromise(transaction.objectStore(STORES.cataloguePages).getAll());
    await transactionDone(transaction);
    return pages.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  async function countVideos() {
    const db = await open();
    const transaction = db.transaction(STORES.videos, "readonly");
    const count = await requestPromise(transaction.objectStore(STORES.videos).count());
    await transactionDone(transaction);
    return count;
  }

  async function countDetailStatus(status) {
    const db = await open();
    const transaction = db.transaction([STORES.videos, STORES.videoDetails], "readonly");
    const [videos, details] = await Promise.all([
      requestPromise(transaction.objectStore(STORES.videos).getAllKeys()),
      requestPromise(transaction.objectStore(STORES.videoDetails).index("status").getAll(IDBKeyRange.only(status)))
    ]);
    await transactionDone(transaction);
    const current = new Set(videos.map(String));
    return details.filter((detail) => current.has(String(detail.videoId))).length;
  }

  async function countDetailedVideos() { return countDetailStatus("complete"); }
  async function countFailedDetails() { return countDetailStatus("failed"); }
  async function countOutdatedDetails() {
    const [videos, details] = await Promise.all([getAllLocalRecords(), listDetailRecords()]);
    const current = new Set(videos.records.map((video) => String(video.videoId)));
    return details.filter((detail) => detail?.status === "complete" && Number(detail.schemaVersion || 1) < 5 && current.has(String(detail.videoId))).length;
  }

  async function getDetail(videoId) {
    const db = await open();
    const transaction = db.transaction(STORES.videoDetails, "readonly");
    const record = await requestPromise(transaction.objectStore(STORES.videoDetails).get(String(videoId)));
    await transactionDone(transaction);
    return record ?? null;
  }

  async function getDetailsByIds(ids) {
    const requested = [...new Set([...(ids ?? [])].map(String))];
    if (!requested.length) return [];
    const db = await open();
    const transaction = db.transaction(STORES.videoDetails, "readonly");
    const store = transaction.objectStore(STORES.videoDetails);
    const records = await Promise.all(requested.map((id) => requestPromise(store.get(id))));
    await transactionDone(transaction);
    return records.filter(Boolean);
  }

  async function listDetailRecords() {
    const db = await open();
    const transaction = db.transaction(STORES.videoDetails, "readonly");
    const records = await requestPromise(transaction.objectStore(STORES.videoDetails).getAll());
    await transactionDone(transaction);
    return records;
  }

  async function synchronizeDetailedCount() {
    const detailedCount = await countDetailedVideos();
    await putCatalogueState({ detailedCount });
    return detailedCount;
  }

  async function writeCompleteDetail(record) {
    const id = String(record?.videoId ?? "").trim();
    if (!id) throw new TypeError("A completed detail record requires videoId.");
    const db = await open();
    const transaction = db.transaction(STORES.videoDetails, "readwrite");
    const store = transaction.objectStore(STORES.videoDetails);
    let normalized; let newlyComplete = false;
    const request = store.get(id);
    request.onsuccess = () => { newlyComplete = request.result?.status !== "complete"; normalized = mergeCompleteDetail(request.result, { ...record, videoId: id }); store.put(normalized); };
    await transactionDone(transaction);
    notifyDetailChanges({ type: "complete", videoId: normalized.videoId, newlyComplete });
    return { record: normalized, newlyComplete };
  }

  async function recordDetailFailure(videoId, error) {
    const id = String(videoId ?? "").trim();
    if (!id) throw new TypeError("A failed detail attempt requires videoId.");
    const db = await open();
    const transaction = db.transaction(STORES.videoDetails, "readwrite");
    const store = transaction.objectStore(STORES.videoDetails);
    const request = store.get(id);
    request.onsuccess = () => store.put(mergeDetailFailure(request.result ?? { videoId: id }, { ...error, videoId: id }));
    await transactionDone(transaction);
    const record = await getDetail(id);
    notifyDetailChanges({ type: "failed", videoId: id, preservedComplete: record?.status === "complete" });
    return record;
  }

  async function getMissingDetailTargets({ limit = null } = {}) {
    const source = await getAllLocalRecords();
    return missingDetailTargets(source.records, [...source.detailsById.values()], limit);
  }

  async function updateDetailsState(changes) {
    const state = await getCatalogueState();
    return putCatalogueState({ detailsState: { ...state.detailsState, ...changes } });
  }

  async function commitCompletedPage({ pageNumber, records, sessionId, stateChanges = {}, sourceFingerprint = null }) {
    const db = await open();
    const transaction = db.transaction([STORES.videos, STORES.cataloguePages, STORES.catalogueState], "readwrite");
    const videos = transaction.objectStore(STORES.videos);
    const pages = transaction.objectStore(STORES.cataloguePages);
    const states = transaction.objectStore(STORES.catalogueState);
    const now = Date.now();
    const unique = new Map();
    for (const record of records ?? []) if (record?.videoId) unique.set(record.videoId, record);
    const stateRequest = states.get(STATE_KEY);
    stateRequest.onsuccess = () => {
      const previous = deriveCatalogueState(stateRequest.result);
      states.put(deriveCatalogueState(previous, {
        ...stateChanges,
        pagesCompleted: Number(stateChanges.pagesCompleted ?? previous.pagesCompleted),
        lastProgressAt: now
      }));
    };
    for (const record of unique.values()) {
      const getRequest = videos.get(record.videoId);
      getRequest.onsuccess = () => videos.put(mergeListingRecord(getRequest.result, record, now));
    }
    pages.put({
      pageNumber,
      videoIds: [...unique.keys()],
      scannedAt: now,
      sourceFingerprint,
      sessionId,
      status: "complete",
      lastError: null
    });
    await transactionDone(transaction);
    invalidateCatalogueOrder();
    return { indexedOnPage: unique.size, committedAt: now };
  }

  async function stageSmartUpdatePage({ sessionId, pageNumber, records }) {
    if (!sessionId || !Number.isInteger(Number(pageNumber))) throw new TypeError("Smart Update staging requires a session and page number.");
    const db = await open(); const transaction = db.transaction(STORES.smartUpdatePages, "readwrite");
    transaction.objectStore(STORES.smartUpdatePages).put({ key: `${sessionId}:${pageNumber}`, sessionId, pageNumber: Number(pageNumber), records: [...(records ?? [])], stagedAt: Date.now() });
    await transactionDone(transaction);
  }

  async function listSmartUpdateStage(sessionId) {
    const db = await open(); const transaction = db.transaction(STORES.smartUpdatePages, "readonly");
    const rows = await requestPromise(transaction.objectStore(STORES.smartUpdatePages).getAll()); await transactionDone(transaction);
    return rows.filter((row) => row.sessionId === sessionId).sort((a, b) => a.pageNumber - b.pageNumber);
  }

  async function clearSmartUpdateStage(sessionId = null) {
    const db = await open(); const transaction = db.transaction(STORES.smartUpdatePages, "readwrite"); const store = transaction.objectStore(STORES.smartUpdatePages);
    if (!sessionId) store.clear(); else { const request = store.getAll(); request.onsuccess = () => request.result.filter((row) => row.sessionId === sessionId).forEach((row) => store.delete(row.key)); }
    await transactionDone(transaction);
  }

  async function finalizeSmartUpdateReconciliation({ sessionId, orderedVideoIds, pageSize, nativeTotal, pageCount, smartUpdate, completedAt = Date.now() }) {
    const ids = [...new Set([...(orderedVideoIds ?? [])].map(String).filter(Boolean))]; const size = Math.max(1, Number(pageSize) || 24);
    if (!ids.length || (Number(nativeTotal) > 0 && ids.length !== Number(nativeTotal))) throw new Error("Smart Update order does not match the trusted native total.");
    const staged = await listSmartUpdateStage(sessionId); const incoming = new Map(staged.flatMap((page) => page.records ?? []).map((record) => [String(record.videoId), record]));
    const db = await open(); const transaction = db.transaction([STORES.videos, STORES.videoDetails, STORES.cataloguePages, STORES.catalogueState], "readwrite");
    const videos = transaction.objectStore(STORES.videos); const details = transaction.objectStore(STORES.videoDetails); const pages = transaction.objectStore(STORES.cataloguePages); const states = transaction.objectStore(STORES.catalogueState); const idSet = new Set(ids);
    const allVideos = videos.getAll(); allVideos.onsuccess = () => {
      const existing = new Map(allVideos.result.map((record) => [String(record.videoId), record]));
      if (ids.some((id) => !incoming.has(id) && !existing.has(id))) { transaction.abort(); return; }
      ids.forEach((id, index) => { const prior = existing.get(id); const next = incoming.get(id) ?? prior; if (next) videos.put(mergeListingRecord(prior, { ...next, videoId: id, nativePage: Math.floor(index / size) + 1, nativeOrder: index % size + 1 }, completedAt)); });
      allVideos.result.filter((record) => !idSet.has(String(record.videoId))).forEach((record) => { videos.delete(record.videoId); details.delete(record.videoId); });
    };
    const allPages = pages.getAll(); allPages.onsuccess = () => { allPages.result.forEach((page) => pages.delete(page.pageNumber)); for (let index = 0; index < ids.length; index += size) { const pageNumber = Math.floor(index / size) + 1; pages.put({ pageNumber, videoIds: ids.slice(index, index + size), scannedAt: completedAt, sessionId, status: "complete", lastError: null }); } };
    let detailedCount = 0; const allDetails = details.getAll(); allDetails.onsuccess = () => { detailedCount = allDetails.result.filter((detail) => detail.status === "complete" && idSet.has(String(detail.videoId))).length; };
    const stateRequest = states.get(STATE_KEY); stateRequest.onsuccess = () => states.put(deriveCatalogueState(stateRequest.result, {
      indexedCount: ids.length, detailedCount, discoveredNativeTotal: Number(nativeTotal) || ids.length,
      discoveredPageSize: size, discoveredPageCount: Number(pageCount) || Math.ceil(ids.length / size), pagesCompleted: Math.ceil(ids.length / size),
      smartUpdate, scanStatus: "complete", scanKind: "smart-update", catalogueReady: true,
      lastSmartUpdateAt: completedAt, lastCatalogueUpdateAt: completedAt
    }));
    await transactionDone(transaction); await clearSmartUpdateStage(sessionId); invalidateCatalogueOrder();
    return { indexedCount: ids.length, detailedCount, pageCount: Math.ceil(ids.length / size) };
  }

  async function getOrderedVideoIds() {
    if (orderedIdsCache) return [...orderedIdsCache];
    const db = await open();
    const transaction = db.transaction([STORES.cataloguePages, STORES.videos], "readonly");
    const [manifests, videos] = await Promise.all([requestPromise(transaction.objectStore(STORES.cataloguePages).getAll()), requestPromise(transaction.objectStore(STORES.videos).getAll())]);
    await transactionDone(transaction);
    orderedIdsCache = orderedVideoIdsFromManifests(manifests, videos);
    return [...orderedIdsCache];
  }

  async function getVideosByIds(ids) {
    const requested = [...(ids ?? [])]; if (!requested.length) return [];
    const db = await open(); const transaction = db.transaction(STORES.videos, "readonly"); const store = transaction.objectStore(STORES.videos);
    const records = await Promise.all(requested.map((id) => requestPromise(store.get(id))));
    await transactionDone(transaction); return records.filter(Boolean);
  }

  async function repairThumbnail(videoId, thumbnailUrl) {
    if (!videoId || typeof thumbnailUrl !== "string" || !/^https?:/i.test(thumbnailUrl)) return false;
    const db = await open(); const transaction = db.transaction(STORES.videos, "readwrite"); const store = transaction.objectStore(STORES.videos); const request = store.get(videoId);
    request.onsuccess = () => {
      const record = request.result;
      // A parser-provided source is authoritative.  Only heal records that have no
      // usable static source, and do not repeatedly rewrite an already repaired one.
      const hasVerifiedSource = [record?.thumbnailPreferredUrl, record?.thumbnailUrl, record?.thumbnailFallbackUrl].some((value) => typeof value === "string" && /^https?:/i.test(value));
      if (record && !hasVerifiedSource) store.put({ ...record, thumbnailUrl, thumbnailFallbackUrl: thumbnailUrl, thumbnailRepairedAt: Date.now() });
    };
    await transactionDone(transaction);
    return true;
  }

  async function getAllLocalRecords() {
    const ids = await getOrderedVideoIds();
    const db = await open(); const transaction = db.transaction([STORES.videos, STORES.videoDetails], "readonly");
    const [videos, details] = await Promise.all([requestPromise(transaction.objectStore(STORES.videos).getAll()), requestPromise(transaction.objectStore(STORES.videoDetails).getAll())]);
    await transactionDone(transaction);
    const byId = new Map(videos.map((video) => [video.videoId, video]));
    return { records: ids.map((id) => byId.get(id)).filter(Boolean), detailsById: new Map(details.map((detail) => [detail.videoId, detail])) };
  }

  async function getLocalPage({ page = 1, pageSize = 24 } = {}) {
    const ids = await getOrderedVideoIds(); const size = [24, 48, 72].includes(Number(pageSize)) ? Number(pageSize) : 24;
    const pageCount = Math.max(1, Math.ceil(ids.length / size)); const currentPage = Math.min(pageCount, Math.max(1, Number(page) || 1));
    return { ids, records: await getVideosByIds(ids.slice((currentPage - 1) * size, currentPage * size)), total: ids.length, page: currentPage, pageCount, pageSize: size };
  }

  async function markPageFailure(pageNumber, error, changes = {}) {
    const db = await open();
    const transaction = db.transaction([STORES.cataloguePages, STORES.catalogueState], "readwrite");
    const pageStore = transaction.objectStore(STORES.cataloguePages);
    const existing = pageStore.get(pageNumber);
    existing.onsuccess = () => pageStore.put(existing.result?.status === "complete" ? {
      ...existing.result,
      lastAttemptError: error,
      lastAttemptAt: Date.now(),
      lastAttemptSessionId: changes.sessionId ?? null
    } : { pageNumber, videoIds: [], scannedAt: Date.now(), sessionId: changes.sessionId ?? null, status: "failed", lastError: error });
    const stateStore = transaction.objectStore(STORES.catalogueState);
    const request = stateStore.get(STATE_KEY);
    request.onsuccess = () => stateStore.put(deriveCatalogueState(request.result, changes));
    await transactionDone(transaction);
  }

  async function finalizeFullRescan({ sessionId, pageCount }) {
    const count = Number(pageCount); if (!sessionId || !Number.isInteger(count) || count < 1) return { finalized: false };
    const db = await open(); const transaction = db.transaction([STORES.cataloguePages, STORES.videos, STORES.videoDetails, STORES.catalogueState], "readwrite");
    const pages = transaction.objectStore(STORES.cataloguePages), videos = transaction.objectStore(STORES.videos), details = transaction.objectStore(STORES.videoDetails), states = transaction.objectStore(STORES.catalogueState);
    const request = pages.getAll(); request.onsuccess = () => {
      const manifests = request.result ?? []; const replacement = manifests.filter((page) => page.status === "complete" && page.sessionId === sessionId && page.pageNumber >= 1 && page.pageNumber <= count);
      if (replacement.length !== count || replacement.some((page, index) => page.pageNumber !== index + 1)) return;
      const ids = new Set(replacement.flatMap((page) => page.videoIds ?? []));
      manifests.filter((page) => page.pageNumber > count || (page.pageNumber <= count && page.sessionId !== sessionId)).forEach((page) => pages.delete(page.pageNumber));
      const allVideos = videos.getAll(); allVideos.onsuccess = () => allVideos.result.filter((video) => !ids.has(video.videoId)).forEach((video) => { videos.delete(video.videoId); details.delete(video.videoId); });
      const state = states.get(STATE_KEY); state.onsuccess = () => states.put(deriveCatalogueState(state.result, { indexedCount: ids.size, discoveredPageCount: count, pagesCompleted: count }));
    };
    await transactionDone(transaction); invalidateCatalogueOrder(); return { finalized: true };
  }

  async function appendHistory(entry) {
    const db = await open();
    const transaction = db.transaction(STORES.jobHistory, "readwrite");
    const store = transaction.objectStore(STORES.jobHistory);
    const finishedAt = Number(entry.finishedAt) || Date.now();
    store.put({ ...entry, id: entry.id ?? `${finishedAt}-${Math.random().toString(36).slice(2, 8)}`, finishedAt });
    const all = store.getAll();
    all.onsuccess = () => {
      const stale = all.result.sort((a, b) => b.finishedAt - a.finishedAt).slice(HISTORY_LIMIT);
      for (const item of stale) store.delete(item.id);
    };
    await transactionDone(transaction);
  }

  async function readRecentHistory(limit = 3) {
    const db = await open();
    const transaction = db.transaction(STORES.jobHistory, "readonly");
    const entries = await requestPromise(transaction.objectStore(STORES.jobHistory).getAll());
    await transactionDone(transaction);
    return entries.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, limit);
  }

  app.modules.db = Object.freeze({
    STORES,
    STATE_KEY,
    HISTORY_LIMIT,
    defaultDetailsState,
    defaultCatalogueState,
    mergeListingRecord,
    deriveCatalogueState,
    authoritativeCountChanges,
    open,
    getCatalogueState,
    putCatalogueState,
    normalizeInterruptedState,
    listPageCheckpoints,
    countVideos,
    countDetailedVideos,
    countFailedDetails,
    countOutdatedDetails,
    getDetail,
    getDetailsByIds,
    listDetailRecords,
    writeCompleteDetail,
    recordDetailFailure,
    getMissingDetailTargets,
    synchronizeDetailedCount,
    updateDetailsState,
    commitCompletedPage,
    stageSmartUpdatePage,
    listSmartUpdateStage,
    clearSmartUpdateStage,
    finalizeSmartUpdateReconciliation,
    markPageFailure,
    finalizeFullRescan,
    appendHistory,
    readRecentHistory,
    orderedVideoIdsFromManifests,
    invalidateCatalogueOrder,
    subscribeCatalogueChanges,
    subscribeDetailChanges,
    getOrderedVideoIds,
    getVideosByIds,
    repairThumbnail,
    getAllLocalRecords,
    getLocalPage,
    normalizeCompleteDetail,
    mergeDetailFailure,
    mergeCompleteDetail,
    missingDetailTargets,
    interruptedStateChanges
  });
})();
