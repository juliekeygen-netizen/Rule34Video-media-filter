import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

function context(files, seed = {}) {
  const value = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, DOMException, AbortController, setTimeout, clearTimeout, ...seed };
  value.globalThis = value;
  vm.createContext(value);
  for (const file of files) vm.runInContext(readFileSync(file, "utf8"), value, { filename: file });
  return value;
}

function parserModule() {
  return context(["src/shared/namespace.js", "src/shared/rule34video-video-url.js", "src/catalogue/detail-parser.js"]).R34MF.modules.detailParser;
}

function detailDocument({ id = "123", artist = true, uploadDate = "2026-08-09", extra = "" } = {}) {
  return parseHTML(`<!doctype html><html><head>
    <title>Example video</title>
    <link rel="canonical" href="https://rule34video.com/video/${id}/example/">
    <meta property="og:url" content="https://rule34video.com/video/${id}/example/">
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "VideoObject",
      url: `https://rule34video.com/video/${id}/example/`, uploadDate,
      description: "A readable description", keywords: ["animated", "female", "animated"],
      genre: ["Anime"], author: { "@type": "Person", name: "Uploader Name" },
      interactionStatistic: { interactionType: { "@type": "CommentAction" }, userInteractionCount: 7 },
      encoding: [{ name: "HD", encodingFormat: "video/mp4", contentUrl: "https://example.invalid/media.mp4" }]
    })}</script>
  </head><body><div id="video_view">
    <div class="info">${artist ? `<div class="col js-video-suggestion-wrap" data-video-id="${id}" data-suggest-type="model"><strong class="label">Artist:</strong><span data-video-id="${id}" data-item-type="model"><a href="/models/artist-name/"><span class="name">Artist Name</span></a></span></div>` : ""}
    <div class="col js-video-suggestion-wrap" data-video-id="${id}" data-suggest-type="category"><strong class="label">Categories:</strong><span data-video-id="${id}" data-item-type="category"><a href="/categories/anime/">Anime</a></span></div>
    <div class="wrap js-video-suggestion-wrap" data-video-id="${id}" data-suggest-type="tag"><strong class="label">Tags:</strong><span data-video-id="${id}" data-item-type="tag"><a href="/tags/animated/">animated</a></span><span data-video-id="${id}" data-item-type="tag"><a href="/tags/female/">female</a></span></div>
    <div class="col"><strong class="label">Uploaded by:</strong><a href="/members/22/">Uploader Name</a></div></div>
    <div class="description">A readable\n description</div>${extra}</div>
  </body></html>`).document;
}

test("detail parser verifies identity and normalizes the required detail model", () => {
  const parser = parserModule();
  const parsed = parser.parseDocument(detailDocument(), { expectedVideoId: "123", url: "https://rule34video.com/video/123/example/" });
  assert.equal(parsed.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.record)), {
    videoId: "123", artist: "Artist Name", artists: ["Artist Name"], artistRefs: [{ key: "artist-name", name: "Artist Name", url: "https://rule34video.com/models/artist-name/" }], uploader: "Uploader Name", uploaders: ["Uploader Name"],
    tags: ["animated", "female"], categories: ["Anime"], entityTrust: { artist: true, uploader: true, tags: true, categories: true }, description: "A readable description",
    exactUploadDate: "2026-08-09", commentsCount: 7,
    formats: [{ name: "HD", format: "video/mp4" }], status: "complete", schemaVersion: 5, lastError: null
  });
  assert.equal(JSON.stringify(parsed.record).includes("media.mp4"), false, "media URLs are not retained");
});
test("detail parser accepts legitimate missing optional metadata without fabricating dates", () => {
  const parser = parserModule();
  const parsed = parser.parseDocument(detailDocument({ artist: false, uploadDate: null }), { expectedVideoId: "123" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.artist, null);
  assert.equal(parsed.record.exactUploadDate, null);
  assert.equal(parser.normalizeExactDate("2 hours ago"), null);
  assert.equal(parser.normalizeExactDate("2026-08-09"), "2026-08-09");
  assert.equal(parser.normalizeExactDate("2026-08-09T12:34:56+02:00"), "2026-08-09T10:34:56.000Z");
  const htmlDescription = parseHTML(`<html><head><link rel="canonical" href="https://rule34video.com/video/123/example/"><script type="application/ld+json">${JSON.stringify({ "@type": "VideoObject", url: "https://rule34video.com/video/123/example/", description: "<b>Readable</b> <span>text</span>" })}</script></head><body><div id="kt_player"></div></body></html>`).document;
  const description = parser.parseDocument(htmlDescription, { expectedVideoId: "123" });
  assert.equal(description.record.description, "Readable text");
  assert.equal(description.record.description.includes("<"), false);
});

test("detail parser rejects identity mismatch, unexpected pages, and auth/challenge pages", () => {
  const parser = parserModule();
  assert.equal(parser.parseDocument(detailDocument({ id: "999" }), { expectedVideoId: "123" }).reason, "video-id-mismatch");
  const unexpected = parseHTML('<html><head><link rel="canonical" href="https://rule34video.com/video/123/example/"></head><body>Not a video</body></html>').document;
  assert.equal(parser.parseDocument(unexpected, { expectedVideoId: "123" }).reason, "unexpected-detail-structure");
  const challenge = parseHTML("<html><head><title>Checking your browser</title></head><body>Verify you are human</body></html>").document;
  assert.equal(parser.parseDocument(challenge, { expectedVideoId: "123" }).reason, "authentication-required");
});

test("shared Rule34Video identity accepts singular/plural and www without accepting lookalikes", () => {
  const identity = context(["src/shared/namespace.js", "src/shared/rule34video-video-url.js"]).R34MF.modules.rule34VideoIdentity;
  for (const url of [
    "https://rule34video.com/video/3065157/foo/",
    "https://rule34video.com/videos/3065157/foo/",
    "https://www.rule34video.com/video/3065157/foo/",
    "https://www.rule34video.com/videos/3065157/foo/#ignored"
  ]) {
    const parsed = identity.validateRecord({ videoId: "3065157", url });
    assert.equal(parsed.ok, true, url);
    assert.equal(parsed.url.includes("#"), false);
  }
  assert.equal(identity.validateRecord({ videoId: "1", url: "https://rule34video.com/video/2/x/" }).reason, "video-id-mismatch");
  assert.equal(identity.validateRecord({ videoId: "1", url: "https://rule34video.com/categories/1/" }).reason, "invalid-video-path");
  assert.equal(identity.validateRecord({ videoId: "1", url: "https://rule34video.com.evil.example/video/1/" }).reason, "invalid-host");
  assert.equal(identity.validateRecord({ videoId: "1", url: "://bad" }).ok, false);
});

test("catalogue identity extraction uses the same strict Rule34Video video-path contract", () => {
  const parsing = context(["src/shared/namespace.js", "src/shared/rule34video-video-url.js", "src/catalogue/parsing.js"]).R34MF.modules.catalogueParsing;
  assert.equal(parsing.extractVideoId("/video/123/x/"), "123");
  assert.equal(parsing.extractVideoId("/videos/123/x/"), "123");
  assert.equal(parsing.extractVideoId("https://www.rule34video.com/videos/123/x/"), "123");
  assert.equal(parsing.extractVideoId("https://rule34video.com/categories/123/"), null);
  assert.equal(parsing.extractVideoId("https://example.com/video/123/"), null);
});

function rule34Fixture({ id = "3065157", canonicalForm = "videos", jsonForm = "video", optional = true } = {}) {
  const json = optional ? `<script type="application/ld+json">${JSON.stringify({ "@type": "VideoObject", url: `https://rule34video.com/${jsonForm}/${id}/fixture/`, description: "Structured video description", uploadDate: "2021-12-19", datePublished: "2 days ago" })}</script>` : "";
  return parseHTML(`<!doctype html><html><head><link rel="canonical" href="https://www.rule34video.com/${canonicalForm}/${id}/fixture/">${json}</head><body><div id="video_view"></div>
    ${optional ? `<div class="col"><span class="label">Artist:</span><a class="item">Artist One</a><a class="item">Artist Two</a></div>
    <div class="col"><span class="label">Categories:</span><a class="item">3D</a><a class="item">MMD</a></div>
    <div class="col"><span class="label">Uploaded By:</span><a class="name" href="/members/22/">Uploader Name</a></div>
    <a class="tag_item" href="https://rule34video.com/tags/10/">tag one</a><a href="#tab_comments">Comments (1,234)</a>
    <a href="/get-file.mp4?download=true">MP4 1080p</a>` : ""}</body></html>`).document;
}

test("Rule34Video KVS fixture parses labelled columns, tags, JSON-LD, comments, and descriptive quality", () => {
  const parser = parserModule();
  for (const [canonicalForm, jsonForm] of [["videos", "video"], ["video", "videos"]]) {
    const parsed = parser.parseDocument(rule34Fixture({ canonicalForm, jsonForm }), { expectedVideoId: "3065157", url: `https://rule34video.com/${jsonForm}/3065157/fixture/` });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.record.artist, null, "unscoped legacy columns are deliberately not entity metadata");
    assert.equal(parsed.record.uploader, null);
    assert.deepEqual([...parsed.record.categories], []);
    assert.deepEqual([...parsed.record.tags], []);
    assert.equal(parsed.record.description, "Structured video description");
    assert.equal(parsed.record.exactUploadDate, "2021-12-19");
    assert.equal(parsed.record.commentsCount, 1234);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.record.formats)), []);
    assert.equal(parsed.diagnostics.strictEntityContainers.artist, 0);
    assert.equal(parsed.diagnostics.uploaderCandidates, 0);
  }
});

