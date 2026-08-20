import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function modules() {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map };
  context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/filters/filter-engine.js", "src/sort/sorter.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return context.R34MF.modules;
}

function recoveryModules() {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL };
  context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/catalogue/catalogue-reconciliation.js", "src/ui/paginator-model.js", "src/filters/filter-engine.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return context.R34MF.modules;
}

test("catalogue reconciliation uses manifests and counts without erasing usable partial data", () => {
  const { catalogueReconciliation: reconcile } = recoveryModules();
  const completePages = [1, 2, 3].map((pageNumber) => ({ pageNumber, status: "complete" }));
  const stale = reconcile.reconcileCatalogueState({ catalogueReady: false, scanStatus: "idle", completedAt: 10, discoveredPageCount: 3, indexedCount: 0, detailedCount: 99 }, { indexedCount: 72, detailedCount: 4, pages: completePages });
  assert.equal(stale.catalogueReady, true); assert.equal(stale.availability, "complete"); assert.equal(stale.indexedCount, 72); assert.equal(stale.detailedCount, 4);
  const partial = reconcile.reconcileCatalogueState({ catalogueReady: false, scanStatus: "paused", discoveredPageCount: 3 }, { indexedCount: 48, detailedCount: 0, pages: completePages.slice(0, 2) });
  assert.equal(partial.catalogueReady, false); assert.equal(partial.availability, "partial"); assert.equal(partial.resumable, true); assert.equal(partial.usable, true);
  const failed = reconcile.reconcileCatalogueState({ scanStatus: "failed", discoveredPageCount: 3 }, { indexedCount: 48, detailedCount: 0, pages: [...completePages.slice(0, 2), { pageNumber: 3, status: "failed" }] });
  assert.equal(failed.availability, "partial"); assert.equal(failed.resumable, true);
  const empty = reconcile.reconcileCatalogueState({ scanStatus: "not-scanned" }, { indexedCount: 0, detailedCount: 9, pages: [] });
  assert.equal(empty.availability, "empty"); assert.equal(empty.catalogueReady, false); assert.equal(empty.detailedCount, 0);
});

test("native-style paginator has no duplicate endpoint representation and validates jumps", () => {
  const { paginatorModel: p } = recoveryModules();
  const first = p.paginationModel(1, 215); assert.equal(first.items.some((item) => item.type === "first" || item.type === "previous"), false); assert.equal(first.items.some((item) => item.type === "last"), true);
  const middle = p.paginationModel(107, 215); assert.equal(middle.items.filter((item) => item.type === "page" && item.value === 215).length, 0); assert.equal(middle.items.filter((item) => item.type === "last").length, 1);
  const final = p.paginationModel(215, 215); assert.equal(final.items.some((item) => item.type === "last" || item.type === "next"), false); assert.equal(final.items.filter((item) => item.type === "page" && item.value === 215).length, 1);
  assert.equal(p.paginationModel(1, 0).items.length, 0); assert.equal(p.parseJump("216", 215), null); assert.equal(p.parseJump("17", 215), 17);
});

test("compact numeric rules normalize shorthand and preserve invalid configuration disabled", () => {
  const { filterEngine: f } = recoveryModules();
  assert.equal(f.normalizeRule({ field: "views", operator: "gte", value: "10K" }).value, 10000);
  assert.equal(f.normalizeRule({ field: "ratingVotes", operator: "gte", value: "1.5M" }).value, 1500000);
  const between = f.normalizeRule({ field: "views", operator: "between", value: "10K", valueTo: "1.5M" }); assert.deepEqual(JSON.parse(JSON.stringify([between.value, between.valueTo])), [10000, 1500000]);
  const invalid = f.normalizeRule({ field: "views", operator: "gte", value: "not-a-number" });
  assert.equal(invalid.enabled, false); assert.equal(invalid.value, "not-a-number");
});

test("complete diagnostic catalogue flows into shell and Queue availability", () => {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map };
  context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/catalogue/catalogue-reconciliation.js", "src/ui/shell.js", "src/ui/queue/queue-view-model.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const pages = Array.from({ length: 215 }, (_, index) => ({ pageNumber: index + 1, status: "complete" }));
  const catalogue = context.R34MF.modules.catalogueReconciliation.reconcileCatalogueState({ scanStatus: "complete", catalogueReady: true, indexedCount: 0, detailedCount: 0, discoveredPageCount: 215, pagesCompleted: 215 }, { indexedCount: 5142, detailedCount: 0, pages });
  const shell = context.R34MF.modules.shell.deriveState({ mode: "local", catalogue: { ...catalogue, hasCatalogue: catalogue.catalogueReady }, canFilter: catalogue.usable, canSort: catalogue.usable });
  const queue = context.R34MF.modules.queueViewModel.deriveQueueViewModel({ catalogue });
  assert.equal(catalogue.catalogueReady, true); assert.equal(catalogue.availability, "complete"); assert.equal(shell.statusText, "5142 indexed"); assert.equal(shell.canFilter, true); assert.equal(shell.canSort, true); assert.equal(queue.operations[0].status, "Available");
});

