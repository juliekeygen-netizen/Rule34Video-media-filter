import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function runtime() {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, URLSearchParams };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    "src/shared/namespace.js",
    "src/shared/upload-date.js",
    "src/filters/filter-engine.js",
    "src/filters/filter-quality.js",
    "src/filters/filter-duplicates.js",
    "src/filters/filter-draft.js",
    "src/filters/filter-advanced-draft.js"
  ]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return context.R34MF.modules;
}

function details({ artist = "Artist A", ref = "artist-a", formats = ["1080p", "720p"], categories = ["Category A"], tags = ["Tag A"], exactUploadDate = null } = {}) {
  return {
    status: "complete",
    schemaVersion: 6,
    entityTrust: { artist: true, uploader: true, tags: true, categories: true },
    artists: [artist],
    artistRefs: [{ key: ref, name: artist, url: `https://rule34video.com/models/${ref}/` }],
    categories,
    tags,
    exactUploadDate,
    formats: formats.map((resolution) => ({ format: "mp4", resolution }))
  };
}

function rule(field, extra = {}) {
  return { id: `rule-${field}`, kind: "rule", enabled: true, connector: null, field, polarity: "match", ...extra };
}

test("Quality remains Advanced-only with the requested comparisons and observed quality list", () => {
  const { filterEngine: engine } = runtime();
  assert.equal(engine.ALL_FIELDS.includes("quality"), true);
  assert.deepEqual([...engine.QUALITY_OPERATORS].map(([key]) => key), ["equals", "gt", "gte", "lt", "lte"]);
  assert.deepEqual([...engine.QUALITY_OPTIONS].map(([key]) => key), ["2160p", "1080p", "720p", "480p", "360p"]);
  assert.equal(engine.QUALITY_OPTIONS.some(([key]) => key === "1440p"), false);
  const detail = details({ formats: ["2160p", "1080p", "720p"] });
  assert.equal(engine.evaluateRule({}, detail, rule("quality", { operator: "equals", value: "2160p" })), engine.TRUE);
  assert.equal(engine.evaluateRule({}, detail, rule("quality", { operator: "gt", value: "1080p" })), engine.TRUE);
  assert.equal(engine.evaluateRule({}, detail, rule("quality", { operator: "lte", value: "1080p" })), engine.FALSE);
});

test("Quality and Duplicates survive Advanced normalization inside Groups", () => {
  const { filterEngine: engine } = runtime();
  const filters = engine.normalize({ advanced: { enabled: true, items: [{ id: "g", kind: "group", enabled: true, items: [
    rule("quality", { operator: "gte", value: "720p" }),
    rule("duplicates", { connector: "or", options: { matchingDuration: true, matchingQuality: true, matchingTitleWordCount: 3 } })
  ] }] } });
  assert.equal(filters.advanced.enabled, true);
  assert.equal(filters.advanced.items[0].items[0].field, "quality");
  assert.equal(filters.advanced.items[0].items[1].field, "duplicates");
  assert.equal(filters.advanced.items[0].items[1].connector, "or");
  assert.equal(filters.advanced.items[0].items[1].options.matchingQuality, true);
  assert.equal(filters.advanced.items[0].items[1].options.matchingTitleWordCount, 3);
});

test("Duplicate matching criteria are ANDed against the same candidate", () => {
  const { filterEngine: engine } = runtime();
  const records = [
    { videoId: "1", title: "Original scene", durationSec: 120 },
    { videoId: "2", title: "Reupload scene", durationSec: 120 }
  ];
  const detailMap = new Map([
    ["1", details({ categories: ["Shared"], tags: ["Tag A"], exactUploadDate: "2026-01-01" })],
    ["2", details({ categories: ["Shared"], tags: ["Tag B"], exactUploadDate: "2026-02-01" })]
  ]);
  const context = engine.createEvaluationContext(records, detailMap);
  const both = rule("duplicates", { options: { matchingDuration: true, matchingCategory: true, matchingTag: true } });
  assert.equal(engine.evaluateRule(records[1], detailMap.get("2"), both, Date.now(), context), engine.FALSE, "matching duration AND category must not compensate for a non-matching tag");
  const durationCategory = rule("duplicates", { options: { matchingDuration: true, matchingCategory: true } });
  assert.equal(engine.evaluateRule(records[1], detailMap.get("2"), durationCategory, Date.now(), engine.createEvaluationContext(records, detailMap)), engine.TRUE);
});

