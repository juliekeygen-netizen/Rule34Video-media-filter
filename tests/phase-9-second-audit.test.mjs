import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const settingsSource = await readFile(new URL("../src/storage/settings.js", import.meta.url), "utf8");
const dataSource = await readFile(new URL("../src/storage/settings-data.js", import.meta.url), "utf8");
const settingsUiSource = await readFile(new URL("../src/ui/settings.js", import.meta.url), "utf8");
const settingsCss = await readFile(new URL("../src/ui/settings.css", import.meta.url), "utf8");
const settingsControllerSource = await readFile(new URL("../src/content/settings-controller.js", import.meta.url), "utf8");
const authSource = await readFile(new URL("../src/auth/auto-signin.js", import.meta.url), "utf8");

function loadSettings(raw = null) {
  const state = { "r34mf.settings": raw };
  const R34MF = {
    modules: {
      constants: { storageKeys: { settings: "r34mf.settings" } },
      browserApi: {
        storageLocal: {
          async get() { return state; },
          async set(value) { Object.assign(state, value); }
        }
      }
    }
  };
  vm.runInNewContext(settingsSource, { R34MF, Object, Number, Math, JSON });
  return R34MF.modules.settings;
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
  const storageSets = [];
  const R34MF = {
    version: "0.1.0",
    modules: {
      db: {
        STORES,
        STATE_KEY: "catalogue",
        HISTORY_LIMIT: 12,
        defaultCatalogueState: () => ({ key: "catalogue", catalogueReady: false, indexedCount: 0, detailedCount: 0 }),
        deriveCatalogueState(state, changes = {}) { return { ...(state ?? {}), ...changes, key: "catalogue" }; }
      },
      constants: { storageKeys: { settings: "r34mf.settings", uiState: "r34mf.ui", filterState: "r34mf.filters" } },
      browserApi: {
        storageLocal: {
          async get() { return {}; },
          async set(value) { storageSets.push(value); },
          async remove() {}
        }
      },
      settings: {
        value: {},
        normalize(value) { return { ...(value ?? {}) }; },
        async load() {}
      }
    }
  };
  vm.runInNewContext(dataSource, {
    R34MF, Object, Number, Math, JSON, Date, Set, Map, TextEncoder, Blob, URL, Promise, Array, String
  });
  return { module: R34MF.modules.settingsData, STORES, storageSets };
}

function loadAuthWithStorage(initial) {
  const state = { "r34mf.authCredentials": initial };
  const writes = [];
  const browser = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.map((key) => [key, state[key]]));
        },
        async set(value) { writes.push(value); Object.assign(state, value); }
      }
    }
  };
  const context = { browser, URL, FormData, URLSearchParams, Date, Math, Set, RegExp, String, Number, Object, Promise, queueMicrotask, globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(authSource, context);
  return { auth: context.R34MFAutoSignIn, state, writes };
}

test("second audit clamps detail concurrency to the supported integer worker count", () => {
  const settings = loadSettings();
  assert.equal(settings.normalize({ concurrentDetailRequests: 2.7 }).concurrentDetailRequests, 3);
  assert.equal(settings.normalize({ concurrentDetailRequests: 1.2 }).concurrentDetailRequests, 1);
  assert.equal(settings.normalize({ concurrentDetailRequests: 99 }).concurrentDetailRequests, 3);
  assert.equal(settings.normalize({ concurrentDetailRequests: -2 }).concurrentDetailRequests, 1);
});

test("second audit backup Merge never downgrades complete detail metadata to failed", () => {
  const { module, STORES } = loadSettingsData();
  const currentComplete = module.planMergeDatasets({
    currentState: { key: "catalogue", catalogueReady: true },
    currentVideos: [{ videoId: "one" }],
    currentDetails: [{ videoId: "one", status: "complete", artist: "Kept", fetchedAt: 100, lastAttemptAt: 100 }],
    backupState: { key: "catalogue", catalogueReady: true },
    databasePayload: {
      [STORES.videos]: [{ videoId: "one" }],
      [STORES.videoDetails]: [{ videoId: "one", status: "failed", lastAttemptAt: 500, failureCount: 3, lastError: { code: "http-500" } }],
      [STORES.jobHistory]: []
    }
  });
  assert.equal(currentComplete.details[0].status, "complete");
  assert.equal(currentComplete.details[0].artist, "Kept");
  assert.equal(currentComplete.details[0].failureCount, 3);
  assert.equal(currentComplete.details[0].lastAttemptError.code, "http-500");
  assert.equal(currentComplete.catalogueState.detailedCount, 1);

  const backupComplete = module.mergeDetailRecord(
    { videoId: "one", status: "failed", lastAttemptAt: 500, lastError: { code: "timeout" } },
    { videoId: "one", status: "complete", artist: "Restored", fetchedAt: 100, lastAttemptAt: 100 }
  );
  assert.equal(backupComplete.status, "complete");
  assert.equal(backupComplete.artist, "Restored");
});

