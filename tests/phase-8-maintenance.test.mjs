import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

function context(seed = {}) {
  const value = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, DOMException, AbortController, setTimeout, clearTimeout, ...seed };
  value.globalThis = value;
  vm.createContext(value);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), value, { filename: "src/shared/namespace.js" });
  return value;
}

function load(env, file) {
  vm.runInContext(readFileSync(file, "utf8"), env, { filename: file });
  return env.R34MF.modules;
}

function ids(rows) { return [...rows].map((row) => String(row.videoId)).join(","); }

function phase8MaintenanceModule() {
  const env = context();
  env.R34MF.modules.db = {};
  env.R34MF.modules.createDetailScanner = () => ({ run: async () => ({}), stop() {} });
  return load(env, "src/jobs/detail-maintenance.js").detailMaintenance;
}

test("Phase 8 detail maintenance isolates missing, failed-only, and refresh-only worksets", () => {
  const maintenance = phase8MaintenanceModule();
  const records = ["1", "2", "3", "4", "2"].map((videoId) => ({ videoId }));
  const details = new Map([
    ["1", { videoId: "1", status: "complete" }],
    ["2", { videoId: "2", status: "failed" }],
    ["4", { videoId: "4", status: "complete", lastAttemptError: { code: "http-503" } }]
  ]);
  assert.equal(ids(maintenance.selectTargetsFromSource(records, details, "missing")), "2,3");
  assert.equal(ids(maintenance.selectTargetsFromSource(records, details, "failed")), "2");
  assert.equal(ids(maintenance.selectTargetsFromSource(records, details, "refresh")), "1,4");
  assert.equal(ids(maintenance.selectTargetsFromSource(records, details, "refresh", 1)), "1");
});

test("Repair outdated metadata targets prior trusted schema rows without scanning current schema rows", () => {
  const maintenance = phase8MaintenanceModule();
  const records = ["1", "2", "3", "4"].map((videoId) => ({ videoId }));
  const details = new Map([
    ["1", { videoId: "1", status: "complete", schemaVersion: 3 }],
    ["2", { videoId: "2", status: "complete", schemaVersion: 5 }],
    ["3", { videoId: "3", status: "failed", schemaVersion: 3 }],
    ["4", { videoId: "4", status: "complete", schemaVersion: 4 }]
  ]);
  assert.equal(ids(maintenance.selectTargetsFromSource(records, details, "outdated")), "1,4");
});

test("failed and refresh scopes snapshot their initial universe and persist truthful mode/history", async () => {
  const env = context();
  const details = new Map([["2", { videoId: "2", status: "failed" }]]);
  let reads = 0; let storedState; let storedHistory;
  env.R34MF.modules.db = {
    async getAllLocalRecords() { reads += 1; return { records: [{ videoId: "1" }, { videoId: "2" }], detailsById: details }; },
    async getMissingDetailTargets() { return [{ videoId: "1" }, { videoId: "2" }]; },
    async updateDetailsState(value) { storedState = value; return value; },
    async appendHistory(value) { storedHistory = value; },
    async countFailedDetails() { return 1; }, async countDetailedVideos() { return 0; }, async getCatalogueState() { return { indexedCount: 2, detailedCount: 0 }; }
  };
  env.R34MF.modules.createDetailScanner = () => ({ run: async () => ({}), stop() {} });
  const maintenance = load(env, "src/jobs/detail-maintenance.js").detailMaintenance;
  const scoped = maintenance.createScopedDb("failed");
  assert.equal(ids(await scoped.getMissingDetailTargets()), "2");
  details.set("2", { videoId: "2", status: "complete" });
  assert.equal(ids(await scoped.getMissingDetailTargets()), "2", "reconciliation must not expand or change the maintenance workset");
  assert.equal(reads, 1);
  await scoped.updateDetailsState({ status: "running", mode: "missing" });
  assert.equal(storedState.mode, "failed");
  await scoped.appendHistory({ kind: "detailed-metadata", summary: { processed: 1 } });
  assert.equal(storedHistory.kind, "detailed-metadata-retry");
  assert.equal(storedHistory.summary.mode, "failed");
});

function queueModel(raw) {
  const env = context();
  load(env, "src/ui/queue/queue-view-model.js");
  load(env, "src/ui/queue/queue-maintenance-model.js");
  return env.R34MF.modules.queueViewModel.deriveQueueViewModel(raw);
}

function baseRaw(overrides = {}) {
  return {
    catalogue: {
      catalogueReady: true, usable: true, indexedCount: 10, detailedCount: 4, failedDetailCount: 2,
      scanStatus: "complete", detailsState: { status: "complete", mode: "missing" }, smartUpdate: { status: "complete" },
      ...overrides.catalogue
    },
    runtime: { active: [], waiting: [], slots: 1, ...overrides.runtime },
    capabilities: { fetchDetails: true, smartUpdate: true },
    recent: overrides.recent ?? []
  };
}

