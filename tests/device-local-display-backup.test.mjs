import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync("src/storage/settings-backup-preference-sync.js", "utf8");
const LOCAL_KEYS = [
  "videosPerPage",
  "videoColumns",
  "thumbnailAspectRatio",
  "artistThumbnailLabels",
  "artistThumbnailLabelSize"
];

function runtime() {
  const defaults = {
    videosPerPage: 24,
    videoColumns: 3,
    thumbnailAspectRatio: "16:9",
    artistThumbnailLabels: true,
    artistThumbnailLabelSize: "medium",
    automaticSignIn: false,
    concurrentDetailRequests: 2,
    autoUpdateRecentVideosFrequency: "session"
  };
  let stored = {
    ...defaults,
    videosPerPage: 48,
    videoColumns: 2,
    thumbnailAspectRatio: "3:2",
    artistThumbnailLabels: false,
    artistThumbnailLabelSize: "small"
  };
  const normalize = (raw) => ({ ...defaults, ...(raw ?? {}) });
  const baseData = {
    async storagePayload() { return { settings: { ...stored }, uiState: { mode: "local" } }; },
    async buildBackup() { return { storage: { settings: { ...stored } }, database: {} }; },
    async applyBackupStorage(payload, { replace = false } = {}) {
      if (payload.settings !== null && payload.settings !== undefined) stored = normalize(payload.settings);
      else if (replace) stored = normalize({});
      return true;
    }
  };
  const baseSchema = {
    normalizeStorage(raw) {
      return { ...raw, settings: raw?.settings == null ? raw?.settings : normalize(raw.settings) };
    },
    normalizeBackup(raw) {
      return { ...raw, storage: this.normalizeStorage(raw?.storage ?? {}) };
    }
  };
  const settingsModule = {
    value: stored,
    normalize,
    async load() { this.value = { ...stored }; return this.value; }
  };
  const sandbox = {
    console,
    R34MF: { modules: {
      settingsData: baseData,
      backupSchema: baseSchema,
      settings: settingsModule,
      constants: { storageKeys: { settings: "settings" } },
      browserApi: { storageLocal: {
        async get() { return { settings: { ...stored } }; },
        async set(value) { if (value.settings) stored = { ...value.settings }; }
      } }
    } }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    data: sandbox.R34MF.modules.settingsData,
    schema: sandbox.R34MF.modules.backupSchema,
    getStored: () => ({ ...stored }),
    defaults
  };
}

test("portable backup settings omit device-local Local-grid presentation", async () => {
  const { data, schema } = runtime();
  const backup = await data.buildBackup();
  for (const key of LOCAL_KEYS) assert.equal(Object.hasOwn(backup.storage.settings, key), false, key);

  const hardened = schema.normalizeBackup(backup);
  for (const key of LOCAL_KEYS) assert.equal(Object.hasOwn(hardened.storage.settings, key), false, key);
});

test("old backups cannot overwrite this device's Local-grid presentation", async () => {
  const { data, getStored, defaults } = runtime();
  await data.applyBackupStorage({
    settings: {
      ...defaults,
      videosPerPage: 72,
      videoColumns: 6,
      thumbnailAspectRatio: "4:3",
      artistThumbnailLabels: true,
      artistThumbnailLabelSize: "big",
      automaticSignIn: true,
      concurrentDetailRequests: 3
    }
  }, { replace: true });

  const stored = getStored();
  assert.equal(stored.videosPerPage, 48);
  assert.equal(stored.videoColumns, 2);
  assert.equal(stored.thumbnailAspectRatio, "3:2");
  assert.equal(stored.artistThumbnailLabels, false);
  assert.equal(stored.artistThumbnailLabelSize, "small");
  assert.equal(stored.automaticSignIn, true);
  assert.equal(stored.concurrentDetailRequests, 3);
});

test("replace without Settings still preserves device-local presentation while resetting portable defaults", async () => {
  const { data, getStored } = runtime();
  await data.applyBackupStorage({}, { replace: true });
  const stored = getStored();
  assert.equal(stored.videosPerPage, 48);
  assert.equal(stored.videoColumns, 2);
  assert.equal(stored.thumbnailAspectRatio, "3:2");
  assert.equal(stored.artistThumbnailLabels, false);
  assert.equal(stored.artistThumbnailLabelSize, "small");
  assert.equal(stored.concurrentDetailRequests, 2);
});
