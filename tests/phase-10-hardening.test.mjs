import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path) => readFileSync(join(root, path), "utf8");

function sandbox(modules = {}, extras = {}) {
  const context = {
    console,
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    structuredClone,
    R34MF: { modules },
    ...extras
  };
  context.globalThis = context;
  return vm.createContext(context);
}

function run(path, context) {
  vm.runInContext(source(path), context, { filename: path });
}

function dbStub() {
  const STORES = {
    videos: "videos",
    videoDetails: "videoDetails",
    cataloguePages: "cataloguePages",
    smartUpdatePages: "smartUpdatePages",
    catalogueState: "catalogueState",
    jobHistory: "jobHistory"
  };
  const defaultDetailsState = () => ({ status: "idle", processedCount: 0, completedCount: 0, failedCount: 0, currentPage: null, activeRunStartedAt: null, lastError: null });
  const defaultCatalogueState = () => ({
    key: "subscriptions",
    scanStatus: "not-scanned",
    catalogueReady: false,
    indexedCount: 0,
    detailedCount: 0,
    pagesCompleted: 0,
    nextPage: 1,
    currentPage: null,
    activeRunStartedAt: null,
    detailsState: defaultDetailsState(),
    smartUpdate: { status: "idle", currentPage: null, activeRunStartedAt: null, lastError: null }
  });
  const deriveCatalogueState = (state = {}, changes = {}) => ({
    ...defaultCatalogueState(),
    ...state,
    ...changes,
    key: "subscriptions",
    detailsState: { ...defaultDetailsState(), ...(state.detailsState ?? {}), ...(changes.detailsState ?? {}) },
    smartUpdate: { ...defaultCatalogueState().smartUpdate, ...(state.smartUpdate ?? {}), ...(changes.smartUpdate ?? {}) }
  });
  return { STORES, STATE_KEY: "subscriptions", HISTORY_LIMIT: 12, defaultDetailsState, defaultCatalogueState, deriveCatalogueState };
}

test("Phase 10 manifest orders hardening at the real subsystem boundaries", () => {
  const manifest = JSON.parse(source("manifests/base.json"));
  const scripts = manifest.content_scripts[0].js;
  const index = (path) => scripts.indexOf(path);
  assert.ok(index("src/storage/local-data-cache.js") > index("src/storage/db.js"));
  assert.ok(index("src/storage/data-operation-lock.js") > index("src/storage/db.js"));
  assert.ok(index("src/jobs/data-maintenance-guard.js") > index("src/jobs/job-manager.js"));
  assert.ok(index("src/filters/vocabulary-cache.js") > index("src/filters/upload-date-integration.js"));
  assert.ok(index("src/storage/backup-schema.js") > index("src/sort/sorter.js"));
  assert.ok(index("src/storage/settings-data-hardening.js") > index("src/storage/backup-schema.js"));
  assert.ok(index("src/ui/accessibility-hardening.js") > index("src/ui/queue/queue-operation-controls.js"));
  assert.ok(index("src/ui/accessibility-hardening.js") < index("src/content/subscriptions-controller.js"));
  assert.ok(index("src/content/phase10-hardening-controller.js") > index("src/content/settings-controller.js"));
  assert.ok(index("src/content/phase10-hardening-controller.js") < index("src/content/main.js"));
});

test("Phase 10 data lock closes the Queue idle check/enqueue race", async () => {
  let enqueued = 0;
  const manager = {
    enqueue(input) { enqueued += 1; return { accepted: true, job: input }; },
    snapshot() { return { active: [], waiting: [] }; }
  };
  const context = sandbox({});
  run("src/storage/data-operation-lock.js", context);
  context.R34MF.modules.jobManager = manager;
  run("src/jobs/data-maintenance-guard.js", context);

  const release = context.R34MF.modules.dataOperationLock.acquire("backup-import");
  const blocked = context.R34MF.modules.jobManager.enqueue({ kind: "smart-update" });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, "data-operation-busy");
  assert.equal(enqueued, 0);
  release();
  assert.equal(context.R34MF.modules.jobManager.enqueue({ kind: "smart-update" }).accepted, true);
  assert.equal(enqueued, 1);
});