test("Uploaded-by items beat structural Community headings and multiple artists survive parsing", () => {
  const parser = parserModule();
  const document = parseHTML(`<!doctype html><html><head><link rel="canonical" href="https://rule34video.com/video/42/example/"></head><body><div id="video_view"></div>
    <div class="col"><span class="label">Artist:</span><a class="item">Artist One</a><a class="item">Artist Two</a></div>
    <div class="col"><span class="label">Uploaded By:</span><span class="name">Community</span><a class="item" href="/members/22/">Actual Uploader</a></div>
  </body></html>`).document;
  const parsed = parser.parseDocument(document, { expectedVideoId: "42", url: "https://rule34video.com/video/42/example/" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.uploader, null);
  assert.deepEqual([...parsed.record.uploaders], []);
  assert.deepEqual([...parsed.record.artists], []);
  assert.equal(parsed.record.schemaVersion, 5, "current parser rows carry explicit field-level trust");
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.record.entityTrust)), { artist: false, uploader: false, tags: false, categories: false });
});

test("verified Rule34Video page may omit optional fields while mismatched and unrelated fixtures fail", () => {
  const parser = parserModule();
  const optional = parser.parseDocument(rule34Fixture({ optional: false }), { expectedVideoId: "3065157" });
  assert.equal(optional.ok, true);
  assert.equal(optional.record.artist, null);
  assert.equal(optional.record.exactUploadDate, null);
  assert.equal(parser.parseDocument(rule34Fixture({ id: "999" }), { expectedVideoId: "3065157" }).reason, "video-id-mismatch");
  assert.equal(parser.parseDocument(parseHTML("<html><body><main>unrelated</main></body></html>").document, { expectedVideoId: "3065157" }).reason, "unexpected-detail-structure");
});

