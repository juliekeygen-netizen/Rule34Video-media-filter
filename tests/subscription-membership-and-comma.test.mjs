import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { DOMParser, parseHTML } from "linkedom";

function runFiles(files, seed = {}) {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, URLSearchParams, DOMException, AbortController, ...seed };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of files) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return context;
}

function membershipHtml({ page = 1, total = 5, members = [], parameters = ["01", "02", "03", "02"] } = {}) {
  return `<!doctype html><html><body>
    <div id="list_members_subscriptions_my_subscriptions">
      <h2 class="title">My Subscriptions <span class="total_results">(${total})</span><span class="current_page">Page ${page}</span></h2>
      <div id="list_members_subscriptions_my_subscriptions_items">
        ${members.map(([slug, name]) => `<div class="item"><input id="delete_${slug}"><a class="title wrap-item" href="/models/${slug}/"><span class="name">${name}</span></a><button>Unsubscribe</button></div>`).join("")}
        <div class="item"><a href="/video/99/unrelated/">Unrelated video</a></div>
      </div>
      <div id="list_members_subscriptions_my_subscriptions_pagination">
        ${parameters.map((value, index) => `<span class="item${Number(value) === page && index < 3 ? " active" : ""}"><a data-block-id="list_members_subscriptions_my_subscriptions" data-parameters="sort_by:added_date;from_my_subscriptions:${value}">${index === 3 ? "Next" : Number(value)}</a></span>`).join("")}
        <a data-block-id="list_members_subscriptions_my_subscriptions" data-parameters="sort_by:added_date;from_my_subscriptions:$from">Jump</a>
      </div>
    </div></body></html>`;
}

function membershipItemsFragment(members = [], extra = "") {
  return `<div id="list_members_subscriptions_my_subscriptions_items">${members.map(([slug, name]) => `<div class="item"><a href="/models/${slug}/"><span class="name">${name}</span></a></div>`).join("")}</div>${extra}`;
}

function membershipRuntime(extra = {}) {
  const storage = new Map();
  const context = runFiles(["src/shared/namespace.js", "src/shared/constants.js"], {
    DOMParser,
    location: { origin: "https://rule34video.com", href: "https://rule34video.com/my/subscriptions/" },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setTimeout, clearTimeout,
    ...extra
  });
  context.R34MF.modules.requestScheduler = { runWithPolicy: ({ request, signal }) => request({ signal }) };
  vm.runInContext(readFileSync("src/catalogue/subscription-membership.js", "utf8"), context, { filename: "src/catalogue/subscription-membership.js" });
  return { context, module: context.R34MF.modules.subscriptionMembership, storage };
}

test("native My Subscriptions parser extracts only canonical models and bounded page targets", () => {
  const membership = membershipRuntime().module;
  const document = parseHTML(membershipHtml({
    page: 2,
    total: 5,
    members: [["z1g3d", "Z1g3d"], ["rinhee", "Rinhee"], ["blobcg", "Blobcg"], ["tosaka-chicken-farm", "Tosaka Chicken Farm"], ["nagoonimation", "Nagoonimation"]]
  })).document;
  const parsed = membership.parseDocument(document);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.currentPage, 2);
  assert.equal(parsed.pageCount, 3);
  assert.deepEqual([...parsed.pageTargets], [1, 2, 3]);
  assert.deepEqual([...parsed.values].map((item) => item.key), ["z1g3d", "rinhee", "blobcg", "tosaka-chicken-farm", "nagoonimation"]);
  assert.equal(parsed.values.some((item) => /unsubscribe/i.test(item.name)), false);
  const url = new URL(membership.buildPageUrl(parsed, 3));
  assert.equal(url.pathname, "/my/subscriptions/");
  assert.equal(url.searchParams.get("block_id"), membership.BLOCK_ID);
  assert.equal(url.searchParams.get("from_my_subscriptions"), "03");
  assert.equal(url.searchParams.get("sort_by"), "added_date");
});
test("membership sync fetches each remaining native page sequentially and commits only an exact total", async () => {
  const pages = {
    2: membershipHtml({ page: 2, members: [["blobcg", "Blobcg"], ["tosaka-chicken-farm", "Tosaka Chicken Farm"]] }),
    3: membershipHtml({ page: 3, members: [["nagoonimation", "Nagoonimation"]] })
  };
  const calls = [];
  const { module: membership } = membershipRuntime({
    fetch: async (url) => {
      const page = Number(new URL(url).searchParams.get("from_my_subscriptions"));
      calls.push(page);
      return { ok: true, status: 200, url, text: async () => pages[page] };
    }
  });
  const visible = parseHTML(membershipHtml({ page: 1, members: [["z1g3d", "Z1g3d"], ["rinhee", "Rinhee"]] })).document;
  const result = await membership.refresh({ documentLike: visible, force: true });
  assert.deepEqual(calls, [2, 3]);
  assert.equal(result.snapshot.status, "complete");
  assert.equal(result.snapshot.total, 5);
  assert.equal(result.snapshot.sourcePageCount, 3);

  pages[3] = membershipHtml({ page: 3, total: 5, members: [] });
  await membership.refresh({ documentLike: visible, force: true });
  const retained = membership.publicState();
  assert.equal(retained.status, "failed");
  assert.equal(retained.snapshot.total, 5);
  assert.equal(retained.stale, true);
});

