import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function modules() {
  let now = 0;
  const timers = { now: () => now, setTimeout(callback, ms) { now += ms; callback(); return 1; }, clearTimeout() {} };
  const context = { console, DOMException, AbortController, setTimeout, clearTimeout, URL };
  context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/jobs/request-scheduler.js", "src/jobs/job-manager.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return { app: context.R34MF.modules, timers, now: () => now };
}

test("scheduler reserves simultaneous request starts and honors the longest Retry-After", async () => {
  const { app, timers, now } = modules();
  const scheduler = app.createRequestScheduler({ clock: timers, getMinimumSpacingMs: () => 250 });
  await Promise.all([scheduler.waitTurn(), scheduler.waitTurn()]);
  assert.equal(now(), 250);
  assert.equal(scheduler.parseRetryAfter("5", 1000), 6000);
  scheduler.applyRetryAfter("5", 1000); scheduler.applyRetryAfter("2", 1000);
  assert.equal(scheduler.snapshot().cooldownUntil, 6000);
  assert.equal(scheduler.parseRetryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 1000), 10000);
});

test("scheduler uses bounded 1s/2s exponential backoff for persistent non-429 transients", async () => {
  const { app, timers, now } = modules(); const scheduler = app.createRequestScheduler({ clock: timers, getMinimumSpacingMs: () => 0, getMaximumAutomaticRetries: () => 2 }); let attempts = 0;
  const response = await scheduler.runWithPolicy({ request: async () => ({ status: ++attempts < 3 ? 503 : 200 }) });
  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
  assert.equal(now(), 3000);
});

test("JobManager uses FIFO compatible scheduling, conflicts, coverage, and stop", async () => {
  const { app } = modules(); const starts = []; const manager = app.createJobManager({ getConcurrency: () => 2 });
  let releaseA; manager.registerHandler("a", async () => { starts.push("a"); await new Promise((resolve) => { releaseA = resolve; }); });
  manager.registerHandler("b", async () => { starts.push("b"); }); manager.registerHandler("c", async () => { starts.push("c"); });
  manager.enqueue({ kind: "a", scopeKey: "a", resourceKeys: ["catalogue"] }); manager.enqueue({ kind: "b", scopeKey: "b", resourceKeys: ["other"] }); manager.enqueue({ kind: "c", scopeKey: "c", resourceKeys: ["catalogue"] });
  await new Promise(setImmediate); assert.deepEqual(starts, ["a", "b"]); assert.equal(manager.snapshot().waiting.length, 1);
  assert.equal(manager.enqueue({ kind: "full", scopeKey: "full", resourceKeys: ["catalogue"], coverage: ["smart"] }).accepted, true);
  assert.equal(manager.enqueue({ kind: "smart", scopeKey: "smart", resourceKeys: ["catalogue"] }).reason, "covered");
  const active = manager.snapshot().active.find((job) => job.kind === "a"); assert.equal(manager.stop(active.id), true); releaseA(); await new Promise(setImmediate);
  assert.ok(manager.snapshot().recent.some((job) => job.state === "stopped"));
});

test("JobManager fails a missing handler instead of silently completing it", async () => {
  const { app } = modules(); const manager = app.createJobManager();
  manager.enqueue({ kind: "missing", scopeKey: "missing" }); await new Promise(setImmediate);
  const job = manager.snapshot().recent[0]; assert.equal(job.state, "failed"); assert.equal(job.error.code, "missing-job-handler");
});

test("Local manifest order dedupes refreshed prefixes and preserves deterministic orphans", () => {
  const context = { console }; context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/shared/constants.js", "src/storage/db.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const ids = context.R34MF.modules.db.orderedVideoIdsFromManifests([{ pageNumber: 2, status: "complete", videoIds: ["B", "C", "D"] }, { pageNumber: 1, status: "complete", videoIds: ["N", "A", "B"] }], [{ videoId: "X", nativePage: 99 }, { videoId: "A" }]);
  assert.deepEqual([...ids], ["N", "A", "B", "C", "D", "X"]);
});

test("Local card formats and compact page window stay bounded", () => {
  const context = { console }; context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/ui/paginator-model.js", "src/ui/local-grid.js"]) {
    if (file.endsWith("local-grid.js")) context.R34MF.modules.db = {};
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  }
  const grid = context.R34MF.modules.localGrid;
  assert.equal(grid.formatDuration(59), "00:59"); assert.equal(grid.formatDuration(754), "12:34"); assert.equal(grid.formatDuration(3723), "1:02:03");
  assert.equal(grid.formatCompact(1900), "1.9K"); assert.equal(grid.formatCompact(25000), "25K"); assert.equal(grid.formatCompact(1200000), "1.2M");
  assert.ok(grid.pageWindow(107, 215).length <= 11);
});
