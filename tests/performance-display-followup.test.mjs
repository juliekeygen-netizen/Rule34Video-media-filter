import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(path, "utf8");

test("filter UI performance patch skips catalogue vocabulary for parent and non-entity surfaces", () => {
  const manifest = JSON.parse(read("manifests/base.json"));
  const scripts = manifest.content_scripts[0].js;
  const localContext = scripts.indexOf("src/content/local-filter-context.js");
  const performance = scripts.indexOf("src/content/filter-vocabulary-performance.js");
  const seen = scripts.indexOf("src/content/seen-filter-controller.js");
  assert.ok(localContext >= 0 && performance > localContext && seen > performance);

  const source = read("src/content/filter-vocabulary-performance.js");
  assert.match(source, /requiredVocabularyFields/);
  assert.match(source, /if \(fields\.length\)/);
  assert.match(source, /modal\?\.type === "normal" && ENTITY_SET\.has\(modal\.field\)/);
  assert.match(source, /modal\?\.type === "advanced"/);
  assert.doesNotMatch(source, /\["tags", "categories", "artist", "uploader"\]\.forEach/);
});

test("catalogue evaluation prepares filters once and vocabulary scans reuse the prepared path", () => {
  const manifest = JSON.parse(read("manifests/base.json"));
  const scripts = manifest.content_scripts[0].js;
  const uploadDate = scripts.indexOf("src/filters/upload-date-integration.js");
  const prepared = scripts.indexOf("src/filters/filter-evaluation-performance.js");
  const vocabulary = scripts.indexOf("src/filters/vocabulary-cache.js");
  assert.ok(uploadDate >= 0 && prepared > uploadDate && vocabulary > prepared);

  const preparedSource = read("src/filters/filter-evaluation-performance.js");
  assert.match(preparedSource, /function prepareEvaluation/);
  assert.match(preparedSource, /function evaluatePrepared/);
  assert.match(preparedSource, /engine\.evaluateSimple\(video, details, prepared, currentNow, context\)/);

  const favoriteSource = read("src/filters/filter-favorites.js");
  assert.match(favoriteSource, /filters\?\.quick\?\.\[FIELD\] !== undefined/);

  const vocabularySource = read("src/filters/vocabulary-cache.js");
  assert.match(vocabularySource, /engine\.prepareEvaluation\?\.\(filters\)/);
  assert.match(vocabularySource, /engine\.evaluatePrepared \?\? engine\.evaluate/);
});

test("faceted vocabulary keeps bounded caches and reuses identical filtered subsets", () => {
  const source = read("src/filters/vocabulary-cache.js");
  assert.match(source, /filtered: new Map\(\)/);
  assert.match(source, /contexts: new Map\(\)/);
  assert.match(source, /function filteredRecords/);
  assert.match(source, /filterPasses \+= 1/);
  assert.doesNotMatch(source, /entry\.faceted\.clear\(\)/);
});