test("Phase 10 Local snapshot cache coalesces reads and invalidates on catalogue/detail writes", async () => {
  let reads = 0;
  let catalogueListener = null;
  let detailListener = null;
  const backing = {
    async getAllLocalRecords() {
      reads += 1;
      return { records: [{ videoId: String(reads) }], detailsById: new Map() };
    },
    subscribeCatalogueChanges(listener) { catalogueListener = listener; return () => { catalogueListener = null; }; },
    subscribeDetailChanges(listener) { detailListener = listener; return () => { detailListener = null; }; }
  };
  const context = sandbox({ db: backing });
  run("src/storage/local-data-cache.js", context);
  const wrapped = context.R34MF.modules.db;
  const [first, second] = await Promise.all([wrapped.getAllLocalRecords(), wrapped.getAllLocalRecords()]);
  assert.equal(reads, 1);
  assert.equal(first, second);
  assert.equal((await wrapped.getAllLocalRecords()).records[0].videoId, "1");
  assert.equal(reads, 1);
  detailListener();
  assert.equal((await wrapped.getAllLocalRecords()).records[0].videoId, "2");
  assert.equal(reads, 2);
  catalogueListener();
  await wrapped.getAllLocalRecords();
  assert.equal(reads, 3);
  assert.ok(context.R34MF.modules.localDataCache.stats().hits >= 2);
});

test("Phase 10 vocabulary cache derives a large field once and reuses it for searches", () => {
  let calls = 0;
  const engine = {
    vocabulary(records, details, field) {
      calls += 1;
      const values = records.map((record, index) => ({ value: `${field}-${record.videoId}`, count: records.length - index }));
      return { covered: details.size, values };
    }
  };
  const context = sandbox({ filterEngine: engine });
  run("src/filters/vocabulary-cache.js", context);
  const records = Array.from({ length: 5_000 }, (_, index) => ({ videoId: String(index + 1) }));
  const details = new Map(records.map((record) => [record.videoId, { status: "complete" }]));
  const vocabulary = context.R34MF.modules.filterEngine.vocabulary;
  const all = vocabulary(records, details, "tags", "", 60);
  const searched = vocabulary(records, details, "tags", "tags-499", 10);
  assert.equal(calls, 1);
  assert.equal(all.values.length, 60);
  assert.ok(searched.values.length <= 10);
  assert.equal(context.R34MF.modules.vocabularyCache.stats().misses, 1);
  assert.equal(context.R34MF.modules.vocabularyCache.stats().hits, 1);
});

test("Phase 10 backup schema normalizes compatible duplicates and runtime-only state deterministically", () => {
  const db = dbStub();
  const modules = {
    db,
    settings: { normalize: (value = {}) => ({ ...value }) },
    uiState: { normalize: (value = {}) => ({ mode: value.mode === "local" ? "local" : "native", collapsed: value.collapsed === true, localPage: Math.max(1, Number(value.localPage) || 1), sort: value.sort ?? { field: "uploadDate", direction: "desc" } }) },
    filterEngine: { normalize: (value = {}) => value },
    rule34VideoIdentity: {
      validateRecord(record) {
        const match = String(record.url ?? "").match(/^https:\/\/(?:www\.)?rule34video\.com\/videos?\/(\d+)(?:\/|$)/i);
        return match && match[1] === String(record.videoId) ? { ok: true, url: String(record.url) } : { ok: false, reason: "video-id-mismatch" };
      }
    }
  };
  const context = sandbox(modules);
  run("src/storage/backup-schema.js", context);
  const raw = {
    format: "r34mf-backup",
    version: 1,
    storage: {
      settings: { automaticSignIn: true, concurrentQueueJobs: 2 },
      uiState: { mode: "local", localPage: 3 },
      filterState: { version: 1, activePresetId: "p1", presets: [{ id: "p1", name: "Default", filters: {} }] },
      authCredentials: { identifier: "must-not-survive", password: "secret" }
    },
    database: {
      videos: [
        { videoId: "1", url: "https://rule34video.com/video/1/a/", title: "old", listingUpdatedAt: 10 },
        { videoId: "1", url: "https://rule34video.com/video/1/a/", title: "new", listingUpdatedAt: 20 },
        { videoId: "2", url: "https://rule34video.com/videos/2/b/", title: "two" }
      ],
      videoDetails: [
        { videoId: "1", status: "complete", artist: "A", tags: ["x", "X"], categories: [], description: "good", fetchedAt: 20 },
        { videoId: "1", status: "failed", lastError: { code: "network-error", message: "later failure" }, lastAttemptAt: 30 },
        { videoId: "2", status: "queued" },
        { videoId: "999", status: "complete", description: "orphan" }
      ],
      cataloguePages: [{ pageNumber: 1, videoIds: ["1", "999", "1"], status: "complete" }],
      smartUpdatePages: [],
      catalogueState: [{ key: "subscriptions", scanStatus: "running", catalogueReady: true, indexedCount: 999, detailedCount: 999, detailsState: { status: "running" }, smartUpdate: { status: "running" } }],
      jobHistory: [
        { id: "running", status: "running", finishedAt: 5 },
        { id: "done", status: "complete", finishedAt: 10 }
      ]
    }
  };
  context.rawJson = JSON.stringify(raw);
  const normalized = vm.runInContext("R34MF.modules.backupSchema.normalizeBackup(JSON.parse(rawJson))", context);
  assert.equal(normalized.storage.settings.automaticSignIn, false);
  assert.equal(Object.hasOwn(normalized.storage, "authCredentials"), false);
  assert.equal(normalized.database.videos.length, 2);
  assert.equal(normalized.database.videos.find((video) => video.videoId === "1").title, "new");
  assert.equal(normalized.database.videoDetails.length, 2);
  assert.equal(normalized.database.videoDetails.find((detail) => detail.videoId === "1").status, "complete");
  assert.equal(normalized.database.videoDetails.find((detail) => detail.videoId === "1").description, "good");
  assert.equal(normalized.database.videoDetails.find((detail) => detail.videoId === "2").status, "missing");
  assert.deepEqual([...normalized.database.cataloguePages[0].videoIds], ["1"]);
  assert.equal(normalized.database.catalogueState[0].scanStatus, "paused");
  assert.equal(normalized.database.catalogueState[0].detailsState.status, "paused");
  assert.equal(normalized.database.catalogueState[0].smartUpdate.status, "paused");
  assert.equal(normalized.database.catalogueState[0].indexedCount, 2);
  assert.equal(normalized.database.catalogueState[0].detailedCount, 1);
  assert.deepEqual([...normalized.database.jobHistory].map((entry) => entry.id), ["done"]);
});

