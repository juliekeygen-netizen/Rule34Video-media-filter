import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const read = (path) => readFileSync(path, "utf8");

function filterRuntime() {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, URLSearchParams, Object, Array };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    "src/shared/namespace.js",
    "src/shared/upload-date.js",
    "src/filters/filter-engine.js",
    "src/filters/filter-quality.js",
    "src/filters/filter-duplicates.js",
    "src/filters/filter-favorites.js",
    "src/filters/filter-seen.js"
  ]) vm.runInContext(read(file), context, { filename: file });
  return context.R34MF.modules;
}

function detail({ artist = "Artist A", categories = ["2D"], tags = ["one", "two"], date = "2026-01-01" } = {}) {
  return {
    status: "complete",
    schemaVersion: 6,
    entityTrust: { artist: true, uploader: true, tags: true, categories: true },
    artists: [artist],
    artistRefs: [{ key: artist.toLocaleLowerCase().replace(/\s+/g, "-"), name: artist, url: `https://rule34video.com/models/${artist.toLocaleLowerCase().replace(/\s+/g, "-")}/` }],
    categories,
    tags,
    exactUploadDate: date,
    formats: [{ format: "mp4", resolution: "1080p" }]
  };
}

function advancedRule(field, extra = {}) {
  return { id: `rule-${field}`, kind: "rule", enabled: true, connector: null, field, polarity: "match", ...extra };
}

test("Quick fields remove HD, add Favorited before Hide seen, and Categories precede Tags everywhere", () => {
  const { filterEngine: engine } = filterRuntime();
  assert.deepEqual([...engine.QUICK_FIELDS], ["title", "duration", "views", "rating", "ratingVotes", "favorited", "hideSeenVideos"]);
  assert.equal(engine.ALL_FIELDS.includes("hdAvailable"), true, "HD remains Advanced-selectable");
  assert.ok(engine.ALL_FIELDS.indexOf("favorited") < engine.ALL_FIELDS.indexOf("seenVideos"));
  assert.ok(engine.DETAILED_FIELDS.indexOf("categories") < engine.DETAILED_FIELDS.indexOf("tags"));
  assert.ok(engine.ALL_FIELDS.indexOf("categories") < engine.ALL_FIELDS.indexOf("tags"));
});

test("Favorited supports Quick filtering and Advanced Match/Exclude from the shared local-state context", () => {
  const { filterEngine: engine } = filterRuntime();
  const favorited = { status: "complete", ids: new Set(["1"]) };
  const seen = { status: "complete", ids: new Set() };
  const records = [{ videoId: "1", title: "One" }, { videoId: "2", title: "Two" }];
  const context = engine.createEvaluationContext(records, new Map(), { favorited, seen });

  const quick = engine.createEmpty();
  quick.quick.favorited.enabled = true;
  assert.equal(engine.evaluate(records[0], null, quick, Date.now(), context), engine.TRUE);
  assert.equal(engine.evaluate(records[1], null, quick, Date.now(), context), engine.FALSE);

  const match = engine.createEmpty();
  match.advanced = { enabled: true, items: [advancedRule("favorited")] };
  assert.equal(engine.evaluate(records[0], null, match, Date.now(), context), engine.TRUE);
  assert.equal(engine.evaluate(records[1], null, match, Date.now(), context), engine.FALSE);
  match.advanced.items[0].polarity = "exclude";
  assert.equal(engine.evaluate(records[0], null, match, Date.now(), context), engine.FALSE);
  assert.equal(engine.evaluate(records[1], null, match, Date.now(), context), engine.TRUE);
});