function dbHelpers() {
  return context(["src/shared/namespace.js", "src/shared/constants.js", "src/storage/db.js"]).R34MF.modules.db;
}

test("detail DB helpers normalize complete/failure records, preserve good data, and plan missing work", () => {
  const db = dbHelpers();
  const complete = db.normalizeCompleteDetail({ videoId: "1", entityTrust: { tags: true }, tags: [" animated ", "Animated", ""], categories: ["Anime"], description: " text " }, 100);
  assert.equal(complete.status, "complete");
  assert.deepEqual([...complete.tags], ["animated"]);
  assert.deepEqual(JSON.parse(JSON.stringify(complete.entityTrust)), { artist: false, uploader: false, tags: true, categories: false });
  const preserved = db.mergeDetailFailure(complete, { code: "http-503", message: "temporary", httpStatus: 503 }, 200);
  assert.equal(preserved.status, "complete");
  assert.equal(preserved.lastAttemptError.code, "http-503");
  const failed = db.mergeDetailFailure({ videoId: "2" }, { code: "http-404", message: "gone" }, 200);
  assert.equal(failed.status, "failed");
  assert.deepEqual(JSON.parse(JSON.stringify(db.missingDetailTargets([{ videoId: "1" }, { videoId: "2" }, { videoId: "2" }], [complete, failed]).map((video) => video.videoId))), ["2"]);
  const changes = db.interruptedStateChanges({ scanStatus: "complete", detailsState: { status: "running", processedCount: 9, activeRunStartedAt: 1 } }, 500);
  assert.equal(changes.detailsState.status, "paused");
  assert.equal(changes.detailsState.processedCount, 9);
  assert.equal(changes.detailsState.lastError.code, "runtime-interrupted");
  const recovered = db.mergeCompleteDetail(failed, { videoId: "2", artist: "Recovered" }, 300);
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.lastAttemptError, null);
  assert.equal(recovered.failureCount, 1);
});

function scannerFactory() {
  const env = context(["src/shared/namespace.js", "src/shared/rule34video-video-url.js"], { crypto: { randomUUID: () => "detail-session" } });
  env.R34MF.modules.db = {};
  env.R34MF.modules.detailParser = {};
  env.R34MF.modules.requestScheduler = {};
  vm.runInContext(readFileSync("src/catalogue/detail-scanner.js", "utf8"), env, { filename: "src/catalogue/detail-scanner.js" });
  return env.R34MF.modules.createDetailScanner;
}

function memoryDb(videos, initialDetails = []) {
  const records = [...videos];
  const details = new Map(initialDetails.map((detail) => [String(detail.videoId), { ...detail }]));
  const state = { catalogueReady: true, indexedCount: records.length, detailedCount: initialDetails.filter((detail) => detail.status === "complete").length, detailsState: { status: "idle" } };
  const history = [];
  return {
    records, details, state, history,
    async getCatalogueState() { return structuredClone(state); },
    async getMissingDetailTargets({ limit = null } = {}) {
      const targets = records.filter((video) => details.get(String(video.videoId))?.status !== "complete");
      return limit === null ? targets : targets.slice(0, limit);
    },
    async countDetailedVideos() { return records.filter((video) => details.get(String(video.videoId))?.status === "complete").length; },
    async writeCompleteDetail(record) { details.set(String(record.videoId), { ...record, status: "complete" }); state.detailedCount = await this.countDetailedVideos(); return { record, detailedCount: state.detailedCount }; },
    async recordDetailFailure(videoId, error) { details.set(String(videoId), { videoId: String(videoId), status: "failed", lastError: error }); },
    async updateDetailsState(value) { state.detailsState = { ...state.detailsState, ...value }; return structuredClone(state); },
    async synchronizeDetailedCount() { state.detailedCount = await this.countDetailedVideos(); return state.detailedCount; },
    async appendHistory(entry) { history.push(entry); }
  };
}

function video(id) { return { videoId: String(id), url: `https://rule34video.com/video/${id}/example/` }; }
function response(status, body = "ok", id = "1", headers = {}) {
  return { status, ok: status >= 200 && status < 300, url: `https://rule34video.com/video/${id}/example/`, headers: { get: (name) => headers[name] ?? null }, text: async () => body };
}
function scannerOptions(db, { concurrency = 2, fetchImpl, parser, scheduler } = {}) {
  return {
    db,
    parser: parser ?? { parseDocument: (_body, ctx) => ({ ok: true, record: { videoId: ctx.expectedVideoId, tags: [], categories: [], description: "", exactUploadDate: null } }) },
    scheduler: scheduler ?? { runWithPolicy: ({ request, signal }) => request({ signal, attempt: 0 }) },
    fetchImpl: fetchImpl ?? (async (url) => response(200, "ok", url.match(/\/videos?\/(\d+)/)[1])),
    parseHtml: (html) => html,
    getSettings: () => ({ concurrentDetailRequests: concurrency, retryTemporaryDetailFailures: true }),
    logger: { debug() {}, warn() {} }
  };
}