test("Queue maintenance exposes real contextual work, coverage, correct detail availability, and maintenance history titles", () => {
  let model = queueModel(baseRaw({ recent: [{ kind: "detailed-metadata-refresh", status: "complete" }] }));
  assert.equal(model.maintenanceRows.map((row) => row.title).join("|"), "Retry failed details|Refresh detailed metadata|Full catalogue rescan");
  assert.equal(model.details.status, "Available", "new missing videos must not inherit a stale Completed state");
  assert.equal(model.recent[0].title, "Refresh detailed metadata");

  model = queueModel(baseRaw({ runtime: { active: [{ id: "d1", kind: "detail-enrichment", progress: { phase: "bulk", total: 6, processed: 1 } }] } }));
  assert.equal(model.maintenanceRows.find((row) => row.title === "Retry failed details").status, "Covered");
  assert.equal(model.details.status, "Running");

  model = queueModel(baseRaw({ runtime: { waiting: [{ id: "r1", kind: "detail-refresh", progress: { total: 4, detailMode: "refresh" } }] } }));
  assert.equal(model.details.status, "Waiting");
  assert.equal(model.details.mode, "refresh");
  assert.equal(model.waiting[0].title, "Refresh detailed metadata");
});

test("Queue restores interrupted Smart Update state, requires Full rescan after unsafe reconciliation, and represents queued Catalogue work", () => {
  let model = queueModel(baseRaw({ catalogue: { smartUpdate: { status: "paused", sessionId: "smart-1", pagesChecked: 7, nextPage: 8, nativePageCount: 250 } } }));
  assert.equal(model.smartResume.resumable, true);
  assert.equal(model.operations.find((row) => row.id === "catalogue").status, "Paused");
  assert.equal(model.maintenanceRows.find((row) => row.title === "Retry catalogue scan errors").action, "smart-update");

  model = queueModel(baseRaw({ catalogue: { smartUpdate: { status: "failed", sessionId: "smart-2", lastError: { code: "smart-update-reconciliation-required", message: "Needs rescan" } } } }));
  assert.equal(model.smartResume.requiresFullRescan, true);
  assert.match(model.maintenanceRows.find((row) => row.title === "Full catalogue rescan").subtitle, /Required/);

  model = queueModel(baseRaw({ runtime: { waiting: [{ id: "queued-update", kind: "smart-update", progress: {} }] } }));
  assert.equal(model.catalogueWaiting.id, "queued-update");
  assert.equal(model.operations.find((row) => row.id === "catalogue").status, "Queued #1");
});

test("resumed Full rescans finalize replacement data and Full rescan invalidates obsolete Smart Update staging", async () => {
  const env = context();
  const calls = [];
  env.R34MF.modules.db = {
    defaultCatalogueState() { return { smartUpdate: { status: "idle", sessionId: null, nextPage: 1 } }; },
    async getCatalogueState() { return { scanStatus: "paused", scanKind: "full-rescan", sessionId: "scan-1", discoveredPageCount: 3, smartUpdate: { status: "paused", sessionId: "old-smart" } }; },
    async clearSmartUpdateStage() { calls.push("clear-smart"); },
    async putCatalogueState(changes) { if (changes.smartUpdate) calls.push("reset-smart"); },
    async finalizeFullRescan({ sessionId, pageCount }) { calls.push(`finalize:${sessionId}:${pageCount}`); },
    async countVideos() { return 30; }, async countDetailedVideos() { return 10; },
    authoritativeCountChanges(indexedCount, detailedCount) { return { indexedCount, detailedCount }; }
  };
  env.R34MF.modules.catalogueScanner = {
    async run() { calls.push("run"); return { scanStatus: "complete", discoveredPageCount: 3 }; },
    async refresh() { calls.push("refresh"); return { scanStatus: "complete", indexedCount: 30, detailedCount: 10 }; },
    stop() {}, subscribe() {}
  };
  const scanner = load(env, "src/catalogue/catalogue-maintenance.js").catalogueScanner;
  await scanner.run({ fullRescan: false });
  assert.equal(calls.slice(0, 3).join("|"), "clear-smart|reset-smart|run");
  assert.ok(calls.includes("finalize:scan-1:3"));
  assert.equal(calls.at(-1), "refresh");
});