test("Local filter refresh yields to the browser and does not block the filter interaction task", () => {
  const local = read("src/content/local-filter-context.js");
  assert.match(local, /EVALUATION_SLICE_MS = 12/);
  assert.match(local, /await yieldToBrowser\(\)/);
  assert.match(local, /engine\.prepareEvaluation\?\./);
  assert.match(local, /engine\.evaluatePrepared \?\? engine\.evaluate/);

  const preservation = read("src/content/filter-page-preservation.js");
  assert.match(preservation, /function scheduleLocalRefresh/);
  assert.match(preservation, /setTimeout\?\.\([\s\S]*instance\.renderLocal\?\.\(\)/);
  assert.doesNotMatch(preservation, /await this\.setUiState\(\{ localPage: this\.state\.localPage \}\)/);

  const stability = read("src/content/filter-modal-stability-controller.js");
  assert.match(stability, /filterPagePreservation\?\.scheduleLocalRefresh/);
});

test("Local grid and Artist labels reuse the controller's already-loaded detail map", () => {
  const localGrid = read("src/ui/local-grid.js");
  assert.match(localGrid, /records = null, detailsById = null/);
  assert.match(localGrid, /resolvedDetailsById = detailsById \?\? source\?\.detailsById/);
  assert.match(localGrid, /!source && !detailsById && currentRecords\.length/);
  assert.match(localGrid, /detailsById: resolvedDetailsById/);

  const context = read("src/content/local-filter-context.js");
  assert.match(context, /detailsById: source\.detailsById/);

  const labels = read("src/ui/local-grid-artist-labels.js");
  assert.match(labels, /suppliedDetailsById/);
  assert.match(labels, /options\.detailsById \?\? result\?\.detailsById/);
});

test("Duplicates keeps the requested two-row order, tiny amount fields, and explicit hover help", () => {
  const source = read("src/ui/advanced-filter-field-additions.js");
  assert.match(source, /\["matchingDuration", "matchingCategory", "matchingTag"\]/);
  assert.match(source, /\["matchingTitleWords", "matchingQuality"\]/);
  assert.match(source, /r34mf-duplicate-row/);
  assert.match(source, /Second difference for flag/);
  assert.match(source, /Amount of tags to flag/);
  assert.match(source, /Amount of words to flag/);
  assert.match(source, /pointerenter/);
  assert.match(source, /role", "tooltip/);
  assert.doesNotMatch(source, /placeholder:\s*"Sec diff"/);
  assert.doesNotMatch(source, /placeholder:\s*"Amount of"/);

  const css = read("src/ui/advanced-filter-followup.css");
  assert.match(css, /\.r34mf-duplicate-options[\s\S]*display:\s*grid/);
  assert.match(css, /\.r34mf-duplicate-row[\s\S]*flex-wrap:\s*nowrap/);
  assert.match(css, /\.r34mf-duplicate-amount[\s\S]*width:\s*34px/);
  assert.match(css, /\.r34mf-duplicate-amount[\s\S]*font:\s*500 10px\/1 var\(--r34mf-font\) !important/);
  assert.match(css, /\.r34mf-duplicate-help[\s\S]*position:\s*fixed/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

test("phone Filters use a wide two-column parent and phone modals stay content-sized", () => {
  const filters = read("src/ui/filters.js");
  assert.match(filters, /r34mf-filter-columns/);
  assert.match(filters, /r34mf-filter-column-quick/);
  assert.match(filters, /r34mf-filter-column-detailed/);

  const css = read("src/ui/mobile-followup.css");
  assert.match(css, /\.r34mf-tool-layer[\s\S]*width:\s*calc\(100% - 12px\)\s*!important/);
  assert.match(css, /\.r34mf-filter-columns[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.r34mf-modal-layer[\s\S]*place-items:\s*center\s*!important/);
  assert.match(css, /\.r34mf-modal\s*\{[\s\S]*height:\s*auto\s*!important/);
  assert.doesNotMatch(css, /\.r34mf-modal-layer[\s\S]{0,180}align-items:\s*stretch/);
});

test("phone Advanced rules use full-width editors and Add Rule/Add Group no longer float", () => {
  const css = read("src/ui/mobile-followup.css");
  assert.match(css, /grid-template-areas:[\s\S]*"drag check logic field menu"[\s\S]*"polarity polarity polarity polarity polarity"[\s\S]*"condition condition condition condition condition"[\s\S]*"value value value value value"/);
  assert.match(css, /\.r34mf-rule-secondary[\s\S]*padding-left:\s*0\s*!important/);
  assert.match(css, /\.r34mf-rule-error[\s\S]*margin:\s*7px 0 0\s*!important/);
  assert.match(css, /\.r34mf-advanced-actions[\s\S]*position:\s*static\s*!important/);
  assert.match(css, /\.r34mf-advanced-actions[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.r34mf-advanced-date-range[\s\S]*flex-wrap:\s*wrap/);
});

test("native mobile host churn reuses the same extension root instead of resetting open UI", () => {
  const manifest = JSON.parse(read("manifests/base.json"));
  const runtimeContent = manifest.content_scripts.find((entry) => entry.js?.includes("src/content/main.js"));
  const styleContent = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/styles.css"));
  assert.ok(styleContent.css.indexOf("src/ui/mobile-followup.css") > styleContent.css.indexOf("src/ui/mobile.css"));
  const runtime = runtimeContent.js.indexOf("src/content/mobile-runtime-stability-controller.js");
  const modalStability = runtimeContent.js.indexOf("src/content/filter-modal-stability-controller.js");
  const main = runtimeContent.js.indexOf("src/content/main.js");
  assert.ok(runtime > modalStability && main > runtime);

  const source = read("src/content/mobile-runtime-stability-controller.js");
  assert.match(source, /fastInsertionPointIsCurrent/);
  assert.match(source, /rememberedRoot/);
  assert.match(source, /root === rememberedRoot && root\.isConnected !== true/);
  assert.match(source, /insertBefore\(root, parts\.grid\)/);
  assert.match(source, /refreshLocal:\s*!\(recoveringRememberedRoot && hadLocalHost\)/);
  assert.match(source, /if \(refreshLocal \|\| !existingLocal\) this\.renderLocal\?\.\(\)/);
});

test("Artist thumbnail label size normalizes to Small, Medium, or Big with Medium default", () => {
  const app = {
    modules: {
      constants: { storageKeys: { settings: "settings" } },
      browserApi: {
        storageLocal: { async get() { return {}; }, async set() {} },
        storage: { onChanged: { addListener() {} } }
      }
    }
  };
  const context = vm.createContext({ R34MF: app, globalThis: null, Object, Number, String, Math, Set, Map });
  context.globalThis = context;
  vm.runInContext(read("src/storage/settings.js"), context, { filename: "src/storage/settings.js" });
  const settings = app.modules.settings;
  assert.deepEqual([...settings.ARTIST_THUMBNAIL_LABEL_SIZES], ["small", "medium", "big"]);
  assert.equal(settings.normalize({}).artistThumbnailLabelSize, "medium");
  assert.equal(settings.normalize({ artistThumbnailLabelSize: "big" }).artistThumbnailLabelSize, "big");
  assert.equal(settings.normalize({ artistThumbnailLabelSize: "invalid" }).artistThumbnailLabelSize, "medium");

  const ui = read("src/ui/settings-p2-ui.js");
  assert.match(ui, /Artist label text size/);
  assert.match(ui, /Medium — Default/);
  assert.doesNotMatch(ui, /Medium \(Recommended\)/);
  assert.match(ui, /\["small", "Small"\]/);
  assert.match(ui, /\["big", "Big"\]/);
});

test("Artist label rendering applies size classes while Medium preserves the current 11px size", () => {
  const js = read("src/ui/local-grid-artist-labels.js");
  const css = read("src/ui/local-grid-artist-labels.css");
  assert.match(js, /is-size-\$\{size\}/);
  assert.match(css, /is-size-small[\s\S]*10px/);
  assert.match(css, /is-size-medium[\s\S]*11px/);
  assert.match(css, /is-size-big[\s\S]*13px/);
  assert.match(css, /font-size:\s*var\(--r34mf-artist-label-font-size\)/);
});
