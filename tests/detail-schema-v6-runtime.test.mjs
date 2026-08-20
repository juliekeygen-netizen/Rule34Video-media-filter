import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

function context(seed = {}) {
  const value = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, Object, Array, URL, DOMException, AbortController, Promise, ...seed };
  value.globalThis = value;
  vm.createContext(value);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), value, { filename: "src/shared/namespace.js" });
  return value;
}

function load(env, file) {
  vm.runInContext(readFileSync(file, "utf8"), env, { filename: file });
  return env.R34MF.modules;
}

function parserRuntime() {
  const env = context();
  load(env, "src/shared/rule34video-video-url.js");
  load(env, "src/catalogue/detail-parser.js");
  load(env, "src/catalogue/detail-parser-v6.js");
  return env.R34MF.modules.detailParser;
}

function realTopologyPage() {
  return `<!doctype html><html><head>
    <link rel="canonical" href="https://rule34video.com/video/3143712/rainy-day-lewdfroggo/">
    <script type="application/ld+json">{"@type":"VideoObject","url":"https://rule34video.com/video/3143712/rainy-day-lewdfroggo/","description":"desc"}</script>
  </head><body>
    <div id="video_view" data-video-id="3143712"><div id="kt_player">player only</div></div>
    <section class="real-info-panel">
      <div class="col js-video-suggestion-wrap" data-video-id="3143712" data-suggest-type="category">
        <div class="label">Categories</div>
        <span data-video-id="3143712" data-item-type="category" data-status="normal"><a class="item btn_link video_meta_pill" href="https://rule34video.com/categories/2d/"><span>2D</span></a></span>
      </div>
      <div class="col js-video-suggestion-wrap" data-video-id="3143712" data-suggest-type="model">
        <div class="label">Artist</div>
        <span data-video-id="3143712" data-item-type="model" data-status="hardened"><a class="item btn_link video_meta_pill" href="https://rule34video.com/models/lewdfroggo/"><span class="name">LewdFroggo</span></a></span>
      </div>
      <div class="col">
        <div class="label">Uploaded by</div>
        <a class="item btn_link video_meta_pill" href="https://rule34video.com/members/98965/">Oppai3Dporn</a>
      </div>
      <div class="wrap js-video-suggestion-wrap is-tags-collapsible" data-video-id="3143712" data-suggest-type="tag" data-tag-visible-limit="22">
        <div class="label">Tags</div>
        <span data-video-id="3143712" data-item-type="tag" data-status="hardened"><a class="tag_item" href="https://rule34video.com/tags/22/">blowjob</a></span>
        <span class="is-tag-overflow-hidden" data-video-id="3143712" data-item-type="tag" data-status="normal"><a class="tag_item" href="https://rule34video.com/tags/61/">deepthroat</a></span>
        <span class="tag_vote_chip tag_suggestion_chip" data-video-id="3143712" data-item-type="tag" data-status="pending"><span class="tag_item tag_suggestion_item">male focus</span></span>
        <button type="button" class="tag_item tag_item_load_more js-video-tags-load-more">Load more (17)</button>
        <a class="js-open-suggest tag_item tag_item_suggest" href="#">+ | Suggest</a>
      </div>
      <div class="wrap">
        <div class="label">Download</div>
        <a class="tag_item tag_item_download" href="https://rule34video.com/get_file/x/3143712_2160p.mp4/?acctoken=secret">MP4 2160p</a>
        <a class="tag_item tag_item_download" href="https://rule34video.com/get_file/x/3143712_1080p.webm/?acctoken=secret">WEBM 1080p</a>
      </div>
    </section>
    <aside>
      <a href="/models/jackerman/">1 Jackerman 85%</a>
      <a href="/models/derpixon/">2 Derpixon 86%</a>
      <a href="/categories/101-dalmatians/">1 101 dalmatians 14</a>
      <a href="/categories/">All Categories</a>
      <a href="/tags/sidebar/">TAGS</a>
    </aside>
  </body></html>`;
}

test("schema 6 parses current-video entity metadata when the info panel is outside the player root", () => {
  const parser = parserRuntime();
  const document = parseHTML(realTopologyPage()).document;
  const result = parser.parseDocument(document, {
    expectedVideoId: "3143712",
    url: "https://rule34video.com/video/3143712/rainy-day-lewdfroggo/"
  });

  assert.equal(result.ok, true);
  assert.equal(result.record.schemaVersion, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(result.record.entityTrust)), { artist: true, uploader: true, tags: true, categories: true });
  assert.deepEqual([...result.record.artists], ["LewdFroggo"]);
  assert.deepEqual([...result.record.uploaders], ["Oppai3Dporn"]);
  assert.deepEqual([...result.record.categories], ["2D"]);
  assert.deepEqual([...result.record.tags], ["blowjob", "deepthroat"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.record.formats)), [
    { format: "mp4", resolution: "2160p" },
    { format: "webm", resolution: "1080p" }
  ]);
  assert.doesNotMatch(JSON.stringify(result.record), /acctoken|Jackerman|Derpixon|All Categories|male focus/i);
  assert.equal(result.diagnostics.metadataRegionFound, true);
});

