import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(path, "utf8");

function boundedRecentRuntime() {
  const app = {
    modules: {
      catalogueScanner: {}, db: {}, feedDiscovery: {}, cardParser: {}, catalogueParsing: {},
      requestScheduler: {}, browserApi: {}, settings: { value: { recentUpdatePageLimit: 3 } }
    }
  };
  const context = vm.createContext({
    R34MF: app, globalThis: null, Number, Math, Set, Map, String, Date, URL,
    fetch: async () => { throw new Error("unused"); }
  });
  context.globalThis = context;
  vm.runInContext(read("src/catalogue/recent-update-bounded.js"), context, { filename: "src/catalogue/recent-update-bounded.js" });
  return app.modules.boundedRecentUpdate;
}

function storeRuntime(file, keyName) {
  let stored = { version: 1, ids: [], updatedAt: 0 };
  let changeHandler = null;
  let gets = 0;
  let sets = 0;
  const browserApi = {
    storageLocal: {
      async get(key) { gets += 1; return { [key]: stored }; },
      async set(value) {
        sets += 1;
        const key = Object.keys(value)[0];
        stored = value[key];
        // Simulate browsers echoing the writer's own storage.local change.
        changeHandler?.({ [key]: { newValue: stored } }, "local");
      }
    },
    storage: { onChanged: { addListener(handler) { changeHandler = handler; } } }
  };
  const app = { modules: { browserApi, constants: { storageKeys: { seenVideos: keyName, favoriteVideos: keyName } } } };
  const context = vm.createContext({
    R34MF: app, globalThis: null, Object, Number, String, Math, Set, Map, Date, RegExp, Array, Promise
  });
  context.globalThis = context;
  vm.runInContext(read(file), context, { filename: file });
  return {
    store: file.includes("seen-store") ? app.modules.seenStore : app.modules.favoriteStore,
    counts: () => ({ gets, sets })
  };
}

test("bounded Recent Update only becomes destructive after current live feed depth proves full coverage", () => {
  const recent = boundedRecentRuntime();
  const partial = recent.reconcileRecentOrder(
    ["105", "104", "103"],
    ["103", "102", "101", "100"],
    { pagesChecked: 1, livePageCount: 2, nativeTotal: 4 }
  );
  assert.equal(partial.authoritative, false);
  assert.deepEqual(Array.from(partial.orderedIds), ["105", "104", "103", "102", "101", "100"]);

  const full = recent.reconcileRecentOrder(
    ["105", "104", "103", "102"],
    ["104", "103", "102", "101", "100"],
    { pagesChecked: 2, livePageCount: 2, nativeTotal: 4 }
  );
  assert.equal(full.authoritative, true);
  assert.deepEqual(Array.from(full.orderedIds), ["105", "104", "103", "102"]);
  assert.equal(full.nativeTotal, 4);
  assert.equal(full.pageCount, 2);

  const mismatch = recent.reconcileRecentOrder(
    ["105", "104", "103"],
    ["104", "103", "102", "101"],
    { pagesChecked: 2, livePageCount: 2, nativeTotal: 4 }
  );
  assert.equal(mismatch.authoritative, false);
  assert.deepEqual(Array.from(mismatch.orderedIds), ["105", "104", "103", "102", "101"]);
});

test("Recent Update never caps configured depth or deletion authority to a stale stored page count", () => {
  const source = read("src/catalogue/recent-update-bounded.js");
  assert.match(source, /const limit = Math\.max\(1, Math\.min\(configuredLimit, livePageCount \|\| configuredLimit\)\)/);
  assert.match(source, /if \(livePageCount && pageNumber >= livePageCount\) break/);
  assert.doesNotMatch(source, /Math\.min\(configuredLimit, nativePageCount/);
  assert.match(source, /current live/);
});

test("automatic Recent Update releases an unowned claim and retries after meaningful tab or BFCache re-entry", () => {
  const source = read("src/content/recent-auto-update-controller.js");
  assert.match(source, /if \(claimed && !outcome\?\.accepted\) await release\(\)/);
  assert.match(source, /AUTO_REENTRY_RETRY_MS = 30_000/);
  assert.match(source, /awayFor >= AUTO_REENTRY_RETRY_MS/);
  assert.match(source, /event\?\.persisted === true/);
  assert.match(source, /automaticAttemptedThisPage = false/);
});

test("Seen writes dedupe their own storage echo and keep a monotonic change stamp", async () => {
  const runtime = storeRuntime("src/storage/seen-store.js", "seen");
  let emissions = 0;
  runtime.store.subscribe(() => { emissions += 1; });
  await runtime.store.load();
  emissions = 0;
  await runtime.store.setSeen("1", true);
  const first = runtime.store.snapshot().updatedAt;
  assert.equal(emissions, 1);
  await runtime.store.setSeen("2", true);
  assert.equal(emissions, 2);
  assert.ok(runtime.store.snapshot().updatedAt > first);
  assert.deepEqual(runtime.counts(), { gets: 3, sets: 2 });
});

test("Favorites coalesce state application and avoid duplicate Local refreshes from self storage echoes", async () => {
  const runtime = storeRuntime("src/storage/favorite-store.js", "favorites");
  let emissions = 0;
  runtime.store.subscribe(() => { emissions += 1; });
  await runtime.store.load();
  emissions = 0;
  await runtime.store.setFavorited("1", true);
  const first = runtime.store.snapshot().updatedAt;
  assert.equal(emissions, 1);
  await runtime.store.toggle("1");
  assert.equal(emissions, 2);
  assert.ok(runtime.store.snapshot().updatedAt > first);
  assert.equal(await runtime.store.has("1"), false);
});

test("Local page redraws can reuse one filtered/sorted result while time-sensitive filters expire each minute", () => {
  const controller = {};
  const app = {
    modules: {
      subscriptionsController: controller,
      db: {},
      filterEngine: {},
      phase10HardeningController: {},
      subscriptionMembership: { publicState: () => ({ snapshot: { refreshedAt: 10 } }) },
      seenStore: { evaluationContext: () => ({ updatedAt: 20 }) },
      favoriteStore: { evaluationContext: () => ({ updatedAt: 30 }) }
    }
  };
  const context = vm.createContext({
    R34MF: app, globalThis: null, Number, Math, String, Date, JSON, Promise, Set, Map,
    performance: { now: () => 0 }, setTimeout: (fn) => { fn(); return 1; }
  });
  context.globalThis = context;
  vm.runInContext(read("src/content/local-filter-context.js"), context, { filename: "src/content/local-filter-context.js" });
  const cache = app.modules.localFilterContext;
  const source = { records: [], detailsById: new Map() };
  const a = cache.resultCacheKey(source, { quick: {} }, { field: "uploadDate" }, 60_001);
  const b = cache.resultCacheKey(source, { quick: {} }, { field: "uploadDate" }, 60_999);
  const c = cache.resultCacheKey(source, { quick: {} }, { field: "uploadDate" }, 120_001);
  assert.equal(cache.sameResultCacheKey(a, b), true);
  assert.equal(cache.sameResultCacheKey(a, c), false);
});
