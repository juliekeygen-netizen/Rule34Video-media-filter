import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { parseHTML, DOMParser } from "linkedom";

const settingsSource = await readFile(new URL("../src/storage/settings.js", import.meta.url), "utf8");
const authSource = await readFile(new URL("../src/auth/auto-signin.js", import.meta.url), "utf8");
const dataSource = await readFile(new URL("../src/storage/settings-data.js", import.meta.url), "utf8");
const settingsUiSource = await readFile(new URL("../src/ui/settings.js", import.meta.url), "utf8");
const settingsCss = await readFile(new URL("../src/ui/settings.css", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifests/base.json", import.meta.url), "utf8"));

function loadSettings(raw = null) {
  const state = { "r34mf.settings": raw };
  const R34MF = {
    modules: {
      constants: { storageKeys: { settings: "r34mf.settings" } },
      browserApi: {
        storageLocal: {
          async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.map((key) => [key, state[key]]));
          },
          async set(value) { Object.assign(state, value); }
        }
      }
    }
  };
  vm.runInNewContext(settingsSource, { R34MF, Object, Number, Math, JSON });
  return { module: R34MF.modules.settings, state };
}

function loadSettingsData() {
  const STORES = {
    videos: "videos",
    videoDetails: "videoDetails",
    cataloguePages: "cataloguePages",
    smartUpdatePages: "smartUpdatePages",
    catalogueState: "catalogueState",
    jobHistory: "jobHistory"
  };
  const removed = [];
  const setValues = [];
  let settingsLoads = 0;
  const defaults = () => ({ key: "catalogue", catalogueReady: false, indexedCount: 0, detailedCount: 0 });
  const db = {
    STORES,
    STATE_KEY: "catalogue",
    HISTORY_LIMIT: 12,
    defaultCatalogueState: defaults,
    defaultDetailsState: () => ({ status: "idle" }),
    deriveCatalogueState(state, changes = {}) { return { ...defaults(), ...(state ?? {}), ...changes, key: "catalogue" }; }
  };
  const R34MF = {
    version: "0.1.0",
    modules: {
      db,
      constants: { storageKeys: { settings: "r34mf.settings", uiState: "r34mf.ui", filterState: "r34mf.filters" } },
      browserApi: {
        storageLocal: {
          async get() { return {}; },
          async set(value) { setValues.push(value); },
          async remove(keys) { removed.push(...keys); }
        }
      },
      settings: {
        value: {},
        normalize(value) { return value ?? {}; },
        async load() { settingsLoads += 1; }
      }
    }
  };
  vm.runInNewContext(dataSource, {
    R34MF, Object, Number, Math, JSON, Date, Set, Map, TextEncoder, Blob, URL, Promise, Array, String
  });
  return { module: R34MF.modules.settingsData, STORES, removed, setValues, getSettingsLoads: () => settingsLoads };
}

function authContext(markup, href = "https://rule34video.com/") {
  const { document } = parseHTML(markup);
  const parsed = new URL(href);
  const context = {
    browser: { storage: {} },
    document,
    location: { href, origin: parsed.origin, hostname: parsed.hostname, reload() {} },
    URL, FormData, URLSearchParams, DOMParser, Date, Math, Set, RegExp, String, Number, Object, queueMicrotask, globalThis: null
  };
  context.globalThis = context;
  vm.runInNewContext(authSource, context);
  return { context, document, auth: context.R34MFAutoSignIn };
}

test("Phase 9 settings derive request pace and include automatic sign-in", async () => {
  const { module } = loadSettings();
  const loaded = await module.load();
  assert.equal(loaded.concurrentQueueJobs, 1);
  assert.equal(loaded.concurrentDetailRequests, 2);
  assert.equal(loaded.requestPace, "recommended");
  assert.equal(loaded.advanced.minimumRequestSpacingMs, 250);
  assert.equal(loaded.automaticSignIn, false);
  assert.equal(module.paceForSpacing(500), "conservative");
  assert.equal(module.paceForSpacing(250), "recommended");
  assert.equal(module.paceForSpacing(125), "faster");
  assert.equal(module.paceForSpacing(333), "custom");
});

test("selecting a request pace changes scheduler spacing and raw edits derive Custom", () => {
  const { module } = loadSettings();
  const faster = module.applyRequestPace(module.resetPreview(), "faster");
  assert.equal(faster.requestPace, "faster");
  assert.equal(faster.advanced.minimumRequestSpacingMs, 125);
  const custom = module.normalize({ ...faster, advanced: { ...faster.advanced, minimumRequestSpacingMs: 333 } });
  assert.equal(custom.requestPace, "custom");
});

test("Settings save can commit credential storage in the same storage.local write", async () => {
  const { module, state } = loadSettings();
  const saved = await module.save(module.resetPreview(), { "r34mf.authCredentials": { identifier: "alice", password: "secret" } });
  assert.equal(saved.concurrentQueueJobs, 1);
  assert.equal(state["r34mf.settings"].requestPace, "recommended");
  assert.deepEqual(JSON.parse(JSON.stringify(state["r34mf.authCredentials"])), { identifier: "alice", password: "secret" });
});