test("Duplicates supports allowed duration difference and minimum shared tag count", () => {
  const { filterEngine: engine } = filterRuntime();
  const records = [
    { videoId: "1", title: "Original", durationSec: 100 },
    { videoId: "2", title: "Copy", durationSec: 102 }
  ];
  const details = new Map([
    ["1", detail({ tags: ["one", "two", "alpha"], date: "2026-01-01" })],
    ["2", detail({ tags: ["one", "two", "beta"], date: "2026-02-01" })]
  ]);
  const oneSecond = advancedRule("duplicates", { options: { matchingDuration: true, matchingDurationSecDifference: 1 } });
  const twoSeconds = advancedRule("duplicates", { options: { matchingDuration: true, matchingDurationSecDifference: 2 } });
  assert.equal(engine.evaluateRule(records[1], details.get("2"), oneSecond, Date.now(), engine.createEvaluationContext(records, details)), engine.FALSE);
  assert.equal(engine.evaluateRule(records[1], details.get("2"), twoSeconds, Date.now(), engine.createEvaluationContext(records, details)), engine.TRUE);

  const twoTags = advancedRule("duplicates", { options: { matchingDuration: false, matchingTag: true, matchingTagCount: 2 } });
  const threeTags = advancedRule("duplicates", { options: { matchingDuration: false, matchingTag: true, matchingTagCount: 3 } });
  assert.equal(engine.evaluateRule(records[1], details.get("2"), twoTags, Date.now(), engine.createEvaluationContext(records, details)), engine.TRUE);
  assert.equal(engine.evaluateRule(records[1], details.get("2"), threeTags, Date.now(), engine.createEvaluationContext(records, details)), engine.FALSE);
});

test("entity vocabulary counts and ordering follow the active filters while omitting the edited facet itself", () => {
  const modules = filterRuntime();
  const engine = modules.filterEngine;
  const filters = engine.createEmpty();
  filters.detailed.categories.enabled = true;
  filters.detailed.categories.value = ["2D"];
  filters.detailed.categories.matchMode = "any";
  modules.filterState = { active: () => ({ filters }) };
  modules.subscriptionMembership = { evaluationContext: () => ({ status: "complete", keys: new Set(), names: new Set() }) };
  modules.seenStore = { evaluationContext: () => ({ status: "complete", ids: new Set(), updatedAt: 1 }) };
  modules.favoriteStore = { evaluationContext: () => ({ status: "complete", ids: new Set(), updatedAt: 1 }) };

  const context = vm.createContext({ console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, URLSearchParams, Object, Array, globalThis: null, R34MF: { modules } });
  context.globalThis = context;
  context.R34MF = { modules };
  vm.runInContext(read("src/filters/vocabulary-cache.js"), context, { filename: "src/filters/vocabulary-cache.js" });
  const finalEngine = context.R34MF.modules.filterEngine;
  const records = [{ videoId: "1" }, { videoId: "2" }, { videoId: "3" }];
  const details = new Map([
    ["1", detail({ artist: "Artist A", categories: ["2D"] })],
    ["2", detail({ artist: "Artist A", categories: ["2D"] })],
    ["3", detail({ artist: "Artist B", categories: ["3D"] })]
  ]);
  const artists = finalEngine.vocabulary(records, details, "artist");
  assert.equal(JSON.stringify(artists.values.map(({ value, count }) => [value, count])), JSON.stringify([["Artist A", 2]]));

  const categories = finalEngine.vocabulary(records, details, "categories");
  assert.equal(JSON.stringify(categories.values.map(({ value, count }) => [value, count])), JSON.stringify([["2D", 2], ["3D", 1]]), "editing Categories ignores only the Categories facet so alternate values remain selectable");
});