test("thumbnail sources reject lazy data placeholders and prefer authenticated data-webp", () => {
  const context = { console, URL }; context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/shared/constants.js", "src/utils/url.js", "src/catalogue/parsing.js", "src/catalogue/card-parser.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const image = { getAttribute: (name) => ({ src: "data:image/gif;base64,R0lGODlhAQABAIAAAA==", "data-webp": "https://rule34video.com/contents/videos_screenshots/4513000/4513497/336x189/6.jpg", "data-original": "https://rule34video.com/contents/videos_screenshots/4513000/4513497/336x189/6.jpg" })[name] ?? null };
  const sources = context.R34MF.modules.cardParser.thumbnailSources(image);
  assert.equal(sources.preferred, "https://rule34video.com/contents/videos_screenshots/4513000/4513497/336x189/6.jpg"); assert.equal(sources.fallback, null);
});

test("failed maintenance rescan preserves a proven completed baseline", () => {
  const { catalogueReconciliation: reconcile } = recoveryModules();
  const pages = Array.from({ length: 3 }, (_, index) => ({ pageNumber: index + 1, status: "complete" }));
  const state = reconcile.reconcileCatalogueState({ scanStatus: "failed", scanKind: "full-rescan", catalogueReady: true, discoveredPageCount: 3 }, { indexedCount: 72, detailedCount: 0, pages });
  assert.equal(state.catalogueReady, true); assert.equal(state.availability, "complete");
});

test("numeric/date utilities reject invalid values and retain leap dates", () => {
  const { filterEngine: f } = modules();
  assert.equal(f.parseCompactNumber("10K"), 10000); assert.equal(f.parseCompactNumber("1.5M"), 1500000); assert.equal(f.parseCompactNumber("invalid"), null);
  assert.equal(f.parseDate("2024-02-29"), "2024-02-29"); assert.equal(f.parseDate("2023-02-29"), null);
});

test("three-valued detail rules retain UNKNOWN through Exclude and Boolean combinations", () => {
  const { filterEngine: f } = modules(); const video = { videoId: "1", title: "One" };
  assert.equal(f.evaluateRule(video, null, { enabled: true, field: "artist", operator: "is", value: "Foo", polarity: "exclude" }), f.UNKNOWN);
  assert.equal(f.triAnd(f.FALSE, f.UNKNOWN), f.FALSE); assert.equal(f.triAnd(f.TRUE, f.UNKNOWN), f.UNKNOWN); assert.equal(f.triOr(f.TRUE, f.UNKNOWN), f.TRUE); assert.equal(f.triOr(f.FALSE, f.UNKNOWN), f.UNKNOWN);
});

test("advanced expressions evaluate in visible left-to-right order", () => {
  const { filterEngine: f } = modules(); const video = { videoId: "1", title: "Alpha", views: 200, durationSec: 10 };
  const items = [{ enabled: true, connector: null, field: "title", operator: "contains", value: "nope" }, { enabled: true, connector: "or", field: "views", operator: "gte", value: 100 }, { enabled: true, connector: "and", field: "duration", operator: "gte", value: 20 }];
  assert.equal(f.evaluateItems(video, null, items), f.FALSE);
  assert.equal(f.evaluateItems(video, null, [{ kind: "group", enabled: true, connector: null, items: items.slice(0, 2) }]), f.TRUE);
});

test("sort keeps unknown values last in either direction with stable ties", () => {
  const { sorter } = modules(); const records = [{ videoId: "a", views: 2 }, { videoId: "b", views: null }, { videoId: "c", views: 2 }];
  assert.deepEqual(sorter.sort(records, new Map(), { field: "views", direction: "desc" }).map((v) => v.videoId), ["a", "c", "b"]);
  assert.deepEqual(sorter.sort(records, new Map(), { field: "views", direction: "asc" }).map((v) => v.videoId), ["a", "c", "b"]);
  assert.deepEqual(JSON.parse(JSON.stringify(sorter.select({ field: "views", direction: "desc" }, "views"))), { field: "views", direction: "asc" });
});

test("advanced normalization removes empty groups and fixes sibling connectors", () => {
  const { filterEngine: f } = modules(); const normalized = f.normalize({ advanced: { enabled: true, items: [{ kind: "group", items: [] }, { field: "title", value: "a" }, { field: "title", connector: "or", value: "b" }] } });
  assert.equal(normalized.advanced.items.length, 2); assert.equal(normalized.advanced.items[0].connector, null); assert.equal(normalized.advanced.items[1].connector, "or");
});

