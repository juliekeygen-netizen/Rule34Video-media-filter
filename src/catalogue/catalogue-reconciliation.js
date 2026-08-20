(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before catalogue reconciliation.");

  // This intentionally uses evidence rather than treating a non-zero video count as a
  // completed scan.  A partial scan is still useful for Local browsing, but must remain
  // resumable until its complete page manifests prove the terminal state.
  function positive(value) { return Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0; }
  function completePages(pages) { return [...(pages ?? [])].filter((page) => page?.status === "complete" && positive(page.pageNumber)).sort((a, b) => a.pageNumber - b.pageNumber); }
  function contiguousCount(pages) {
    let expected = 1;
    for (const page of completePages(pages)) { if (page.pageNumber !== expected) break; expected += 1; }
    return expected - 1;
  }

  function reconcileCatalogueState(stored = {}, evidence = {}) {
    const indexedCount = positive(evidence.indexedCount);
    const detailedCount = Math.min(indexedCount, positive(evidence.detailedCount));
    const pages = [...(evidence.pages ?? [])];
    const complete = completePages(pages);
    const contiguous = contiguousCount(pages);
    const discoveredPageCount = positive(stored.discoveredPageCount) || null;
    const terminalStatus = ["complete", "idle"].includes(stored.scanStatus);
    const interrupted = ["running", "paused", "failed"].includes(stored.scanStatus);
    const failedCheckpoint = pages.some((page) => page?.status === "failed");
    const manifestsProveComplete = Boolean(discoveredPageCount && contiguous >= discoveredPageCount && complete.length >= discoveredPageCount);
    // Older compatible records may have a stale `catalogueReady:false`, but a completed
    // timestamp plus complete contiguous manifests is durable completion evidence.
    const historicalCompletion = Boolean(stored.lastFullScanAt || stored.completedAt) && manifestsProveComplete;
    const explicitCompletion = stored.catalogueReady === true && indexedCount > 0 && !interrupted;
    const protectedMaintenanceBaseline = interrupted && stored.catalogueReady === true && ["full-rescan", "smart-update", "recent-update"].includes(stored.scanKind) && manifestsProveComplete && !failedCheckpoint;
    const ready = indexedCount > 0 && !failedCheckpoint && (!interrupted || protectedMaintenanceBaseline) && (explicitCompletion || manifestsProveComplete || historicalCompletion || (terminalStatus && stored.catalogueReady === true) || protectedMaintenanceBaseline);
    const partial = indexedCount > 0 && !ready;
    const status = ready ? "complete" : partial ? (interrupted ? stored.scanStatus : "partial") : "not-scanned";
    const recovered = ready && stored.catalogueReady !== true;
    return {
      ...stored,
      indexedCount,
      detailedCount,
      pagesCompleted: Math.max(positive(stored.pagesCompleted), complete.length),
      catalogueReady: ready,
      scanStatus: status,
      availability: ready ? "complete" : partial ? "partial" : "empty",
      usable: indexedCount > 0,
      resumable: partial && (interrupted || failedCheckpoint || contiguous > 0 || complete.length > 0),
      recovered,
      evidence: { completePages: complete.length, contiguousPages: contiguous, manifestsProveComplete }
    };
  }

  function stableOrderedOverlap(scannedIds, oldIds, minimumRun = 3) {
    const current = [...(scannedIds ?? [])].map(String);
    const previous = [...(oldIds ?? [])].map(String);
    const oldPositions = new Map(previous.map((id, index) => [id, index]));
    let best = null;
    for (let scanIndex = 0; scanIndex < current.length; scanIndex += 1) {
      const oldIndex = oldPositions.get(current[scanIndex]);
      if (oldIndex === undefined) continue;
      let runLength = 0;
      while (scanIndex + runLength < current.length && oldIndex + runLength < previous.length && current[scanIndex + runLength] === previous[oldIndex + runLength]) runLength += 1;
      if (runLength >= minimumRun && (!best || runLength > best.runLength || (runLength === best.runLength && scanIndex < best.scanIndex))) best = { scanIndex, oldIndex, runLength };
    }
    return best;
  }

  function smartUpdateOrder({ scannedIds, oldIds, nativeTotal = null, minimumRun = 3, reachedEnd = false } = {}) {
    const scanned = [...new Set([...(scannedIds ?? [])].map(String).filter(Boolean))];
    const old = [...new Set([...(oldIds ?? [])].map(String).filter(Boolean))];
    if (reachedEnd) {
      const totalMatches = !Number.isInteger(Number(nativeTotal)) || Number(nativeTotal) <= 0 || scanned.length === Number(nativeTotal);
      return { ready: totalMatches, orderedIds: totalMatches ? scanned : [], overlap: null, reason: totalMatches ? "full-current-order" : "native-total-mismatch" };
    }
    const overlap = stableOrderedOverlap(scanned, old, minimumRun);
    if (!overlap) return { ready: false, orderedIds: [], overlap: null, reason: "stable-overlap-not-found" };
    const orderedIds = [...new Set([...scanned.slice(0, overlap.scanIndex), ...old.slice(overlap.oldIndex)])];
    if (!Number.isInteger(Number(nativeTotal)) || Number(nativeTotal) <= 0) return { ready: false, orderedIds: [], overlap, reason: "native-total-unavailable" };
    const totalMatches = orderedIds.length === Number(nativeTotal);
    return { ready: totalMatches, orderedIds: totalMatches ? orderedIds : [], overlap, reason: totalMatches ? "stable-overlap" : "native-total-mismatch" };
  }

  function recentUpdateOrder({ scannedIds, oldIds, nativeTotal = null, reachedEnd = false } = {}) {
    const scanned = [...new Set([...(scannedIds ?? [])].map(String).filter(Boolean))];
    const old = [...new Set([...(oldIds ?? [])].map(String).filter(Boolean))];
    if (!old.length) return { ready: false, orderedIds: [], anchorIndex: -1, reason: "recent-anchor-unavailable" };
    const anchorIndex = scanned.indexOf(old[0]);
    if (anchorIndex < 0) {
      if (reachedEnd && Number(nativeTotal) > 0 && scanned.length === Number(nativeTotal)) return { ready: true, orderedIds: scanned, anchorIndex, reason: "full-current-order" };
      return { ready: false, orderedIds: [], anchorIndex, reason: "recent-anchor-not-found" };
    }
    const orderedIds = [...new Set([...scanned.slice(0, anchorIndex), ...old])];
    if (!Number.isInteger(Number(nativeTotal)) || Number(nativeTotal) <= 0) return { ready: false, orderedIds: [], anchorIndex, reason: "native-total-unavailable" };
    if (orderedIds.length !== Number(nativeTotal)) return { ready: false, orderedIds: [], anchorIndex, reason: "native-total-mismatch" };
    return { ready: true, orderedIds, anchorIndex, reason: "recent-anchor" };
  }

  app.modules.catalogueReconciliation = Object.freeze({ reconcileCatalogueState, completePages, contiguousCount, stableOrderedOverlap, smartUpdateOrder, recentUpdateOrder });
})();
