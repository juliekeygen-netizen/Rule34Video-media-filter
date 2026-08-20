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
    "src/filters/filter-seen.js",
    "src/filters/upload-date-integration.js"
  ]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return context.R34MF.modules.filterEngine;
}

const video = (id) => ({ videoId: String(id), title: `Video ${id}`, durationSec: 10 });
const context = (...ids) => ({ seen: { status: "complete", ids: new Set(ids.map(String)) } });

test("Hide seen videos is Quick-only while Seen videos is an Advanced boolean field", () => {
  const engine = runtime();
  const filters = engine.createEmpty();
  assert.equal(filters.quick.hideSeenVideos.enabled, false);
  assert.equal(engine.QUICK_FIELDS.includes("hideSeenVideos"), true);
  assert.equal(engine.ALL_FIELDS.includes("hideSeenVideos"), false);
  assert.equal(engine.ALL_FIELDS.includes("seenVideos"), true);
  assert.equal(engine.FIELD_DEFINITIONS.seenVideos.editor, "boolean");
  assert.ok(engine.ALL_FIELDS.indexOf("seenVideos") > engine.ALL_FIELDS.indexOf("hdAvailable"));
  assert.ok(engine.ALL_FIELDS.indexOf("seenVideos") < engine.ALL_FIELDS.indexOf("uploadDate"));
});

test("Hide seen videos removes marked IDs but keeps unmarked videos", () => {
  const engine = runtime();
  const filters = engine.createEmpty();
  filters.quick.hideSeenVideos.enabled = true;
  assert.equal(engine.evaluate(video(1), null, filters, Date.now(), context(1)), engine.FALSE);
  assert.equal(engine.evaluate(video(2), null, filters, Date.now(), context(1)), engine.TRUE);
});

test("Advanced Seen videos supports Match and Exclude with no extra condition", () => {
  const engine = runtime();
  const make = (polarity) => ({
    ...engine.createEmpty(),
    advanced: { enabled: true, items: [{ id: "seen", kind: "rule", enabled: true, connector: null, field: "seenVideos", polarity }] }
  });
  assert.equal(engine.evaluate(video(1), null, make("match"), Date.now(), context(1)), engine.TRUE);
  assert.equal(engine.evaluate(video(2), null, make("match"), Date.now(), context(1)), engine.FALSE);
  assert.equal(engine.evaluate(video(1), null, make("exclude"), Date.now(), context(1)), engine.FALSE);
  assert.equal(engine.evaluate(video(2), null, make("exclude"), Date.now(), context(1)), engine.TRUE);
});

test("Seen filters normalize through presets and Disable all", () => {
  const engine = runtime();
  const normalized = engine.normalize({
    quick: { hideSeenVideos: { enabled: true } },
    advanced: { enabled: true, items: [{ id: "seen", kind: "rule", enabled: true, field: "seenVideos", polarity: "exclude" }] }
  });
  assert.equal(normalized.quick.hideSeenVideos.enabled, true);
  assert.equal(normalized.advanced.items[0].field, "seenVideos");
  assert.equal(engine.countApplied(normalized), 2);
  const disabled = engine.disableAll(normalized);
  assert.equal(disabled.quick.hideSeenVideos.enabled, false);
  assert.equal(disabled.advanced.enabled, false);
});