test("Duplicates keeps the earliest uploaded representative and flags only redundant copies", () => {
  const { filterEngine: engine } = runtime();
  const records = [
    { videoId: "10", title: "The original longer title", durationSec: 80 },
    { videoId: "20", title: "Copy", durationSec: 80 }
  ];
  const detailMap = new Map([
    ["10", details({ exactUploadDate: "2025-01-02" })],
    ["20", details({ exactUploadDate: "2025-06-10" })]
  ]);
  const duplicate = rule("duplicates", { options: { matchingDuration: true } });
  const context = engine.createEvaluationContext(records, detailMap);
  assert.equal(engine.evaluateRule(records[0], detailMap.get("10"), duplicate, Date.now(), context), engine.FALSE, "earliest upload is the representative and is not itself flagged as redundant");
  assert.equal(engine.evaluateRule(records[1], detailMap.get("20"), duplicate, Date.now(), context), engine.TRUE, "later upload is the redundant duplicate");
  assert.equal(engine.evaluateRule(records[1], detailMap.get("20"), { ...duplicate, polarity: "exclude" }, Date.now(), context), engine.FALSE, "Exclude hides the redundant copy");
  assert.equal(engine.evaluateRule(records[0], detailMap.get("10"), { ...duplicate, polarity: "exclude" }, Date.now(), context), engine.TRUE, "Exclude keeps the representative");
});

test("Duplicate representative ties fall back to shortest title and stable video ID", () => {
  const { filterEngine: engine } = runtime();
  const records = [
    { videoId: "3", title: "A considerably longer title", durationSec: 40 },
    { videoId: "2", title: "Short", durationSec: 40 }
  ];
  const detailMap = new Map([["3", details()], ["2", details()]]);
  const duplicate = rule("duplicates", { options: { matchingDuration: true } });
  const context = engine.createEvaluationContext(records, detailMap);
  assert.equal(engine.evaluateRule(records[0], detailMap.get("3"), duplicate, Date.now(), context), engine.TRUE);
  assert.equal(engine.evaluateRule(records[1], detailMap.get("2"), duplicate, Date.now(), context), engine.FALSE);
});

test("Matching title words ignores bracketed tag/artist fragments and supports a configurable minimum", () => {
  const { filterEngine: engine } = runtime();
  assert.deepEqual([...engine.titleWords("【Cianyo】 [z1g3d] {kizu} (3D) Cinematic Clothed Scene")], ["cinematic", "clothed", "scene"]);

  const records = [
    { videoId: "1", title: "【Cianyo】 (3D) Cinematic Clothed Scene", durationSec: 60 },
    { videoId: "2", title: "[z1g3d] {kizu} cinematic clothed alternate", durationSec: 60 }
  ];
  const detailMap = new Map([
    ["1", details({ exactUploadDate: "2025-01-01" })],
    ["2", details({ exactUploadDate: "2025-02-01" })]
  ]);
  const context = engine.createEvaluationContext(records, detailMap);
  const twoWords = rule("duplicates", { options: { matchingDuration: true, matchingTitleWords: true, matchingTitleWordCount: 2 } });
  const threeWords = rule("duplicates", { options: { matchingDuration: true, matchingTitleWords: true, matchingTitleWordCount: 3 } });
  assert.equal(engine.evaluateRule(records[1], detailMap.get("2"), twoWords, Date.now(), context), engine.TRUE);
  assert.equal(engine.evaluateRule(records[1], detailMap.get("2"), threeWords, Date.now(), engine.createEvaluationContext(records, detailMap)), engine.FALSE);
});

test("Duplicates returns UNKNOWN when an enabled detail criterion is unavailable", () => {
  const { filterEngine: engine } = runtime();
  const records = [{ videoId: "1", title: "A", durationSec: 10 }, { videoId: "2", title: "A", durationSec: 10 }];
  const missingFormats = details({ formats: [] });
  const detailMap = new Map([["1", missingFormats], ["2", missingFormats]]);
  const qualityRule = rule("duplicates", { options: { matchingDuration: true, matchingQuality: true } });
  assert.equal(engine.evaluateRule(records[0], missingFormats, qualityRule, Date.now(), engine.createEvaluationContext(records, detailMap)), engine.UNKNOWN);
});
