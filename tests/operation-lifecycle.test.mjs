import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

function context(seed = {}) {
  const env = {
    console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL,
    DOMException, AbortController, setTimeout, clearTimeout, ...seed
  };
  env.globalThis = env;
  vm.createContext(env);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), env, { filename: "src/shared/namespace.js" });
  return env;
}

function load(env, path) {
  vm.runInContext(readFileSync(path, "utf8"), env, { filename: path });
  return env.R34MF.modules;
}

function ids(rows) {
  return [...rows].map((row) => String(row.videoId)).join(",");
}

function lifecycleModule() {
  const env = context();
  env.R34MF.modules.db = {
    async getAllLocalRecords() { return { records: [], detailsById: new Map() }; },
    async getCatalogueState() { return { catalogueReady: true, detailsState: {} }; },
    async updateDetailsState(value) { return value; },
    async appendHistory() {},
    async countFailedDetails() { return 0; },
    async countDetailedVideos() { return 0; },
    defaultDetailsState() { return {}; }
  };
  env.R34MF.modules.createDetailScanner = () => ({ run: async () => ({ detailsState: {} }), stop() {} });
  load(env, "src/jobs/detail-maintenance.js");
  return load(env, "src/jobs/detail-operation-lifecycle.js").detailMaintenance;
}

test("detail operation resume skips records already attempted after the logical operation cutoff", () => {
  const maintenance = lifecycleModule();
  const records = ["1", "2", "3", "4"].map((videoId) => ({ videoId }));
  const details = new Map([
    ["1", { videoId: "1", status: "complete", fetchedAt: 500 }],
    ["2", { videoId: "2", status: "complete", fetchedAt: 1500 }],
    ["3", { videoId: "3", status: "failed", lastAttemptAt: 1700 }],
    ["4", { videoId: "4", status: "failed", lastAttemptAt: 400 }]
  ]);

  assert.equal(ids(maintenance.selectTargetsFromSource(records, details, "refresh", null, { cutoffAt: 1000 })), "1");
  assert.equal(ids(maintenance.selectTargetsFromSource(records, details, "failed", null, { cutoffAt: 1000 })), "4");
  assert.equal(ids(maintenance.selectTargetsFromSource(records, details, "missing", null, { cutoffAt: 1000 })), "4");
});

test("detail logical operation plan preserves resume boundary/counts and starts other modes fresh", () => {
  const maintenance = lifecycleModule();
  const catalogue = {
    detailsState: {
      status: "paused", mode: "refresh", operationCutoffAt: 1000, startedAt: 900,
      processedCount: 4, completedCount: 3, failedCount: 1, targetCount: 10
    }
  };
  const resumed = maintenance.planOperation(catalogue, "refresh", 5000);
  assert.equal(resumed.resuming, true);
  assert.equal(resumed.cutoffAt, 1000);
  assert.equal(resumed.startedAt, 900);
  assert.equal(resumed.baseProcessed, 4);
  assert.equal(resumed.baseCompleted, 3);
  assert.equal(resumed.baseFailed, 1);

  const fresh = maintenance.planOperation(catalogue, "failed", 5000);
  assert.equal(fresh.resuming, false);
  assert.equal(fresh.cutoffAt, 5000);
  assert.equal(fresh.baseProcessed, 0);
});

test("resumed detail bulk progress continues logical counts while timing only the new active segment", () => {
  const maintenance = lifecycleModule();
  const plan = {
    mode: "refresh", resuming: true, cutoffAt: 1000, startedAt: 900,
    baseProcessed: 4, baseCompleted: 3, baseFailed: 1, targetCount: 10,
    bulkProcessedBaseline: null, timingStartedAt: null
  };
  const first = maintenance.mapProgress(plan, { phase: "bulk", processed: 2, total: 6, runCompleted: 1, failedCount: 1 }, 2000);
  assert.equal(first.completed, 6);
  assert.equal(first.total, 10);
  assert.equal(first.timingCompleted, 0);
  assert.equal(first.timingStartedAt, 2000);
  const second = maintenance.mapProgress(plan, { phase: "bulk", processed: 4, total: 6, runCompleted: 3, failedCount: 1 }, 5000);
  assert.equal(second.completed, 8);
  assert.equal(second.total, 10);
  assert.equal(second.runCompleted, 6);
  assert.equal(second.failedCount, 2);
  assert.equal(second.timingCompleted, 2);
});

