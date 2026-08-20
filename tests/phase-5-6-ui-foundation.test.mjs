import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadFilterEngine() {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), context, { filename: "src/shared/namespace.js" });
  vm.runInContext(readFileSync("src/filters/filter-engine.js", "utf8"), context, { filename: "src/filters/filter-engine.js" });
  return context.R34MF.modules.filterEngine;
}

test("normal detailed Artist/Uploader filters migrate to exact multi-select Any/All semantics", () => {
  const f = loadFilterEngine();
  const video = { videoId: "one" };
  const details = { status: "complete", schemaVersion: 5, entityTrust: { artist: true, uploader: true }, artist: "Foo Bar", artists: ["Foo Bar", "Second Artist"], uploader: "Alice Example" };
  let filters = f.createEmpty();
  filters.detailed.artist = { enabled: true, value: { operator: "is", value: "Foo", options: {} } };
  assert.equal(f.evaluate(video, details, filters), f.FALSE);
  filters.detailed.artist = { enabled: true, value: ["foo bar", "missing"], matchMode: "any" };
  assert.equal(f.evaluate(video, details, filters), f.TRUE);
  filters.detailed.artist.matchMode = "all";
  assert.equal(f.evaluate(video, details, filters), f.FALSE);
  filters.detailed.artist.value = ["Foo Bar", "Second Artist"];
  assert.equal(f.evaluate(video, details, filters), f.TRUE);
  filters = f.createEmpty();
  filters.detailed.uploader = { enabled: true, value: ["Alice Example"], matchMode: "any" };
  assert.equal(f.evaluate(video, details, filters), f.TRUE);
});

test("normal Views and Rating votes filters accept compact K/M/B values", () => {
  const f = loadFilterEngine();
  let filters = f.createEmpty();
  filters.quick.views = { enabled: true, value: { operator: "gte", value: "10K", valueTo: "" } };
  assert.equal(f.evaluate({ videoId: "one", views: 12500 }, null, filters), f.TRUE);
  assert.equal(f.evaluate({ videoId: "two", views: 9000 }, null, filters), f.FALSE);
  filters = f.createEmpty();
  filters.quick.ratingVotes = { enabled: true, value: { operator: "gte", value: "1.5K", valueTo: "" } };
  assert.equal(f.evaluate({ videoId: "one", ratingVotes: 2000 }, null, filters), f.TRUE);
});

test("configured normal filters require a real value instead of only an operator", () => {
  const f = loadFilterEngine();
  const emptyText = f.normalize({ quick: { title: { enabled: true, value: { operator: "contains", value: "", options: {} } } } });
  assert.equal(emptyText.quick.title.enabled, false);
  const emptyBetween = f.normalize({ quick: { views: { enabled: true, value: { operator: "between", value: "10K", valueTo: "" } } } });
  assert.equal(emptyBetween.quick.views.enabled, false);
  const valid = f.normalize({ quick: { views: { enabled: true, value: { operator: "gte", value: "10K", valueTo: "" } } } });
  assert.equal(valid.quick.views.enabled, true);
});

