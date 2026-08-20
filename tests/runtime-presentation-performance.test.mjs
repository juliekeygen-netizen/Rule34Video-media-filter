import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function makeContext() {
  const frames = [];
  const timers = [];
  const env = {
    console,
    Date,
    JSON,
    Math,
    Object,
    Promise,
    String,
    Array,
    Set,
    Map,
    clearTimeout() {},
    setTimeout(callback) { timers.push(callback); return timers.length; },
    cancelAnimationFrame() {},
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; }
  };
  env.globalThis = env;
  vm.createContext(env);
  vm.runInContext(readFileSync("src/shared/namespace.js", "utf8"), env, { filename: "src/shared/namespace.js" });
  return { env, frames, timers };
}

function makeManager() {
  const listeners = new Set();
  let current = { active: [], waiting: [], slots: 1 };
  return {
    snapshot() { return current; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(snapshot) { current = snapshot; for (const listener of [...listeners]) listener(snapshot); },
    listenerCount() { return listeners.size; }
  };
}

test("runtime presentation replaces the base double-render listener with one coalesced shell refresh", async () => {
  const { env, frames } = makeContext();
  const manager = makeManager();
  let shellUpdates = 0;
  let directQueueRenders = 0;
  const visibilityOptions = [];
  const controller = {
    started: false,
    root: { isConnected: true },
    runtimeUnsubscribers: [],
    updateShell() { shellUpdates += 1; },
    renderQueue() { directQueueRenders += 1; },
    applyModeVisibility(_parts, options = {}) { visibilityOptions.push(options); },
    onCatalogueState() { if (this.root?.isConnected) this.applyModeVisibility(); },
    async start() {
      if (this.started) return;
      this.started = true;
      this.runtimeUnsubscribers = [env.R34MF.modules.jobManager.subscribe(() => {
        this.renderQueue();
        this.updateShell();
      })];
    },
    cleanup() {}
  };
  env.R34MF.modules.jobManager = manager;
  env.R34MF.modules.subscriptionsController = controller;

  vm.runInContext(readFileSync("src/content/runtime-presentation-performance.js", "utf8"), env, { filename: "src/content/runtime-presentation-performance.js" });
  await controller.start();
  assert.equal(manager.listenerCount(), 1);

  manager.emit({ active: [{ id: "job-1", kind: "detail-enrichment", progress: { completed: 1 } }], waiting: [], slots: 1 });
  assert.equal(shellUpdates, 0, "presentation waits for the next animation frame");
  assert.equal(directQueueRenders, 0, "the old direct Queue render listener was intercepted");
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(shellUpdates, 1);
  assert.equal(directQueueRenders, 0);

  controller.onCatalogueState({ scanStatus: "complete" });
  assert.equal(visibilityOptions.at(-1)?.refreshLocal, false, "status-only catalogue emissions must not restart Local filtering");
});