test("second audit backup metadata counts unique videos and imported backups cannot enable automatic sign-in", async () => {
  const { module, STORES, storageSets } = loadSettingsData();
  const validated = module.validateBackup({
    format: module.BACKUP_FORMAT,
    version: module.BACKUP_VERSION,
    database: {
      [STORES.videos]: [{ videoId: "same" }, { videoId: "same" }],
      [STORES.videoDetails]: [],
      [STORES.cataloguePages]: [],
      [STORES.smartUpdatePages]: [],
      [STORES.catalogueState]: [],
      [STORES.jobHistory]: []
    }
  });
  assert.equal(validated.meta.indexed, 1);

  await module.applyBackupStorage({ settings: { automaticSignIn: true, concurrentQueueJobs: 2 } });
  assert.equal(storageSets.length, 1);
  assert.equal(storageSets[0]["r34mf.settings"].automaticSignIn, false);
  assert.equal(storageSets[0]["r34mf.settings"].concurrentQueueJobs, 2);
});

test("second audit Settings rejects partial credentials even when automatic sign-in is off", () => {
  assert.match(settingsUiSource, /const partialCredentials = credentialsDirty\(active\)/);
  assert.match(settingsUiSource, /Saved sign-in credentials need both a username\/email and password/);
  assert.match(settingsUiSource, /Sign-in credentials must include both an identifier and password/);
  assert.match(settingsUiSource, /active\.auth\.identifier = user\.value;[\s\S]*active\.auth\.remove = false/);
});

test("second audit Settings deduplicates pending opens and force-closes on controller unmount", () => {
  assert.match(settingsUiSource, /let opening = null;/);
  assert.match(settingsUiSource, /let openGeneration = 0;/);
  assert.match(settingsUiSource, /if \(opening\) return opening;/);
  assert.match(settingsUiSource, /generation !== openGeneration/);
  assert.match(settingsUiSource, /function close\(\{ returnFocus = false, force = false \} = \{\}\)/);
  assert.match(settingsControllerSource, /settingsUi\.close\(\{ returnFocus: false, force: true \}\)/);
  assert.match(settingsUiSource, /function resolveReturnFocus/);
});

test("second audit preserves confirmations through redraw and labels the alert dialog", () => {
  assert.match(settingsUiSource, /const confirmLayer = active\.dialog\?\.querySelector\("\.r34mf-settings-confirm-layer"\)/);
  assert.match(settingsUiSource, /if \(confirmLayer\) next\.append\(confirmLayer\)/);
  assert.match(settingsUiSource, /aria-labelledby", "r34mf-settings-confirm-title/);
  assert.match(settingsUiSource, /aria-describedby", "r34mf-settings-confirm-description/);
  assert.match(settingsUiSource, /function dismissConfirm/);
  assert.match(settingsUiSource, /_returnFocusKey = focusedKey\(\)/);
});

test("second audit uses final SVG/icon and switch semantics without CSS gradient chevrons", () => {
  assert.match(settingsUiSource, /function closeIcon\(\)/);
  assert.doesNotMatch(settingsUiSource, /r34mf-settings-close", "×"/);
  assert.doesNotMatch(settingsUiSource, /aria-pressed", String\(value === true\)/);
  assert.match(settingsCss, /r34mf-settings-switch\[aria-checked="true"\]/);
  assert.match(settingsCss, /data:image\/svg\+xml/);
  const selectBlock = settingsCss.match(/\.r34mf-settings-select \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(selectBlock, /linear-gradient/);
});

test("second audit stale automatic-sign-in status cannot overwrite changed credentials", async () => {
  const current = { identifier: "new", password: "new-secret", savedAt: 200 };
  const attempted = { identifier: "old", password: "old-secret", savedAt: 100 };
  const { auth, state, writes } = loadAuthWithStorage(current);
  assert.equal(auth.sameCredentialRecord(current, attempted), false);
  const result = await auth.updateCredentialStatus(attempted, { lastAttemptAt: 999, lastError: { code: "old-attempt" } });
  assert.equal(writes.length, 0);
  assert.equal(state["r34mf.authCredentials"].identifier, "new");
  assert.equal(result.identifier, "new");
});
