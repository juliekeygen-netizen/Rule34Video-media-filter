(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before Queue view model.");

  const CATALOGUE_KINDS = new Set(["initial-scan", "full-rescan", "smart-update"]);
  const DETAIL_KIND = "detail-enrichment";

  function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
  function plural(value, word) { return `${number(value).toLocaleString()} ${word}${number(value) === 1 ? "" : "s"}`; }
  function elapsed(startedAt, now = Date.now()) {
    if (!startedAt) return null;
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    if (seconds < 60) return "just started";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m elapsed`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m elapsed`;
  }
  function updated(timestamp, now = Date.now()) {
    if (!timestamp) return null;
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 60) return "Updated just now";
    if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
    return `Updated ${Math.floor(seconds / 3600)}h ago`;
  }
  function terminalStatus(status) {
    return { complete: "Completed", completed: "Completed", failed: "Failed", stopped: "Stopped", paused: "Paused" }[String(status ?? "").toLowerCase()] ?? "Completed";
  }
  function jobTitle(kind) {
    return { "initial-scan": "Scan subscriptions", "full-rescan": "Full catalogue rescan", "smart-update": "Smart Update", [DETAIL_KIND]: "Detailed metadata" }[kind] ?? kind;
  }
  function historyTitle(kind) {
    return { "full-catalogue-rescan": "Full catalogue rescan", "catalogue-update": "Smart Update", "catalogue-recent-update": "Recent Update", "initial-catalogue-scan": "Catalogue scan", "detailed-metadata": "Detailed metadata" }[kind] ?? "Catalogue scan";
  }

  function activeJob(job, indexedCount) {
    if (job.kind === DETAIL_KIND) {
      const processed = number(job.progress?.processed);
      const phase = ["preflight", "canary", "bulk"].includes(job.progress?.phase) ? job.progress.phase : (processed > 0 ? "bulk" : "preflight");
      const canaryAttempted = number(job.progress?.canaryAttempted); const canaryMaximum = number(job.progress?.canaryMaximum) || 10; const total = phase === "canary" ? canaryMaximum : phase === "preflight" ? 0 : number(job.progress?.total);
      const scope = phase === "preflight" ? "Validating stored video URLs" : phase === "canary" ? `${canaryAttempted} of ${canaryMaximum} attempted` : total ? `${processed.toLocaleString()} of ${total.toLocaleString()} checked` : "Preparing missing details…";
      return {
        ...job,
        title: jobTitle(job.kind),
        destination: "details",
        action: "queue-details",
        phase,
        scope,
        completed: phase === "canary" ? canaryAttempted : phase === "preflight" ? 0 : processed,
        total,
        detailedCount: number(job.progress?.detailedCount),
        failedCount: number(job.progress?.failedCount),
        runCompleted: number(job.progress?.runCompleted),
        canaryAttempted,
        canaryMaximum,
        canaryVerified: number(job.progress?.canaryVerified),
        canaryRequired: number(job.progress?.canaryRequired)
      };
    }
    const page = Number(job.progress?.pageNumber);
    if (job.kind === "smart-update") {
      const recent = job.progress?.updateMode === "recent";
      const nativePageCount = number(job.progress?.nativePageCount ?? job.progress?.total);
      const progressTotal = recent ? number(job.progress?.recentPageLimit ?? job.progress?.total) : nativePageCount;
      return { ...job, title: recent ? "Recent Update" : jobTitle(job.kind), destination: "catalogue", action: "queue-catalogue", phase: page > 0 ? "running" : "starting", scope: page > 0 ? `Page ${page}${progressTotal ? ` of ${progressTotal}` : ""}` : (recent ? "Preparing recent-video update…" : "Preparing newest-page update…"), completed: page > 0 ? page : 0, total: progressTotal, updateMode: recent ? "recent" : "smart", recentPageLimit: recent ? progressTotal : null, indexedCount: number(job.progress?.indexedCount ?? indexedCount), pagesChecked: number(job.progress?.pagesChecked), newVideos: number(job.progress?.newVideos), knownStreak: number(job.progress?.knownStreak), knownThreshold: number(job.progress?.knownThreshold) || 3 };
    }
    return {
      ...job,
      title: jobTitle(job.kind),
      destination: "catalogue",
      action: "queue-catalogue",
      phase: page > 0 ? "running" : "starting",
      scope: page > 0 ? `Page ${page}${job.progress?.total ? ` of ${job.progress.total}` : ""}` : job.kind === "smart-update" ? "Preparing newest-page update…" : "Preparing subscription scan…",
      completed: number(job.progress?.completed),
      total: number(job.progress?.total),
      indexedCount: number(job.progress?.indexedCount ?? indexedCount)
    };
  }

  function waitingJob(job, index, missingCount) {
    const details = job.kind === DETAIL_KIND;
    return {
      ...job,
      title: jobTitle(job.kind),
      destination: details ? "details" : "catalogue",
      action: details ? "queue-details" : "queue-catalogue",
      scope: details ? `Missing details · ${missingCount.toLocaleString()} videos` : job.kind === "smart-update" ? "Newest subscription pages" : "Subscription catalogue",
      removeAction: `job-remove:${job.id}`,
      position: index + 1
    };
  }

  function deriveQueueViewModel(raw = {}) {
    const catalogue = raw.catalogue ?? {};
    const indexedCount = number(catalogue.indexedCount);
    const detailedCount = number(catalogue.detailedCount);
    const missingCount = Math.max(0, indexedCount - detailedCount);
    const hasCatalogue = catalogue.catalogueReady === true;
    const usable = catalogue.usable === true || indexedCount > 0;
    const runtime = raw.runtime ?? { active: [], waiting: [], slots: 1 };
    const runtimeActive = runtime.active ?? [];
    const runtimeWaiting = runtime.waiting ?? [];
    const runningCatalogue = runtimeActive.find((job) => CATALOGUE_KINDS.has(job.kind));
    const runningDetails = runtimeActive.find((job) => job.kind === DETAIL_KIND);
    const waitingDetailsIndex = runtimeWaiting.findIndex((job) => job.kind === DETAIL_KIND);
    const waitingDetails = waitingDetailsIndex >= 0 ? runtimeWaiting[waitingDetailsIndex] : null;
    const scanRunning = catalogue.scanStatus === "running" || Boolean(runningCatalogue);
    const scanPaused = catalogue.scanStatus === "paused";
    const scanFailed = catalogue.scanStatus === "failed";
    const resumable = scanPaused || scanFailed || catalogue.resumable === true;
    const smartCheckpoint = catalogue.smartUpdate ?? {};
    const catalogueCancellable = scanRunning || resumable || (Boolean(smartCheckpoint.sessionId) && ["paused", "failed"].includes(smartCheckpoint.status));
    const active = runtimeActive.map((job) => activeJob(job, indexedCount));
    if (!runtimeActive.length && catalogue.scanStatus === "running") {
      const smart = catalogue.smartUpdate ?? {};
      const page = catalogue.scanKind === "smart-update" ? smart.currentPage ?? smart.nextPage : catalogue.currentPage ?? catalogue.nextPage;
      active.push({
        title: catalogue.scanKind === "full-rescan" ? "Full catalogue rescan" : catalogue.scanKind === "recent-update" ? "Recent Update" : catalogue.scanKind === "smart-update" ? "Smart Update" : "Scan subscriptions",
        destination: "catalogue",
        action: "queue-catalogue",
        state: "running",
        phase: Number(page) > 0 ? "running" : "starting",
        scope: Number(page) > 0 ? (catalogue.discoveredPageCount ? `Page ${page} of ${catalogue.discoveredPageCount}` : `Page ${page}`) : "Preparing subscription scan…",
        completed: number(catalogue.pagesCompleted),
        total: number(catalogue.discoveredPageCount),
        indexedCount,
        startedAt: catalogue.activeRunStartedAt
      });
    }
    const waiting = runtimeWaiting.map((job, index) => waitingJob(job, index, missingCount));
    const durableDetails = catalogue.detailsState ?? {};
    const detailsStatus = !hasCatalogue ? "Unavailable"
      : runningDetails ? "Running"
        : waitingDetails ? "Waiting"
          : raw.future?.detailsState?.status ?? (raw.capabilities?.fetchDetails !== true ? "Unavailable"
            : ({ paused: "Paused", failed: "Failed", complete: "Completed", running: "Paused" }[durableDetails.status] ?? "Available"));
    const details = {
      ...durableDetails,
      status: detailsStatus,
      active: active.find((job) => job.destination === "details") ?? null,
      waiting: waiting.find((job) => job.destination === "details") ?? null,
      position: waitingDetailsIndex >= 0 ? waitingDetailsIndex + 1 : null,
      progress: runningDetails?.progress ?? null,
      error: durableDetails.lastError ?? runningDetails?.error ?? null
    };
    const discoveredScale = catalogue.discoveredNativeTotal ? `Not scanned yet · ≈${number(catalogue.discoveredNativeTotal).toLocaleString()} videos` : "Not scanned yet";
    const catalogueStatus = scanRunning ? "Running" : scanFailed ? "Failed" : scanPaused ? "Paused" : hasCatalogue ? "Available" : usable ? "Partial" : "";
    const maintenanceStatus = !hasCatalogue ? "Unavailable" : raw.future?.maintenanceState?.status ?? "Available";
    const catalogueActive = active.find((job) => job.destination === "catalogue") ?? null;
    const progress = catalogueActive?.total ? Math.min(100, Math.round(number(catalogueActive.completed) / number(catalogueActive.total) * 100)) : null;
    const slots = Math.max(1, number(runtime.slots) || 1);

    return {
      hasCatalogue,
      scanRunning,
      scanPaused,
      scanFailed,
      resumable,
      catalogueCancellable,
      indexedCount,
      detailedCount,
      missingCount,
      catalogue,
      details,
      catalogueActive,
      operations: [
        { id: "catalogue", title: "Catalogue", subtitle: hasCatalogue ? `${plural(indexedCount, "video")} indexed` : (usable ? `${plural(indexedCount, "video")} indexed · scan can resume` : (scanRunning || resumable ? `${number(catalogue.pagesCompleted)} pages scanned` : discoveredScale)), status: catalogueStatus, navigable: true },
        { id: "details", title: "Detailed metadata", subtitle: hasCatalogue ? `${detailedCount.toLocaleString()} / ${indexedCount.toLocaleString()} detailed · ${missingCount.toLocaleString()} missing` : "Available after videos have been indexed", status: detailsStatus, navigable: hasCatalogue },
        { id: "maintenance", title: "Maintenance", subtitle: hasCatalogue ? "Retry, refresh and rescan tools" : "Available after videos have been indexed", status: maintenanceStatus, navigable: hasCatalogue }
      ],
      headerStatus: active.length ? `${active.length} of ${slots} slots${waiting.length ? ` · ${waiting.length} waiting` : ""}` : "Idle",
      active,
      waiting,
      recent: (raw.recent ?? []).map((entry) => ({ ...entry, title: historyTitle(entry.kind), displayStatus: terminalStatus(entry.status) })),
      progress,
      elapsed: elapsed(catalogue.activeRunStartedAt),
      updatedText: updated(catalogue.lastCatalogueUpdateAt ?? catalogue.lastSmartUpdateAt ?? catalogue.lastFullScanAt),
      capabilities: {
        startScan: !scanRunning && !hasCatalogue,
        resumeScan: resumable,
        stopScan: scanRunning,
        fullRescan: hasCatalogue && !scanRunning,
        smartUpdate: raw.capabilities?.smartUpdate === true,
        fetchDetails: hasCatalogue && missingCount > 0 && raw.capabilities?.fetchDetails === true && !runningDetails && !waitingDetails
      },
      future: raw.future ?? {}
    };
  }

  app.modules.queueViewModel = Object.freeze({ deriveQueueViewModel, elapsed, updated, terminalStatus, plural, jobTitle, historyTitle });
})();
