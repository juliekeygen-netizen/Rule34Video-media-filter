import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path) => readFileSync(join(root, path), "utf8");

function context(modules = {}, extras = {}) {
  const value = { console, URL, setTimeout, clearTimeout, R34MF: { modules }, ...extras };
  value.globalThis = value;
  return vm.createContext(value);
}

function run(path, ctx) {
  vm.runInContext(source(path), ctx, { filename: path });
}

test("browser feedback settings add recent update, 1-6 columns and thumbnail ratios", () => {
  const storageLocal = { async get() { return {}; }, async set() {} };
  const ctx = context({ constants: { storageKeys: { settings: "settings" } }, browserApi: { storageLocal } });
  run("src/storage/settings.js", ctx);
  const settings = ctx.R34MF.modules.settings;
  assert.equal(settings.defaults.autoUpdateRecentVideos, false);
  assert.equal(settings.defaults.videoColumns, 3);
  assert.equal(settings.defaults.thumbnailAspectRatio, "16:9");
  assert.deepEqual([...settings.THUMBNAIL_ASPECT_RATIOS], ["16:9", "16:10", "3:2", "4:3", "5:4", "1:1"]);
  assert.equal(settings.normalize({ autoUpdateRecentVideos: true, videoColumns: 6, thumbnailAspectRatio: "5:4" }).autoUpdateRecentVideos, true);
  assert.equal(settings.normalize({ videoColumns: 6 }).videoColumns, 6);
  assert.equal(settings.normalize({ thumbnailAspectRatio: "1:1" }).thumbnailAspectRatio, "1:1");
  assert.equal(settings.normalize({ thumbnailAspectRatio: "16:10" }).thumbnailAspectRatio, "16:10");
  assert.equal(settings.normalize({ thumbnailAspectRatio: "3:2" }).thumbnailAspectRatio, "3:2");
  assert.equal(settings.normalize({ thumbnailAspectRatio: "2:1" }).thumbnailAspectRatio, "16:9");
});

test("backup depth accepts the Phase 10 canary evidence path that failed in-browser", () => {
  const backup = source("src/storage/backup-schema.js");
  assert.match(backup, /const MAX_DEPTH = 32;/);
  assert.doesNotMatch(backup, /const MAX_DEPTH = 10;/);
});

test("Recent Update prepends only records before the newest Local anchor", () => {
  const ctx = context();
  run("src/catalogue/catalogue-reconciliation.js", ctx);
  const recent = ctx.R34MF.modules.catalogueReconciliation.recentUpdateOrder;
  const result = recent({ scannedIds: ["103", "102", "101", "100"], oldIds: ["100", "99", "98", "97"], nativeTotal: 7 });
  assert.equal(result.ready, true);
  assert.deepEqual(Array.from(result.orderedIds), ["103", "102", "101", "100", "99", "98", "97"]);
  assert.equal(recent({ scannedIds: ["103", "102"], oldIds: ["100", "99"], nativeTotal: 4 }).reason, "recent-anchor-not-found");
  assert.equal(recent({ scannedIds: ["103", "102", "100"], oldIds: ["100", "99"], nativeTotal: 6 }).reason, "native-total-mismatch");
});

