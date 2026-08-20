import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const runtimeFiles = [
  "src/shared/namespace.js",
  "src/shared/upload-date.js",
  "src/filters/filter-engine.js",
  "src/filters/filter-quality.js",
  "src/filters/filter-duplicates.js",
  "src/filters/filter-favorites.js",
  "src/filters/filter-seen.js",
  "src/filters/filter-draft.js",
  "src/filters/filter-advanced-draft.js",
  "src/ui/date-control.js",
  "src/ui/entity-picker.js",
  "src/ui/filters.js",
  "src/ui/advanced-filter-editor.js",
  "src/ui/advanced-filter-field-additions.js",
  "src/ui/filter-modals.js",
  "src/ui/filter-wording-polish.js"
];

function env() {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  window.console = console;
  window.queueMicrotask = queueMicrotask;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.innerWidth = 1280;
  window.innerHeight = 900;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 136, left: 100, right: 320, width: 220, height: 36 });
  const context = vm.createContext(window);
  for (const file of runtimeFiles) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const root = document.createElement("div");
  root.dataset.r34mfRoot = "subscriptions";
  document.body.append(root);
  return { window, document, root, app: context.R34MF };
}

function renderAdvanced(environment, item) {
  const filters = environment.app.modules.filterEngine.createEmpty();
  filters.advanced = { enabled: true, items: [item] };
  return environment.app.modules.filterModals.render({ root: environment.root, filters, coverage: { detailed: 10, total: 10 }, vocabulary: {}, modal: { type: "advanced", draft: filters.advanced, enableOnApply: false } }, () => {});
}