test("membership sync reuses verified page-one pagination for fragment-only subsequent pages", async () => {
  const pages = { 2: membershipItemsFragment([["c", "C"], ["duplicate", "Duplicate"]], '<a href="/models/sidebar/">Sidebar</a>'), 3: membershipItemsFragment([["d", "D"]]) };
  const { module: membership } = membershipRuntime({ fetch: async (url) => {
    const page = Number(new URL(url).searchParams.get("from_my_subscriptions"));
    return { ok: true, status: 200, url, text: async () => pages[page] };
  } });
  const first = parseHTML(membershipHtml({ total: 4, members: [["a", "A"], ["duplicate", "Duplicate"]] })).document;
  const result = await membership.refresh({ documentLike: first, force: true });
  assert.equal(result.snapshot.status, "complete");
  assert.deepEqual([...result.snapshot.values].map((value) => value.key), ["a", "c", "d", "duplicate"]);
});

test("membership refresh falls back to a verified authenticated page one when the live block is late", async () => {
  const requests = [];
  const { module: membership } = membershipRuntime({ fetch: async (url) => {
    requests.push(url);
    return { ok: true, status: 200, url: "https://rule34video.com/my/subscriptions/", text: async () => membershipHtml({ total: 1, members: [["fallback", "Fallback"]], parameters: ["01"] }) };
  } });
  const result = await membership.refresh({ documentLike: parseHTML("<!doctype html><html><body></body></html>").document, force: true });
  assert.equal(requests.length, 1);
  assert.equal(result.status, "complete");
  assert.deepEqual([...result.snapshot.values].map((value) => value.key), ["fallback"]);
});

test("membership fallback rejects redirects and login documents without replacing a complete snapshot", async () => {
  const live = parseHTML(membershipHtml({ total: 1, members: [["kept", "Kept"]], parameters: ["01"] })).document;
  let fallback = false;
  const { module: membership } = membershipRuntime({ fetch: async (url) => fallback
    ? { ok: true, status: 200, url: "https://rule34video.com/login/", text: async () => "<html><body>Login</body></html>" }
    : { ok: true, status: 200, url, text: async () => membershipHtml({ total: 1, members: [["fetched", "Fetched"]], parameters: ["01"] }) }
  });
  await membership.refresh({ documentLike: live, force: true });
  fallback = true;
  await membership.refresh({ documentLike: parseHTML("<!doctype html><html><body></body></html>").document, force: true });
  const state = membership.publicState();
  assert.equal(state.status, "failed");
  assert.equal(state.stale, true);
  assert.deepEqual([...state.snapshot.values].map((value) => value.key), ["kept"]);
});