test("frozen filter-state facade restores, commits, and saves mutable configuration", async () => {
  const stored = { "r34mf.filterState": { version: 1, activePresetId: "custom", presets: [{ id: "preset-default", name: "Default", filters: {} }, { id: "custom", name: "Custom", filters: { quick: { title: "before" } } }] } };
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, crypto: { randomUUID: () => "test-id" }, chrome: { runtime: {}, storage: { local: { get: async (key) => ({ [key]: stored[key] }), set: async (value) => Object.assign(stored, value) } } } };
  context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/shared/constants.js", "src/shared/browser-api.js", "src/filters/filter-engine.js", "src/filters/filter-state.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const state = context.R34MF.modules.filterState;
  assert.equal(Object.isFrozen(state), true);
  await state.load();
  assert.equal(state.value.activePresetId, "custom"); assert.deepEqual(JSON.parse(JSON.stringify(state.active().filters.quick.title)), { enabled: true, value: "before" });
  await state.commitFilters({ quick: { title: "after" } }); assert.deepEqual(JSON.parse(JSON.stringify(state.active().filters.quick.title)), { enabled: true, value: "after" });
  await state.save({ ...state.value, activePresetId: "preset-default" }); assert.equal(state.value.activePresetId, "preset-default");
  await state.select("custom"); await state.rename("custom", "Renamed"); assert.equal(state.active().name, "Renamed");
});

test("normal filter migration retains configuration while only enabled entries restrict results", () => {
  const { filterEngine: f } = modules();
  const migrated = f.normalize({ quick: { duration: { operator: "between", value: 2, valueTo: 15, unit: "minutes" }, title: null }, advanced: { enabled: false, items: [{ field: "title", value: "saved" }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.quick.duration)), { enabled: true, value: { operator: "between", value: 2, valueTo: 15, unit: "minutes" } });
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.quick.title)), { enabled: false, value: null });
  migrated.quick.duration.enabled = false;
  assert.equal(f.evaluate({ videoId: "one", durationSec: 3600 }, null, migrated), f.TRUE);
  migrated.quick.duration.enabled = true;
  assert.equal(f.evaluate({ videoId: "one", durationSec: 3600 }, null, migrated), f.FALSE);
  assert.equal(f.countApplied(migrated), 1);
  assert.equal(migrated.advanced.items.length, 1);
});

test("Local grid defaults to three columns while retaining bounded internal overrides", () => {
  const source = readFileSync("src/ui/local-grid.js", "utf8"), css = readFileSync("src/ui/styles.css", "utf8");
  assert.match(source, /columns = 3/); assert.match(source, /\[1, 2, 3, 4, 5, 6\]/); assert.match(css, /--r34mf-local-columns: 3/);
});