test("Filters parent keeps one mounted surface and patches state instead of recreating it on modal close", () => {
  const source = readFileSync("src/ui/filters.js", "utf8");
  assert.match(source, /function patchParent\(/);
  assert.match(source, /data-filter-surface='parent'/);
  assert.match(source, /r34mf-filter-row-main/);
  assert.match(source, /--r34mf-filter-popover-width/);
  assert.doesNotMatch(source, /host\.replaceChildren\(parent\(state\)\)/);
});

test("normal filter modals expose readable conditions and never render redundant Clear controls", () => {
  const source = readFileSync("src/ui/filter-modals.js", "utf8");
  const polish = readFileSync("src/ui/filter-modal-polish.js", "utf8");
  assert.match(source, /Greater than or equal to/);
  assert.match(source, /Less than or equal to/);
  assert.match(source, /\+ New preset/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.doesNotMatch(source, /button\("Clear", "clear"\)/);
  assert.doesNotMatch(polish, /\[data-modal-action='clear'\]/);
  assert.match(source, /type === "presets"/);
  assert.match(source, /event\.target === layer/);
});

test("entity picker separates neutral search results from selected values and supports pointer-drag scrolling", () => {
  const source = readFileSync("src/ui/entity-picker.js", "utf8");
  assert.match(source, /SELECTED/);
  assert.match(source, /RESULTS/);
  assert.match(source, /pointerdown/);
  assert.match(source, /pointermove/);
  assert.match(source, /aria-selected/);
  assert.doesNotMatch(source, /classList\.add\("is-selected"\)/);
});

test("date control uses the shared SVG chevron language and reports typed date changes", () => {
  const source = readFileSync("src/ui/date-control.js", "utf8");
  assert.match(source, /createElementNS/);
  assert.match(source, /r34mf-date-chevron/);
  assert.match(source, /dispatchEvent\(new Event\("change"/);
  assert.doesNotMatch(source, /"⌄"/);
});

test("filter-specific CSS layers load after shared styles and final responsive corrections load last", () => {
  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const styles = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/styles.css"));
  assert.deepEqual(styles.css, ["src/ui/styles.css", "src/ui/local-grid-artist-labels.css", "src/ui/filters.css", "src/ui/filters-polish.css", "src/ui/filter-parent-minimal.css", "src/ui/advanced-filter.css", "src/ui/advanced-filter-followup.css", "src/ui/settings.css", "src/ui/cloud-sync.css", "src/ui/cloud-sync-followup.css", "src/ui/mobile.css", "src/ui/mobile-followup.css", "src/ui/filter-layout-followup.css"]);
  const css = readFileSync("src/ui/filters.css", "utf8");
  const polish = readFileSync("src/ui/filters-polish.css", "utf8");
  const mobile = readFileSync("src/ui/mobile.css", "utf8");
  const mobileFollowup = readFileSync("src/ui/mobile-followup.css", "utf8");
  const layoutFollowup = readFileSync("src/ui/filter-layout-followup.css", "utf8");
  assert.match(css, /--r34mf-filter-popover-width/);
  assert.match(css, /\.r34mf-filter-row[\s\S]*background:\s*var\(--r34mf-control\)/);
  assert.match(css, /\.r34mf-filter-row-main/);
  assert.match(polish, /--r34mf-sort-popover-width/);
  assert.match(polish, /\.r34mf-preset-menu[\s\S]*position:\s*fixed/);
  assert.match(mobile, /100dvh/);
  assert.match(mobile, /safe-area-inset-bottom/);
  assert.match(mobileFollowup, /place-items:\s*center\s*!important/);
  assert.match(mobileFollowup, /\.r34mf-advanced-actions[\s\S]*position:\s*static\s*!important/);
  assert.match(layoutFollowup, /\.r34mf-filter-columns[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
});

test("filter modal lifecycle hooks preserve the parent popover and keep preset management modal-backed", () => {
  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const scripts = manifest.content_scripts[0].js;
  const controllerIndex = scripts.indexOf("src/content/subscriptions-controller.js");
  const hooksIndex = scripts.indexOf("src/content/filter-ui-hooks.js");
  const mainIndex = scripts.indexOf("src/content/main.js");
  assert.ok(controllerIndex >= 0 && hooksIndex > controllerIndex && mainIndex > hooksIndex);
  const hooks = readFileSync("src/content/filter-ui-hooks.js", "utf8");
  assert.match(hooks, /this\.filterModal/);
  assert.match(hooks, /r34mf-modal-layer/);
  assert.match(hooks, /filterModal = \{ type: "presets" \}/);
  assert.match(hooks, /preset-duplicate:/);
  assert.match(hooks, /preset-delete:/);
});