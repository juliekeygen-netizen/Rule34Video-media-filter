import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(path, "utf8");

function settingsRuntime(raw = {}) {
  const app = {
    modules: {
      constants: { storageKeys: { settings: "settings" } },
      browserApi: {
        storageLocal: { async get() { return { settings: raw }; }, async set() {} },
        storage: { onChanged: { addListener() {} } }
      }
    }
  };
  const context = vm.createContext({ R34MF: app, globalThis: null, Object, Number, String, Math, Set, Map });
  context.globalThis = context;
  vm.runInContext(read("src/storage/settings.js"), context, { filename: "src/storage/settings.js" });
  return app.modules.settings;
}

test("Recent Update page depth is a dedicated normalized setting with a 3-page default", () => {
  const settings = settingsRuntime();
  assert.equal(settings.defaults.recentUpdatePageLimit, 3);
  assert.equal(settings.normalize({}).recentUpdatePageLimit, 3);
  assert.equal(settings.normalize({ recentUpdatePageLimit: 7 }).recentUpdatePageLimit, 7);
  assert.equal(settings.normalize({ recentUpdatePageLimit: 0 }).recentUpdatePageLimit, 1);
  assert.equal(settings.normalize({ recentUpdatePageLimit: 99 }).recentUpdatePageLimit, 20);
});

test("bounded Recent Update scans a configured newest-page prefix without an anchor and reconciles partial scans conservatively", () => {
  const source = read("src/catalogue/recent-update-bounded.js");
  assert.match(source, /recentUpdatePageLimit/);
  assert.match(source, /for \(let pageNumber = 1; pageNumber <= limit; pageNumber \+= 1\)/);
  assert.match(source, /mergeRecentPrefix\(scannedIds, oldIds\)/);
  assert.match(source, /reconcileRecentOrder\(scannedIds, oldIds/);
  assert.match(source, /partial Recent Update is conservative/i);
  assert.match(source, /current live/i);
  assert.doesNotMatch(source, /recent-anchor-not-found/);
  assert.doesNotMatch(source, /newest Local video/);
});

test("Recent Update preserves older Local IDs behind the refreshed prefix", () => {
  const app = {
    modules: {
      catalogueScanner: {}, db: {}, feedDiscovery: {}, cardParser: {}, catalogueParsing: {},
      requestScheduler: {}, browserApi: {}, settings: { value: { recentUpdatePageLimit: 3 } }
    }
  };
  const context = vm.createContext({
    R34MF: app,
    globalThis: null,
    Number,
    Math,
    Set,
    Map,
    String,
    Date,
    URL,
    fetch: async () => { throw new Error("unused"); }
  });
  context.globalThis = context;
  vm.runInContext(read("src/catalogue/recent-update-bounded.js"), context, { filename: "src/catalogue/recent-update-bounded.js" });
  assert.deepEqual(
    Array.from(app.modules.boundedRecentUpdate.mergeRecentPrefix(["105", "104", "103", "102"], ["103", "102", "101", "100"])),
    ["105", "104", "103", "102", "101", "100"]
  );
  assert.equal(app.modules.boundedRecentUpdate.configuredPageLimit(), 3);
});

test("failed automatic Recent Updates release their claim while successful runs finalize and reschedule hour modes", () => {
  const source = read("src/content/recent-auto-update-controller.js");
  assert.match(source, /automaticAttemptedThisPage/);
  assert.match(source, /page-already-attempted/);
  assert.match(source, /r34mf:auto-recent-complete/);
  assert.match(source, /if \(result\?\.smartUpdate\?\.status === "complete"\) \{/);
  assert.match(source, /const completion = await complete\(\)/);
  assert.match(source, /if \(intervalMs > 0\) \{[\s\S]*automaticAttemptedThisPage = false;[\s\S]*scheduleFromCooldown/);
  assert.match(source, /\} else \{\s*await release\(\);\s*\}/);
  assert.match(source, /catch \(error\) \{[\s\S]*if \(automatic\) await release\(\)/);
});

test("background Recent Update claims distinguish completed sessions from abandoned in-progress claims", () => {
  const background = read("src/background/session-runtime.js");
  assert.match(background, /CLAIM_STALE_MS = 15 \* 60 \* 1000/);
  assert.match(background, /status: "claimed"/);
  assert.match(background, /status: "complete"/);
  assert.match(background, /r34mf:auto-recent-complete/);
  assert.match(background, /recoveredStaleClaim/);
});

test("Settings distinguish Recent Update depth from full Smart Update overlap and use requested default labels", () => {
  const ui = read("src/ui/settings-p2-ui.js");
  assert.match(ui, /Recent Update pages/);
  assert.match(ui, /How many newest subscription pages Recent Update scans from page 1 on every run/);
  assert.match(ui, /Smart Update known-page threshold/);
  assert.match(ui, /24 — Default/);
  assert.match(ui, /Medium — Default/);
  assert.doesNotMatch(ui, /Medium \(Recommended\)/);
});

test("automatic sign-in adds a low-frequency visible-page retry watchdog for delayed mobile login UI", () => {
  const manifest = JSON.parse(read("manifests/base.json"));
  const globalScript = manifest.content_scripts.find((entry) => entry.js?.includes("src/auth/auto-signin.js"));
  assert.ok(globalScript);
  assert.ok(globalScript.js.indexOf("src/auth/auto-signin-reliability.js") > globalScript.js.indexOf("src/auth/auto-signin.js"));

  const reliability = read("src/auth/auto-signin-reliability.js");
  assert.match(reliability, /FAST_RETRY_MS = 3000/);
  assert.match(reliability, /IDLE_RETRY_MS = 20_000/);
  assert.match(reliability, /visibilitychange/);
  assert.match(reliability, /addEventListener\?\.\("focus"/);
  assert.match(reliability, /addEventListener\?\.\("online"/);
  assert.match(reliability, /auth\.run\(\)/);
});

test("bounded Recent Update module is loaded immediately after the base scanner", () => {
  const manifest = JSON.parse(read("manifests/base.json"));
  const scripts = manifest.content_scripts.find((entry) => entry.js?.includes("src/content/main.js")).js;
  const scanner = scripts.indexOf("src/catalogue/catalogue-scanner.js");
  const bounded = scripts.indexOf("src/catalogue/recent-update-bounded.js");
  const controller = scripts.indexOf("src/content/recent-auto-update-controller.js");
  assert.ok(scanner >= 0 && bounded === scanner + 1 && controller > bounded);
});