test("detail scanner is missing-only, skips complete records, and reconciles newly added videos", async () => {
  const factory = scannerFactory();
  const db = memoryDb([video(1), video(2)], [{ videoId: "1", status: "complete" }]);
  const requested = [];
  const originalWrite = db.writeCompleteDetail.bind(db);
  db.writeCompleteDetail = async (record) => {
    const result = await originalWrite(record);
    if (record.videoId === "2") db.records.push(video(3));
    return result;
  };
  const scanner = factory(scannerOptions(db, { concurrency: 1, fetchImpl: async (url) => { requested.push(url.match(/\/video\/(\d+)/)[1]); return response(200, "ok", requested.at(-1)); } }));
  const result = await scanner.run();
  assert.deepEqual(requested, ["2", "3"]);
  assert.equal(result.detailsState.status, "complete");
  assert.equal(result.detailsState.processedCount, 2);
  assert.equal(result.detailedCount, 3);
});

test("detail scanner honors internal concurrency 1, 2, and 3 and routes every request through the scheduler", async () => {
  const factory = scannerFactory();
  for (const concurrency of [1, 2, 3]) {
    const db = memoryDb(Array.from({ length: 6 }, (_, index) => video(index + 1)));
    let active = 0; let maximum = 0; let schedulerCalls = 0;
    const scheduler = { async runWithPolicy({ request, signal }) { schedulerCalls += 1; return request({ signal, attempt: 0 }); } };
    const fetchImpl = async (url) => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return response(200, "ok", url.match(/\/video\/(\d+)/)[1]);
    };
    const result = await factory(scannerOptions(db, { concurrency, scheduler, fetchImpl })).run({ limit: 6 });
    assert.equal(maximum, concurrency);
    assert.equal(schedulerCalls, 6);
    assert.equal(result.detailsState.completedCount, 6);
  }
});

test("detail scanner maps the transient retry setting onto the shared scheduler policy", async () => {
  const factory = scannerFactory();
  for (const retry of [false, true]) {
    const db = memoryDb([video(1)]);
    let maximumRetries = "unset";
    const scanner = factory({
      ...scannerOptions(db),
      scheduler: { runWithPolicy: async (options) => { maximumRetries = options.maximumRetries; return options.request({ signal: options.signal, attempt: 0 }); } },
      getSettings: () => ({ concurrentDetailRequests: 1, retryTemporaryDetailFailures: retry })
    });
    await scanner.run({ limit: 1 });
    assert.equal(maximumRetries, retry ? undefined : 0);
  }
});

test("detail scanner records individual failures, does not retry them in-run, and continues", async () => {
  const factory = scannerFactory();
  const db = memoryDb([video(1), video(2), video(3)]);
  const calls = [];
  const scanner = factory(scannerOptions(db, { concurrency: 1, fetchImpl: async (url) => {
    const id = url.match(/\/videos?\/(\d+)/)[1]; calls.push(id);
    return id === "2" ? response(404, "gone", id) : response(200, "ok", id);
  } }));
  const result = await scanner.run();
  assert.deepEqual(calls, ["1", "2", "2", "3"], "404 canary target receives one identity-preserving alternate-path attempt");
  assert.equal(result.detailsState.status, "complete");
  assert.equal(result.detailsState.failedCount, 1);
  assert.equal(db.details.get("2").status, "failed");
});

test("detail scanner circuit-breaks repeated structural failures", async () => {
  const factory = scannerFactory();
  const db = memoryDb(Array.from({ length: 20 }, (_, index) => video(index + 1)));
  let requests = 0;
  const scanner = factory(scannerOptions(db, {
    concurrency: 1,
    fetchImpl: async (_url) => { requests += 1; return response(200); },
    parser: { parseDocument: () => ({ ok: false, reason: "unexpected-detail-structure", diagnostics: { expectedDetailRootFound: false } }) }
  }));
  const result = await scanner.run();
  assert.equal(result.detailsState.status, "failed");
  assert.equal(result.lastError.code, "detail-canary-parser-failure");
  assert.equal(requests, 3);
});

test("local URL preflight aborts a systemic bad workset before requests or failure-row writes", async () => {
  const factory = scannerFactory();
  const db = memoryDb(Array.from({ length: 1000 }, (_, index) => ({ videoId: String(index + 1), url: `https://rule34video.com/categories/${index + 1}/` })));
  let requests = 0; let failureWrites = 0;
  db.recordDetailFailure = async () => { failureWrites += 1; };
  const result = await factory(scannerOptions(db, { fetchImpl: async () => { requests += 1; return response(200); } })).run();
  assert.equal(result.detailsState.status, "failed");
  assert.equal(result.lastError.code, "detail-url-preflight-failed");
  assert.equal(result.detailsState.processedCount, 0);
  assert.equal(result.detailsState.lastPreflight.invalidCount, 1000);
  assert.equal(result.detailsState.lastPreflight.invalidSamples.length, 10);
  assert.equal(requests, 0);
  assert.equal(failureWrites, 0);
});

