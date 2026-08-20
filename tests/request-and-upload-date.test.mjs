import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadContext(files, seed = {}) {
  const context = {
    console,
    Date,
    JSON,
    Math,
    RegExp,
    String,
    Number,
    Set,
    Map,
    URL,
    DOMException,
    AbortController,
    ...seed
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of files) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return context;
}

test("default request scheduler keeps browser timer receiver and survives a real spacing wait", async () => {
  const context = {
    console,
    Date,
    JSON,
    Math,
    RegExp,
    String,
    Number,
    Set,
    Map,
    URL,
    DOMException,
    AbortController,
    __setTimeout: setTimeout,
    __clearTimeout: clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), context, { filename: "src/shared/namespace.js" });
  vm.runInContext(`
    globalThis.__timerCalls = 0;
    globalThis.setTimeout = function (callback, ms) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      globalThis.__timerCalls += 1;
      return globalThis.__setTimeout(callback, ms);
    };
    globalThis.clearTimeout = function (id) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return globalThis.__clearTimeout(id);
    };
  `, context);
  vm.runInContext(readFileSync("src/jobs/request-scheduler.js", "utf8"), context, { filename: "src/jobs/request-scheduler.js" });

  const scheduler = context.R34MF.modules.createRequestScheduler({
    getMinimumSpacingMs: () => 8,
    getMaximumAutomaticRetries: () => 0
  });
  let requests = 0;
  await scheduler.runWithPolicy({ request: async () => ({ status: 200, ok: true, headers: { get: () => null } }) });
  await scheduler.runWithPolicy({ request: async () => { requests += 1; return { status: 200, ok: true, headers: { get: () => null } }; } });
  assert.equal(requests, 1);
  assert.ok(context.__timerCalls >= 1, "the second request must exercise the timer-backed spacing wait");
});

function dateModules() {
  return loadContext([
    "src/shared/namespace.js",
    "src/shared/upload-date.js",
    "src/filters/filter-engine.js",
    "src/filters/upload-date-integration.js",
    "src/sort/sorter.js"
  ]).R34MF.modules;
}

test("listing relative age becomes an absolute approximate range and exact detail overrides it", () => {
  const { uploadDate } = dateModules();
  const observedAt = Date.parse("2026-08-12T12:00:00Z");
  const fields = uploadDate.listingObservationFields("1 hour ago", observedAt);
  assert.equal(fields.relativeUploadObservedAt, observedAt);
  assert.equal(fields.listingUploadEarliestAt, observedAt - 2 * uploadDate.HOUR);
  assert.equal(fields.listingUploadLatestAt, observedAt - uploadDate.HOUR);

  const video = { relativeUploadText: "1 hour ago", ...fields };
  const listing = uploadDate.resolve(video, null);
  assert.equal(listing.source, "listing-estimate");
  const exact = uploadDate.resolve(video, { status: "complete", exactUploadDate: "2026-08-10" });
  assert.equal(exact.source, "detail-exact");
  assert.equal(exact.precision, "date");
  assert.equal(new Date(exact.earliestAt).toISOString().slice(0, 10), "2026-08-10");
});

test("legacy listing records resolve from listingUpdatedAt without a catalogue reset", () => {
  const { uploadDate } = dateModules();
  const observedAt = Date.parse("2026-08-12T12:00:00Z");
  const resolved = uploadDate.resolve({ relativeUploadText: "3 days ago", listingUpdatedAt: observedAt }, null);
  assert.equal(resolved.source, "listing-estimate");
  assert.ok(Number.isFinite(resolved.sortTimestamp));
});

test("Upload date sort mixes exact and estimated dates chronologically and keeps unknown last", () => {
  const { uploadDate, sorter } = dateModules();
  const now = Date.parse("2026-08-12T12:00:00Z");
  const bObservation = uploadDate.listingObservationFields("1 hour ago", now);
  const records = [
    { videoId: "A" },
    { videoId: "B", relativeUploadText: "1 hour ago", ...bObservation },
    { videoId: "C" },
    { videoId: "D" }
  ];
  const details = new Map([
    ["A", { status: "complete", exactUploadDate: "2026-08-10" }],
    ["C", { status: "complete", exactUploadDate: "2026-08-11" }]
  ]);

  assert.deepEqual(
    sorter.sort(records, details, { field: "uploadDate", direction: "desc" }).map((item) => item.videoId),
    ["B", "C", "A", "D"]
  );
  assert.deepEqual(
    sorter.sort(records, details, { field: "uploadDate", direction: "asc" }).map((item) => item.videoId),
    ["A", "C", "B", "D"]
  );
});

test("normal and Advanced Upload date filters use the same hybrid source and one supplied now", () => {
  const { uploadDate, filterEngine } = dateModules();
  const now = Date.parse("2026-08-12T12:00:00Z");
  const video = {
    videoId: "1",
    relativeUploadText: "1 day ago",
    ...uploadDate.listingObservationFields("1 day ago", now)
  };

  const normal = filterEngine.createEmpty();
  normal.detailed.uploadDate = { enabled: true, value: { operator: "within", value: 2, valueTo: "", unit: "days" } };
  assert.equal(filterEngine.evaluate(video, null, normal, now), filterEngine.TRUE);

  const advanced = filterEngine.createEmpty();
  advanced.advanced = {
    enabled: true,
    items: [{
      id: "r1",
      kind: "rule",
      enabled: true,
      connector: null,
      field: "uploadDate",
      polarity: "match",
      operator: "within",
      value: 2,
      valueTo: "",
      unit: "days"
    }]
  };
  assert.equal(filterEngine.evaluate(video, null, advanced, now), filterEngine.TRUE);

  const uncertain = {
    videoId: "2",
    relativeUploadText: "2 days ago",
    ...uploadDate.listingObservationFields("2 days ago", now)
  };
  assert.equal(filterEngine.evaluate(uncertain, null, normal, now), filterEngine.UNKNOWN);
});

