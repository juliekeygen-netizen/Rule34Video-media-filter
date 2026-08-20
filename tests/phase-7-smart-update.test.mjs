import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("Smart Update stages shifted pages then atomically reconciles order, scale, manifests, and retained details", async () => {
  const oldIds = ["A", "B", "C", "D", "E", "F"];
  const currentPages = { 1: ["X", "Y", "Z"], 2: ["A", "B", "C"], 3: ["D", "E", "F"] };
  const stages = []; const requests = []; const progress = []; const details = new Map([["A", { videoId: "A", status: "complete", artist: "Preserved" }]]);
  let canonical = [...oldIds];
  let manifests = [{ pageNumber: 1, status: "complete", videoIds: ["A", "B", "C"] }, { pageNumber: 2, status: "complete", videoIds: ["D", "E", "F"] }];
  let state = { catalogueReady: true, scanStatus: "complete", scanKind: "initial", indexedCount: 6, detailedCount: 1, discoveredNativeTotal: 6, discoveredPageCount: 2, discoveredPageSize: 3, pagesCompleted: 2, lastFullScanAt: 1, smartUpdate: { status: "idle" } };
  const db = {
    defaultCatalogueState: () => ({ scanStatus: "not-scanned", smartUpdate: { status: "idle" } }),
    async getCatalogueState() { return structuredClone(state); },
    async countVideos() { return canonical.length; },
    async countDetailedVideos() { return [...details.values()].filter((detail) => detail.status === "complete" && canonical.includes(detail.videoId)).length; },
    async listPageCheckpoints() { return structuredClone(manifests); },
    async putCatalogueState(changes) { state = { ...state, ...changes, smartUpdate: { ...state.smartUpdate, ...(changes.smartUpdate ?? {}) } }; return structuredClone(state); },
    async getOrderedVideoIds() { return [...canonical]; },
    async clearSmartUpdateStage() { stages.length = 0; },
    async listSmartUpdateStage() { return structuredClone(stages); },
    async stageSmartUpdatePage(page) { stages.push(structuredClone(page)); },
    async finalizeSmartUpdateReconciliation(input) {
      canonical = [...input.orderedVideoIds];
      manifests = Array.from({ length: Math.ceil(canonical.length / input.pageSize) }, (_, index) => ({ pageNumber: index + 1, status: "complete", videoIds: canonical.slice(index * input.pageSize, (index + 1) * input.pageSize) }));
      for (const id of [...details.keys()]) if (!canonical.includes(id)) details.delete(id);
      state = { ...state, indexedCount: canonical.length, detailedCount: details.size, discoveredNativeTotal: input.nativeTotal, discoveredPageCount: input.pageCount, discoveredPageSize: input.pageSize, pagesCompleted: manifests.length, smartUpdate: input.smartUpdate, scanStatus: "complete", scanKind: "smart-update", catalogueReady: true, lastSmartUpdateAt: input.completedAt, lastCatalogueUpdateAt: input.completedAt };
      stages.length = 0; return { indexedCount: canonical.length, detailedCount: details.size, pageCount: manifests.length };
    },
    authoritativeCountChanges: (indexedCount, detailedCount) => ({ indexedCount, detailedCount }),
    async appendHistory() {}
  };
  class DOMParser { parseFromString(value) { const ids = currentPages[Number(value)] ?? []; return { grid: { children: ids }, records: ids }; } }
  const context = { console, URL, DOMException, AbortController, DOMParser, crypto: { randomUUID: () => "smart-session" }, location: { origin: "https://rule34video.com" } };
  context.globalThis = context; context.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, text: async () => new URL(url).searchParams.get("from").replace(/^0/, "") }; };
  vm.createContext(context); vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), context);
  context.R34MF.modules.db = db;
  context.R34MF.modules.feedDiscovery = {
    discoverFeed: () => ({ nativeTotal: 9, pageSize: 3, pageCount: 3, blockId: "subscriptions" }),
    buildKvsPageUrl: ({ pageNumber }) => `https://rule34video.com/my/subscriptions/?from=${String(pageNumber).padStart(2, "0")}`,
    findSubscriptionsGrid: (documentLike) => ({ structureValid: true, grid: documentLike.grid }),
    extractCards: (documentLike) => documentLike.records
  };
  context.R34MF.modules.cardParser = { parseCard: (id, meta) => ({ ok: true, record: { videoId: id, url: `https://rule34video.com/video/${id}/`, nativePage: meta.pageNumber, nativeOrder: meta.nativeOrder } }) };
  context.R34MF.modules.catalogueParsing = { dedupeByVideoId: (records) => [...new Map(records.map((record) => [record.videoId, record])).values()], calculatePageCount: (total, size) => Math.ceil(total / size) };
  context.R34MF.modules.requestScheduler = { runWithPolicy: ({ request }) => request() };
  context.R34MF.modules.settings = { value: { advanced: { smartUpdateKnownPageThreshold: 1 } } };
  vm.runInContext(readFileSync("src/catalogue/catalogue-reconciliation.js", "utf8"), context);
  vm.runInContext(readFileSync("src/catalogue/catalogue-scanner.js", "utf8"), context);

  const result = await context.R34MF.modules.catalogueScanner.runSmartUpdate({ documentLike: {}, onProgress: (value) => progress.push(value) });
  assert.equal(result.smartUpdate.status, "complete");
  assert.deepEqual(canonical, ["X", "Y", "Z", "A", "B", "C", "D", "E", "F"]);
  assert.equal(new Set(canonical).size, 9);
  assert.deepEqual(manifests.map((page) => page.videoIds), [["X", "Y", "Z"], ["A", "B", "C"], ["D", "E", "F"]]);
  assert.equal(details.get("A").artist, "Preserved");
  assert.equal(state.discoveredNativeTotal, 9);
  assert.equal(state.discoveredPageCount, 3);
  assert.equal(state.discoveredPageSize, 3);
  assert.equal(progress.at(-1).pageNumber, 2);
  assert.equal(progress.at(-1).nativePageCount, 3);
  assert.equal(requests.every((request) => request.options.cache === "no-store" && request.options.credentials === "include"), true);
});