test("native Favorites state is parsed from Add/Remove controls and detail parsing synchronizes it", async () => {
  const state = {};
  const listeners = [];
  const app = {
    modules: {
      constants: { storageKeys: { favoriteVideos: "fav" } },
      browserApi: {
        storageLocal: { async get() { return { fav: state.fav }; }, async set(value) { Object.assign(state, value); } },
        storage: { onChanged: { addListener(fn) { listeners.push(fn); } } }
      }
    }
  };
  const context = vm.createContext({ R34MF: app, globalThis: null, Date, JSON, Set, Object, String, Number });
  context.globalThis = context;
  vm.runInContext(read("src/storage/favorite-store.js"), context, { filename: "src/storage/favorite-store.js" });
  const store = app.modules.favoriteStore;
  const add = parseHTML(`<div class="btn-favourites"><ul><li id="delete_fav_0" class="hidden"><a href="#delete" class="delete button_fav" data-video-id="1" data-fav-type="0">Remove from Favorites</a></li><li id="add_fav_0"><a class="button_fav" href="#add_to_fav" data-video-id="1" data-fav-type="0">Add to Favorites</a></li></ul></div>`).document;
  const remove = parseHTML(`<div class="btn-favourites"><ul><li id="delete_fav_0"><a href="#delete" class="delete button_fav" data-video-id="1" data-fav-type="0">Remove from Favorites</a></li><li id="add_fav_0" class="hidden"><a class="button_fav" href="#add_to_fav" data-video-id="1" data-fav-type="0">Add to Favorites</a></li></ul></div>`).document;
  assert.equal(store.nativeState(add), false);
  assert.equal(store.nativeState(remove), true);
  await store.syncFromDocument("1", remove);
  assert.equal(await store.has("1"), true);
  await store.syncFromDocument("1", add);
  assert.equal(await store.has("1"), false);
});

test("Part 2 settings defaults, thumbnail labels, automatic-sign-in return, and page preservation are wired", () => {
  const manifest = JSON.parse(read("manifests/base.json"));
  const runtime = manifest.content_scripts.find((entry) => entry.js?.includes("src/content/main.js"));
  const subscriptionsStyles = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/local-grid-artist-labels.css"));
  const auth = manifest.content_scripts.find((entry) => entry.js?.includes("src/auth/auto-signin.js"));
  assert.ok(subscriptionsStyles.css.includes("src/ui/local-grid-artist-labels.css"));
  assert.ok(runtime.js.includes("src/ui/local-grid-artist-labels.js"));
  assert.ok(runtime.js.indexOf("src/ui/settings-draft-bridge.js") < runtime.js.indexOf("src/ui/settings.js"));
  assert.ok(runtime.js.indexOf("src/ui/settings-p2-ui.js") > runtime.js.indexOf("src/ui/settings.js"));
  assert.ok(runtime.js.indexOf("src/catalogue/favorite-detail-parser.js") < runtime.js.indexOf("src/catalogue/detail-scanner.js"));
  assert.ok(runtime.js.includes("src/content/video-page-favorite-sync.js"));
  assert.ok(auth.js.includes("src/auth/auto-signin-return.js"));

  const settings = read("src/storage/settings.js");
  assert.match(settings, /artistThumbnailLabels:\s*true/);
  assert.match(settings, /openSubscriptionsAfterAutomaticSignIn:\s*false/);
  const settingsUi = read("src/ui/settings-p2-ui.js");
  assert.match(settingsUi, /Artist label\/s on video thumbnails/);
  assert.match(settingsUi, /Open my subscriptions on automatic sign in/);

  const artistCss = read("src/ui/local-grid-artist-labels.css");
  assert.match(artistCss, /top:\s*6px/);
  assert.match(artistCss, /left:\s*6px/);
  assert.match(artistCss, /gap:\s*6px/);
  assert.match(artistCss, /padding:\s*2px 5px/);
  assert.match(artistCss, /font-size:\s*11px/);
  assert.match(artistCss, /font-weight:\s*700/);
  assert.match(artistCss, /background:\s*rgba\(20, 27, 32, \.85\)/);
  assert.match(read("src/ui/local-grid-artist-labels.js"), /`\+\$\{hidden\}`/);

  const pagePreservation = read("src/content/filter-page-preservation.js");
  assert.doesNotMatch(pagePreservation, /localPage:\s*1/);
  assert.doesNotMatch(read("src/content/filter-ui-hooks.js"), /localPage:\s*1/);
  assert.match(read("src/auth/auto-signin-return.js"), /\/my\/subscriptions\//);
});