test("automatic sign-in discovers only a verified same-origin POST login form", () => {
  const { document, auth } = authContext(`<!doctype html><html><body>
    <a href="/login/">Login</a>
    <form method="post" action="/login/">
      <input type="hidden" name="csrf" value="token">
      <input name="username" autocomplete="username">
      <input type="password" name="pass">
      <button type="submit" name="action" value="login">Login</button>
    </form>
  </body></html>`);
  assert.equal(auth.looksLoggedOut(document), true);
  assert.equal(auth.discoverLoginUrl(document, { href: "https://rule34video.com/", origin: "https://rule34video.com" }), "https://rule34video.com/login/");
  const match = auth.findLoginForm(document, "https://rule34video.com/login/");
  assert.ok(match);
  assert.equal(match.identifier.name, "username");
  assert.equal(match.password.name, "pass");
  assert.equal(match.action, "https://rule34video.com/login/");
  assert.equal(auth.safeUrl("https://evil.example/login", "https://rule34video.com/"), null);
});

test("automatic sign-in rejects password forms that are not semantically Login", () => {
  const { document, auth } = authContext(`<!doctype html><form method="post" action="/account/update">
    <input name="email" type="email">
    <input name="password" type="password">
    <button type="submit">Save account</button>
  </form>`, "https://rule34video.com/account/");
  assert.equal(auth.findLoginForm(document, "https://rule34video.com/account/"), null);
});

test("automatic sign-in distinguishes positively verified logged-in state from ambiguous pages", () => {
  const loggedIn = authContext(`<!doctype html><a href="/logout/">Logout</a>`);
  const ambiguous = authContext(`<!doctype html><main>Welcome</main>`);
  assert.equal(loggedIn.auth.looksLoggedIn(loggedIn.document), true);
  assert.equal(loggedIn.auth.looksLoggedOut(loggedIn.document), false);
  assert.equal(ambiguous.auth.looksLoggedIn(ambiguous.document), false);
  assert.equal(ambiguous.auth.looksLoggedOut(ambiguous.document), false);
  assert.equal(ambiguous.auth.retryDelayFor("login-state-unverified"), 15 * 60 * 1000);
});

test("automatic sign-in refuses challenge forms", () => {
  const { document, auth } = authContext(`<!doctype html><form method="post" action="/login/">
    <input name="email" type="email">
    <input name="password" type="password">
    <input name="captcha_response">
    <button type="submit">Login</button>
  </form>`, "https://rule34video.com/login/");
  assert.equal(auth.challengePresent(document), true);
  assert.equal(auth.findLoginForm(document, "https://rule34video.com/login/"), null);
});

test("Merge adopts a complete backup without retaining partial local-only orphan records", () => {
  const { module, STORES } = loadSettingsData();
  const plan = module.planMergeDatasets({
    currentState: { key: "catalogue", catalogueReady: false, indexedCount: 2 },
    currentVideos: [
      { videoId: "local-only", listingUpdatedAt: 300 },
      { videoId: "shared", title: "new current", listingUpdatedAt: 300 }
    ],
    currentDetails: [
      { videoId: "local-only", status: "complete", fetchedAt: 300 },
      { videoId: "shared", status: "complete", fetchedAt: 300 }
    ],
    backupState: { key: "catalogue", catalogueReady: true, indexedCount: 2 },
    databasePayload: {
      [STORES.videos]: [
        { videoId: "shared", title: "older backup", listingUpdatedAt: 100 },
        { videoId: "backup-only", listingUpdatedAt: 100 }
      ],
      [STORES.videoDetails]: [{ videoId: "backup-only", status: "complete", fetchedAt: 100 }],
      [STORES.cataloguePages]: [{ pageNumber: 1, status: "complete", videoIds: ["shared", "backup-only"] }],
      [STORES.jobHistory]: []
    }
  });
  assert.equal(plan.adoptBackupCatalogue, true);
  assert.deepEqual(Array.from(plan.videos, (video) => video.videoId), ["shared", "backup-only"]);
  assert.equal(plan.videos.find((video) => video.videoId === "shared").title, "new current");
  assert.deepEqual(Array.from(plan.details, (detail) => detail.videoId).sort(), ["backup-only", "shared"]);
  assert.equal(plan.catalogueState.indexedCount, 2);
  assert.equal(plan.catalogueState.detailedCount, 2);
});