function timingModule() {
  const env = context();
  load(env, "src/ui/queue/queue-view-model.js");
  load(env, "src/ui/queue/queue-maintenance-model.js");
  load(env, "src/ui/queue/queue-maintenance-state.js");
  return load(env, "src/ui/queue/queue-timing-model.js").queueViewModel;
}

test("Queue timing reports observed average and finite ETA without inventing Smart Update remaining time", () => {
  const timing = timingModule();
  const finite = timing.estimateTiming({ startedAt: 1000, now: 11000, sampleCompleted: 2, completed: 4, total: 10, unit: "video" });
  assert.equal(finite.averageMs, 5000);
  assert.equal(finite.etaMs, 30000);
  assert.match(finite.text, /Avg 5\.0s\/video/);
  assert.match(finite.text, /≈30s remaining/);

  const openEnded = timing.estimateTiming({ startedAt: 1000, now: 11000, sampleCompleted: 2, completed: 2, total: 200, unit: "page", allowEta: false });
  assert.match(openEnded.text, /Avg 5\.0s\/page/);
  assert.doesNotMatch(openEnded.text, /remaining/);
});

function raw(overrides = {}) {
  return {
    catalogue: {
      catalogueReady: true, usable: true, indexedCount: 20, detailedCount: 10, failedDetailCount: 2,
      scanStatus: "complete", detailsState: { status: "complete", mode: "missing" }, smartUpdate: { status: "complete" },
      ...(overrides.catalogue ?? {})
    },
    runtime: { active: [], waiting: [], slots: 1, ...(overrides.runtime ?? {}) },
    capabilities: { fetchDetails: true, smartUpdate: true },
    recent: []
  };
}

function queueHarness() {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const env = context({ document, Element: window.Element });
  load(env, "src/ui/queue/queue-view-model.js");
  load(env, "src/ui/queue/queue-maintenance-model.js");
  load(env, "src/ui/queue/queue-maintenance-state.js");
  load(env, "src/ui/queue/queue-timing-model.js");
  load(env, "src/ui/queue/queue.js");
  load(env, "src/ui/queue/queue-maintenance.js");
  load(env, "src/ui/queue/queue-diagnostic-polish.js");
  load(env, "src/ui/queue/queue-operation-controls.js");
  return { env, document, root: document.querySelector("#root"), queue: env.R34MF.modules.queue };
}

test("running and paused Queue operations expose Cancel plus Pause/Resume with Cancel on the left", () => {
  const { root, queue } = queueHarness();
  const now = Date.now();
  queue.render(root, raw({ runtime: { active: [{
    id: "detail", kind: "detail-refresh", startedAt: now - 10000,
    progress: { phase: "bulk", processed: 4, completed: 4, total: 10, runCompleted: 4, detailedCount: 10, failedCount: 0, timingStartedAt: now - 10000, timingCompleted: 2 }
  }] } }), "details", null);
  const detailFooter = root.querySelector(".r34mf-queue-footer");
  const detailActions = [...detailFooter.querySelectorAll("button")].map((node) => `${node.dataset.r34mfAction}:${node.textContent}`);
  assert.ok(detailActions.includes("details-cancel:Cancel"));
  assert.ok(detailActions.includes("details-stop:Pause"));
  assert.ok(detailActions.indexOf("details-cancel:Cancel") < detailActions.indexOf("details-stop:Pause"));
  assert.match(root.textContent, /Avg .*\/video/);

  queue.render(root, raw({ catalogue: { detailsState: { status: "paused", mode: "refresh", processedCount: 4, completedCount: 4, targetCount: 10 } } }), "details", null);
  const pausedActions = [...root.querySelectorAll(".r34mf-queue-footer button")].map((node) => node.dataset.r34mfAction);
  assert.ok(pausedActions.includes("details-cancel"));
  assert.ok(pausedActions.includes("details-resume"));
  assert.ok(pausedActions.indexOf("details-cancel") < pausedActions.indexOf("details-resume"));

  queue.render(root, raw({
    catalogue: { scanStatus: "running", scanKind: "full-rescan", currentPage: 2, discoveredPageCount: 10 },
    runtime: { active: [{ id: "scan", kind: "full-rescan", startedAt: now - 5000, progress: { pageNumber: 2, completed: 2, total: 10, timingStartedAt: now - 5000, timingCompleted: 2 } }] }
  }), "catalogue", null);
  const scanActions = [...root.querySelectorAll(".r34mf-queue-footer button")].map((node) => `${node.dataset.r34mfAction}:${node.textContent}`);
  assert.ok(scanActions.includes("scan-cancel:Cancel"));
  assert.ok(scanActions.includes("scan-stop:Pause"));
  assert.ok(scanActions.indexOf("scan-cancel:Cancel") < scanActions.indexOf("scan-stop:Pause"));
});

