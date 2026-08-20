(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.queueViewModel;
  if (!app || !base) throw new Error("R34MF Queue view model must load before maintenance model.");

  const DETAIL_KINDS = new Set(["detail-enrichment", "detail-retry-failed", "detail-retry-failed-refreshes", "detail-refresh", "detail-repair-outdated"]);
  const FULL_RESCAN_KINDS = new Set(["full-rescan", "full-rescan-resume"]);
  const CATALOGUE_KINDS = new Set(["initial-scan", "full-rescan", "full-rescan-resume", "smart-update"]);

  const DETAIL_MODE = Object.freeze({
    "detail-enrichment": "missing",
    "detail-retry-failed": "failed",
    "detail-retry-failed-refreshes": "refreshFailed",
    "detail-refresh": "refresh",
    "detail-repair-outdated": "outdated"
  });
  const DETAIL_TITLE = Object.freeze({
    missing: "Detailed metadata",
    failed: "Retry failed details",
    refreshFailed: "Retry failed refreshes",
    refresh: "Refresh detailed metadata",
    outdated: "Repair outdated metadata"
  });
  const HISTORY_TITLE = Object.freeze({
    "detailed-metadata-retry": "Retry failed details",
    "detailed-metadata-refresh-retry": "Retry failed refreshes",
    "detailed-metadata-refresh": "Refresh detailed metadata",
    "detail-repair-outdated": "Repair outdated metadata"
  });

  function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }

  function normalizeJob(job) {
    if (!job) return job;
    if (job.kind === "detail-retry-failed" || job.kind === "detail-retry-failed-refreshes" || job.kind === "detail-refresh" || job.kind === "detail-repair-outdated") {
      return {
        ...job,
        phase8OriginalKind: job.kind,
        kind: "detail-enrichment",
        progress: { ...(job.progress ?? {}), detailMode: DETAIL_MODE[job.kind] }
      };
    }
    if (job.kind === "full-rescan-resume") return { ...job, phase8OriginalKind: job.kind, kind: "full-rescan" };
    return job;
  }

  function normalizeRaw(raw) {
    const runtime = raw?.runtime ?? {};
    return {
      ...raw,
      runtime: {
        ...runtime,
        active: (runtime.active ?? []).map(normalizeJob),
        waiting: (runtime.waiting ?? []).map(normalizeJob)
      }
    };
  }

  function stateForKinds(runtime, kinds) {
    const active = (runtime.active ?? []).find((job) => kinds.has(job.kind));
    if (active) return { status: "Running", job: active, active: true, position: null };
    const index = (runtime.waiting ?? []).findIndex((job) => kinds.has(job.kind));
    if (index >= 0) return { status: `Queued #${index + 1}`, job: runtime.waiting[index], active: false, position: index + 1 };
    return null;
  }

  function coveringMissingJob(runtime) {
    const own = stateForKinds(runtime, new Set(["detail-enrichment"]));
    return own ? { ...own, active: own.active === true } : null;
  }

  function catalogueRuntimeState(runtime) {
    return stateForKinds(runtime, CATALOGUE_KINDS);
  }

  function catalogueResumeRow(raw, model, runtime) {
    const normalResume = ["paused", "failed"].includes(raw.catalogue?.scanStatus)
      && raw.catalogue?.scanKind !== "smart-update"
      && Boolean(raw.catalogue?.sessionId);
    if (normalResume) {
      const expectedKind = raw.catalogue.scanKind === "full-rescan" ? "full-rescan-resume" : "initial-scan";
      const queued = stateForKinds(runtime, new Set([expectedKind]));
      return queued
        ? {
          title: "Retry catalogue scan errors",
          status: queued.status,
          subtitle: raw.catalogue.scanKind === "full-rescan" ? "Full catalogue rescan is already represented in Queue" : "Catalogue resume is already represented in Queue",
          action: "queue-catalogue",
          navigable: true
        }
        : {
          title: "Retry catalogue scan errors",
          status: "Available",
          subtitle: raw.catalogue.scanKind === "full-rescan" ? "Resume the interrupted Full catalogue rescan" : "Continue the incomplete subscription scan",
          action: "scan-resume",
          navigable: true
        };
    }
    if (model.smartResume?.resumable) {
      const queued = stateForKinds(runtime, new Set(["smart-update"]));
      return queued
        ? { title: "Retry catalogue scan errors", status: queued.status, subtitle: "Smart Update is already represented in Queue", action: "queue-catalogue", navigable: true }
        : { title: "Retry catalogue scan errors", status: "Available", subtitle: "Resume the interrupted Smart Update", action: "smart-update", navigable: true };
    }
    return null;
  }

  function maintenanceRows(raw, model) {
    const runtime = raw.runtime ?? { active: [], waiting: [] };
    const rows = [];
    const failedCount = number(raw.catalogue?.failedDetailCount);
    const failedRefreshCount = number(raw.catalogue?.failedRefreshDetailCount);
    const outdatedCount = number(raw.catalogue?.outdatedDetailCount);
    const detailedCount = number(model.detailedCount);

    if (failedCount > 0) {
      const own = stateForKinds(runtime, new Set(["detail-retry-failed"]));
      const covering = own ? null : coveringMissingJob(runtime);
      if (own) {
        rows.push({ title: "Retry failed details", status: own.status, subtitle: `${failedCount.toLocaleString()} failed detail record${failedCount === 1 ? "" : "s"}`, action: "queue-details", navigable: true });
      } else if (covering) {
        rows.push({ title: "Retry failed details", status: "Covered", subtitle: `Included in ${covering.active ? "running" : "queued"} Detailed metadata job`, action: "queue-details", navigable: true });
      } else {
        rows.push({ title: "Retry failed details", status: "Available", subtitle: `Retry ${failedCount.toLocaleString()} failed detail record${failedCount === 1 ? "" : "s"} only`, action: "maintenance-retry-failed-details", navigable: true });
      }
    }

    if (failedRefreshCount > 0) {
      const own = stateForKinds(runtime, new Set(["detail-retry-failed-refreshes"]));
      const refresh = own ? null : stateForKinds(runtime, new Set(["detail-refresh"]));
      rows.push(own
        ? { title: "Retry failed refreshes", status: own.status, subtitle: `${failedRefreshCount.toLocaleString()} preserved completed record${failedRefreshCount === 1 ? "" : "s"} with a failed refresh attempt`, action: "queue-details", navigable: true }
        : refresh
          ? { title: "Retry failed refreshes", status: "Covered", subtitle: `Included in ${refresh.active ? "running" : "queued"} Refresh detailed metadata`, action: "queue-details", navigable: true }
          : { title: "Retry failed refreshes", status: "Available", subtitle: `Retry ${failedRefreshCount.toLocaleString()} failed refresh attempt${failedRefreshCount === 1 ? "" : "s"} only`, action: "maintenance-retry-failed-refreshes", navigable: true });
    }

    if (detailedCount > 0) {
      const own = stateForKinds(runtime, new Set(["detail-refresh"]));
      rows.push(own
        ? { title: "Refresh detailed metadata", status: own.status, subtitle: `${detailedCount.toLocaleString()} completed detail record${detailedCount === 1 ? "" : "s"}`, action: "queue-details", navigable: true }
        : { title: "Refresh detailed metadata", status: "Available", subtitle: `Re-fetch ${detailedCount.toLocaleString()} completed detail record${detailedCount === 1 ? "" : "s"}`, action: "maintenance-refresh-details", navigable: true });
    }
    if (outdatedCount > 0) {
      const own = stateForKinds(runtime, new Set(["detail-repair-outdated"]));
      const refresh = stateForKinds(runtime, new Set(["detail-refresh"]));
      rows.push(own ? { title: "Repair outdated metadata", status: own.status, subtitle: `${outdatedCount.toLocaleString()} outdated detail record${outdatedCount === 1 ? "" : "s"}`, action: "queue-details", navigable: true }
        : refresh ? { title: "Repair outdated metadata", status: "Covered", subtitle: `Included in ${refresh.active ? "running" : "queued"} Refresh detailed metadata`, action: "queue-details", navigable: true }
          : { title: "Repair outdated metadata", status: "Available", subtitle: `${outdatedCount.toLocaleString()} outdated detail record${outdatedCount === 1 ? "" : "s"}`, action: "maintenance-repair-outdated-details", navigable: true });
    }

    const resume = catalogueResumeRow(raw, model, runtime);
    if (resume) rows.push(resume);

    const full = stateForKinds(runtime, FULL_RESCAN_KINDS);
    const needsRescan = model.smartResume?.requiresFullRescan === true;
    rows.push(full
      ? { title: "Full catalogue rescan", status: full.status, subtitle: "Rechecking every subscription page", action: "queue-catalogue", navigable: true }
      : { title: "Full catalogue rescan", status: "Available", subtitle: needsRescan ? "Required because Smart Update could not prove a safe reconciliation" : "Recheck every subscription page, even after the current catalogue", action: "queue-full-rescan", navigable: true });

    return rows;
  }

  function deriveQueueViewModel(raw = {}) {
    const normalized = normalizeRaw(raw);
    const model = base.deriveQueueViewModel(normalized);
    const runtime = raw.runtime ?? { active: [], waiting: [] };
    const originals = new Map([...(runtime.active ?? []), ...(runtime.waiting ?? [])].map((job) => [job.id, job]));

    for (const item of [...(model.active ?? []), ...(model.waiting ?? [])]) {
      const original = originals.get(item.id);
      if (!original) continue;
      if (DETAIL_KINDS.has(original.kind)) {
        const mode = DETAIL_MODE[original.kind] ?? "missing";
        item.kind = original.kind;
        item.detailMode = mode;
        item.title = DETAIL_TITLE[mode];
      } else if (original.kind === "full-rescan-resume") {
        item.kind = original.kind;
        item.title = "Full catalogue rescan";
      }
    }

    for (let index = 0; index < model.recent.length; index += 1) {
      const source = raw.recent?.[index];
      if (source && HISTORY_TITLE[source.kind]) model.recent[index].title = HISTORY_TITLE[source.kind];
    }

    const activeDetailOriginal = (runtime.active ?? []).find((job) => DETAIL_KINDS.has(job.kind));
    const waitingDetailOriginal = (runtime.waiting ?? []).find((job) => DETAIL_KINDS.has(job.kind));
    const durableMode = ["missing", "failed", "refreshFailed", "refresh", "outdated"].includes(raw.catalogue?.detailsState?.mode) ? raw.catalogue.detailsState.mode : "missing";
    model.details.mode = activeDetailOriginal ? DETAIL_MODE[activeDetailOriginal.kind] : waitingDetailOriginal ? DETAIL_MODE[waitingDetailOriginal.kind] : durableMode;
    model.failedDetailCount = number(raw.catalogue?.failedDetailCount);
    model.failedRefreshDetailCount = number(raw.catalogue?.failedRefreshDetailCount);

    if (!activeDetailOriginal && !waitingDetailOriginal && model.hasCatalogue && raw.capabilities?.fetchDetails === true && !["Paused", "Failed"].includes(model.details.status)) {
      model.details.status = model.missingCount > 0 ? "Available" : "Completed";
      const operation = model.operations.find((row) => row.id === "details");
      if (operation) operation.status = model.details.status;
    }

    const smart = raw.catalogue?.smartUpdate ?? {};
    const smartStatus = String(smart.status ?? "").toLowerCase();
    const smartFailureCode = smart.lastError?.code ?? null;
    const requiresFullRescan = smartStatus === "failed" && smartFailureCode === "smart-update-reconciliation-required";
    const smartResumable = ["paused", "failed"].includes(smartStatus) && Boolean(smart.sessionId) && !requiresFullRescan;
    const activeCatalogue = (runtime.active ?? []).find((job) => CATALOGUE_KINDS.has(job.kind)) ?? null;
    const waitingCatalogueIndex = (runtime.waiting ?? []).findIndex((job) => CATALOGUE_KINDS.has(job.kind));
    const waitingCatalogue = waitingCatalogueIndex >= 0 ? runtime.waiting[waitingCatalogueIndex] : null;
    model.catalogueWaiting = waitingCatalogue ? { ...waitingCatalogue, position: waitingCatalogueIndex + 1 } : null;

    if (!activeCatalogue && !waitingCatalogue && model.hasCatalogue && (smartResumable || requiresFullRescan)) {
      model.smartResume = {
        status: smartStatus === "failed" ? "Failed" : "Paused",
        resumable: smartResumable,
        requiresFullRescan,
        pagesChecked: number(smart.pagesChecked),
        newVideos: number(smart.newVideos),
        nextPage: number(smart.nextPage) || 1,
        nativePageCount: number(smart.nativePageCount ?? raw.catalogue?.discoveredPageCount),
        lastError: smart.lastError ?? null
      };
      const operation = model.operations.find((row) => row.id === "catalogue");
      if (operation) operation.status = model.smartResume.status;
    } else model.smartResume = null;

    const catalogueOperation = model.operations.find((row) => row.id === "catalogue");
    if (catalogueOperation && waitingCatalogue) catalogueOperation.status = `Queued #${waitingCatalogueIndex + 1}`;

    model.maintenanceRows = model.hasCatalogue ? maintenanceRows(raw, model) : [];
    const maintenanceOperation = model.operations.find((row) => row.id === "maintenance");
    if (maintenanceOperation) {
      const maintenanceJob = stateForKinds(runtime, new Set(["detail-retry-failed", "detail-retry-failed-refreshes", "detail-refresh", "detail-repair-outdated"]));
      maintenanceOperation.status = maintenanceJob?.status ?? "Available";
      maintenanceOperation.subtitle = "Retry, refresh and rescan tools";
    }

    return model;
  }

  app.modules.queueViewModel = Object.freeze({
    ...base,
    deriveQueueViewModel,
    maintenanceRows,
    normalizeJob,
    stateForKinds,
    catalogueRuntimeState,
    DETAIL_KINDS,
    DETAIL_MODE,
    DETAIL_TITLE,
    CATALOGUE_KINDS
  });
})();