test("tool overlays are root-owned and anchored rather than Local-flow siblings", () => {
  const controller = readFileSync("src/content/subscriptions-controller.js", "utf8"), filters = readFileSync("src/ui/filters.js", "utf8"), css = readFileSync("src/ui/styles.css", "utf8");
  assert.match(filters, /r34mf-tool-layer/); assert.match(controller, /placeTool\(host,/); assert.match(css, /\.r34mf-tool-layer, \.r34mf-sort-surface \{ position: absolute/);
  assert.match(controller, /filter-toggle:/); assert.match(filters, /advanced-toggle/); assert.doesNotMatch(filters, /Enabled \[switch\]/);
});

test("filter draft reducers drive reactive operators, Advanced counts, preview, and same-level reorder", () => {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map }; context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/filters/filter-engine.js", "src/filters/filter-draft.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const draft = context.R34MF.modules.filterDraft, engine = context.R34MF.modules.filterEngine;
  assert.equal(draft.updateNormalDraft({ operator: "gte", value: "10K" }, { operator: "between" }).operator, "between");
  const root = { enabled: false, items: [draft.defaultRule("title"), { id: "group", kind: "group", enabled: true, connector: "and", items: [draft.defaultRule("rating"), draft.defaultRule("views", "or")] }, draft.defaultRule("duration", "and")] };
  root.items[1].items[0].enabled = false;
  assert.deepEqual(JSON.parse(JSON.stringify(draft.counts(root.items))), { rules: 4, enabled: 3, groups: 1 });
  const reordered = draft.reorder(root, { parentId: "group", id: root.items[1].items[1].id, beforeId: root.items[1].items[0].id });
  assert.equal(reordered.items[1].items[0].connector, null); assert.equal(reordered.items[1].items[1].connector, "and");
  assert.match(draft.preview(root.items).join("\n"), /Title/); assert.equal(engine.normalize({ advanced: root }).advanced.items.length, 3);
});

test("modal architecture keeps parent separate and removes obsolete Advanced grid patterns", () => {
  const modal = readFileSync("src/ui/filter-modals.js", "utf8"), filters = readFileSync("src/ui/filters.js", "utf8"), styles = readFileSync("src/ui/styles.css", "utf8");
  assert.match(modal, /r34mf-modal-layer/); assert.match(modal, /modal-cancel/); assert.match(modal, /Greater than or equal to/);
  assert.doesNotMatch(filters, /display:\s*contents/); assert.match(styles, /\.r34mf-modal-layer \{ position: fixed/);
});

test("controller startup restores filter state and reconciles a completed diagnostic catalogue", async () => {
  const storage = {
    "r34mf.settings": {}, "r34mf.uiState": { mode: "local" },
    "r34mf.filterState": { activePresetId: "saved", presets: [{ id: "preset-default", name: "Default", filters: {} }, { id: "saved", name: "Saved", filters: { quick: { title: "needle" } } }] }
  };
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, crypto: { randomUUID: () => "runtime" }, chrome: { runtime: {}, storage: { local: { get: async (key) => ({ [key]: storage[key] }), set: async (value) => Object.assign(storage, value) } } } };
  context.window = { location: { href: "https://example.test/" }, addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {} };
  context.document = { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] };
  context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/shared/constants.js", "src/shared/browser-api.js", "src/storage/settings.js", "src/storage/ui-state.js", "src/filters/filter-engine.js", "src/filters/filter-state.js", "src/sort/sorter.js", "src/catalogue/catalogue-reconciliation.js", "src/content/subscriptions-controller.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const pages = Array.from({ length: 215 }, (_, index) => ({ pageNumber: index + 1, status: "complete" }));
  const catalogue = context.R34MF.modules.catalogueReconciliation.reconcileCatalogueState({ catalogueReady: false, scanStatus: "complete", discoveredPageCount: 215, pagesCompleted: 215 }, { indexedCount: 5142, detailedCount: 0, pages });
  context.R34MF.modules.catalogueScanner = { subscribe() {}, initialize: async () => catalogue, run() {}, runSmartUpdate() {} };
  context.R34MF.modules.jobManager = { subscribe() {}, registerHandler() {}, snapshot: () => ({}) };
  context.R34MF.modules.db = { subscribeCatalogueChanges() {}, readRecentHistory: async () => [] };
  await context.R34MF.modules.settings.load();
  await context.R34MF.modules.subscriptionsController.start();
  const state = context.R34MF.modules.subscriptionsController.state;
  assert.equal(state.catalogue.catalogueReady, true); assert.equal(state.catalogue.availability, "complete"); assert.equal(state.catalogue.indexedCount, 5142);
  assert.equal(state.canFilter, true); assert.equal(state.canSort, true); assert.equal(state.activePresetId, "saved");
});

test("startup warning includes a readable operation and error message", () => {
  const calls = []; const context = { console: { warn: (...args) => calls.push(args), debug() {} } }; context.globalThis = context; vm.createContext(context);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), context); vm.runInContext(readFileSync("src/utils/logger.js", "utf8"), context);
  context.R34MF.modules.logger.warn("extension-init-failed", { message: "Cannot assign to read only property 'value'", stack: "stack" });
  assert.match(calls[0][0], /extension-init-failed: Cannot assign/); assert.equal(calls[0][1].stack, "stack");
});

test("thumbnail candidates use exact sources, recover legacy records, and eagerly render current-page cards", () => {
  const source = readFileSync("src/ui/local-grid.js", "utf8");
  const context = { console, URL }; context.globalThis = context; vm.createContext(context);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), context, { filename: "src/shared/namespace.js" });
  context.R34MF.modules = { db: {}, paginatorModel: { paginationModel: () => ({ items: [], page: 1, pageCount: 0 }), clampPage: (page) => page, parseJump: () => null } };
  vm.runInContext(source, context, { filename: "src/ui/local-grid.js" });
  const grid = context.R34MF.modules.localGrid;
  assert.deepEqual(JSON.parse(JSON.stringify(grid.thumbnailCandidates({ videoId: "4513497", thumbnailUrl: "data:image/gif" }))), ["https://rule34video.com/contents/videos_screenshots/4513000/4513497/336x189/1.jpg"]);
  assert.deepEqual(JSON.parse(JSON.stringify(grid.thumbnailCandidates({ videoId: "4513497", thumbnailPreferredUrl: "https://example.test/preferred.jpg", thumbnailFallbackUrl: "https://example.test/fallback.jpg" }))), ["https://example.test/preferred.jpg", "https://example.test/fallback.jpg"]);
  assert.match(source, /currentRecords\.forEach\(\(record\) => grid\.append\(card\(record, \{ eager: true \}\)\)\)/);
  assert.match(source, /if \(!preview\.src\) preview\.src = preview\.dataset\.preview/);
  assert.match(source, /image\.alt = ""/);
});
