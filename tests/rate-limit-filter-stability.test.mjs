import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function runSource(env, file) {
  vm.runInContext(readFileSync(file, "utf8"), env, { filename: file });
}

function createRateLimitRuntime() {
  let listener = null;
  let snapshotValue = { active: [], waiting: [], recent: [] };
  const timers = [];
  const cleared = [];
  const enqueues = [];
  const notices = [];
  let catalogue = {
    detailsState: {
      status: "paused",
      mode: "outdated",
      lastError: { code: "http-429" }
    }
  };

  const controller = {
    started: true,
    mounted: true,
    phase10PageHidden: false,
    root: { isConnected: true },
    state: {},
    async start() { return true; },
    async handleIntent() { return true; },
    cleanup() { return true; },
    updateShell() { notices.push(this.state.queueNotice ?? null); },
    enqueueDetails(options) {
      enqueues.push(options);
      return { accepted: true };
    }
  };

  const manager = {
    subscribe(callback) {
      listener = callback;
      return () => { listener = null; };
    },
    snapshot() { return snapshotValue; }
  };

  const env = {
    console,
    Date,
    Math,
    Number,
    Object,
    Array,
    Set,
    Promise,
    R34MF: {
      modules: {
        subscriptionsController: controller,
        jobManager: manager,
        db: { async getCatalogueState() { return catalogue; } },
        maintenanceController: {
          DETAIL_KINDS: new Set([
            "detail-enrichment",
            "detail-retry-failed",
            "detail-retry-failed-refreshes",
            "detail-refresh",
            "detail-repair-outdated"
          ])
        },
        logger: { debug() {}, warn() {} }
      }
    },
    setTimeout(callback, delay) {
      const id = timers.length + 1;
      timers.push({ id, callback, delay });
      return id;
    },
    clearTimeout(id) { cleared.push(id); }
  };
  env.globalThis = env;
  vm.createContext(env);
  runSource(env, "src/content/detail-rate-limit-recovery-controller.js");

  return {
    env,
    controller,
    manager,
    timers,
    cleared,
    enqueues,
    notices,
    setCatalogue(value) { catalogue = value; },
    emit(value) {
      snapshotValue = value;
      listener?.(value);
    }
  };
}

function rateLimitedJob(id, kind = "detail-repair-outdated", mode = "outdated") {
  return {
    id,
    kind,
    state: "stopped",
    error: { code: "http-429" },
    progress: { detailMode: mode },
    result: {
      detailsState: {
        status: "paused",
        mode,
        lastError: { code: "http-429" }
      }
    }
  };
}

test("final detail 429 pauses schedule adaptive 1/2/3 minute automatic resumes", async () => {
  const runtime = createRateLimitRuntime();
  await runtime.controller.start();
  const recovery = runtime.env.R34MF.modules.detailRateLimitRecovery;

  runtime.emit({ active: [], waiting: [], recent: [rateLimitedJob("one")] });
  assert.equal(runtime.timers.at(-1).delay, 60_000);
  assert.match(runtime.controller.state.queueNotice, /auto-resume in about 1 minute/i);
  assert.equal(recovery.snapshot().rateLimitStreak, 1);

  assert.equal(await recovery.attemptAutoResume(recovery.snapshot().scheduled), true);
  assert.equal(runtime.enqueues.at(-1).mode, "outdated");
  assert.equal(runtime.enqueues.at(-1).automatic, true);

  runtime.setCatalogue({ detailsState: { status: "paused", mode: "outdated", lastError: { code: "http-429" } } });
  runtime.emit({ active: [], waiting: [], recent: [rateLimitedJob("two"), rateLimitedJob("one")] });
  assert.equal(runtime.timers.at(-1).delay, 120_000);
  assert.equal(await recovery.attemptAutoResume(recovery.snapshot().scheduled), true);

  runtime.setCatalogue({ detailsState: { status: "paused", mode: "outdated", lastError: { code: "http-429" } } });
  runtime.emit({ active: [], waiting: [], recent: [rateLimitedJob("three"), rateLimitedJob("two")] });
  assert.equal(runtime.timers.at(-1).delay, 180_000);
  assert.equal(await recovery.attemptAutoResume(recovery.snapshot().scheduled), true);

  runtime.setCatalogue({ detailsState: { status: "paused", mode: "outdated", lastError: { code: "http-429" } } });
  runtime.emit({ active: [], waiting: [], recent: [rateLimitedJob("four"), rateLimitedJob("three")] });
  assert.equal(runtime.timers.at(-1).delay, 180_000, "repeated rate limiting stays capped at three minutes");
});

test("automatic rate-limit resume does not override manual work, cancellation, or non-429 pauses", async () => {
  const runtime = createRateLimitRuntime();
  await runtime.controller.start();
  const recovery = runtime.env.R34MF.modules.detailRateLimitRecovery;

  runtime.emit({ active: [], waiting: [], recent: [rateLimitedJob("rate-limit")] });
  assert.ok(recovery.snapshot().scheduled);

  await runtime.controller.handleIntent("details-cancel");
  assert.equal(recovery.snapshot().scheduled, null);
  assert.equal(recovery.snapshot().rateLimitStreak, 0);

  runtime.emit({
    active: [],
    waiting: [],
    recent: [{
      id: "manual-pause",
      kind: "detail-refresh",
      state: "stopped",
      error: null,
      result: { detailsState: { status: "paused", mode: "refresh", lastError: null } }
    }]
  });
  assert.equal(recovery.snapshot().scheduled, null);

  runtime.emit({ active: [], waiting: [], recent: [rateLimitedJob("again", "detail-refresh", "refresh")] });
  const plan = recovery.snapshot().scheduled;
  assert.ok(plan);
  runtime.setCatalogue({ detailsState: { status: "running", mode: "refresh", lastError: null } });
  assert.equal(await recovery.attemptAutoResume(plan), false);
  assert.equal(runtime.enqueues.length, 0);
});