test("membership attach discovers a native block inserted after extension mount", async () => {
  class TestMutationObserver {
    static instances = [];
    constructor(callback) { this.callback = callback; TestMutationObserver.instances.push(this); }
    observe() {}
    disconnect() {}
  }
  const { module: membership } = membershipRuntime({ MutationObserver: TestMutationObserver, fetch: async () => { throw new Error("fallback should not run"); } });
  const documentLike = parseHTML("<!doctype html><html><body></body></html>").document;
  membership.attach(documentLike);
  documentLike.body.innerHTML = membershipHtml({ total: 1, members: [["late", "Late"]], parameters: ["01"] });
  TestMutationObserver.instances[0].callback([{ type: "childList", target: documentLike.body }]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(membership.publicState().status, "complete");
  assert.deepEqual([...membership.publicState().snapshot.values].map((value) => value.key), ["late"]);
  membership.detach();
});

function filtersRuntime() {
  return runFiles(["src/shared/namespace.js", "src/filters/filter-engine.js", "src/filters/filter-draft.js"]);
}

test("Subscriptions only shares tri-state artist-intersection semantics across normal and Advanced", () => {
  const engine = filtersRuntime().R34MF.modules.filterEngine;
  const membership = { status: "complete", keys: new Set(["a", "c"]), names: new Set(["a", "c"]) };
  const details = (artists) => ({ status: "complete", schemaVersion: 5, entityTrust: { artist: true }, artists });
  assert.equal(engine.evaluateSubscriptionMembership(details(["A"]), membership, false), engine.TRUE);
  assert.equal(engine.evaluateSubscriptionMembership(details(["B"]), membership, false), engine.FALSE);
  assert.equal(engine.evaluateSubscriptionMembership(details(["B", "C"]), membership, false), engine.TRUE);
  assert.equal(engine.evaluateSubscriptionMembership(null, membership, false), engine.UNKNOWN);
  assert.equal(engine.evaluateSubscriptionMembership(null, membership, true), engine.TRUE);
  assert.equal(engine.evaluateSubscriptionMembership(details([]), membership, true), engine.FALSE);
  assert.equal(engine.evaluateSubscriptionMembership({ status: "complete", schemaVersion: 5, entityTrust: { artist: true }, artist: "A" }, membership, false), engine.TRUE);
  assert.equal(engine.evaluateSubscriptionMembership({ status: "complete", schemaVersion: 5, entityTrust: { artist: true }, artists: ["Renamed artist"], artistRefs: [{ key: "c" }] }, membership, false), engine.TRUE);
  assert.equal(engine.evaluateSubscriptionMembership(details(["A"]), { status: "unavailable" }, false), engine.UNKNOWN);

  const rule = { enabled: true, field: "subscriptionsOnly", polarity: "match", options: { includeWithoutDetails: false } };
  assert.equal(engine.evaluateRule({}, details(["A"]), rule, Date.now(), { membership }), engine.TRUE);
  assert.equal(engine.evaluateRule({}, details(["B"]), rule, Date.now(), { membership }), engine.FALSE);
  rule.polarity = "exclude";
  assert.equal(engine.evaluateRule({}, details(["A"]), rule, Date.now(), { membership }), engine.FALSE);
  assert.equal(engine.evaluateRule({}, details(["B"]), rule, Date.now(), { membership }), engine.TRUE);
  assert.equal(engine.evaluateRule({}, null, rule, Date.now(), { membership }), engine.UNKNOWN);
  rule.options.includeWithoutDetails = true;
  assert.equal(engine.evaluateRule({}, null, rule, Date.now(), { membership }), engine.FALSE);
});

test("Separate by commas composes with Contains options and preserves entity boundaries", () => {
  const { filterEngine: engine, filterDraft: drafts } = filtersRuntime().R34MF.modules;
  const rule = { enabled: true, field: "title", operator: "contains", value: " cat,  red fox ,, dog, ", options: { separateByCommas: true } };
  assert.deepEqual([...engine.commaTerms(rule.value)], ["cat", "red fox", "dog"]);
  assert.equal(engine.evaluateRule({ title: "red fox animation" }, null, rule), engine.TRUE);
  rule.value = "cat, dog";
  assert.equal(engine.evaluateRule({ title: "red fox animation" }, null, rule), engine.FALSE);
  rule.value = "RED FOX, dog";
  rule.options.caseSensitive = true;
  assert.equal(engine.evaluateRule({ title: "red fox animation" }, null, rule), engine.FALSE);
  rule.options.caseSensitive = false;
  rule.options.wholeWord = true;
  rule.value = "fox, dog";
  assert.equal(engine.evaluateRule({ title: "foxglove red fox" }, null, rule), engine.TRUE);
  rule.options.matchAnyWord = true;
  rule.value = "green bird, blue cat";
  assert.equal(engine.evaluateRule({ title: "a blue animation" }, null, rule), engine.TRUE);

  const description = { ...rule, field: "description", value: "missing, second phrase", options: { separateByCommas: true } };
  assert.equal(engine.evaluateRule({}, { status: "complete", description: "the second phrase appears" }, description), engine.TRUE);
  const artist = { ...rule, field: "artist", value: "foo, artist b", options: { separateByCommas: true } };
  assert.equal(engine.evaluateRule({}, { status: "complete", schemaVersion: 5, entityTrust: { artist: true }, artists: ["Artist A", "Artist B"] }, artist), engine.TRUE);
  const uploader = { ...artist, field: "uploader", value: "none, uploader b" };
  assert.equal(engine.evaluateRule({}, { status: "complete", schemaVersion: 5, entityTrust: { uploader: true }, uploaders: ["Uploader A", "Uploader B"] }, uploader), engine.TRUE);

  const empty = { ...rule, value: ", ,   ,", options: { separateByCommas: true } };
  assert.equal(engine.validateRule(empty).valid, false);
  assert.equal(engine.normalizeRule(empty).enabled, false);
  assert.equal(engine.textOptionKeys("contains").includes("separateByCommas"), true);
  assert.equal(engine.textOptionKeys("startsWith").includes("separateByCommas"), false);
  assert.equal(drafts.changeRuleOperator({ ...rule, options: { separateByCommas: true } }, "startsWith").options.separateByCommas, undefined);
  const regex = engine.normalizeRule({ ...rule, operator: "regex", value: "a,b", options: { separateByCommas: true } });
  assert.equal(regex.options.separateByCommas, undefined);
  assert.match(drafts.formatRule({ ...rule, value: "catgirl, foxgirl, bunny girl" }), /contains any of "catgirl", "foxgirl", "bunny girl"/);
});

test("preset and backup normalization preserve membership configs but expose no live snapshot key", () => {
  const chrome = { runtime: {}, storage: { local: { get: async () => ({}), set: async () => {} } } };
  const context = runFiles([
    "src/shared/namespace.js", "src/shared/constants.js", "src/shared/browser-api.js", "src/shared/rule34video-video-url.js",
    "src/storage/settings.js", "src/storage/ui-state.js", "src/storage/db.js", "src/filters/filter-engine.js", "src/storage/backup-schema.js"
  ], { chrome, indexedDB: {}, IDBKeyRange: {}, crypto: { randomUUID: () => "id" } });
  const schema = context.R34MF.modules.backupSchema;
  const filters = context.R34MF.modules.filterEngine.createEmpty();
  filters.detailed.subscriptionsOnly = { enabled: true, value: { options: { includeWithoutDetails: true } } };
  filters.advanced = { enabled: true, items: [{ id: "sub-rule", kind: "rule", enabled: true, connector: null, field: "subscriptionsOnly", polarity: "exclude", options: { includeWithoutDetails: false } }] };
  const storageLiteral = JSON.stringify({ filterState: { version: 1, activePresetId: "p", presets: [{ id: "p", name: "Membership", filters }] } });
  const storage = vm.runInContext(`R34MF.modules.backupSchema.normalizeStorage(${storageLiteral})`, context);
  const restored = storage.filterState.presets[0].filters;
  assert.equal(restored.detailed.subscriptionsOnly.enabled, true);
  assert.equal(restored.detailed.subscriptionsOnly.value.options.includeWithoutDetails, true);
  assert.equal(restored.advanced.items[0].field, "subscriptionsOnly");
  assert.equal(restored.advanced.items[0].polarity, "exclude");
  assert.equal(restored.advanced.items[0].options.includeWithoutDetails, false);
  assert.equal(Object.hasOwn(storage, "currentSubscriptions"), false);
});

test("visible Filters toolbar label is count-free while chips and internal count remain", () => {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  window.console = console;
  const context = vm.createContext(window);
  for (const file of ["src/shared/namespace.js", "src/ui/shell.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const filters = { quick: { title: { enabled: true } }, detailed: { subscriptionsOnly: { enabled: true } }, advanced: { enabled: false, items: [] } };
  const shell = context.R34MF.modules.shell.render({ mode: "local", filterCount: 5, canFilter: true, canSort: true, filters, catalogue: { hasCatalogue: true, indexedCount: 10 } });
  assert.equal(shell.querySelector("[data-r34mf-action='filters']").textContent, "Filters");
  assert.equal(context.R34MF.modules.shell.deriveState({ mode: "local", filterCount: 5 }).filterCount, 5);
  assert.match(shell.querySelector(".r34mf-active-filter-chips").textContent, /Subscriptions only/);
});

test("normal and Advanced editors expose membership and comma controls only in their supported contexts", () => {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  window.console = console;
  window.queueMicrotask = queueMicrotask;
  window.innerWidth = 1280;
  window.innerHeight = 900;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 132, left: 100, right: 260, width: 160, height: 32 });
  const context = vm.createContext(window);
  for (const file of [
    "src/shared/namespace.js", "src/filters/filter-engine.js", "src/filters/filter-draft.js", "src/ui/date-control.js",
    "src/ui/entity-picker.js", "src/ui/filters.js", "src/ui/advanced-filter-editor.js", "src/ui/filter-modals.js"
  ]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const app = context.R34MF;
  app.modules.filterState = { active: () => ({ filters: app.modules.filterEngine.createEmpty() }) };
  const root = document.createElement("div");
  root.dataset.r34mfRoot = "subscriptions";
  document.body.append(root);
  const filters = app.modules.filterEngine.createEmpty();
  app.modules.filtersUi.render({ root, filters, preset: { name: "Default" } }, () => {});
  const detailedLabels = [...root.querySelectorAll("[data-filter-source='detailed'] .r34mf-filter-row-label")].map((node) => node.textContent);
  assert.deepEqual(detailedLabels, ["Upload date", "Artist", "Uploader", "Tags", "Categories", "Subscriptions only"]);

  app.modules.filterModals.render({ root, filters, membership: { status: "failed", snapshot: null }, modal: { type: "normal", source: "detailed", field: "subscriptionsOnly", draft: filters.detailed.subscriptionsOnly.value } }, () => {});
  assert.match(root.querySelector(".r34mf-modal-subscriptions").textContent, /Include videos without details/);
  assert.doesNotMatch(root.querySelector(".r34mf-modal-subscriptions").textContent, /Could not refresh subscriptions/);

  const advancedFilters = app.modules.filterEngine.createEmpty();
  advancedFilters.advanced = { enabled: true, items: [{ id: "title-rule", kind: "rule", enabled: true, connector: null, field: "title", polarity: "match", operator: "contains", value: "a,b", options: {} }] };
  app.modules.filterModals.render({ root, filters: advancedFilters, modal: { type: "advanced", draft: advancedFilters.advanced } }, () => {});
  assert.match(root.querySelector(".r34mf-modal-advanced").textContent, /Separate by commas/);
  const membershipFilters = app.modules.filterEngine.createEmpty();
  membershipFilters.advanced = { enabled: true, items: [{ id: "membership-rule", kind: "rule", enabled: true, connector: null, field: "subscriptionsOnly", polarity: "match", options: { includeWithoutDetails: true } }] };
  app.modules.filterModals.render({ root, filters: membershipFilters, modal: { type: "advanced", draft: membershipFilters.advanced } }, () => {});
  assert.equal(root.querySelector("[data-advanced-id='membership-rule']").classList.contains("is-membership"), true);
  assert.match(root.querySelector("[data-advanced-id='membership-rule'] .r34mf-advanced-value").textContent, /Include videos without details/);
});