test("one malformed target remains isolated while valid targets pass canary and bulk", async () => {
  const factory = scannerFactory();
  const db = memoryDb([{ videoId: "bad", url: "not a video" }, ...Array.from({ length: 6 }, (_, index) => video(index + 1))]);
  const requested = [];
  const result = await factory(scannerOptions(db, { concurrency: 2, fetchImpl: async (url) => { const id = url.match(/\/videos?\/(\d+)/)[1]; requested.push(id); return response(200, "ok", id); } })).run({ limit: 7 });
  assert.equal(result.detailsState.status, "complete");
  assert.equal(result.detailsState.failedCount, 1);
  assert.equal(db.details.get("bad").lastError.code, "invalid-video-url");
  assert.equal(new Set(requested).size, 6);
});

test("authenticated canary must pass before bulk and committed canaries are never fetched twice", async () => {
  const factory = scannerFactory(); const db = memoryDb(Array.from({ length: 12 }, (_, index) => video(index + 1))); const calls = []; const phases = [];
  const originalState = db.updateDetailsState.bind(db); db.updateDetailsState = async (state) => { phases.push(state.phase); return originalState(state); };
  const result = await factory(scannerOptions(db, { concurrency: 3, fetchImpl: async (url) => { const id = url.match(/\/videos?\/(\d+)/)[1]; calls.push({ id, phase: db.state.detailsState.phase }); return response(200, "ok", id); } })).run({ limit: 12 });
  assert.equal(result.detailsState.status, "complete");
  assert.equal(result.detailsState.lastCanary.passed, true);
  assert.equal(result.detailsState.lastCanary.successCount, 3);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.phase), ["canary", "canary", "canary"]);
  assert.equal(calls.slice(3).every((call) => call.phase === "bulk"), true);
  assert.equal(new Set(calls.map((call) => call.id)).size, calls.length);
  assert.equal(phases.includes("preflight") && phases.includes("canary") && phases.includes("bulk"), true);
});

test("failed canary prevents bulk cascade and persists bounded structural evidence", async () => {
  const factory = scannerFactory(); const db = memoryDb(Array.from({ length: 100 }, (_, index) => video(index + 1))); let requests = 0;
  const result = await factory(scannerOptions(db, { concurrency: 3, fetchImpl: async () => { requests += 1; return response(200); }, parser: { parseDocument: () => ({ ok: false, reason: "unexpected-detail-structure", diagnostics: { expectedDetailRootFound: false } }) } })).run();
  assert.equal(result.detailsState.status, "failed");
  assert.equal(requests, 3);
  assert.equal(result.detailsState.lastCanary.samples.length, 3);
  assert.equal(result.detailsState.systemicReason.code, "detail-canary-parser-failure");
  assert.equal(result.detailsState.lastCanary.failureCodes["unexpected-detail-structure"], 3);
  assert.equal(result.detailsState.lastCanary.samples[0].evidence.detailRoot, false);
});

test("old failed rows retry in a fresh run with reset counters and become complete", async () => {
  const factory = scannerFactory(); const db = memoryDb([video(1), video(2)], [{ videoId: "1", status: "failed", failureCount: 20, lastError: { code: "invalid-video-url" } }, { videoId: "2", status: "complete" }]);
  db.state.detailsState = { status: "failed", processedCount: 3381, failedCount: 3381, lastError: { code: "invalid-video-url" } };
  const result = await factory(scannerOptions(db, { concurrency: 1 })).run();
  assert.equal(result.detailsState.status, "complete");
  assert.equal(result.detailsState.targetCount, 1);
  assert.equal(result.detailsState.processedCount, 1);
  assert.equal(result.detailsState.failedCount, 0);
  assert.equal(db.details.get("1").status, "complete");
  assert.equal(db.details.get("1").lastError ?? null, null);
  assert.equal(db.details.get("2").status, "complete");
});

test("persistent HTTP 504 canary is classified as transient with safe response evidence", async () => {
  const factory = scannerFactory(); const db = memoryDb(Array.from({ length: 12 }, (_, index) => video(index + 1))); let calls = 0;
  const result = await factory(scannerOptions(db, { fetchImpl: async (url) => { calls += 1; const id = url.match(/\/videos?\/(\d+)/)[1]; return calls === 1 ? response(200, "ok", id) : response(504, "gateway timeout", id, { "Content-Type": "text/html", "Content-Length": "15" }); } })).run();
  assert.equal(result.lastError.code, "detail-canary-transient-network");
  assert.match(result.lastError.message, /HTTP 504/);
  assert.equal(result.detailsState.lastCanary.successCount, 1);
  assert.equal(result.detailsState.lastCanary.failedCount, 9);
  assert.equal(result.detailsState.lastCanary.httpStatuses[504], 9);
  const failed = result.detailsState.lastCanary.samples.find((sample) => !sample.ok);
  assert.equal(failed.response.httpStatus, 504);
  assert.equal(failed.response.contentType, "text/html");
  assert.equal(failed.response.responseLength, 15);
});