test("schema 6 treats verified empty independently from unknown fields", () => {
  const parser = parserRuntime();
  const document = parseHTML(`<!doctype html><html><head><link rel="canonical" href="https://rule34video.com/video/8/example/"></head><body>
    <div id="video_view" data-video-id="8"></div>
    <section class="real-info-panel">
      <div class="wrap js-video-suggestion-wrap" data-video-id="8" data-suggest-type="tag"><div class="label">Tags</div><button class="tag_item_load_more">Load more</button></div>
      <div class="col"><div class="label">Uploaded by</div><a href="https://rule34video.com/members/8/">Uploader Eight</a></div>
    </section>
  </body></html>`).document;
  const result = parser.parseDocument(document, { expectedVideoId: "8", url: "https://rule34video.com/video/8/example/" });

  assert.equal(result.ok, true);
  assert.equal(result.record.schemaVersion, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(result.record.entityTrust)), { artist: false, uploader: true, tags: true, categories: false });
  assert.deepEqual([...result.record.tags], []);
  assert.deepEqual([...result.record.uploaders], ["Uploader Eight"]);
});

test("schema 6 keeps a changed populated entity structure UNKNOWN instead of trusting it as empty", () => {
  const parser = parserRuntime();
  const document = parseHTML(`<!doctype html><html><head><link rel="canonical" href="https://rule34video.com/video/81/example/"></head><body>
    <div id="video_view" data-video-id="81"></div>
    <section class="real-info-panel">
      <div class="wrap js-video-suggestion-wrap" data-video-id="81" data-suggest-type="tag">
        <div class="label">Tags</div>
        <span data-video-id="81" data-item-type="tag"><span class="changed-tag-markup">animated</span></span>
      </div>
      <div class="col js-video-suggestion-wrap" data-video-id="81" data-suggest-type="model">
        <div class="label">Artist</div>
        <span data-video-id="81" data-item-type="model"><a href="https://rule34video.com/models/artist-81/"><span class="name">Artist 81</span></a></span>
      </div>
    </section>
  </body></html>`).document;
  const result = parser.parseDocument(document, { expectedVideoId: "81", url: "https://rule34video.com/video/81/example/" });

  assert.equal(result.ok, true);
  assert.equal(result.record.schemaVersion, 6);
  assert.equal(result.record.entityTrust.artist, true);
  assert.equal(result.record.entityTrust.tags, false);
  assert.deepEqual([...result.record.tags], []);
  assert.equal(result.diagnostics.entityMalformedItems.tag, 1);
});

test("entity-blind successful-looking pages become structural failures before bulk can accept them", () => {
  const parser = parserRuntime();
  const document = parseHTML(`<!doctype html><html><head>
    <link rel="canonical" href="https://rule34video.com/video/9/example/">
    <script type="application/ld+json">{"@type":"VideoObject","url":"https://rule34video.com/video/9/example/","description":"valid detail body"}</script>
  </head><body><div id="video_view" data-video-id="9"><div id="kt_player"></div></div></body></html>`).document;
  const result = parser.parseDocument(document, { expectedVideoId: "9", url: "https://rule34video.com/video/9/example/" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unexpected-detail-structure");
  assert.equal(result.diagnostics.entityStructureVerified, false);
});

test("schema 6 maintenance makes schema-5 completed rows repairable without touching schema-6 rows", () => {
  const env = context();
  env.R34MF.modules.db = {};
  env.R34MF.modules.createDetailScanner = () => ({ run: async () => ({}), stop() {} });
  load(env, "src/jobs/detail-maintenance.js");
  load(env, "src/jobs/detail-operation-lifecycle.js");
  const maintenance = load(env, "src/jobs/detail-schema-v6-maintenance.js").detailMaintenance;
  const records = ["legacy", "broken-v5", "current-v6", "failed"].map((videoId) => ({ videoId }));
  const details = new Map([
    ["legacy", { videoId: "legacy", status: "complete", schemaVersion: 3 }],
    ["broken-v5", { videoId: "broken-v5", status: "complete", schemaVersion: 5, entityTrust: { artist: false, uploader: false, tags: false, categories: false } }],
    ["current-v6", { videoId: "current-v6", status: "complete", schemaVersion: 6, entityTrust: { artist: true } }],
    ["failed", { videoId: "failed", status: "failed", schemaVersion: 5 }]
  ]);

  assert.equal(maintenance.CURRENT_DETAIL_SCHEMA, 6);
  assert.deepEqual(Array.from(maintenance.selectTargetsFromSource(records, details, "outdated"), (row) => row.videoId), ["legacy", "broken-v5"]);
});

test("schema 6 runtime layers are loaded before their consumers and retry UI exposes the real 100 ceiling", () => {
  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.equal(scripts.indexOf("src/catalogue/detail-parser-v6.js"), scripts.indexOf("src/catalogue/detail-parser.js") + 1);
  assert.ok(scripts.indexOf("src/catalogue/detail-parser-v6.js") < scripts.indexOf("src/catalogue/detail-scanner.js"));
  assert.equal(scripts.indexOf("src/jobs/detail-schema-v6-maintenance.js"), scripts.indexOf("src/jobs/detail-operation-lifecycle.js") + 1);
  assert.ok(scripts.indexOf("src/jobs/detail-schema-v6-maintenance.js") < scripts.indexOf("src/content/maintenance-controller.js"));

  assert.equal(scripts.indexOf("src/ui/settings-retry-cap.js"), scripts.indexOf("src/ui/settings.js") + 1);
  const retryCapSource = readFileSync("src/ui/settings-retry-cap.js", "utf8");
  assert.match(retryCapSource, /input\.max = "100"/);
  const queueStateSource = readFileSync("src/ui/queue/queue-maintenance-state.js", "utf8");
  assert.match(queueStateSource, /"detail-retry-failed-refreshes": "refreshFailed"/);
});