test("backup normalization round-trips every preset and normal entity Any/All state", () => {
  const db = dbStub();
  const modules = {
    db,
    settings: { normalize: (value = {}) => ({ ...value }) },
    uiState: { normalize: (value = {}) => ({ ...value }) },
    rule34VideoIdentity: { validateRecord: (record) => ({ ok: true, url: record.url }) }
  };
  const context = sandbox(modules);
  run("src/filters/filter-engine.js", context);
  run("src/storage/backup-schema.js", context);
  const engine = context.R34MF.modules.filterEngine;
  const presetA = engine.createEmpty();
  presetA.detailed.artist = { enabled: true, value: ["Artist A", "Artist B"], matchMode: "any" };
  presetA.detailed.tags = { enabled: true, value: ["tag1", "tag2"], matchMode: "all" };
  presetA.advanced = { enabled: true, items: [{ id: "rule-a", kind: "rule", enabled: true, connector: null, polarity: "match", field: "artist", operator: "contains", value: "studio", options: {} }] };
  const presetB = engine.createEmpty();
  presetB.detailed.uploader = { enabled: true, value: ["Uploader A"], matchMode: "any" };
  presetB.detailed.categories = { enabled: false, value: ["3D", "MMD"], matchMode: "all" };
  const raw = {
    format: "r34mf-backup", version: 1,
    storage: {
      settings: { automaticSignIn: true, videoColumns: 4, thumbnailAspectRatio: "3:2" },
      uiState: { mode: "local", localPage: 7, collapsed: true, sort: { field: "views", direction: "desc" } },
      filterState: { version: 1, activePresetId: "preset-b", presets: [
        { id: "preset-a", name: "Preset A", createdAt: 1, updatedAt: 2, filters: presetA },
        { id: "preset-b", name: "Preset B", createdAt: 3, updatedAt: 4, filters: presetB }
      ] },
      authCredentials: { identifier: "excluded", password: "excluded" }
    },
    database: {
      videos: [{ videoId: "1", url: "https://rule34video.com/video/1/a/" }],
      videoDetails: [{ videoId: "1", status: "complete", artist: "Artist A", artists: ["Artist A", "Artist B"], uploader: "Uploader A", uploaders: ["Uploader A"], tags: ["tag1"], categories: ["3D"], description: "", schemaVersion: 2 }],
      cataloguePages: [{ pageNumber: 1, videoIds: ["1"], status: "complete" }], smartUpdatePages: [],
      catalogueState: [{ key: "subscriptions", scanStatus: "complete", catalogueReady: true }],
      jobHistory: [{ id: "history-1", status: "complete", finishedAt: 5 }]
    }
  };
  context.rawJson = JSON.stringify(raw);
  const first = vm.runInContext("R34MF.modules.backupSchema.normalizeBackup(JSON.parse(rawJson))", context);
  context.roundTripJson = JSON.stringify(first);
  const restored = vm.runInContext("R34MF.modules.backupSchema.normalizeBackup(JSON.parse(roundTripJson))", context);
  assert.equal(restored.storage.filterState.activePresetId, "preset-b");
  assert.deepEqual([...restored.storage.filterState.presets].map((preset) => [preset.id, preset.name]), [["preset-a", "Preset A"], ["preset-b", "Preset B"]]);
  assert.deepEqual([...restored.storage.filterState.presets[0].filters.detailed.artist.value], ["Artist A", "Artist B"]);
  assert.equal(restored.storage.filterState.presets[0].filters.detailed.artist.matchMode, "any");
  assert.equal(restored.storage.filterState.presets[0].filters.detailed.tags.matchMode, "all");
  assert.equal(restored.storage.filterState.presets[1].filters.detailed.uploader.matchMode, "any");
  assert.equal(restored.storage.filterState.presets[1].filters.detailed.categories.matchMode, "all");
  assert.equal(restored.storage.filterState.presets[1].filters.detailed.categories.enabled, false);
  assert.equal(restored.storage.filterState.presets[0].filters.advanced.items[0].operator, "contains");
  assert.equal(restored.storage.settings.automaticSignIn, false);
  assert.equal(restored.storage.uiState.localPage, 7);
  assert.equal(Object.hasOwn(restored.storage, "authCredentials"), false);
  assert.equal(restored.database.videoDetails[0].artists.length, 2);
  assert.equal(restored.database.cataloguePages.length, 1);
  assert.equal(restored.database.jobHistory.length, 1);
});