test("404-heavy canary is classified as catalogue liveness failure and never starts bulk", async () => {
  const factory = scannerFactory(); const db = memoryDb(Array.from({ length: 20 }, (_, index) => video(index + 1))); let calls = 0;
  const result = await factory(scannerOptions(db, { fetchImpl: async (url) => { calls += 1; const id = url.match(/\/videos?\/(\d+)/)[1]; return response(404, "gone", id); } })).run();
  assert.equal(result.lastError.code, "detail-canary-http-failure");
  assert.equal(result.detailsState.lastCanary.attemptedCount, 10);
  assert.equal(result.detailsState.lastCanary.httpStatuses[404], 10);
  assert.equal(calls, 20, "each canary target uses at most one singular/plural fallback");
  assert.equal(db.details.size, 10);
});

test("detail requests use current Rule34Video origin, no-store, and canary-proven alternate path", async () => {
  const factory = scannerFactory(); const videos = Array.from({ length: 3 }, (_, index) => ({ videoId: String(index + 1), url: `https://www.rule34video.com/videos/${index + 1}/slug/` })); const db = memoryDb(videos); const requests = [];
  const scanner = factory({ ...scannerOptions(db), getCurrentOrigin: () => "https://rule34video.com", fetchImpl: async (url, options) => { requests.push({ url, options }); const id = url.match(/\/videos?\/(\d+)/)[1]; return /\/videos\//.test(url) ? response(404, "gone", id) : response(200, "ok", id); } });
  const result = await scanner.run({ limit: 3 });
  assert.equal(result.detailsState.status, "complete");
  assert.equal(result.detailsState.lastCanary.preferredPathShape, "/video/");
  assert.equal(requests.every((request) => new URL(request.url).hostname === "rule34video.com"), true);
  assert.equal(requests.every((request) => request.options.cache === "no-store" && request.options.credentials === "include"), true);
});

test("detail scanner stops safely on a final 429 and preserves earlier commits", async () => {
  const factory = scannerFactory();
  const db = memoryDb([video(1), video(2), video(3)]);
  const scanner = factory(scannerOptions(db, { concurrency: 1, fetchImpl: async (url) => {
    const id = url.match(/\/video\/(\d+)/)[1];
    return id === "2" ? response(429, "limited", id, { "Retry-After": "10" }) : response(200, "ok", id);
  } }));
  const result = await scanner.run();
  assert.equal(result.detailsState.status, "paused");
  assert.equal(result.lastError.code, "http-429");
  assert.equal(db.details.get("1").status, "complete");
  assert.equal(db.details.has("3"), false);
});

test("detail scanner aborts all workers while retaining completed records", async () => {
  const factory = scannerFactory();
  const db = memoryDb([video(1), video(2), video(3)]);
  const controller = new AbortController();
  const scanner = factory(scannerOptions(db, { concurrency: 1, fetchImpl: async (url, { signal }) => {
    const id = url.match(/\/video\/(\d+)/)[1];
    if (id === "1") return response(200, "ok", id);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }));
  } }));
  const run = scanner.run({ signal: controller.signal });
  while (db.details.get("1")?.status !== "complete") await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  const result = await run;
  assert.equal(result.detailsState.status, "paused");
  assert.equal(db.details.get("1").status, "complete");
  assert.equal(result.detailedCount, 1);
});

test("scheduler applies Retry-After even when a 429 has no retry remaining", async () => {
  let now = 1000;
  const clock = { now: () => now, setTimeout(callback, ms) { now += ms; callback(); return 1; }, clearTimeout() {} };
  const env = context(["src/shared/namespace.js", "src/jobs/request-scheduler.js"]);
  const scheduler = env.R34MF.modules.createRequestScheduler({ clock, getMinimumSpacingMs: () => 0, getMaximumAutomaticRetries: () => 0 });
  const result = await scheduler.runWithPolicy({ request: async () => response(429, "limited", "1", { "Retry-After": "7" }) });
  assert.equal(result.status, 429);
  assert.equal(scheduler.snapshot().cooldownUntil, 8000);
});

test("Queue maps detail jobs, destinations, top-level slots, and Recent labels by kind", () => {
  const env = context(["src/shared/namespace.js", "src/ui/queue/queue-view-model.js"]);
  const derive = env.R34MF.modules.queueViewModel.deriveQueueViewModel;
  const model = derive({
    catalogue: { catalogueReady: true, scanStatus: "complete", indexedCount: 10, detailedCount: 4, detailsState: { status: "running" } },
    capabilities: { fetchDetails: true, smartUpdate: true },
    runtime: { slots: 2, active: [{ id: "d", kind: "detail-enrichment", progress: { processed: 3, total: 6, detailedCount: 7, failedCount: 0 } }], waiting: [] },
    recent: [{ kind: "detailed-metadata", status: "complete" }, { kind: "catalogue-update", status: "failed" }]
  });
  assert.equal(model.headerStatus, "1 of 2 slots");
  assert.equal(model.active[0].action, "queue-details");
  assert.equal(model.active[0].scope, "3 of 6 checked");
  assert.equal(model.operations[1].status, "Running");
  assert.deepEqual(model.recent.map((entry) => entry.title), ["Detailed metadata", "Smart Update"]);
});

test("Queue truthfully labels detail preflight and canary phases", () => {
  const derive = context(["src/shared/namespace.js", "src/ui/queue/queue-view-model.js"]).R34MF.modules.queueViewModel.deriveQueueViewModel;
  for (const [phase, scope] of [["preflight", "Validating stored video URLs"], ["canary", "0 of 10 attempted"]]) {
    const model = derive({ catalogue: { catalogueReady: true, indexedCount: 20, detailedCount: 0, detailsState: { status: "running", phase } }, capabilities: { fetchDetails: true }, runtime: { slots: 1, active: [{ kind: "detail-enrichment", progress: { phase, processed: 0, total: 20, detailedCount: 0, failedCount: 0 } }], waiting: [] } });
    assert.equal(model.active[0].phase, phase);
    assert.equal(model.active[0].scope, scope);
  }
});

