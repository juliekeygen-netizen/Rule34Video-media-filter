import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadScanner(defaultDb) {
  const context = vm.createContext({
    AbortController,
    DOMException,
    URL,
    console,
    crypto: { randomUUID: () => "tiny-canary-test" },
    location: { origin: "https://rule34video.com" },
    setTimeout,
    clearTimeout
  });
  context.globalThis = context;

  for (const path of [
    "src/shared/namespace.js",
    "src/shared/rule34video-video-url.js"
  ]) {
    vm.runInContext(readFileSync(path, "utf8"), context, { filename: path });
  }

  context.R34MF.modules.db = defaultDb;
  context.R34MF.modules.detailParser = { parseDocument() { throw new Error("404 responses must not reach the parser"); } };
  context.R34MF.modules.requestScheduler = {
    async runWithPolicy({ request }) {
      return request({ signal: new AbortController().signal });
    }
  };

  vm.runInContext(readFileSync("src/catalogue/detail-scanner.js", "utf8"), context, {
    filename: "src/catalogue/detail-scanner.js"
  });
  return context.R34MF.modules;
}

function video(id) {
  return {
    videoId: String(id),
    url: `https://rule34video.com/video/${id}/example/`
  };
}

function response404(url) {
  return {
    status: 404,
    ok: false,
    url,
    redirected: false,
    headers: { get() { return null; } }
  };
}

function memoryDb(targets) {
  const details = new Map();
  const history = [];
  let detailsState = null;
  return {
    details,
    history,
    get detailsState() { return detailsState; },
    async getCatalogueState() { return { catalogueReady: true }; },
    async getMissingDetailTargets() { return targets; },
    async countDetailedVideos() { return 0; },
    async updateDetailsState(next) { detailsState = structuredClone(next); return detailsState; },
    async appendHistory(entry) { history.push(structuredClone(entry)); },
    async recordDetailFailure(videoId, error) {
      details.set(String(videoId), {
        videoId: String(videoId),
        status: "failed",
        lastError: structuredClone(error)
      });
    },
    async synchronizeDetailedCount() { return 0; },
    async writeCompleteDetail() { throw new Error("No complete detail write is expected in this fixture"); }
  };
}

test("one exhausted 404 canary is isolated instead of failing the whole detail operation", async () => {
  const db = memoryDb([video(1)]);
  const modules = loadScanner(db);
  const scanner = modules.createDetailScanner({
    db,
    parser: modules.detailParser,
    scheduler: modules.requestScheduler,
    fetchImpl: async (url) => response404(url),
    getCurrentOrigin: () => "https://rule34video.com"
  });

  const result = await scanner.run();

  assert.equal(result.detailsState.status, "complete");
  assert.equal(result.detailsState.failedCount, 1);
  assert.equal(result.detailsState.lastError, null);
  assert.equal(result.detailsState.systemicReason, null);
  assert.equal(result.detailsState.lastCanary.passed, false);
  assert.equal(result.detailsState.lastCanary.isolatedGoneOnly, true);
  assert.equal(db.details.get("1").lastError.code, "http-404");
  assert.equal(db.history.at(-1).status, "complete");
});

test("isolated-gone exception is limited to fewer than the systemic threshold", () => {
  const db = memoryDb([]);
  const modules = loadScanner(db);
  const helper = modules.detailScanner.exhaustedGoneOnlyCanary;

  const one = [video(1)];
  assert.equal(helper([{ videoId: "1", ok: false, httpStatus: 404 }], one, new Set(["1"])), true);

  const three = [video(1), video(2), video(3)];
  assert.equal(helper([
    { videoId: "1", ok: false, httpStatus: 404 },
    { videoId: "2", ok: false, httpStatus: 410 },
    { videoId: "3", ok: false, httpStatus: 404 }
  ], three, new Set(["1", "2", "3"])), false);

  assert.equal(helper([{ videoId: "1", ok: false, httpStatus: 404 }], [video(1), video(2)], new Set(["1"])), false);
  assert.equal(helper([{ videoId: "1", ok: false, httpStatus: 500 }], one, new Set(["1"])), false);
});