test("maintenance controller enqueues scoped detail jobs and resumes an interrupted Full rescan as Full rescan", async () => {
  const env = context();
  const enqueued = [];
  env.document = {};
  env.R34MF.modules.jobManager = {
    registerHandler() {},
    enqueue(input) { enqueued.push(input); return { accepted: true, job: input }; },
    snapshot() { return { active: [], waiting: [], slots: 1 }; }, stop() {}, remove() {}
  };
  env.R34MF.modules.db = { async countFailedDetails() { return 2; } };
  env.R34MF.modules.detailMaintenance = { normalizeMode: (mode) => ["failed", "refresh"].includes(mode) ? mode : "missing", async run() {} };
  env.R34MF.modules.catalogueScanner = { async run() { return { scanStatus: "complete" }; } };
  env.R34MF.modules.logger = { warn() {} };
  env.R34MF.modules.subscriptionsController = {
    state: { catalogue: { catalogueReady: true, indexedCount: 10, detailedCount: 4, failedDetailCount: 2, scanStatus: "paused", scanKind: "full-rescan", sessionId: "s" } },
    root: null,
    async start() {}, async refreshCatalogueState() {}, async refreshDetailData() {}, async runCatalogueJob() {},
    onCatalogueState() {}, async handleIntent() {}, updateShell() {}, renderQueue() {}, async maybeAutoFetchDetails() {}
  };
  const api = load(env, "src/content/maintenance-controller.js").maintenanceController;
  assert.equal(api.detailJobInput("missing", env.R34MF.modules.subscriptionsController.state.catalogue).coverage.join(","), "detail-retry-failed");
  assert.equal(api.detailJobInput("failed", env.R34MF.modules.subscriptionsController.state.catalogue).kind, "detail-retry-failed");
  assert.equal(api.detailJobInput("refresh", env.R34MF.modules.subscriptionsController.state.catalogue).progress.total, 4);
  assert.equal(api.resumeCatalogueKind(env.R34MF.modules.subscriptionsController.state.catalogue), "full-rescan-resume");
  await env.R34MF.modules.subscriptionsController.handleIntent("maintenance-retry-failed-details");
  assert.equal(enqueued.at(-1).kind, "detail-retry-failed");
  await env.R34MF.modules.subscriptionsController.handleIntent("scan-resume");
  assert.equal(enqueued.at(-1).kind, "full-rescan-resume");
});

test("Maintenance Queue UI keeps final Queue anatomy while adding contextual actions, Smart resume, and queued Catalogue removal", () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const env = context({ document, Element: window.Element });
  load(env, "src/ui/queue/queue-view-model.js");
  load(env, "src/ui/queue/queue-maintenance-model.js");
  load(env, "src/ui/queue/queue.js");
  load(env, "src/ui/queue/queue-maintenance.js");
  const root = document.querySelector("#root");
  const queue = env.R34MF.modules.queue;

  queue.render(root, baseRaw(), "maintenance", null);
  assert.ok(root.querySelector("[data-r34mf-action='maintenance-retry-failed-details']"));
  assert.ok(root.querySelector("[data-r34mf-action='maintenance-refresh-details']"));
  assert.ok(root.querySelector("[data-r34mf-action='queue-full-rescan']"));

  queue.render(root, baseRaw({ catalogue: { smartUpdate: { status: "paused", sessionId: "smart", pagesChecked: 4, nextPage: 5, nativePageCount: 250 } } }), "catalogue", null);
  assert.match(root.querySelector(".r34mf-queue-lead")?.textContent ?? "", /Resume Smart Update/);
  assert.ok(root.querySelector("[data-r34mf-action='smart-update']"));

  queue.render(root, baseRaw({ runtime: { waiting: [{ id: "queued-update", kind: "smart-update", progress: {} }] } }), "catalogue", null);
  assert.equal(root.querySelector(".r34mf-queue-lead")?.textContent, "Waiting in queue");
  assert.ok(root.querySelector("[data-r34mf-action='job-remove:queued-update']"));
});

test("Phase 8 modules load in dependency order in the shared Chrome/Firefox manifest", () => {
  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const scripts = manifest.content_scripts[0].js;
  const index = (name) => scripts.indexOf(name);
  assert.ok(index("src/jobs/detail-maintenance.js") > index("src/catalogue/detail-scanner.js"));
  assert.ok(index("src/catalogue/catalogue-maintenance.js") > index("src/catalogue/catalogue-scanner.js"));
  assert.ok(index("src/ui/queue/queue-maintenance-model.js") > index("src/ui/queue/queue-view-model.js"));
  assert.ok(index("src/ui/queue/queue-maintenance-model.js") < index("src/ui/queue/queue.js"));
  assert.ok(index("src/ui/queue/queue-maintenance.js") > index("src/ui/queue/queue.js"));
  assert.ok(index("src/ui/queue/queue-diagnostic-polish.js") > index("src/ui/queue/queue-maintenance.js"));
  assert.ok(index("src/content/maintenance-controller.js") > index("src/content/subscriptions-controller.js"));
  assert.ok(index("src/content/maintenance-controller.js") < index("src/content/main.js"));
});
