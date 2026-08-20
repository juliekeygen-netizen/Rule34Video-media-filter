import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

function uploadDateModule() {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), context, { filename: "src/shared/namespace.js" });
  vm.runInContext(readFileSync("src/shared/upload-date.js", "utf8"), context, { filename: "src/shared/upload-date.js" });
  return context.R34MF.modules.uploadDate;
}

test("date-only detail keeps compatible listing hour precision for Local age text", () => {
  const uploadDate = uploadDateModule();
  const now = Date.parse("2026-08-12T18:00:00Z");
  const video = {
    relativeUploadText: "20 hours ago",
    ...uploadDate.listingObservationFields("20 hours ago", now)
  };
  const details = { status: "complete", exactUploadDate: "2026-08-11" };

  const authoritative = uploadDate.resolve(video, details);
  assert.equal(authoritative.source, "detail-exact");
  assert.equal(authoritative.precision, "date");

  const display = uploadDate.displayResolved(video, details);
  assert.equal(display.source, "detail-date+listing-estimate");
  assert.equal(display.precision, "range");
  assert.equal(uploadDate.formatRelative(video, details, now), "20 hours ago");
  assert.equal(uploadDate.evaluate(video, details, { operator: "on", value: "2026-08-11" }, now), true);
});

test("date-only detail uses compatible listing precision only as an intra-day sort tie-break", () => {
  const uploadDate = uploadDateModule();
  const now = Date.parse("2026-08-12T18:00:00Z");
  const details = { status: "complete", exactUploadDate: "2026-08-11" };
  const older = { relativeUploadText: "20 hours ago", ...uploadDate.listingObservationFields("20 hours ago", now) };
  const newer = { relativeUploadText: "19 hours ago", ...uploadDate.listingObservationFields("19 hours ago", now) };

  assert.ok(uploadDate.sortValue(newer, details) > uploadDate.sortValue(older, details));

  const conflicting = { relativeUploadText: "2 hours ago", ...uploadDate.listingObservationFields("2 hours ago", now) };
  const conflictingDetails = { status: "complete", exactUploadDate: "2026-08-10" };
  assert.equal(uploadDate.displayResolved(conflicting, conflictingDetails).precision, "date");
  assert.equal(uploadDate.formatRelative(conflicting, conflictingDetails, now), "2 days ago");
});

function queueContext() {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
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
    document,
    Element: window.Element
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    "src/shared/namespace.js",
    "src/ui/queue/queue-view-model.js",
    "src/ui/queue/queue.js",
    "src/ui/queue/queue-diagnostic-polish.js"
  ]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return { context, root: document.querySelector("#root") };
}

function detailRaw(detailsState) {
  return {
    catalogue: {
      catalogueReady: true,
      usable: true,
      indexedCount: 100,
      detailedCount: 20,
      detailsState
    },
    runtime: { active: [], waiting: [], slots: 1 },
    capabilities: { fetchDetails: true }
  };
}

test("manual Detail pause hides Export diagnostic while real failures keep it available", () => {
  const { context, root } = queueContext();
  const queue = context.R34MF.modules.queue;

  queue.render(root, detailRaw({
    status: "paused",
    processedCount: 12,
    completedCount: 12,
    failedCount: 0,
    lastError: null,
    systemicReason: null,
    lastCanary: { passed: true, samples: [] }
  }), "details", null);
  assert.equal(root.querySelector("[data-r34mf-action='details-export-diagnostic']"), null);
  assert.ok(root.querySelector("[data-r34mf-action='details-resume']"));

  queue.render(root, detailRaw({
    status: "paused",
    processedCount: 12,
    completedCount: 11,
    failedCount: 1,
    lastError: null,
    systemicReason: null,
    lastCanary: { passed: true, samples: [] }
  }), "details", null);
  assert.ok(root.querySelector("[data-r34mf-action='details-export-diagnostic']"));
});

test("failed Detail state keeps diagnostics and uses a failure heading instead of calling it paused", () => {
  const { context, root } = queueContext();
  context.R34MF.modules.queue.render(root, detailRaw({
    status: "failed",
    failedCount: 0,
    lastError: { code: "request-scheduler-error", message: "Scheduler failed." },
    systemicReason: { code: "request-scheduler-error", message: "Scheduler failed." }
  }), "details", null);

  assert.ok(root.querySelector("[data-r34mf-action='details-export-diagnostic']"));
  assert.equal(root.querySelector(".r34mf-queue-lead")?.textContent, "Detailed metadata failed");
});

test("Queue diagnostic polish loads after Queue and before the subscriptions controller", () => {
  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const scripts = manifest.content_scripts[0].js;
  const queue = scripts.indexOf("src/ui/queue/queue.js");
  const polish = scripts.indexOf("src/ui/queue/queue-diagnostic-polish.js");
  const controller = scripts.indexOf("src/content/subscriptions-controller.js");
  assert.ok(queue >= 0 && polish > queue && controller > polish);
});