test("exact detail date wins for filtering even when listing observation says something newer", () => {
  const { uploadDate, filterEngine } = dateModules();
  const now = Date.parse("2026-08-12T12:00:00Z");
  const video = {
    relativeUploadText: "1 hour ago",
    ...uploadDate.listingObservationFields("1 hour ago", now)
  };
  const filters = filterEngine.createEmpty();
  filters.detailed.uploadDate = { enabled: true, value: { operator: "on", value: "2026-08-10", valueTo: "", unit: "days" } };
  assert.equal(
    filterEngine.evaluate(video, { status: "complete", exactUploadDate: "2026-08-10" }, filters, now),
    filterEngine.TRUE
  );
});

test("relative formatter advances through requested hour/day/week/month/year thresholds", () => {
  const { uploadDate } = dateModules();
  const now = Date.parse("2026-08-12T12:00:00Z");
  const stamp = (age) => ({ source: "detail-exact", precision: "timestamp", earliestAt: now - age, latestAt: now - age, sortTimestamp: now - age });

  assert.equal(uploadDate.formatRelativeResolved(stamp(uploadDate.HOUR), now), "1 hour ago");
  assert.equal(uploadDate.formatRelativeResolved(stamp(23 * uploadDate.HOUR), now), "23 hours ago");
  assert.equal(uploadDate.formatRelativeResolved(stamp(uploadDate.DAY), now), "1 day ago");
  assert.equal(uploadDate.formatRelativeResolved(stamp(6 * uploadDate.DAY), now), "6 days ago");
  assert.equal(uploadDate.formatRelativeResolved(stamp(7 * uploadDate.DAY), now), "1 week ago");
  assert.equal(uploadDate.formatRelativeResolved(stamp(28 * uploadDate.DAY), now), "1 month ago");
  assert.equal(uploadDate.formatRelativeResolved(stamp(366 * uploadDate.DAY), now), "1 year ago");

  const today = uploadDate.resolve({}, { status: "complete", exactUploadDate: "2026-08-12" });
  assert.equal(uploadDate.formatRelativeResolved(today, now), "Today");
});

test("new listing observation replaces stale first-scan chronology", () => {
  const { uploadDate } = dateModules();
  const first = Date.parse("2026-08-11T12:00:00Z");
  const later = Date.parse("2026-08-12T12:00:00Z");
  const oldRecord = { relativeUploadText: "1 hour ago", ...uploadDate.listingObservationFields("1 hour ago", first) };
  const refreshed = { ...oldRecord, relativeUploadText: "1 day ago", ...uploadDate.listingObservationFields("1 day ago", later) };
  const oldValue = uploadDate.sortValue(oldRecord, null);
  const refreshedValue = uploadDate.sortValue(refreshed, null);
  assert.notEqual(oldValue, refreshedValue);
  assert.ok(refreshed.listingUploadLatestAt <= later - uploadDate.DAY);
});

function detailScannerFactory() {
  const context = loadContext(["src/shared/namespace.js", "src/shared/rule34video-video-url.js"], { crypto: { randomUUID: () => "scheduler-test" } });
  context.R34MF.modules.db = {};
  context.R34MF.modules.detailParser = {};
  context.R34MF.modules.requestScheduler = {};
  vm.runInContext(readFileSync("src/catalogue/detail-scanner.js", "utf8"), context, { filename: "src/catalogue/detail-scanner.js" });
  return { factory: context.R34MF.modules.createDetailScanner, module: context.R34MF.modules.detailScanner };
}

test("detail scanner treats an internal scheduler failure as systemic without poisoning a video detail row", async () => {
  const { factory } = detailScannerFactory();
  let failureWrites = 0;
  const state = { catalogueReady: true, detailsState: {} };
  const db = {
    async getCatalogueState() { return state; },
    async getMissingDetailTargets() { return [{ videoId: "123", url: "https://rule34video.com/video/123/example/" }]; },
    async countDetailedVideos() { return 0; },
    async updateDetailsState(value) { state.detailsState = value; return state; },
    async recordDetailFailure() { failureWrites += 1; },
    async synchronizeDetailedCount() { return 0; },
    async appendHistory() {}
  };
  const scheduler = {
    async runWithPolicy() {
      const error = new Error("browser timer receiver failed");
      error.code = "request-scheduler-error";
      throw error;
    }
  };
  const scanner = factory({
    db,
    parser: { parseDocument: () => ({ ok: true, record: { videoId: "123" }, diagnostics: {} }) },
    scheduler,
    fetchImpl: async () => { throw new Error("fetch must not be called through a failed scheduler"); },
    getCurrentOrigin: () => "https://rule34video.com"
  });
  const result = await scanner.run({ limit: 1 });
  assert.equal(result.detailsState.status, "failed");
  assert.equal(result.lastError.code, "request-scheduler-error");
  assert.equal(result.detailsState.systemicReason.code, "request-scheduler-error");
  assert.equal(failureWrites, 0, "an extension scheduler failure is not a per-video metadata failure");
});

test("detail diagnostics use measured HTML length when Content-Length is absent", () => {
  const { module } = detailScannerFactory();
  const response = {
    url: "https://rule34video.com/video/123/example/",
    status: 200,
    ok: true,
    redirected: false,
    headers: { get: () => null }
  };
  const evidence = module.responseEvidence(response, response.url, 4321, "stored-shape");
  assert.equal(evidence.responseLength, 4321);
});