test("manual Resume cancels the pending timer but preserves the consecutive rate-limit backoff", async () => {
  const runtime = createRateLimitRuntime();
  await runtime.controller.start();
  const recovery = runtime.env.R34MF.modules.detailRateLimitRecovery;

  runtime.emit({ active: [], waiting: [], recent: [rateLimitedJob("one")] });
  assert.equal(recovery.snapshot().rateLimitStreak, 1);
  assert.ok(recovery.snapshot().scheduled);

  await runtime.controller.handleIntent("details-resume");
  assert.equal(recovery.snapshot().scheduled, null);
  assert.equal(recovery.snapshot().rateLimitStreak, 1);

  runtime.emit({ active: [], waiting: [], recent: [rateLimitedJob("two"), rateLimitedJob("one")] });
  assert.equal(runtime.timers.at(-1).delay, 120_000);
});

function createModalRuntime() {
  let shellUpdates = 0;
  let queueRenders = 0;
  let localRenders = 0;
  let openCalls = 0;
  let modalMounted = true;
  const deferredTimers = [];
  const root = {
    isConnected: true,
    querySelector(selector) {
      if (selector === ":scope > .r34mf-modal-layer" && modalMounted) return { isConnected: true };
      return null;
    }
  };
  const controller = {
    root,
    filterModal: { type: "normal", field: "views" },
    queueUiState: { page: "root" },
    state: { mode: "local" },
    renderQueue() { queueRenders += 1; return this.queueUiState; },
    async renderLocal() { localRenders += 1; return { total: 1 }; },
    updateShell() {
      shellUpdates += 1;
      this.renderQueue();
      return root;
    },
    async openFilters() { openCalls += 1; return root; },
    cleanup() { return true; }
  };
  const env = {
    console,
    Promise,
    setTimeout(callback) {
      deferredTimers.push(callback);
      return deferredTimers.length;
    },
    R34MF: { modules: { subscriptionsController: controller } }
  };
  env.globalThis = env;
  vm.createContext(env);
  runSource(env, "src/content/filter-modal-stability-controller.js");
  return {
    env,
    controller,
    async flushDeferredTimers() {
      while (deferredTimers.length) await deferredTimers.shift()?.();
    },
    setModalMounted(value) { modalMounted = value; },
    shellUpdates: () => shellUpdates,
    queueRenders: () => queueRenders,
    localRenders: () => localRenders,
    openCalls: () => openCalls
  };
}

test("filter modals suppress shell, Queue, and Local redraws until the modal closes", async () => {
  const runtime = createModalRuntime();
  const stability = runtime.env.R34MF.modules.filterModalStabilityController;

  runtime.controller.renderQueue();
  await runtime.controller.renderLocal();
  runtime.controller.updateShell();
  assert.equal(runtime.shellUpdates(), 0);
  assert.equal(runtime.queueRenders(), 0);
  assert.equal(runtime.localRenders(), 0);
  assert.deepEqual({ ...stability.snapshot() }, {
    deferredShellUpdate: true,
    deferredQueueUpdate: true,
    deferredLocalRender: true
  });

  runtime.controller.filterModal = null;
  runtime.setModalMounted(false);
  await runtime.controller.openFilters();
  assert.equal(runtime.openCalls(), 1);
  assert.equal(runtime.shellUpdates(), 1, "one deferred shell update is flushed after close");
  assert.equal(runtime.queueRenders(), 1, "the shell flush includes one Queue render");
  assert.equal(runtime.localRenders(), 0, "Local refresh waits so the restored filter UI can paint first");
  assert.deepEqual({ ...stability.snapshot() }, {
    deferredShellUpdate: false,
    deferredQueueUpdate: false,
    deferredLocalRender: false
  });

  await runtime.flushDeferredTimers();
  assert.equal(runtime.localRenders(), 1, "one deferred Local render runs on the following task");

  runtime.controller.updateShell();
  assert.equal(runtime.shellUpdates(), 2, "normal shell updates continue outside filter modals");
  assert.equal(runtime.queueRenders(), 2);
});

test("filter parent hides all right-side summaries and runtime modules load at the final controller boundary", () => {
  const css = readFileSync("src/ui/filter-parent-minimal.css", "utf8");
  assert.match(css, /r34mf-filter-row-summary[\s\S]*display:\s*none\s*!important/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*13px/);

  const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
  const runtime = manifest.content_scripts.find((entry) => entry.js?.includes("src/content/main.js"));
  const styles = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/styles.css"));
  assert.ok(styles.css.indexOf("src/ui/filter-parent-minimal.css") > styles.css.indexOf("src/ui/filters-polish.css"));
  const scripts = runtime.js;
  assert.ok(scripts.indexOf("src/content/filter-modal-stability-controller.js") > scripts.indexOf("src/content/phase10-hardening-controller.js"));
  assert.equal(scripts.indexOf("src/content/detail-rate-limit-recovery-controller.js"), scripts.indexOf("src/content/filter-modal-stability-controller.js") + 1);
  assert.ok(scripts.indexOf("src/content/detail-rate-limit-recovery-controller.js") < scripts.indexOf("src/content/main.js"));
});