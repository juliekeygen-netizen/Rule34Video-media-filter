import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function context(seed = {}) {
  const value = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, Object, Array, URL, AbortController, Promise, ...seed };
  value.globalThis = value;
  value.R34MF = { modules: {} };
  vm.createContext(value);
  return value;
}

function load(env, rel) {
  vm.runInContext(readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"), env, { filename: rel });
  return env.R34MF.modules;
}

test("automatic retry ceiling is 100 while default remains 2", () => {
  const env = context();
  env.R34MF.modules.constants = { storageKeys: { settings: "settings" } };
  env.R34MF.modules.browserApi = { storageLocal: { async get() { return {}; }, async set() {} }, storage: {} };
  const settings = load(env, "src/storage/settings.js").settings;
  assert.equal(settings.normalize({}).advanced.maximumAutomaticRetries, 2);
  assert.equal(settings.normalize({ advanced: { maximumAutomaticRetries: 100 } }).advanced.maximumAutomaticRetries, 100);
  assert.equal(settings.normalize({ advanced: { maximumAutomaticRetries: 999 } }).advanced.maximumAutomaticRetries, 100);
});

test("refresh retry workset only includes complete records with a previous attempt error", () => {
  const env = context();
  env.R34MF.modules.db = {};
  env.R34MF.modules.createDetailScanner = () => ({ run: async () => ({}), stop() {} });
  const maintenance = load(env, "src/jobs/detail-maintenance.js").detailMaintenance;
  const records = ["clean", "initial-error", "refresh-error"].map((videoId) => ({ videoId }));
  const details = new Map([
    ["clean", { videoId: "clean", status: "complete", lastAttemptError: null }],
    ["initial-error", { videoId: "initial-error", status: "failed" }],
    ["refresh-error", { videoId: "refresh-error", status: "complete", lastAttemptError: { code: "temporary" } }]
  ]);
  assert.deepEqual(Array.from(maintenance.selectTargetsFromSource(records, details, "refreshFailed"), (row) => row.videoId), ["refresh-error"]);
});

test("resume cutoff skips refresh retry targets already attempted in the logical operation", () => {
  const env = context();
  env.R34MF.modules.db = {};
  env.R34MF.modules.createDetailScanner = () => ({ run: async () => ({}), stop() {} });
  load(env, "src/jobs/detail-maintenance.js");
  const lifecycle = load(env, "src/jobs/detail-operation-lifecycle.js").detailMaintenance;
  const records = ["before", "after"].map((videoId) => ({ videoId }));
  const details = new Map([
    ["before", { videoId: "before", status: "complete", lastAttemptAt: 100, lastAttemptError: { code: "old" } }],
    ["after", { videoId: "after", status: "complete", lastAttemptAt: 300, lastAttemptError: { code: "new" } }]
  ]);
  assert.deepEqual(Array.from(lifecycle.selectTargetsFromSource(records, details, "refreshFailed", null, { cutoffAt: 200 }), (row) => row.videoId), ["before"]);
});