test("Phase 10 backup schema rejects incompatible keys/stores before import planning", () => {
  const db = dbStub();
  const context = sandbox({
    db,
    settings: { normalize: (value = {}) => value },
    uiState: { normalize: (value = {}) => value },
    filterEngine: { normalize: (value = {}) => value },
    rule34VideoIdentity: { validateRecord: () => ({ ok: false, reason: "video-id-mismatch" }) }
  });
  run("src/storage/backup-schema.js", context);
  context.badJson = JSON.stringify({ database: { videos: [{ videoId: "1", url: "https://rule34video.com/video/2/wrong/" }] } });
  assert.throws(() => vm.runInContext("R34MF.modules.backupSchema.normalizeBackup(JSON.parse(badJson))", context), /does not match its video ID/);
  context.unknownJson = JSON.stringify({ database: { videos: [], secretStore: [{ password: "no" }] } });
  assert.throws(() => vm.runInContext("R34MF.modules.backupSchema.normalizeBackup(JSON.parse(unknownJson))", context), /unsupported database store/);
});

test("Phase 10 import restores the pre-import snapshot if storage application fails", async () => {
  const oldDatabase = { videos: [{ videoId: "old" }] };
  const newDatabase = { videos: [{ videoId: "new" }] };
  const oldStorage = { settings: { marker: "old" }, uiState: null, filterState: null };
  const newStorage = { settings: { marker: "new" }, uiState: null, filterState: null };
  const replaced = [];
  const applied = [];
  const base = {
    validateBackup(input) { return { backup: input, meta: { indexed: 1 } }; },
    ensureQueueIdle() {},
    async readStores() { return oldDatabase; },
    async storagePayload() { return oldStorage; },
    async replaceDatabase(value) { replaced.push(value); },
    async mergeDatabase() {},
    async applyBackupStorage(value) {
      applied.push(value);
      if (value === newStorage) throw new Error("storage write failed");
    },
    async summary() { return { indexed: 1 }; },
    async buildBackup() { return {}; },
    async clearDetailedMetadata() {},
    async clearEntireCatalogue() {}
  };
  const context = sandbox({
    settingsData: base,
    backupSchema: { normalizeBackup: (value) => value, normalizeDatabase: (value) => value },
    dataOperationLock: { async runExclusive(_label, work) { return work(); } },
    db: { invalidateCatalogueOrder() {} }
  });
  run("src/storage/settings-data-hardening.js", context);
  await assert.rejects(() => context.R34MF.modules.settingsData.importBackup({ database: newDatabase, storage: newStorage }, "replace"), /Previous extension data was restored/);
  assert.deepEqual(replaced, [newDatabase, oldDatabase]);
  assert.deepEqual(applied, [newStorage, oldStorage]);
});