test("Merge preserves membership of an already-complete current catalogue", () => {
  const { module, STORES } = loadSettingsData();
  const plan = module.planMergeDatasets({
    currentState: { key: "catalogue", catalogueReady: true, indexedCount: 2 },
    currentVideos: [{ videoId: "current-a", listingUpdatedAt: 100 }, { videoId: "shared", listingUpdatedAt: 100 }],
    currentDetails: [],
    backupState: { key: "catalogue", catalogueReady: true },
    databasePayload: {
      [STORES.videos]: [{ videoId: "backup-only", listingUpdatedAt: 500 }, { videoId: "shared", title: "refreshed", listingUpdatedAt: 500 }],
      [STORES.videoDetails]: [{ videoId: "backup-only", status: "complete" }, { videoId: "shared", status: "complete" }],
      [STORES.jobHistory]: []
    }
  });
  assert.equal(plan.adoptBackupCatalogue, false);
  assert.deepEqual(Array.from(plan.videos, (video) => video.videoId), ["current-a", "shared"]);
  assert.equal(plan.videos.find((video) => video.videoId === "shared").title, "refreshed");
  assert.deepEqual(Array.from(plan.details, (detail) => detail.videoId), ["shared"]);
});

test("Replace sanitizes orphan details and clears absent UI/filter/settings storage keys", async () => {
  const { module, STORES, removed, getSettingsLoads } = loadSettingsData();
  const replacement = module.prepareReplacementDatabase({
    [STORES.videos]: [{ videoId: "one" }],
    [STORES.videoDetails]: [{ videoId: "one", status: "complete" }, { videoId: "orphan", status: "complete" }],
    [STORES.catalogueState]: [{ key: "catalogue", catalogueReady: true, indexedCount: 99, detailedCount: 99 }]
  });
  assert.deepEqual(Array.from(replacement[STORES.videoDetails], (detail) => detail.videoId), ["one"]);
  assert.equal(replacement[STORES.catalogueState][0].indexedCount, 1);
  assert.equal(replacement[STORES.catalogueState][0].detailedCount, 1);
  await module.applyBackupStorage({ settings: null, uiState: null, filterState: null }, { replace: true });
  assert.deepEqual(removed.sort(), ["r34mf.filters", "r34mf.settings", "r34mf.ui"]);
  assert.equal(getSettingsLoads(), 1);
});

test("manifest loads automatic sign-in globally while Settings UI styles stay subscriptions-scoped", () => {
  const authScript = manifest.content_scripts.find((entry) => entry.js?.includes("src/auth/auto-signin.js"));
  assert.ok(authScript);
  assert.equal(authScript.run_at, "document_start");
  assert.deepEqual(authScript.matches, ["https://rule34video.com/*", "https://www.rule34video.com/*"]);
  const runtime = manifest.content_scripts.find((entry) => entry.js?.includes("src/content/main.js"));
  const subscriptionsStyles = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/settings.css"));
  assert.ok(runtime.js.includes("src/storage/settings-data.js"));
  assert.ok(runtime.js.includes("src/ui/settings.js"));
  assert.ok(runtime.js.includes("src/content/settings-controller.js"));
  assert.ok(runtime.matches.includes("https://rule34video.com/*"));
  assert.ok(subscriptionsStyles.css.includes("src/ui/settings.css"));
  assert.ok(subscriptionsStyles.matches.includes("https://rule34video.com/my/subscriptions*"));
  assert.ok(runtime.js.indexOf("src/ui/settings.js") < runtime.js.indexOf("src/content/settings-controller.js"));
  assert.ok(runtime.js.indexOf("src/content/subscriptions-controller.js") < runtime.js.indexOf("src/content/settings-controller.js"));
});

test("Settings follows the frozen four-tab fixed-layer contract and backups exclude credentials", () => {
  for (const label of ["Scanning & queue", "Local display", "Data & storage", "Advanced"]) assert.match(settingsUiSource, new RegExp(label.replace(/[&]/g, "&")));
  assert.match(settingsUiSource, /Unsaved changes/);
  assert.match(settingsUiSource, /Discard unsaved changes\?/);
  assert.match(settingsUiSource, /Automatically sign in/);
  assert.doesNotMatch(settingsUiSource, /never included in backups/i);
  assert.match(settingsCss, /grid-template-rows:\s*64px minmax\(0, 1fr\) 64px/);
  assert.match(settingsCss, /\.r34mf-settings-content[\s\S]*overflow-y:\s*auto/);
  assert.doesNotMatch(dataSource, /storagePayload\([\s\S]*authCredentials/);
  assert.match(dataSource, /BACKUP_FORMAT = "r34mf-backup"/);
});

test("Settings audit keeps redraw focus, blocks busy close, persists validation errors, and shares select chevrons", () => {
  assert.match(settingsUiSource, /settingsFocusKey/);
  assert.match(settingsUiSource, /function restoreFocus/);
  assert.match(settingsUiSource, /if \(!active \|\| active\.busy\) return;/);
  assert.match(settingsUiSource, /r34mf-settings-form-error/);
  assert.match(settingsUiSource, /credentialStorageUpdate/);
  assert.match(settingsUiSource, /settings\.save\(session\.draft, extraStorage\)/);
  assert.match(settingsCss, /\.r34mf-settings-select[\s\S]*appearance:\s*none/);
  assert.match(settingsCss, /background-image:[\s\S]*data:image\/svg\+xml/);
  assert.doesNotMatch(settingsCss.match(/\.r34mf-settings-select \{[\s\S]*?\n\}/)?.[0] ?? "", /linear-gradient/);
});