import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadModules() {
  const context = { URL, console, setTimeout, clearTimeout, DOMException, crypto: globalThis.crypto };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    "src/shared/namespace.js",
    "src/shared/constants.js",
    "src/utils/url.js",
    "src/shared/rule34video-video-url.js",
    "src/catalogue/parsing.js",
    "src/jobs/request-scheduler.js",
    "src/catalogue/card-parser.js",
    "src/catalogue/feed-discovery.js",
    "src/storage/db.js",
    "src/catalogue/catalogue-reconciliation.js",
    "src/catalogue/catalogue-scanner.js",
    "src/ui/queue/queue-view-model.js"
  ]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return context.R34MF.modules;
}

function createFakeDom() {
  let activeElement = null;

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.attributes = {};
      this.listeners = new Map();
      this.style = {};
      this.disabled = false;
      this.scrollTop = 0;
      this._text = "";
      this.className = "";
      this.classList = {
        add: (...names) => { this.className = [...new Set(`${this.className} ${names.join(" ")}`.trim().split(/\s+/))].join(" "); }
      };
    }

    get firstChild() { return this.children[0] ?? null; }
    get childNodes() { return this.children; }
    get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join("")}`; }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) {
      for (const node of nodes) {
        if (node === null || node === undefined) continue;
        const child = typeof node === "string" ? Object.assign(new FakeElement("span"), { textContent: node }) : node;
        child.parentNode = this;
        this.children.push(child);
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    dispatchEvent(event) {
      event.target ??= this;
      event.currentTarget = this;
      for (const listener of this.listeners.get(event.type) ?? []) listener(event);
      if (this.parentNode && event.bubbles !== false) this.parentNode.dispatchEvent(event);
      return true;
    }
    focus() { activeElement = this; }
    contains(node) {
      return node === this || this.children.some((child) => child.contains(node));
    }
    closest(selector) {
      for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node;
      return null;
    }
    matches(selector) {
      const withoutDisabled = selector.includes(":not(:disabled)");
      if (withoutDisabled && this.disabled) return false;
      const action = selector.match(/\[data-r34mf-action(?:="([^"]+)")?\]/);
      if (action && (action[1] ? this.dataset.r34mfAction !== action[1] : !this.dataset.r34mfAction)) return false;
      const className = selector.match(/\.([\w-]+)/)?.[1];
      return !className || this.className.split(/\s+/).includes(className);
    }
    querySelector(selector) {
      if (selector.startsWith(":scope > .r34mf-queue-host")) {
        const host = this.children.find((child) => child.matches(".r34mf-queue-host"));
        return selector.includes(".r34mf-queue-panel") ? host?.querySelector(".r34mf-queue-panel") ?? null : host ?? null;
      }
      for (const child of this.children) {
        if (child.matches(selector)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
  }

  const document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
    get activeElement() { return activeElement; }
  };
  return { document, FakeElement };
}

function loadQueueDomModules() {
  const { document, FakeElement } = createFakeDom();
  const context = { console, document, Element: FakeElement };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    "src/shared/namespace.js",
    "src/ui/queue/queue-view-model.js",
    "src/ui/queue/queue.js"
  ]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return { modules: context.R34MF.modules, document, FakeElement };
}

const modules = loadModules();

function textNode(text, attributes = {}) {
  return {
    textContent: text,
    getAttribute(name) { return attributes[name] ?? null; }
  };
}

function videoCard({
  href = "https://rule34video.com/video/4535965/joshi-kousei-full/",
  videoId = null,
  title = "Joshi Kousei Full",
  duration = "39:06",
  preview = "https://rule34video.com/get_file/4535965_preview.mp4/",
  thumbnail = "https://rule34video.com/contents/videos_screenshots/4535965/3.jpg",
  added = "3 hours ago",
  rating = "88% (9)",
  views = "1.9K",
  hd = true
} = {}) {
  const link = textNode("", { href, title, "data-video-id": videoId });
  const titleNode = textNode(title);
  const previewNode = textNode("", { "data-preview": preview });
  const image = textNode("", { src: thumbnail });
  return {
    className: "item thumb video_5",
    getAttribute(name) { return name === "data-video-id" ? videoId : null; },
    matches(selector) {
      if (selector === ".item.thumb") return true;
      if (selector === ".spot-thumb") return false;
      return false;
    },
    querySelector(selector) {
      if (selector.includes("a.th.js-open-popup[href*='/video/']") || selector.includes("a[href*='/video/']")) return link;
      if (selector.includes(".thumb_title")) return titleNode;
      if (selector.includes(".img.wrap_image[data-preview]")) return previewNode;
      if (selector.includes("img.thumb") || selector === "img") return image;
      if (selector.includes(".time")) return textNode(duration);
      if (selector.includes(".thumb_info .added")) return textNode(added);
      if (selector.includes(".thumb_info .rating")) return textNode(rating);
      if (selector.includes(".thumb_info .views")) return textNode(views);
      if (selector.includes(".quality .custom-hd") && hd) return textNode("");
      return null;
    }
  };
}

function spotThumb() {
  return {
    className: "spot-thumb thumb",
    matches(selector) { return selector === ".spot-thumb"; },
    querySelector() { return null; }
  };
}

function responseDocument(cards = null) {
  const grid = cards === null ? null : {
    children: cards,
    getAttribute() { return null; },
    querySelector() { return null; }
  };
  return {
    querySelector(selector) {
      return selector.includes("list_videos_videos_from_my_subscriptions_items") ? grid : null;
    }
  };
}

test("listing parsing handles compact counts, percentages, durations, and stable IDs", () => {
  const parse = modules.catalogueParsing;
  assert.equal(parse.parseCompactNumber("52K views"), 52000);
  assert.equal(parse.parseCompactNumber("1.2M"), 1200000);
  assert.equal(parse.parseCompactNumber("unknown"), null);
  assert.equal(parse.parsePercentage("96%"), 96);
  assert.equal(parse.parsePercentage("101%"), null);
  assert.equal(parse.parseDuration("12:34"), 754);
  assert.equal(parse.parseDuration("1:02:03"), 3723);
  assert.equal(parse.parseDuration("n/a"), null);
  assert.equal(parse.extractVideoId("/video/1234567/a-title/"), "1234567");
  assert.equal(parse.parseNativeTotal("Videos from My Subscriptions (5,017)"), 5017);
  assert.equal(parse.calculatePageCount(5017, 24), 210);
  assert.equal(parse.formatPageParameter(2), "02");
});

test("KVS URLs are absolute and retain page formatting", () => {
  const url = new URL(modules.feedDiscovery.buildKvsPageUrl({ pageNumber: 12, origin: "https://rule34video.com" }));
  assert.equal(url.origin, "https://rule34video.com");
  assert.equal(url.pathname, "/my/subscriptions/");
  assert.equal(url.searchParams.get("mode"), "async");
  assert.equal(url.searchParams.get("function"), "get_block");
  assert.equal(url.searchParams.get("block_id"), "list_videos_videos_from_my_subscriptions");
  assert.equal(url.searchParams.get("from"), "12");
});

test("database persistence helpers preserve first-seen time and normalize interrupted scans", () => {
  const db = modules.db;
  assert.equal(modules.constants.database.version, 2);
  const dbSource = readFileSync("src/storage/db.js", "utf8");
  assert.match(dbSource, /function upgrade[\s\S]*STORES\.smartUpdatePages[\s\S]*createIndex\("sessionId"/);
  assert.doesNotMatch(dbSource.match(/async function commitCompletedPage[\s\S]*?async function stageSmartUpdatePage/)?.[0] ?? "", /createObjectStore/);
  assert.equal(db.mergeListingRecord({ firstSeenAt: 5 }, { videoId: "1", title: "new" }, 9).firstSeenAt, 5);
  assert.equal(db.mergeListingRecord(null, { videoId: "1" }, 9).firstSeenAt, 9);
  const state = db.deriveCatalogueState({ scanStatus: "running", indexedCount: 12 }, { scanStatus: "paused" });
  assert.equal(state.key, "subscriptions");
  assert.equal(state.scanStatus, "paused");
  assert.equal(state.indexedCount, 12);
  assert.equal(db.HISTORY_LIMIT, 12);
});

test("authoritative catalogue counts survive running transitions and Resume", () => {
  const db = modules.db;
  const derive = modules.queueViewModel.deriveQueueViewModel;
  const committedCounts = db.authoritativeCountChanges(4700, 0);
  const afterCommit = db.deriveCatalogueState({ scanStatus: "running", indexedCount: 0, detailedCount: 0 }, committedCounts);
  const nextPageRunning = db.deriveCatalogueState(afterCommit, { currentPage: 199, nextPage: 199, scanStatus: "running" });
  assert.equal(nextPageRunning.indexedCount, 4700);
  assert.equal(derive({ catalogue: nextPageRunning }).indexedCount, 4700);
  const { modules: queueModules, FakeElement } = loadQueueDomModules();
  const root = new FakeElement("div");
  queueModules.queue.render(root, { catalogue: nextPageRunning }, "root");
  assert.match(root.textContent, /4[\s\S]700 indexed/);
  queueModules.queue.render(root, { catalogue: nextPageRunning }, "catalogue");
  assert.match(root.textContent, /4[\s\S]700 videos indexed/);

  const paused = db.deriveCatalogueState(nextPageRunning, { scanStatus: "paused", currentPage: null });
  const resumed = db.deriveCatalogueState(paused, { scanStatus: "running", currentPage: 199, activeRunStartedAt: Date.now() });
  assert.equal(resumed.indexedCount, 4700);
  assert.equal(derive({ catalogue: resumed }).active[0].indexedCount, 4700);
});

test("resume planning skips only completed pages in the active scan session", () => {
  const plan = modules.catalogueScanner.planResume({ sessionId: "scan-a", discoveredPageCount: 4, nextPage: 1 }, [
    { pageNumber: 1, status: "complete", sessionId: "scan-a" },
    { pageNumber: 2, status: "complete", sessionId: "another-scan" },
    { pageNumber: 3, status: "failed", sessionId: "scan-a" }
  ]);
  assert.equal(plan.pagesCompleted, 1);
  assert.equal(plan.nextPage, 2);
  assert.deepEqual([...plan.complete], [1]);
});

test("realistic Rule34Video card parsing uses singular video URLs and ignores spot-thumb ads", () => {
  const parsed = modules.cardParser.parseCard(videoCard(), { pageNumber: 1, nativeOrder: 1 });
  assert.equal(parsed.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.record)), {
    videoId: "4535965",
    url: "https://rule34video.com/video/4535965/joshi-kousei-full/",
    title: "Joshi Kousei Full",
    durationSec: 2346,
    thumbnailUrl: "https://rule34video.com/contents/videos_screenshots/4535965/3.jpg",
    thumbnailPreferredUrl: null,
    thumbnailFallbackUrl: "https://rule34video.com/contents/videos_screenshots/4535965/3.jpg",
    previewUrl: "https://rule34video.com/get_file/4535965_preview.mp4/",
    hdAvailable: true,
    relativeUploadText: "3 hours ago",
    ratingPercent: 88,
    ratingVotes: 9,
    views: 1900,
    nativePage: 1,
    nativeOrder: 1
  });
  const inspected = modules.catalogueScanner.inspectResponseDocument(responseDocument([videoCard(), spotThumb()]), 1);
  assert.equal(inspected.gridChildCount, 2);
  assert.equal(inspected.cards.length, 1);
  assert.equal(inspected.records.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(modules.catalogueScanner.listingDiagnostics(inspected, 1))), {
    pageNumber: 1,
    expectedGridPresent: true,
    gridChildCount: 2,
    candidateVideoCount: 1,
    parsedIdentityCount: 1,
    parseFailureCount: 0,
    duplicateCount: 0
  });
});

test("response inspection rejects missing grids and partial card identities without rejecting optional metadata", () => {
  const scanner = modules.catalogueScanner;
  const invalid = scanner.inspectResponseDocument(responseDocument(null), 3);
  assert.equal(invalid.structureValid, false);
  assert.equal(scanner.isTerminalEmptyPage(invalid, 3, null), false);

  const optionalMetadataMissing = scanner.inspectResponseDocument(responseDocument([videoCard({ duration: "", preview: null, added: "", rating: "", views: "", hd: false })]), 3);
  assert.equal(optionalMetadataMissing.structureValid, true);
  assert.equal(optionalMetadataMissing.records.length, 1);
  assert.equal(optionalMetadataMissing.parseFailures.length, 0);

  const partial = scanner.inspectResponseDocument(responseDocument([
    videoCard(),
    videoCard({ href: null })
  ]), 3);
  assert.equal(partial.cards.length, 2);
  assert.equal(partial.records.length, 1);
  assert.equal(partial.parseFailures.length, 1);

  const duplicates = scanner.inspectResponseDocument(responseDocument([
    videoCard(),
    videoCard({ href: "https://rule34video.com/video/4535965/duplicate/" })
  ]), 3);
  assert.deepEqual([...duplicates.duplicateVideoIds], ["4535965"]);
  assert.equal(duplicates.parseFailures.length, 0);

  const empty = scanner.inspectResponseDocument(responseDocument([]), 4);
  assert.equal(empty.structureValid, true);
  assert.equal(empty.cards.length, 0);
  assert.equal(scanner.isTerminalEmptyPage(empty, 4, null), true);
  assert.equal(scanner.isTerminalEmptyPage(empty, 4, 4), false);
});

test("native paginator derives current and final pages from item parents and Last", () => {
  const link = (text, from) => textNode(text, { "data-parameters": `sort_by:;from:${from}` });
  const current = link("01", "01");
  const last = link("Last", "210");
  const pagination = {
    querySelector(selector) { return selector.includes(".item.active") ? current : null; },
    querySelectorAll() { return [current, link("02", "02"), last]; }
  };
  const state = modules.feedDiscovery.extractPaginatorState(pagination);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), { currentPageNumber: 1, lastPageNumber: 210, observedPageCount: 210 });
  assert.equal(modules.feedDiscovery.pageCapacityFromGrid({ children: [videoCard(), videoCard(), spotThumb()], getAttribute() { return null; } }, 1, 210), 2);
  assert.equal(modules.feedDiscovery.pageCapacityFromGrid({ children: [videoCard(), spotThumb()], getAttribute() { return null; } }, 210, 210), null);
});

test("native paginator recognizes icon-only, rel, aria, title, and class Last controls", () => {
  const control = (attributes = {}, className = "", parentClass = "") => ({ textContent: "", className, parentElement: { className: parentClass }, getAttribute(name) { return attributes[name] ?? null; } });
  const current = control({ "data-parameters": "from:01" });
  for (const last of [
    control({ "data-parameters": "sort_by:;from=250", rel: "last" }),
    control({ "data-parameters": "from:250", "aria-label": "Last page" }),
    control({ "data-parameters": "from:250", title: "Last" }),
    control({ "data-parameters": "from:250" }, "pagination-last"),
    control({ "data-parameters": "from:250" }, "", "item last")
  ]) {
    const pagination = { querySelector: () => current, querySelectorAll: () => [current, last] };
    assert.equal(modules.feedDiscovery.extractPaginatorState(pagination).lastPageNumber, 250);
  }
});

test("feed discovery uses real paginator evidence for current page, Last, capacity, and first-scan scale", () => {
  const link = (text, from) => textNode(text, { "data-parameters": `sort_by:;from:${from}` });
  const current = link("01", "01");
  const last = link("Last", "210");
  const paginator = {
    querySelector(selector) { return selector.includes(".item.active") ? current : null; },
    querySelectorAll() { return [current, last]; }
  };
  const grid = { children: [videoCard(), videoCard({ href: "https://rule34video.com/video/4535966/another/" }), spotThumb()], getAttribute() { return null; } };
  const heading = textNode("Videos from My Subscriptions (5,017)");
  const block = {
    querySelector(selector) {
      if (selector === "#list_videos_videos_from_my_subscriptions_items") return grid;
      if (selector === "#list_videos_videos_from_my_subscriptions_pagination") return paginator;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "h1, h2, h3, h4, h5, h6") return [heading];
      return [current, last];
    }
  };
  const documentLike = {
    querySelector(selector) {
      if (selector === "#list_videos_videos_from_my_subscriptions") return block;
      if (selector === "#list_videos_videos_from_my_subscriptions_items") return grid;
      return null;
    }
  };
  const feed = modules.feedDiscovery.discoverFeed(documentLike);
  assert.equal(feed.currentPageNumber, 1);
  assert.equal(feed.reliablePaginatorPageCount, 210);
  assert.equal(feed.pageCapacity, 2);
  assert.equal(feed.pageCount, 210);
  assert.equal(feed.nativeTotal, 5017);
  assert.equal(feed.currentPageCardCount, 2);
});

test("page discovery distinguishes a current short page from verified capacity evidence", () => {
  const discovery = modules.feedDiscovery;
  const fullGrid = { children: Array.from({ length: 20 }, () => videoCard()), getAttribute() { return null; } };
  const shortFinalGrid = { children: Array.from({ length: 3 }, () => videoCard()), getAttribute() { return null; } };
  assert.equal(discovery.pageCapacityFromGrid(fullGrid, 2, 5), 20);
  assert.equal(discovery.pageCapacityFromGrid(shortFinalGrid, 5, 5), null);
  assert.equal(discovery.pageCapacityFromGrid(fullGrid, 1, null, 5614), 20);
  assert.equal(discovery.derivePageCount({ nativeTotal: 5614, pageCapacity: 24, reliablePaginatorPageCount: null }), 234);
  assert.equal(discovery.derivePageCount({ nativeTotal: 100, pageCapacity: 20, reliablePaginatorPageCount: null }), 5);
  assert.equal(discovery.derivePageCount({ nativeTotal: 100, pageCapacity: null, reliablePaginatorPageCount: null }), null);
  assert.equal(discovery.derivePageCount({ nativeTotal: 100, pageCapacity: null, reliablePaginatorPageCount: 7 }), 7);
});

test("Smart Update ordered overlap rebuilds shifted page boundaries without duplicates or omissions", () => {
  const reconciliation = modules.catalogueReconciliation;
  const oldIds = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
  const current = ["X", "Y", "Z", ...oldIds];
  const result = reconciliation.smartUpdateOrder({ scannedIds: current.slice(0, 10), oldIds, nativeTotal: 15, minimumRun: 6 });
  assert.equal(result.ready, true);
  assert.deepEqual([...result.orderedIds], current);
  assert.equal(new Set(result.orderedIds).size, current.length);
  const mismatch = reconciliation.smartUpdateOrder({ scannedIds: current.slice(0, 9), oldIds, nativeTotal: 16, minimumRun: 6 });
  assert.equal(mismatch.ready, false);
  assert.equal(mismatch.reason, "native-total-mismatch");
  const untrustedScale = reconciliation.smartUpdateOrder({ scannedIds: current.slice(0, 9), oldIds, minimumRun: 6 });
  assert.equal(untrustedScale.ready, false);
  assert.equal(untrustedScale.reason, "native-total-unavailable");
  const full = reconciliation.smartUpdateOrder({ scannedIds: current, oldIds, nativeTotal: 15, reachedEnd: true });
  assert.deepEqual([...full.orderedIds], current);
});

test("Smart Update Queue progress uses native feed position rather than old completion or overlap threshold", () => {
  const derive = modules.queueViewModel.deriveQueueViewModel;
  const raw = {
    catalogue: { catalogueReady: true, scanStatus: "complete", scanKind: "smart-update", indexedCount: 5614, detailedCount: 1, pagesCompleted: 250, discoveredPageCount: 250, smartUpdate: { status: "running", currentPage: 24, pagesChecked: 24, newVideos: 472, consecutiveKnownPages: 2, knownOverlapThreshold: 3, nativePageCount: 250 } },
    capabilities: { smartUpdate: true, fetchDetails: true },
    runtime: { slots: 1, active: [{ kind: "smart-update", progress: { pageNumber: 24, nativePageCount: 250, pagesChecked: 24, newVideos: 472, knownStreak: 2, knownThreshold: 3, indexedCount: 5614 } }], waiting: [] }
  };
  const model = derive(raw);
  assert.equal(model.progress, 10);
  assert.equal(model.catalogueActive.scope, "Page 24 of 250");
  assert.equal(model.catalogueActive.completed, 24);
  assert.equal(model.catalogueActive.total, 250);
  assert.equal(model.catalogueActive.knownStreak, 2);
  const first = derive({ ...raw, runtime: { slots: 1, active: [{ kind: "smart-update", progress: { pageNumber: 1, nativePageCount: 250, pagesChecked: 1, knownStreak: 0, knownThreshold: 3 } }], waiting: [] } });
  assert.notEqual(first.progress, 100);

  const { modules: queueModules, document, FakeElement } = loadQueueDomModules(); const root = new FakeElement("div"); root.isConnected = true;
  queueModules.queue.render(root, raw, "root"); assert.match(root.textContent, /Page 24 of 250/); assert.match(root.textContent, /overlap 2\/3/);
  queueModules.queue.render(root, raw, "catalogue"); assert.match(root.textContent, /Page 24 of 250/); assert.match(root.textContent, /24 pages checked · 472 new videos/); assert.match(root.textContent, /Known overlap 2 \/ 3/);
  assert.equal(document.activeElement !== null, true);
});

test("failed Detail canary renders compact histogram and diagnostic export action without an overall bar", () => {
  const { modules: queueModules, FakeElement } = loadQueueDomModules(); const root = new FakeElement("div"); root.isConnected = true;
  const canary = { passed: false, attemptedCount: 10, successCount: 1, failedCount: 9, samples: [{ ok: true }, ...Array.from({ length: 6 }, () => ({ ok: false, code: "http-5xx", httpStatus: 504 })), ...Array.from({ length: 2 }, () => ({ ok: false, code: "network-error" })), { ok: false, code: "http-404", httpStatus: 404 }] };
  queueModules.queue.render(root, { catalogue: { catalogueReady: true, indexedCount: 5614, detailedCount: 1, detailsState: { status: "failed", processedCount: 10, completedCount: 1, failedCount: 9, lastCanary: canary, lastError: { code: "detail-canary-transient-network", message: "Retry later." } } }, capabilities: { fetchDetails: true }, runtime: { slots: 1, active: [], waiting: [] } }, "details");
  assert.match(root.textContent, /10 attempted · 1 verified · 9 failed/);
  assert.match(root.textContent, /HTTP 504 · 6/);
  assert.match(root.textContent, /Network error · 2/);
  assert.match(root.textContent, /HTTP 404 · 1/);
  assert.match(root.textContent, /Export diagnostic/);
  assert.equal(root.querySelector(".r34mf-queue-progress"), null);
});

test("Queue CSS establishes a full-width in-flow disclosure without a scrim", () => {
  const styles = readFileSync("src/ui/styles.css", "utf8");
  assert.match(styles, /\.r34mf-queue-host\s*\{[^}]*display:\s*block[^}]*width:\s*100%[^}]*margin-top:\s*12px/);
  assert.match(styles, /\.r34mf-queue-panel\s*\{[^}]*width:\s*100%[^}]*padding:\s*16px 20px 18px/);
  assert.doesNotMatch(styles, /\.r34mf-queue-scrim/);
  assert.doesNotMatch(styles, /\.r34mf-queue-host\s*\{[^}]*position:\s*absolute/);
  assert.doesNotMatch(styles, /\.r34mf-queue-panel\s*\{[^}]*position:\s*(absolute|fixed)/);
});

test("Queue operation controls use their rendered click path for Catalogue and Back navigation", () => {
  const { modules, FakeElement } = loadQueueDomModules();
  const root = new FakeElement("div");
  const raw = { catalogue: { scanStatus: "not-scanned", discoveredNativeTotal: 88 } };
  let queuePage = "root";
  const render = () => modules.queue.render(root, raw, queuePage, null, (action) => {
    if (action === "queue-catalogue") queuePage = "catalogue";
    if (action === "queue-back") queuePage = "root";
    render();
  });

  render();
  const inlinePanel = root.querySelector(".r34mf-queue-panel");
  const catalogueControl = root.querySelector('[data-r34mf-action="queue-catalogue"]');
  assert.ok(catalogueControl, "first-use Queue renders a real Catalogue operation control");
  catalogueControl.dispatchEvent({ type: "click" });
  assert.equal(queuePage, "catalogue");
  assert.equal(root.querySelector(".r34mf-queue-panel"), inlinePanel, "child navigation retains the inline Queue frame");
  assert.match(inlinePanel.textContent, /CATALOGUE/);

  const backControl = root.querySelector('[data-r34mf-action="queue-back"]');
  assert.ok(backControl, "Catalogue child renders its Back control");
  backControl.dispatchEvent({ type: "click" });
  assert.equal(queuePage, "root");
  assert.ok(root.querySelector('[data-r34mf-action="queue-catalogue"]'));
});

test("failed first-use Queue remains compact while Catalogue exposes failure state", () => {
  const { modules, FakeElement } = loadQueueDomModules();
  const root = new FakeElement("div");
  modules.queue.render(root, {
    catalogue: { scanStatus: "failed", pagesCompleted: 0, lastError: { message: "No readable cards" } }
  });
  const panelText = root.querySelector(".r34mf-queue-panel").textContent;
  assert.match(panelText, /Catalogue[\s\S]*Failed/);
  assert.doesNotMatch(panelText, /Detailed metadata|Maintenance/);
});

test("Queue view model keeps production first-use data truthful and supports final fixture states", () => {
  const derive = modules.queueViewModel.deriveQueueViewModel;
  const firstUse = derive({ catalogue: { scanStatus: "not-scanned", discoveredNativeTotal: 88 } });
  assert.equal(firstUse.headerStatus, "Idle");
  assert.equal(firstUse.operations[0].subtitle, "Not scanned yet · ≈88 videos");
  assert.equal(firstUse.operations[1].navigable, false);

  const running = derive({ catalogue: { scanStatus: "running", currentPage: 3, discoveredPageCount: 10, pagesCompleted: 2, indexedCount: 44, startedAt: Date.now() - 600_000, activeRunStartedAt: Date.now() - 5_000 } });
  assert.equal(running.headerStatus, "1 of 1 slots");
  assert.equal(running.progress, 20);
  assert.equal(running.capabilities.stopScan, true);
  assert.equal(running.active[0].startedAt, running.catalogue.activeRunStartedAt);
  assert.equal(running.elapsed, "just started");

  const failedFirstUse = derive({ catalogue: { scanStatus: "failed", pagesCompleted: 0, lastError: { message: "No readable cards" } } });
  assert.equal(failedFirstUse.operations[0].status, "Failed");
  assert.equal(failedFirstUse.operations[1].navigable, false);
  assert.equal(failedFirstUse.operations[2].navigable, false);

  const busy = derive({
    catalogue: { scanStatus: "complete", catalogueReady: true, indexedCount: 20, detailedCount: 5 },
    runtime: { slots: 2, active: [{ kind: "Catalogue", scope: "Page 2 of 4" }, { kind: "Detailed metadata", scope: "Missing only" }], waiting: [{ kind: "Refresh detailed metadata", scope: "Full refresh" }] },
    future: { detailsState: { status: "Queued #1" }, maintenanceState: { status: "Covered" } }
  });
  assert.equal(busy.headerStatus, "2 of 2 slots · 1 waiting");
  assert.equal(busy.waiting[0].position, 1);
  assert.equal(busy.operations[1].status, "Queued #1");
  assert.equal(busy.operations[2].status, "Covered");
  assert.equal(busy.missingCount, 15);
  assert.equal(busy.capabilities.fullRescan, true);
});

test("completed Queue children remain navigable while unavailable execution controls are disabled", () => {
  const { modules: queueModules, FakeElement } = loadQueueDomModules();
  const raw = {
    catalogue: { scanStatus: "complete", catalogueReady: true, indexedCount: 5142, detailedCount: 0, discoveredPageCount: 215, lastFullScanAt: Date.now() },
    capabilities: { smartUpdate: false, fetchDetails: false }
  };
  const model = queueModules.queueViewModel.deriveQueueViewModel(raw);
  assert.equal(model.operations[1].navigable, true);
  assert.equal(model.operations[1].status, "Unavailable");

  const root = new FakeElement("div");
  queueModules.queue.render(root, raw, "catalogue");
  const update = root.querySelector('[data-r34mf-action="smart-update"]');
  assert.ok(update);
  assert.equal(update.disabled, true);
  assert.match(root.textContent, /CATALOGUE READY[\s\S]*5[\s\S]142 videos indexed[\s\S]*SMART UPDATE/);

  queueModules.queue.render(root, raw, "details");
  const details = root.querySelector('[data-r34mf-action="details-fetch"]');
  assert.ok(details);
  assert.equal(details.disabled, true);
  assert.match(root.textContent, /COVERAGE[\s\S]*0 \/ 5[\s\S]142 videos detailed[\s\S]*0%/);
});

test("Maintenance rows share the Queue right-side structure and keep only Full rescan executable", () => {
  const { modules: queueModules, FakeElement } = loadQueueDomModules();
  const root = new FakeElement("div");
  queueModules.queue.render(root, {
    catalogue: { scanStatus: "complete", catalogueReady: true, indexedCount: 5142 },
    capabilities: { fullRescan: true }
  }, "maintenance");
  const rows = [];
  const visit = (node) => {
    if (node.className?.split(/\s+/).includes("r34mf-queue-row")) rows.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.querySelector(".r34mf-queue-row-right")), "each maintenance row has a separated right-side status region");
  assert.equal(root.querySelector('[data-r34mf-action="scan-resume"]'), null);
  const fullRescan = root.querySelector('[data-r34mf-action="queue-full-rescan"]');
  assert.ok(fullRescan);
  assert.equal(fullRescan.disabled, false);
});

test("Recent terminal statuses use product capitalization without changing history data", () => {
  const model = modules.queueViewModel.deriveQueueViewModel({
    recent: [{ status: "failed" }, { status: "stopped" }, { status: "complete" }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(model.recent.map((entry) => entry.displayStatus))), ["Failed", "Stopped", "Completed"]);
});
