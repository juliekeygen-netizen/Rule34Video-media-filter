import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function context() {
  const env = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, DOMException, AbortController, setTimeout, clearTimeout };
  env.globalThis = env;
  vm.createContext(env);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), env);
  return env;
}

function load(env, path) {
  vm.runInContext(readFileSync(path, "utf8"), env, { filename: path });
  return env.R34MF.modules;
}

function derive(raw) {
  const env = context();
  load(env, "src/ui/queue/queue-view-model.js");
  load(env, "src/ui/queue/queue-maintenance-model.js");
  load(env, "src/ui/queue/queue-maintenance-state.js");
  return env.R34MF.modules.queueViewModel.deriveQueueViewModel(raw);
}

function raw(overrides = {}) {
  return {
    catalogue: {
      catalogueReady: true,
      usable: true,
      indexedCount: 20,
      detailedCount: 10,
      failedDetailCount: 3,
      scanStatus: "complete",
      detailsState: { status: "complete", mode: "refresh" },
      smartUpdate: { status: "complete" },
      ...(overrides.catalogue ?? {})
    },
    runtime: { active: [], waiting: [], slots: 1, ...(overrides.runtime ?? {}) },
    capabilities: { fetchDetails: true, smartUpdate: true },
    recent: []
  };
}

test("completed maintenance mode does not leak into the normal Detailed metadata child", () => {
  const model = derive(raw());
  assert.equal(model.details.status, "Available");
  assert.equal(model.details.mode, "missing");
});

test("resumable failed/refresh maintenance retains its durable mode", () => {
  let model = derive(raw({ catalogue: { detailsState: { status: "paused", mode: "refresh" } } }));
  assert.equal(model.details.status, "Paused");
  assert.equal(model.details.mode, "refresh");

  model = derive(raw({ catalogue: { detailsState: { status: "failed", mode: "failed" } } }));
  assert.equal(model.details.status, "Failed");
  assert.equal(model.details.mode, "failed");
});

test("maintenance Current Queue scopes name failed-only and refresh work instead of Missing details", () => {
  let model = derive(raw({ runtime: { active: [{ id: "retry", kind: "detail-retry-failed", progress: { phase: "bulk", processed: 2, total: 3, detailedCount: 10 } }] } }));
  assert.equal(model.active[0].title, "Retry failed details");
  assert.equal(model.active[0].scope, "2 of 3 failed details checked");

  model = derive(raw({ runtime: { waiting: [{ id: "refresh", kind: "detail-refresh", progress: { total: 10 } }] } }));
  assert.equal(model.waiting[0].title, "Refresh detailed metadata");
  assert.equal(model.waiting[0].scope, "Completed details · 10 videos");
});

test("maintenance state polish loads before Queue captures the view-model facade", () => {
  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("src/ui/queue/queue-maintenance-state.js") > scripts.indexOf("src/ui/queue/queue-maintenance-model.js"));
  assert.ok(scripts.indexOf("src/ui/queue/queue-maintenance-state.js") < scripts.indexOf("src/ui/queue/queue.js"));
});