test("paused Smart Update can be cancelled without losing its Resume action", () => {
  const { root, queue } = queueHarness();
  queue.render(root, raw({ catalogue: { smartUpdate: { status: "paused", sessionId: "smart", pagesChecked: 4, nextPage: 5, nativePageCount: 20 } } }), "catalogue", null);
  assert.ok(root.querySelector("[data-r34mf-action='scan-cancel']"));
  assert.ok(root.querySelector("[data-r34mf-action='smart-update']"));
});

test("detail-driven UI refresh is deferred while detail work is active and Cancel abandons paused detail/catalogue operations", async () => {
  const env = context();
  let active = [{ id: "detail", kind: "detail-refresh" }];
  const listeners = new Set();
  let scheduled = 0; let refreshed = 0; let abandoned = 0; let catalogueCancelled = 0; let catalogueRefreshed = 0;
  env.R34MF.modules.jobManager = {
    snapshot() { return { active: [...active], waiting: [], slots: 1 }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stop(id) { active = active.filter((job) => job.id !== id); const value = this.snapshot(); listeners.forEach((listener) => listener(value)); return true; }
  };
  env.R34MF.modules.detailMaintenance = { async abandon() { abandoned += 1; } };
  env.R34MF.modules.catalogueScanner = { async cancelCurrent() { catalogueCancelled += 1; return { cancelled: true }; } };
  env.R34MF.modules.logger = { warn() {} };
  env.R34MF.modules.subscriptionsController = {
    operationDetailRefreshDeferred: false,
    scheduleDetailRefresh() { scheduled += 1; },
    async refreshDetailData() { refreshed += 1; },
    async refreshCatalogueState() { catalogueRefreshed += 1; },
    async start() {}, async handleIntent() {}, cleanup() {}, renderQueue() {}, queueOpen: true, queuePage: "details"
  };
  load(env, "src/content/operation-lifecycle-controller.js");
  const controller = env.R34MF.modules.subscriptionsController;

  controller.scheduleDetailRefresh();
  assert.equal(scheduled, 0);
  assert.equal(controller.operationDetailRefreshDeferred, true);
  active = [];
  controller.scheduleDetailRefresh();
  assert.equal(scheduled, 1);

  await controller.handleIntent("details-cancel");
  assert.equal(abandoned, 1);
  assert.ok(refreshed >= 1);
  await controller.handleIntent("scan-cancel");
  assert.equal(catalogueCancelled, 1);
  assert.equal(catalogueRefreshed, 1);
});

test("Full rescan maintenance captures rollback baseline and retains it while paused", async () => {
  const env = context();
  const calls = [];
  let state = { scanStatus: "complete", scanKind: "initial", catalogueReady: true, smartUpdate: { status: "complete", sessionId: "old-smart" } };
  env.R34MF.modules.db = {
    defaultCatalogueState() { return { smartUpdate: { status: "idle", sessionId: null } }; },
    async getCatalogueState() { return state; },
    async clearSmartUpdateStage(sessionId) { calls.push(`clear-smart:${sessionId ?? "all"}`); },
    async putCatalogueState(changes) { calls.push("put-state"); state = { ...state, ...changes }; return state; },
    async finalizeFullRescan() { calls.push("finalize"); },
    async countVideos() { return 20; }, async countDetailedVideos() { return 10; },
    authoritativeCountChanges(indexedCount, detailedCount) { return { indexedCount, detailedCount }; }
  };
  env.R34MF.modules.catalogueCancelStorage = {
    async captureFullRescanBaseline() { calls.push("capture-baseline"); return { captured: true }; },
    async clearFullRescanBaseline() { calls.push("clear-baseline"); },
    async restoreFullRescanBaseline() { calls.push("restore-baseline"); return { restored: true }; },
    async hasFullRescanBaseline() { return true; },
    async cancelSmartUpdate() { calls.push("cancel-smart"); },
    async cancelInitialScan() { calls.push("cancel-initial"); }
  };
  env.R34MF.modules.catalogueScanner = {
    async run() { calls.push("run"); state = { ...state, scanStatus: "paused", scanKind: "full-rescan", sessionId: "rescan" }; return state; },
    async runSmartUpdate() {},
    async refresh() { calls.push("refresh"); return state; },
    stop() {}, subscribe() {}
  };
  const scanner = load(env, "src/catalogue/catalogue-maintenance.js").catalogueScanner;
  await scanner.run({ fullRescan: true });
  assert.ok(calls.indexOf("capture-baseline") < calls.indexOf("run"));
  assert.equal(calls.includes("clear-baseline"), false, "paused Full rescan must retain rollback baseline for Cancel");

  const outcome = await scanner.cancelCurrent();
  assert.equal(outcome.cancelled, true);
  assert.ok(calls.includes("restore-baseline"));
});

test("operation lifecycle modules are ordered around existing Phase 7/8 wrappers for both browser packages", () => {
  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const scripts = manifest.content_scripts[0].js;
  const index = (path) => scripts.indexOf(path);
  assert.ok(index("src/jobs/detail-operation-lifecycle.js") > index("src/jobs/detail-maintenance.js"));
  assert.ok(index("src/jobs/detail-operation-lifecycle.js") < index("src/catalogue/catalogue-scanner.js"));
  assert.ok(index("src/catalogue/catalogue-cancel-storage.js") > index("src/catalogue/catalogue-scanner.js"));
  assert.ok(index("src/catalogue/catalogue-cancel-storage.js") < index("src/catalogue/catalogue-maintenance.js"));
  assert.ok(index("src/ui/queue/queue-timing-model.js") > index("src/ui/queue/queue-maintenance-state.js"));
  assert.ok(index("src/ui/queue/queue-timing-model.js") < index("src/ui/queue/queue.js"));
  assert.ok(index("src/ui/queue/queue-operation-controls.js") > index("src/ui/queue/queue-diagnostic-polish.js"));
  assert.ok(index("src/content/operation-lifecycle-controller.js") > index("src/content/maintenance-controller.js"));
  assert.ok(index("src/content/operation-lifecycle-controller.js") < index("src/content/main.js"));
});

test("idle Queue child pages never invent Cancel controls", () => {
  const { root, queue } = queueHarness();
  queue.render(root, raw(), "catalogue", null);
  assert.equal(root.querySelector("[data-r34mf-action='scan-cancel']"), null);
  assert.ok(root.querySelector("[data-r34mf-action='smart-update']"));
  queue.render(root, raw(), "details", null);
  assert.equal(root.querySelector("[data-r34mf-action='details-cancel']"), null);
  assert.ok(root.querySelector("[data-r34mf-action='details-fetch']") ?? root.querySelector("[data-r34mf-action='queue-maintenance']"));
});
