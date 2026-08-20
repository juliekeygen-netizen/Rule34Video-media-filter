import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadPhaseOneModules() {
  const storage = {
    async get() { return {}; },
    async set() {}
  };
  const context = {
    URL,
    console,
    queueMicrotask,
    Node: { ELEMENT_NODE: 1 },
    browser: { runtime: {}, storage: { local: storage } }
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    "src/shared/namespace.js",
    "src/shared/browser-api.js",
    "src/shared/constants.js",
    "src/storage/ui-state.js",
    "src/ui/shell.js",
    "src/content/subscriptions-controller.js"
  ]) {
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  }
  return context.R34MF.modules;
}

const modules = loadPhaseOneModules();

test("target route recognition accepts harmless subscription URL variants only", () => {
  const { isTargetPage } = modules.subscriptionsController;
  for (const url of [
    "https://rule34video.com/my/subscriptions/",
    "https://rule34video.com/my/subscriptions",
    "https://rule34video.com/my/subscriptions/?foo=bar",
    "https://rule34video.com/my/subscriptions#state"
  ]) {
    assert.equal(isTargetPage(url), true, url);
  }
  for (const url of [
    "https://rule34video.com/my/subscriptions-something",
    "https://rule34video.com/my/videos/",
    "https://example.com/my/subscriptions/"
  ]) {
    assert.equal(isTargetPage(url), false, url);
  }
});

test("UI state normalizes only supported mode and collapse values", () => {
  const uiState = modules.uiState;
  const normalize = (value) => JSON.parse(JSON.stringify(uiState.normalize(value)));
  assert.deepEqual(normalize({ mode: "native", collapsed: false }), { mode: "native", collapsed: false, localPage: 1, sort: { field: "uploadDate", direction: "desc" } });
  assert.deepEqual(normalize({ mode: "local", collapsed: true, localPage: 7 }), { mode: "local", collapsed: true, localPage: 7, sort: { field: "uploadDate", direction: "desc" } });
  assert.deepEqual(normalize({ mode: "unexpected", collapsed: "true", localPage: 0 }), { mode: "native", collapsed: false, localPage: 1, sort: { field: "uploadDate", direction: "desc" } });
  assert.deepEqual(normalize(), { mode: "native", collapsed: false, localPage: 1, sort: { field: "uploadDate", direction: "desc" } });
});

test("shell state stays truthful before a catalogue exists", () => {
  const { deriveState } = modules.shell;
  const native = deriveState({ mode: "native", collapsed: false, catalogue: { hasCatalogue: false } });
  assert.equal(native.showNativeControls, true);
  assert.equal(native.showLocalControls, false);
  assert.equal(native.statusText, "No local catalogue yet");

  const local = deriveState({ mode: "local", collapsed: false, catalogue: { hasCatalogue: false } });
  assert.equal(local.showNativeControls, false);
  assert.equal(local.showLocalControls, true);
  assert.equal(local.statusText, "No local catalogue yet");

  const collapsed = deriveState({ mode: "local", collapsed: true, filterCount: 3 });
  assert.equal(collapsed.collapsedLabel, "LOCAL · 3 FILTERS");
  assert.equal(collapsed.showLocalControls, false);

  const indexedButUnavailable = deriveState({ mode: "local", collapsed: false, catalogue: { hasCatalogue: true, indexedCount: 20 }, canFilter: false, canSort: false });
  assert.equal(indexedButUnavailable.hasCatalogue, true);
  assert.equal(indexedButUnavailable.canFilter, false);
  assert.equal(indexedButUnavailable.canSort, false);
});

test("reconciliation helpers identify only current insertion points and native mutations", () => {
  const controller = modules.subscriptionsController;
  const grid = { isConnected: true };
  const root = { isConnected: true, nextElementSibling: grid };
  assert.equal(controller.rootIsAtInsertionPoint(root, grid), true);
  assert.equal(controller.rootIsAtInsertionPoint({ isConnected: true, nextElementSibling: null }, grid), false);

  const nativeNode = { nodeType: 1, dataset: {}, closest: () => null, matches: () => false, querySelector: () => null };
  const gridNode = { nodeType: 1, dataset: {}, closest: () => null, matches: (selector) => selector.includes("list_videos_videos_from_my_subscriptions_items"), querySelector: () => null };
  const ownedNode = { nodeType: 1, dataset: { r34mfOwned: "true" }, closest: () => null, matches: () => false, querySelector: () => null };
  assert.equal(controller.mutationIsRelevant([{ type: "childList", target: nativeNode, addedNodes: [gridNode], removedNodes: [] }]), true);
  assert.equal(controller.mutationIsRelevant([{ type: "childList", target: nativeNode, addedNodes: [ownedNode], removedNodes: [] }]), false);
});

test("Queue interaction reducer toggles Queue and closes it before shell collapse", () => {
  const transition = modules.subscriptionsController.queueUiTransition;
  const closed = { queueOpen: false, queuePage: "root", collapsed: false };
  const opened = transition(closed, "queue");
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), { queueOpen: true, queuePage: "root", collapsed: false });
  const closedAgain = transition(opened, "queue");
  assert.deepEqual(JSON.parse(JSON.stringify(closedAgain)), closed);
  const collapsed = transition(opened, "toggle-collapse");
  assert.deepEqual(JSON.parse(JSON.stringify(collapsed)), { queueOpen: false, queuePage: "root", collapsed: true });
});
