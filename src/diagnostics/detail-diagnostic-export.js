(() => {
  "use strict";

  const app = globalThis.R34MF;
  const db = app?.modules.db;
  const identity = app?.modules.rule34VideoIdentity;
  if (!app || !db || !identity) throw new Error("R34MF storage and video identity helpers must load before diagnostics.");

  const SAMPLE_LIMIT = 10;
  function increment(target, key) { const safe = String(key ?? "unknown").slice(0, 80); target[safe] = (target[safe] ?? 0) + 1; }
  function boundedError(detail) {
    const error = detail?.lastError ?? detail?.lastAttemptError ?? {};
    return {
      videoId: String(detail?.videoId ?? "").slice(0, 40),
      code: String(error.code ?? "unknown").slice(0, 80),
      ...(Number.isFinite(Number(error.httpStatus)) ? { httpStatus: Number(error.httpStatus) } : {}),
      message: String(error.message ?? "").slice(0, 240)
    };
  }
  function buildDetailSection({ catalogue, records, details }) {
    const ids = new Set(records.map((video) => String(video.videoId))); const currentDetails = details.filter((detail) => ids.has(String(detail.videoId)));
    const failed = currentDetails.filter((detail) => detail.status !== "complete"); const failureCodes = {}; const httpStatuses = {}; const urlShapes = { "/video/": 0, "/videos/": 0, "invalid/other": 0 };
    failed.forEach((detail) => { const error = detail.lastError ?? detail.lastAttemptError; increment(failureCodes, error?.code); if (Number.isFinite(Number(error?.httpStatus))) increment(httpStatuses, Number(error.httpStatus)); });
    records.forEach((video) => increment(urlShapes, identity.shape(video.url)));
    return {
      detailsState: catalogue.detailsState ?? null,
      counts: { indexed: Number(catalogue.indexedCount) || records.length, detailed: Number(catalogue.detailedCount) || currentDetails.filter((detail) => detail.status === "complete").length, failed: failed.length },
      failureCodes,
      httpStatuses,
      urlShapes,
      lastPreflight: catalogue.detailsState?.lastPreflight ?? null,
      lastCanary: catalogue.detailsState?.lastCanary ?? null,
      systemicReason: catalogue.detailsState?.systemicReason ?? null,
      failedSamples: failed.slice(0, SAMPLE_LIMIT).map(boundedError)
    };
  }
  async function build() {
    const [catalogue, local, details] = await Promise.all([db.getCatalogueState(), db.getAllLocalRecords(), db.listDetailRecords()]);
    return { generatedAt: new Date().toISOString(), build: app.build ?? null, detailMetadata: buildDetailSection({ catalogue, records: local.records, details }) };
  }
  async function serialize() { return JSON.stringify(await build(), null, 2); }
  async function download() {
    const blob = new Blob([await serialize()], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `r34mf-diagnostic-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  app.modules.detailDiagnosticExport = Object.freeze({ build, serialize, download, buildDetailSection, boundedError, SAMPLE_LIMIT });
})();
