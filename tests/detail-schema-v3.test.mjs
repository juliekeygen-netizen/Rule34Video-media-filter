import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

function runtime() {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL };
  context.globalThis = context; vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/shared/rule34video-video-url.js", "src/catalogue/detail-parser.js", "src/filters/filter-engine.js", "src/jobs/detail-maintenance.js"]) {
    if (file.endsWith("detail-maintenance.js")) continue;
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  }
  return context.R34MF.modules;
}

function page() { return `<!doctype html><html><head><link rel="canonical" href="https://rule34video.com/video/3143712/example/"></head><body>
  <div id="video_view" data-video-id="3143712"><div class="info">
    <div class="col js-video-suggestion-wrap" data-video-id="3143712" data-suggest-type="model"><div class="label">Artist</div>${["LewdFroggo", "Artist Two", "Artist Three"].map((name, i) => `<span data-video-id="3143712" data-item-type="model"><a href="/models/a${i}/"><span class="name">${name}</span></a></span>`).join("")}</div>
    <div class="col js-video-suggestion-wrap" data-video-id="3143712" data-suggest-type="category"><div class="label">Categories</div><span data-video-id="3143712" data-item-type="category"><a href="/categories/2d/"><span>2D</span></a></span></div>
    <div class="wrap js-video-suggestion-wrap" data-video-id="3143712" data-suggest-type="tag"><div class="label">Tags</div><span data-video-id="3143712" data-item-type="tag"><a class="tag_item" href="/tags/22/">blowjob</a></span><span class="is-tag-overflow-hidden" data-video-id="3143712" data-item-type="tag"><a class="tag_item" href="/tags/23/">hidden genuine</a></span><span data-video-id="3143712" data-item-type="tag" data-status="pending"><span class="tag_item tag_suggestion_item">male focus</span></span><button class="tag_item_load_more">Load more (2)</button></div>
    <div class="col"><div class="label">Uploaded by</div><a href="/members/98965/">Oppai3Dporn</a></div>
    <div class="col"><div class="label">Download</div><a class="tag_item_download" href="/video/3143712/?download=1&amp;acctoken=secret">WEBM 1440p</a><a class="tag_item_download" href="/video/3143712/?download=1&amp;acctoken=secret">MP4 1080p</a></div>
  </div></div>
  <aside><a href="/models/jackerman/">1 Jackerman 85%</a><a href="/models/derpixon/">2 Derpixon 86%</a><a href="/categories/101-dalmatians/">1 101 dalmatians 14</a><a href="/categories/">All Categories</a><a href="/tags/something/">TAGS</a></aside>
</body></html>`; }

test("schema v5 parser scopes entity metadata to the current video and never persists download URLs", () => {
  const parser = runtime().detailParser;
  const result = parser.parseDocument(parseHTML(page()).document, { expectedVideoId: "3143712", url: "https://rule34video.com/video/3143712/example/" });
  assert.equal(result.ok, true);
  assert.equal(result.record.schemaVersion, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(result.record.entityTrust)), { artist: true, uploader: true, tags: true, categories: true });
  assert.deepEqual([...result.record.artists], ["LewdFroggo", "Artist Two", "Artist Three"]);
  assert.deepEqual([...result.record.categories], ["2D"]);
  assert.deepEqual([...result.record.tags], ["blowjob", "hidden genuine"]);
  assert.deepEqual([...result.record.uploaders], ["Oppai3Dporn"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.record.formats)), [{ format: "webm", resolution: "1440p" }, { format: "mp4", resolution: "1080p" }]);
  assert.doesNotMatch(JSON.stringify(result.record), /acctoken|All Categories|male focus/i);
});

test("trusted entity roots distinguish verified empty sections from structurally unrecognized metadata", () => {
  const parser = runtime().detailParser;
  const onlyArtist = parseHTML(`<!doctype html><html><head><link rel="canonical" href="https://rule34video.com/video/7/example/"></head><body>
    <main id="video_view" data-video-id="7"><section><div class="col js-video-suggestion-wrap" data-video-id="7" data-suggest-type="model"><span data-video-id="7" data-item-type="model"><a href="/models/artist-one/"><span class="name">Artist One</span></a></span></div></section><div class="col"><strong>Uploaded by:</strong><a href="/members/7/">Uploader One</a></div></main>
    <aside><a href="/models/sidebar/">Sidebar Artist</a><a href="/members/8/">Sidebar Uploader</a></aside></body></html>`).document;
  const artist = parser.parseDocument(onlyArtist, { expectedVideoId: "7" });
  assert.equal(artist.record.schemaVersion, 5);
  assert.deepEqual([...artist.record.artists], ["Artist One"]);
  assert.deepEqual([...artist.record.uploaders], ["Uploader One"]);
  assert.deepEqual([...artist.record.tags], []);
  assert.deepEqual([...artist.record.categories], []);
  assert.deepEqual(JSON.parse(JSON.stringify(artist.record.entityTrust)), { artist: true, uploader: true, tags: false, categories: false });

  const onlyTags = parseHTML(`<!doctype html><html><head><link rel="canonical" href="https://rule34video.com/video/8/example/"></head><body><main id="video_view" data-video-id="8"><div class="wrap js-video-suggestion-wrap" data-video-id="8" data-suggest-type="tag"><span data-video-id="8" data-item-type="tag"><a href="/tags/3d/"><span class="name">3D</span><span>99</span></a></span></div><div class="col js-video-suggestion-wrap" data-video-id="8" data-suggest-type="category"><span data-video-id="8" data-item-type="category"><a href="/categories/101-dalmatians/"><span data-entity-name>101 Dalmatians</span><span>179</span></a></span></div></main></body></html>`).document;
  const tags = parser.parseDocument(onlyTags, { expectedVideoId: "8" });
  assert.equal(tags.record.schemaVersion, 5);
  assert.deepEqual([...tags.record.artists], []);
  assert.deepEqual([...tags.record.tags], ["3D"]);
  assert.deepEqual([...tags.record.categories], ["101 Dalmatians"]);
  assert.deepEqual(JSON.parse(JSON.stringify(tags.record.entityTrust)), { artist: false, uploader: false, tags: true, categories: true });

  const unrecognized = parseHTML(`<!doctype html><html><head><link rel="canonical" href="https://rule34video.com/video/9/example/"></head><body><main id="video_view" data-video-id="9"><div class="col"><strong>Artist:</strong><a href="/models/not-verified/">Not verified</a></div></main></body></html>`).document;
  const uncertain = parser.parseDocument(unrecognized, { expectedVideoId: "9" });
  assert.equal(uncertain.record.schemaVersion, 5);
  assert.deepEqual([...uncertain.record.artists], []);
  assert.equal(uncertain.diagnostics.entityStructureVerified, false);
  assert.deepEqual(JSON.parse(JSON.stringify(uncertain.record.entityTrust)), { artist: false, uploader: false, tags: false, categories: false });
});

