import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const dataSource = await readFile(new URL("../src/storage/settings-data.js", import.meta.url), "utf8");
const controllerSource = await readFile(new URL("../src/content/subscriptions-controller.js", import.meta.url), "utf8");
const settingsUiSource = await readFile(new URL("../src/ui/settings.js", import.meta.url), "utf8");

function loadSettingsData() {
  const STORES = { videos: "videos", videoDetails: "videoDetails", cataloguePages: "cataloguePages", smartUpdatePages: "smartUpdatePages", catalogueState: "catalogueState", jobHistory: "jobHistory" };
  const defaultState = () => ({ key: "catalogue", catalogueReady: false, indexedCount: 0, detailedCount: 0 });
  const R34MF = {
    version: "0.1.0",
    modules: {
      db: {
        STORES,
        STATE_KEY: "catalogue",
        HISTORY_LIMIT: 12,
        defaultCatalogueState: defaultState,
        defaultDetailsState: () => ({ status: "idle" }),
        deriveCatalogueState(state, changes = {}) { return { ...defaultState(), ...(state ?? {}), ...changes, key: "catalogue" }; }
      },
      constants: { storageKeys: { settings: "r34mf.settings", uiState: "r34mf.ui", filterState: "r34mf.filters" } },
      browserApi: { storageLocal: { async get() { return {}; }, async set() {}, async remove() {} } },
      settings: { value: {}, normalize(value) { return value ?? {}; }, async load() {} }
    }
  };
  vm.runInNewContext(dataSource, { R34MF, Object, Number, Math, JSON, Date, Set, Map, TextEncoder, Blob, URL, Promise, Array, String });
  return { module: R34MF.modules.settingsData, STORES };
}

test("third audit counts unique quality-merged complete detail records", () => {
  const { module, STORES } = loadSettingsData();
  const payload = {
    [STORES.videos]: [{ videoId: "one" }],
    [STORES.videoDetails]: [
      { videoId: "one", status: "complete", artist: "Kept", fetchedAt: 100 },
      { videoId: "one", status: "failed", attemptedAt: 300, lastError: "temporary" },
      { videoId: "one", status: "complete", artist: "Kept", fetchedAt: 100 }
    ]
  };
  assert.equal(module.detailedCountFor(payload), 1);
});

test("third audit Replace deduplicates videos and protects complete detail metadata", () => {
  const { module, STORES } = loadSettingsData();
  const replacement = module.prepareReplacementDatabase({
    [STORES.videos]: [
      { videoId: "one", title: "old", listingUpdatedAt: 100 },
      { videoId: "one", title: "new", listingUpdatedAt: 200 }
    ],
    [STORES.videoDetails]: [
      { videoId: "one", status: "complete", artist: "Kept", fetchedAt: 100 },
      { videoId: "one", status: "failed", attemptedAt: 300, lastError: "temporary" }
    ],
    [STORES.catalogueState]: [{ key: "catalogue", catalogueReady: true, indexedCount: 99, detailedCount: 99 }]
  });
  assert.equal(replacement[STORES.videos].length, 1);
  assert.equal(replacement[STORES.videos][0].title, "new");
  assert.equal(replacement[STORES.videoDetails].length, 1);
  assert.equal(replacement[STORES.videoDetails][0].status, "complete");
  assert.equal(replacement[STORES.videoDetails][0].artist, "Kept");
  assert.equal(replacement[STORES.catalogueState][0].indexedCount, 1);
  assert.equal(replacement[STORES.catalogueState][0].detailedCount, 1);
});

test("third audit controller owns runtime subscriptions and restores native visibility during teardown", () => {
  assert.match(controllerSource, /runtimeUnsubscribers:\s*\[\]/);
  assert.match(controllerSource, /this\.runtimeUnsubscribers\s*=\s*\[/);
  assert.match(controllerSource, /runtimeUnsubscribers\.splice\(0\)/);
  assert.match(controllerSource, /nativeVisibilityNodes\(parts = null\)/);
  assert.match(controllerSource, /typeof document\.querySelector === "function"/);
  assert.match(controllerSource, /restoreNativeVisibility\(parts = null\)/);
  assert.match(controllerSource, /this\.restoreNativeVisibility\(\);[\s\S]*this\.closeQueue/);
});

test("third audit credential fields have explicit visible-label associations", () => {
  assert.match(settingsUiSource, /user\.id = "r34mf-settings-auth-identifier"/);
  assert.match(settingsUiSource, /userLabel\.htmlFor = user\.id/);
  assert.match(settingsUiSource, /pass\.id = "r34mf-settings-auth-password"/);
  assert.match(settingsUiSource, /passLabel\.htmlFor = pass\.id/);
});