test("Settings browser feedback removes redundant cards and keeps dangerous actions confirmed", () => {
  const ui = source("src/ui/settings.js");
  const css = source("src/ui/settings.css");
  assert.match(ui, /Video column amount/);
  assert.match(ui, /Thumbnail aspect ratio/);
  assert.match(ui, /Auto-update recent videos/);
  assert.doesNotMatch(ui, /Native\/Local mode, filters, sort direction/);
  assert.doesNotMatch(ui, /Automatic sign-in requires a positively verified native Login form/);
  assert.doesNotMatch(ui, /Credentials saved locally\. Automatic sign-in has not succeeded yet/);
  assert.doesNotMatch(ui, /section\("Local metadata"\)/);
  assert.match(ui, /title: "Clear detailed metadata\?"/);
  assert.match(ui, /title: "Clear entire local catalogue\?"/);
  assert.match(ui, /password: String\(credentials\?\.password/);
  assert.match(ui, /pass\.autocomplete = "current-password"/);
  assert.doesNotMatch(css, /r34mf-settings-number-suffix/);
  assert.match(ui, /\(ms\)/);
  assert.match(ui, /\(pages\)/);
  assert.match(css, /\.r34mf-settings-danger \{[\s\S]*?border-top: 0;/);
});

test("Local display and Queue CSS expose requested column, aspect and action spacing controls", () => {
  const local = source("src/ui/local-grid.js");
  const styles = source("src/ui/styles.css");
  assert.match(local, /columns = 3/);
  assert.match(local, /\[1, 2, 3, 4, 5, 6\]/);
  assert.match(local, /"5:4"/);
  assert.match(local, /"4:3"/);
  assert.match(local, /"16:9"/);
  assert.match(local, /"1:1"/);
  assert.match(styles, /--r34mf-local-aspect-ratio/);
  assert.match(styles, /\.r34mf-queue-footer \{[^}]*gap: 8px/);
});

test("cross-browser background owns session execution plus bounded GitHub cloud support", () => {
  const chrome = JSON.parse(source("manifests/chrome.json"));
  const firefox = JSON.parse(source("manifests/firefox.json"));
  const sessionBackground = source("src/background/session-runtime.js");
  const cloudBackground = source("src/background/cloud-runtime.js");
  const chromeBackground = source("src/background/chrome-runtime.js");
  const parity = source("scripts/verify-release-parity.mjs");
  assert.equal(chrome.background.service_worker, "src/background/chrome-runtime.js");
  assert.deepEqual(firefox.background.scripts, ["src/background/session-runtime.js", "src/background/cloud-runtime.js"]);
  assert.match(chromeBackground, /importScripts\("session-runtime\.js", "cloud-runtime\.js"\)/);
  assert.match(sessionBackground, /storage\.session/);
  assert.match(sessionBackground, /r34mf:auto-recent-claim/);
  assert.match(sessionBackground, /r34mf:fetch-subscriptions-page/);
  assert.match(sessionBackground, /MAX_RESPONSE_CHARS = 6_000_000/);
  assert.match(cloudBackground, /MAX_BACKUP_BYTES = 80_000_000/);
  assert.match(cloudBackground, /MAX_BASE64_CHARS/);
  assert.match(cloudBackground, /api\.github\.com/);
  assert.match(parity, /shared_scripts/);
  assert.match(parity, /Chrome background runtime changed unexpectedly/);
});

test("Automatic sign-in watches for late Login UI and preserves pageshow recovery", () => {
  const auth = source("src/auth/auto-signin.js");
  assert.match(auth, /new MutationObserver/);
  assert.match(auth, /beginReadinessWatch/);
  assert.match(auth, /normalizeToCurrentOrigin/);
  assert.match(auth, /pageshow/);
});

test("Smart Update native page reuse is optional and falls back when discovery evidence is incomplete", () => {
  const scanner = source("src/catalogue/catalogue-scanner.js");
  assert.match(scanner, /typeof discovery\.pageFromText === "function"/);
  assert.match(scanner, /Native page reuse is only an optimization/);
});


test("explicit Smart Update stays full Smart mode after a durable Recent Update", () => {
  const controller = source("src/content/subscriptions-controller.js");
  assert.match(controller, /job\.progress\?\.updateMode === "recent" \? "recent" : "smart"/);
  assert.match(controller, /options\.updateMode === "recent" \? "recent" : "smart"/);
  assert.doesNotMatch(controller, /this\.state\.catalogue\?\.smartUpdate\?\.updateMode/);
});


test("second browser-feedback patch covers live wiring and structured history values", () => {
  const hardening = source("src/content/phase10-hardening-controller.js");
  assert.match(hardening, /columns: app\.modules\.settings\.value\.videoColumns/);
  assert.match(hardening, /aspectRatio: app\.modules\.settings\.value\.thumbnailAspectRatio/);

  const modules = {
    db: { STORES: {}, HISTORY_LIMIT: 12, STATE_KEY: "catalogue", defaultCatalogueState: () => ({}), defaultDetailsState: () => ({}), deriveCatalogueState: (value) => value },
    settings: { normalize: (value) => value },
    uiState: { normalize: (value) => value },
    filterEngine: { normalize: (value) => value },
    rule34VideoIdentity: { validateRecord: (record) => ({ ok: true, url: record?.url ?? "https://rule34video.com/video/1/" }) }
  };
  const ctx = context(modules, { Date, Error, TypeError, DOMException });
  run("src/storage/backup-schema.js", ctx);
  const cloned = vm.runInContext(`(() => {
    const failure = new TypeError("Failed to fetch");
    failure.code = "network-error";
    return R34MF.modules.backupSchema.cloneJsonValue({ database: { jobHistory: [{ summary: { error: failure } }] } });
  })()`, ctx);
  const safe = cloned.database.jobHistory[0].summary.error;
  assert.equal(safe.name, "TypeError");
  assert.equal(safe.message, "Failed to fetch");
  assert.equal(safe.code, "network-error");
  assert.equal(Object.hasOwn(safe, "stack"), false);
});

test("Recent Update has a repeatable manual path and defers automatic startup until idle Queue readiness", () => {
  const recent = source("src/content/recent-auto-update-controller.js");
  assert.match(recent, /smart-update-recent-test/);
  assert.match(recent, /contextmenu/);
  assert.match(recent, /enqueueRecentUpdate\(this, \{ automatic: false \}\)/);
  assert.match(recent, /enqueueRecentUpdate\(this, \{ automatic: true \}\)/);
  assert.match(recent, /baseOnCatalogueState/);
  assert.match(recent, /AUTO_START_DELAY_MS = 1400/);
  assert.match(recent, /queueRuntimeReady\(\)/);
  assert.match(recent, /requestIdleCallback/);
  assert.doesNotMatch(recent, /setTimeout\?\.\(tryAutomatic, 750\)/);
});

test("Automatic sign-in can discover a native Login control without a navigation href", () => {
  const auth = source("src/auth/auto-signin.js");
  assert.match(auth, /function findLoginControl/);
  assert.match(auth, /function waitForLoginForm/);
  assert.match(auth, /control\.click\?\.\(\)/);
  assert.match(auth, /login-form-not-found/);
  assert.match(auth, /inspectLoginForms/);
  assert.match(auth, /LOGIN_PAGE_PATHS/);
  assert.match(auth, /submissionStarted = true;[\s\S]*submitLogin/);
  assert.doesNotMatch(auth, /autoSignInSuppressed|SUPPRESS_KEY|suppressForTab/);
});