test("Job Manager allows Smart Update with details but conflicts Full Rescan with details", async () => {
  const env = context(["src/shared/namespace.js", "src/jobs/job-manager.js"]);
  const manager = env.R34MF.modules.createJobManager({ getConcurrency: () => 2 });
  const releases = [];
  for (const kind of ["smart-update", "full-rescan", "detail-enrichment"]) manager.registerHandler(kind, () => new Promise((resolve) => releases.push(resolve)));
  manager.enqueue({ kind: "smart-update", resourceKeys: ["catalogue-write"] });
  manager.enqueue({ kind: "detail-enrichment", scopeKey: "details-missing", resourceKeys: ["detail-write", "catalogue-reconcile"] });
  await new Promise(setImmediate);
  assert.equal(manager.snapshot().active.length, 2);
  releases.splice(0).forEach((release) => release());
  await new Promise(setImmediate);

  const manager2 = env.R34MF.modules.createJobManager({ getConcurrency: () => 2 });
  manager2.registerHandler("full-rescan", () => new Promise(() => {}));
  manager2.registerHandler("detail-enrichment", () => new Promise(() => {}));
  manager2.enqueue({ kind: "full-rescan", resourceKeys: ["catalogue-write", "catalogue-reconcile"] });
  manager2.enqueue({ kind: "detail-enrichment", scopeKey: "details-missing", resourceKeys: ["detail-write", "catalogue-reconcile"] });
  await new Promise(setImmediate);
  assert.equal(manager2.snapshot().active.length, 1);
  assert.equal(manager2.snapshot().waiting[0].kind, "detail-enrichment");
  assert.equal(manager2.enqueue({ kind: "detail-enrichment", scopeKey: "details-missing" }).reason, "duplicate");
});

test("controller detail intents enqueue one logical job and Stop aborts only that job", async () => {
  const env = context(["src/shared/namespace.js", "src/shared/constants.js", "src/jobs/job-manager.js", "src/content/subscriptions-controller.js"], {
    Node: { ELEMENT_NODE: 1 }, queueMicrotask,
    window: { location: { href: "https://rule34video.com/my/subscriptions/" }, innerWidth: 1200, setTimeout, clearTimeout },
    document: { documentElement: { clientWidth: 1200 }, querySelectorAll: () => [] }
  });
  const manager = env.R34MF.modules.jobManager;
  let detailAborted = false;
  manager.registerHandler("detail-enrichment", (_job, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => { detailAborted = true; resolve({ detailsState: { status: "paused" } }); }, { once: true })));
  const controller = env.R34MF.modules.subscriptionsController;
  controller.state = { ...controller.state, catalogue: { catalogueReady: true, indexedCount: 10, detailedCount: 2 } };
  await controller.handleIntent("details-fetch");
  await new Promise(setImmediate);
  assert.equal(manager.snapshot().active.filter((job) => job.kind === "detail-enrichment").length, 1);
  await controller.handleIntent("details-fetch");
  assert.equal(manager.snapshot().active.length + manager.snapshot().waiting.length, 1);
  await controller.handleIntent("details-stop");
  await new Promise(setImmediate);
  assert.equal(detailAborted, true);
  assert.equal(manager.snapshot().recent[0].state, "stopped");
});

test("controller removes a waiting detail job without stopping unrelated catalogue work", async () => {
  const env = context(["src/shared/namespace.js", "src/shared/constants.js", "src/jobs/job-manager.js", "src/content/subscriptions-controller.js"], {
    Node: { ELEMENT_NODE: 1 }, queueMicrotask,
    window: { location: { href: "https://rule34video.com/my/subscriptions/" }, innerWidth: 1200, setTimeout, clearTimeout },
    document: { documentElement: { clientWidth: 1200 }, querySelectorAll: () => [] }
  });
  const manager = env.R34MF.modules.jobManager;
  manager.registerHandler("full-rescan", () => new Promise(() => {}));
  manager.registerHandler("detail-enrichment", () => new Promise(() => {}));
  manager.enqueue({ kind: "full-rescan", resourceKeys: ["catalogue-write", "catalogue-reconcile"] });
  const controller = env.R34MF.modules.subscriptionsController;
  controller.state = { ...controller.state, catalogue: { catalogueReady: true, indexedCount: 10, detailedCount: 2 } };
  await controller.handleIntent("details-fetch");
  await new Promise(setImmediate);
  assert.equal(manager.snapshot().waiting[0].kind, "detail-enrichment");
  await controller.handleIntent("details-remove");
  assert.equal(manager.snapshot().waiting.length, 0);
  assert.equal(manager.snapshot().active[0].kind, "full-rescan");
});