test("Phase 10 accessibility decorator adds tab/menu/input semantics without trapping non-modal Queue", () => {
  const { document, window } = parseHTML(`<!doctype html><html><body>
    <div id="root">
      <div class="r34mf-tool-layer"><section class="r34mf-filters-surface"></section></div>
      <div class="r34mf-queue-host"><section class="r34mf-queue-panel"><span class="r34mf-queue-header-status">Idle</span><div role="progressbar"></div></section></div>
    </div>
    <div class="r34mf-settings-layer"><section class="r34mf-settings-dialog"><nav class="r34mf-settings-nav"><button class="is-active" data-settings-focus-key="nav:scanning">Scanning</button><button data-settings-focus-key="nav:data">Data</button></nav><main class="r34mf-settings-content"><input placeholder="Thing"></main><footer><span class="r34mf-settings-footer-status">Saved</span></footer></section></div>
    <div class="r34mf-modal-layer"><section class="r34mf-modal"><h2 class="r34mf-modal-title">TITLE</h2><input placeholder="Text"><div role="menu"><button>Rename</button></div></section></div>
  </body></html>`);
  const context = sandbox({}, { document, window, CSS: { escape: (value) => String(value).replace(/"/g, "\\\"") } });
  run("src/ui/accessibility-hardening.js", context);
  context.R34MF.modules.accessibilityHardening.decorateRoot(document.querySelector("#root"));
  context.R34MF.modules.accessibilityHardening.decorateSettings(document.querySelector(".r34mf-settings-layer"));
  context.R34MF.modules.accessibilityHardening.decorateFilterModal(document.querySelector(".r34mf-modal-layer"));
  assert.equal(document.querySelector(".r34mf-tool-layer").getAttribute("role"), "region");
  assert.equal(document.querySelector(".r34mf-queue-header-status").getAttribute("aria-live"), "polite");
  assert.equal(document.querySelector(".r34mf-settings-nav").getAttribute("role"), "tablist");
  assert.equal(document.querySelector(".r34mf-settings-nav .is-active").getAttribute("role"), "tab");
  assert.equal(document.querySelector(".r34mf-settings-content").getAttribute("role"), "tabpanel");
  assert.equal(document.querySelector(".r34mf-settings-content input").getAttribute("aria-label"), "Settings value: Thing");
  assert.equal(document.querySelector("[role='menu'] > button").getAttribute("role"), "menuitem");
  assert.equal(document.querySelector(".r34mf-modal input").getAttribute("aria-label"), "TITLE: Text");
  assert.equal(source("src/ui/accessibility-hardening.js").includes("event.key === \"Tab\""), false, "non-modal Queue/popover decorator must not install a second Tab trap");
});

test("Phase 10 lifecycle layer is event-aware and guards stale Local/filter async work", () => {
  const lifecycle = source("src/content/phase10-hardening-controller.js");
  assert.match(lifecycle, /event\?\.persisted === true/);
  assert.match(lifecycle, /phase10Generation/);
  assert.match(lifecycle, /phase10LocalRenderEpoch/);
  assert.match(lifecycle, /phase10FilterOpenEpoch/);
  assert.match(lifecycle, /if \(!current\(this, snapshot\)/);
  assert.match(lifecycle, /this\.revision \+= 1/);
  assert.match(lifecycle, /this\.scheduleReconcile\(\)/);
  assert.doesNotMatch(lifecycle, /background|serviceWorker|service_worker/i);
});

test("Phase 10 Local-grid and Settings redraws keep stale work and accessibility bounded", () => {
  const local = source("src/ui/local-grid.js");
  const lifecycle = source("src/content/phase10-hardening-controller.js");
  const a11y = source("src/ui/accessibility-hardening.js");
  assert.match(local, /guard = null/);
  assert.ok((local.match(/if \(!canCommit\(\)\) return \{ aborted: true \};/g) ?? []).length >= 3);
  assert.match(lifecycle, /guard: \(\) => current\(this, snapshot\)/);
  assert.match(a11y, /new globalThis\.MutationObserver/);
  assert.match(a11y, /\{ childList: true, subtree: true \}/);
  assert.match(a11y, /button\.tabIndex = selected \? 0 : -1/);
  assert.match(a11y, /ArrowLeft/);
  assert.match(a11y, /disconnectSettingsObserver/);
});

test("Phase 10 CI gates generated packages on release parity", () => {
  const workflow = source(".github/workflows/verify.yml");
  const pkg = JSON.parse(source("package.json"));
  assert.match(workflow, /Verify Chrome and Firefox release parity/);
  assert.equal(pkg.scripts["verify:release-parity"], "node scripts/verify-release-parity.mjs");
  assert.match(source("scripts/verify-release-parity.mjs"), /same source identity/);
});