function selectValue(window, control, value) {
  for (const option of control.options) option.selected = option.value === value;
  control.dispatchEvent(new window.Event("change", { bubbles: true }));
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

test("Any word wording and four two-row text options are exposed for normal and Advanced text Contains modes", async () => {
  const e = env();
  const title = e.app.modules.filterDraft.defaultRule("title");
  title.value = "animation";
  let layer = renderAdvanced(e, title);
  await flush();
  let labels = [...layer.querySelectorAll(".r34mf-check-label span")].map((node) => node.textContent.trim());
  assert.ok(labels.includes("Any word"));
  assert.ok(labels.includes("Separate by commas"));
  assert.equal(layer.textContent.includes("Match any word"), false);

  e.app.modules.filterModals.render({ root: e.root, filters: e.app.modules.filterEngine.createEmpty(), modal: null }, () => {});
  layer = e.app.modules.filterModals.render({ root: e.root, filters: e.app.modules.filterEngine.createEmpty(), modal: { type: "normal", source: "quick", field: "title", draft: { operator: "contains", value: "animation", options: {} } } }, () => {});
  await flush();
  labels = [...layer.querySelectorAll(".r34mf-text-options .r34mf-check-label span")].map((node) => node.textContent.trim());
  assert.deepEqual(labels, ["Case sensitive", "Exact word / phrase", "Any word", "Separate by commas"]);
});

test("Advanced Quality, Favorited and Seen videos are selectable in the requested field ordering", async () => {
  const e = env();
  let layer = renderAdvanced(e, e.app.modules.filterDraft.defaultRule("title"));
  const fieldOptions = [...layer.querySelector("select[aria-label='Rule field']").options].map((option) => option.value);
  assert.ok(fieldOptions.includes("quality"));
  assert.ok(fieldOptions.includes("favorited"));
  assert.ok(fieldOptions.includes("seenVideos"));
  assert.ok(fieldOptions.indexOf("favorited") < fieldOptions.indexOf("seenVideos"));
  assert.ok(fieldOptions.indexOf("seenVideos") < fieldOptions.indexOf("uploadDate"));
  assert.ok(fieldOptions.indexOf("categories") < fieldOptions.indexOf("tags"));

  e.app.modules.filterModals.render({ root: e.root, filters: e.app.modules.filterEngine.createEmpty(), modal: null }, () => {});
  layer = renderAdvanced(e, e.app.modules.filterDraft.defaultRule("quality"));
  await flush();
  assert.deepEqual([...layer.querySelector("select[aria-label='Quality condition']").options].map((option) => option.textContent), ["Equals", "Greater than", "Greater than or equal to", "Less than", "Less than or equal to"]);
  assert.deepEqual([...layer.querySelector("select[aria-label='Quality']").options].map((option) => option.value), ["2160p", "1080p", "720p", "480p", "360p"]);
});

test("Advanced Duplicates renders compact numeric fields for duration, tags, and title words", async () => {
  const e = env();
  const layer = renderAdvanced(e, e.app.modules.filterDraft.defaultRule("title"));
  selectValue(e.window, layer.querySelector("select[aria-label='Rule field']"), "duplicates");
  await flush();
  const labels = [...layer.querySelectorAll(".r34mf-duplicate-toggle span")].map((node) => node.textContent.trim());
  assert.deepEqual(labels, ["Matching duration", "Matching category", "Matching tag", "Matching words on title", "Matching quality"]);
  assert.deepEqual([...layer.querySelectorAll(".r34mf-duplicate-row")].map((row) => [...row.querySelectorAll(".r34mf-duplicate-toggle span")].map((node) => node.textContent.trim())), [
    ["Matching duration", "Matching category", "Matching tag"],
    ["Matching words on title", "Matching quality"]
  ]);
  assert.equal(labels.some((label) => /artist/i.test(label)), false);
  const amounts = [...layer.querySelectorAll(".r34mf-duplicate-amount")];
  assert.equal(amounts.length, 3);
  assert.deepEqual(amounts.map((node) => node.getAttribute("aria-label")), ["Allowed seconds difference", "Amount of matching tags", "Amount of matching words"]);
  assert.deepEqual(amounts.map((node) => node.getAttribute("placeholder")), [null, null, null]);
  assert.deepEqual({ ...e.app.modules.advancedFilterEditor.DUPLICATE_HELP }, {
    matchingDuration: "Second difference for flag",
    matchingTag: "Amount of tags to flag",
    matchingTitleWords: "Amount of words to flag"
  });
  amounts[2].value = "2e!5";
  amounts[2].dispatchEvent(new e.window.Event("input", { bubbles: true }));
  assert.equal(amounts[2].value, "25");
});

test("parent Filter UI has right-click toggle shortcut, Favorited/Hide seen toggle-only rows, and equal-gap checkbox offset", () => {
  const source = readFileSync("src/ui/filters.js", "utf8");
  const css = readFileSync("src/ui/advanced-filter-followup.css", "utf8");
  assert.match(source, /contextmenu/);
  assert.match(source, /favorited:\s*"Favorited"/);
  assert.match(source, /hideSeenVideos:\s*"Hide seen videos"/);
  assert.match(source, /toggleOnlyFields\s*=\s*new Set\(\["hdAvailable", "favorited", "hideSeenVideos"\]\)/);
  assert.match(css, /\.r34mf-filter-checkbox-cell\s*\{[\s\S]*padding-left:\s*4px/);
  assert.match(css, /\.r34mf-duplicate-amount\s*\{[\s\S]*width:\s*34px;[\s\S]*font:\s*500 10px\/1 var\(--r34mf-font\) !important/);
});

test("Advanced text options start under the value column and stay exactly two per row", () => {
  const css = readFileSync("src/ui/advanced-filter-followup.css", "utf8");
  assert.match(css, /\.r34mf-rule-secondary \.r34mf-text-options\s*\{[\s\S]*grid-column:\s*7;[\s\S]*grid-template-columns:\s*repeat\(2, max-content\)/);
  assert.match(css, /\.r34mf-group-add\s*\{[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;/);
});

test("manifest wires Favorites and Seen state into Local evaluation after Phase 10 hardening", () => {
  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("src/filters/filter-favorites.js") > scripts.indexOf("src/filters/filter-duplicates.js"));
  assert.ok(scripts.indexOf("src/filters/filter-seen.js") > scripts.indexOf("src/filters/filter-favorites.js"));
  assert.ok(scripts.indexOf("src/content/local-filter-context.js") > scripts.indexOf("src/content/phase10-hardening-controller.js"));
  assert.ok(scripts.indexOf("src/content/seen-filter-controller.js") > scripts.indexOf("src/content/local-filter-context.js"));
  const source = readFileSync("src/content/local-filter-context.js", "utf8");
  assert.match(source, /seenStore\?\.load/);
  assert.match(source, /favoriteStore\?\.load/);
  assert.match(source, /createEvaluationContext/);
});