test("completed details make normal/Advanced fields, vocabulary, and exact-date sort authoritative", () => {
  const env = context(["src/shared/namespace.js", "src/filters/filter-engine.js", "src/sort/sorter.js"]);
  const f = env.R34MF.modules.filterEngine;
  const sorter = env.R34MF.modules.sorter;
  const a = { videoId: "a", relativeUploadText: "2 hours ago" };
  const b = { videoId: "b" };
  const c = { videoId: "c" };
  const details = new Map([
    ["a", { status: "complete", schemaVersion: 5, entityTrust: { artist: true, uploader: true, tags: true, categories: true }, artist: "Artist", uploader: "Uploader", tags: ["animated", "female"], categories: ["Anime"], description: "An animation example", exactUploadDate: "2026-08-09" }],
    ["b", { status: "complete", schemaVersion: 5, entityTrust: { artist: true, uploader: true, tags: true, categories: true }, artist: "Other", uploader: "Uploader", tags: ["animated"], categories: [], description: "Other", exactUploadDate: "2025-01-01" }],
    ["c", { status: "failed", exactUploadDate: "2027-01-01" }]
  ]);
  assert.equal(f.evaluateRule(a, null, { enabled: true, field: "artist", operator: "is", value: "Artist", polarity: "exclude" }), f.UNKNOWN);
  for (const rule of [
    { field: "artist", operator: "is", value: "Artist" }, { field: "uploader", operator: "is", value: "Uploader" },
    { field: "tags", value: "animated" }, { field: "categories", value: "Anime" },
    { field: "description", operator: "contains", value: "animation" }, { field: "uploadDate", operator: "on", value: "2026-08-09" }
  ]) assert.equal(f.evaluateRule(a, details.get("a"), { enabled: true, polarity: "match", ...rule }), f.TRUE);
  assert.deepEqual(JSON.parse(JSON.stringify(f.vocabulary([a, b, c], details, "tags").values.map((entry) => [entry.value, entry.count]))), [["animated", 2], ["female", 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(sorter.sort([a, b, c], details, { field: "uploadDate", direction: "desc" }).map((item) => item.videoId))), ["a", "b", "c"]);
  assert.deepEqual(JSON.parse(JSON.stringify(sorter.sort([a, b, c], details, { field: "uploadDate", direction: "asc" }).map((item) => item.videoId))), ["b", "a", "c"]);
  assert.equal(details.get("a").exactUploadDate, "2026-08-09", "listing relative age did not supply detail precision");
});

test("detail diagnostic export is bounded and includes current failure, HTTP, URL, preflight, and canary distributions", () => {
  const env = context(["src/shared/namespace.js", "src/shared/rule34video-video-url.js"], { Blob, document: { createElement: () => ({ click() {} }) } });
  env.R34MF.modules.db = {};
  vm.runInContext(readFileSync("src/diagnostics/detail-diagnostic-export.js", "utf8"), env, { filename: "src/diagnostics/detail-diagnostic-export.js" });
  const records = Array.from({ length: 15 }, (_, index) => ({ videoId: String(index + 1), url: `https://rule34video.com/${index % 2 ? "videos" : "video"}/${index + 1}/x/` }));
  records.push({ videoId: "bad", url: "https://rule34video.com/categories/99/" });
  const details = records.map((record, index) => ({ videoId: record.videoId, status: "failed", lastError: { code: index % 2 ? "http-404" : "unexpected-detail-structure", message: "x".repeat(500), ...(index % 2 ? { httpStatus: 404 } : {}) } }));
  const catalogue = { indexedCount: 16, detailedCount: 0, detailsState: { lastPreflight: { invalidCount: 1 }, lastCanary: { passed: false }, systemicReason: { code: "detail-canary-failed" } } };
  const section = env.R34MF.modules.detailDiagnosticExport.buildDetailSection({ catalogue, records, details });
  assert.equal(section.counts.failed, 16);
  assert.equal(section.failedSamples.length, 10);
  assert.equal(section.failedSamples[0].message.length, 240);
  assert.equal(section.failureCodes["http-404"], 8);
  assert.equal(section.httpStatuses[404], 8);
  assert.deepEqual(JSON.parse(JSON.stringify(section.urlShapes)), { "/video/": 8, "/videos/": 7, "invalid/other": 1 });
  assert.equal(section.lastPreflight.invalidCount, 1);
  assert.equal(section.lastCanary.passed, false);
  assert.equal(section.systemicReason.code, "detail-canary-failed");
});

test("Phase 7 controller and manifest wire one real detail job without a second scheduler", () => {
  const controller = readFileSync("src/content/subscriptions-controller.js", "utf8");
  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("src/shared/rule34video-video-url.js") < scripts.indexOf("src/catalogue/detail-parser.js"));
  assert.ok(scripts.indexOf("src/catalogue/detail-parser.js") < scripts.indexOf("src/catalogue/detail-scanner.js"));
  assert.ok(scripts.indexOf("src/catalogue/detail-scanner.js") < scripts.indexOf("src/content/subscriptions-controller.js"));
  assert.match(controller, /registerHandler\("detail-enrichment"/);
  assert.match(controller, /details-fetch/);
  assert.match(controller, /details-stop/);
  assert.match(controller, /details-export-diagnostic/);
  assert.match(controller, /autoFetchMissingDetails/);
  assert.doesNotMatch(readFileSync("src/catalogue/detail-scanner.js", "utf8"), /createRequestScheduler/);
  const writeComplete = readFileSync("src/storage/db.js", "utf8").match(/async function writeCompleteDetail[\s\S]*?\n  }/)?.[0] ?? "";
  assert.doesNotMatch(writeComplete, /synchronizeDetailedCount/, "per-video detail commits must not globally recount the detail store");
});
