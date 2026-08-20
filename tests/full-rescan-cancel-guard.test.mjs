import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function context() {
  const env = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, DOMException, AbortController, setTimeout, clearTimeout };
  env.globalThis = env;
  vm.createContext(env);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), env, { filename: "src/shared/namespace.js" });
  return env;
}

function load(env, path) {
  vm.runInContext(readFileSync(path, "utf8"), env, { filename: path });
  return env.R34MF.modules;
}

test("a resumable Full rescan must be resumed or cancelled before a fresh replacement can overwrite its rollback baseline", async () => {
  const env = context();
  let ran = 0; let cleared = 0; let captured = 0;
  env.R34MF.modules.db = {
    defaultCatalogueState() { return { smartUpdate: { status: "idle" } }; },
    async getCatalogueState() { return { scanStatus: "paused", scanKind: "full-rescan", sessionId: "rescan-1", smartUpdate: { status: "idle" } }; },
    async clearSmartUpdateStage() { cleared += 1; }, async putCatalogueState() {},
    async countVideos() { return 10; }, async countDetailedVideos() { return 5; }, authoritativeCountChanges() { return {}; }
  };
  env.R34MF.modules.catalogueCancelStorage = {
    async captureFullRescanBaseline() { captured += 1; }, async restoreFullRescanBaseline() { return { restored: true }; },
    async hasFullRescanBaseline() { return true; }, async clearFullRescanBaseline() {}, async cancelSmartUpdate() {}, async cancelInitialScan() {}
  };
  env.R34MF.modules.catalogueScanner = {
    async run() { ran += 1; return { scanStatus: "complete" }; }, async runSmartUpdate() {}, async refresh() { return {}; }, stop() {}, subscribe() {}
  };
  const scanner = load(env, "src/catalogue/catalogue-maintenance.js").catalogueScanner;
  await assert.rejects(scanner.run({ fullRescan: true }), (error) => error?.code === "full-rescan-resumable");
  assert.equal(ran, 0);
  assert.equal(cleared, 0, "guard must fire before clearing rollback/Smart staging");
  assert.equal(captured, 0, "guard must not replace the existing rollback baseline");
});