test("entity field trust keeps verified empty distinct from unknown and scopes vocabulary", () => {
  const { detailParser: parser, filterEngine: engine } = runtime();
  const emptyTags = parseHTML(`<!doctype html><html><head><link rel="canonical" href="https://rule34video.com/video/10/example/"></head><body><main id="video_view" data-video-id="10"><div class="wrap js-video-suggestion-wrap" data-video-id="10" data-suggest-type="tag"><button class="tag_item_load_more">Load more</button></div><div class="col"><strong>Uploaded by:</strong></div></main><aside><a href="/tags/sidebar/">sidebar tag</a></aside></body></html>`).document;
  const empty = parser.parseDocument(emptyTags, { expectedVideoId: "10" });
  assert.deepEqual(JSON.parse(JSON.stringify(empty.record.entityTrust)), { artist: false, uploader: true, tags: true, categories: false });
  assert.deepEqual([...empty.record.tags], []);
  assert.equal(engine.evaluateRule({}, empty.record, { enabled: true, field: "tags", value: "animated" }), engine.FALSE);
  assert.equal(engine.evaluateRule({}, empty.record, { enabled: true, field: "uploader", operator: "is", value: "Nobody" }), engine.FALSE);

  const unknown = { status: "complete", schemaVersion: 5, entityTrust: { artist: true, uploader: false, tags: false, categories: true }, artists: ["Artist One"], tags: [], categories: [] };
  assert.equal(engine.evaluateRule({}, unknown, { enabled: true, field: "tags", value: "sidebar tag" }), engine.UNKNOWN);
  const trustedEmptyArtist = { ...unknown, artists: [] };
  assert.equal(engine.evaluateRule({}, trustedEmptyArtist, { enabled: true, field: "artist", operator: "amountOf", value: "0", countComparator: "gt" }), engine.FALSE);
  assert.equal(engine.evaluateRule({}, { ...trustedEmptyArtist, entityTrust: { ...unknown.entityTrust, artist: false } }, { enabled: true, field: "artist", operator: "amountOf", value: "0", countComparator: "gt" }), engine.UNKNOWN);
  const vocabulary = engine.vocabulary([{ videoId: "a" }, { videoId: "b" }], new Map([
    ["a", unknown],
    ["b", { status: "complete", schemaVersion: 5, entityTrust: { artist: true, tags: true }, artists: ["Artist Two"], tags: ["trusted tag"] }]
  ]), "tags");
  assert.deepEqual(JSON.parse(JSON.stringify(vocabulary.values)), [{ value: "trusted tag", count: 1 }]);
  assert.equal(engine.vocabulary([{ videoId: "a" }], new Map([["a", unknown]]), "artist").values[0].value, "Artist One");
});
test("trusted entity rules keep legacy entity metadata UNKNOWN and exact phrases are Unicode-aware", () => {
  const engine = runtime().filterEngine;
  const legacy = { status: "complete", schemaVersion: 2, artists: ["Jackerman"] };
  const schema4 = { status: "complete", schemaVersion: 4, artists: ["Jackerman"] };
  const modern = { status: "complete", schemaVersion: 5, entityTrust: { artist: true }, artists: ["A", "A", "B"] };
  assert.equal(engine.evaluateRule({}, legacy, { enabled: true, field: "artist", operator: "is", value: "Jackerman" }), engine.UNKNOWN);
  assert.equal(engine.evaluateRule({}, schema4, { enabled: true, field: "artist", operator: "is", value: "Jackerman" }), engine.UNKNOWN);
  assert.equal(engine.evaluateRule({}, modern, { enabled: true, field: "artist", operator: "amountOf", value: "1", countComparator: "gt" }), engine.TRUE);
  const exact = { wholeWord: true };
  assert.equal(engine.textMatch?.("a quick edit of this video", "contains", "edit", exact) ?? engine.evaluateRule({ title: "a quick edit of this video" }, null, { enabled: true, field: "title", operator: "contains", value: "edit", options: exact }), engine.TRUE);
  assert.equal(engine.evaluateRule({ title: "currently editing" }, null, { enabled: true, field: "title", operator: "contains", value: "edit", options: exact }), engine.FALSE);
  assert.equal(engine.evaluateRule({ title: "(compilation collection)" }, null, { enabled: true, field: "title", operator: "contains", value: "compilation collection", options: exact }), engine.TRUE);
});
