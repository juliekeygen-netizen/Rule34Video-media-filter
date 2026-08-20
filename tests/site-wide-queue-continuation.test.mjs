import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(path, "utf8");

function jobManagerRuntime() {
  const app = {
    modules: {
      settings: { value: { concurrentQueueJobs: 1 } },
      logger: { debug() {}, warn() {} }
    }
  };
  const context = vm.createContext({
    R34MF: app,
    globalThis: null,
    Date,
    Number,
    Object,
    Array,
    Set,
    Map,
    Promise,
    AbortController,
    Error
  });
  context.globalThis = context;
  vm.runInContext(read("src/jobs/job-manager.js"), context, { filename: "src/jobs/job-manager.js" });
  return app.modules.jobManager;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("Job Manager can preserve queued work while a site executor handoff temporarily disables execution", async () => {
  const manager = jobManagerRuntime();
  let runs = 0;
  manager.registerHandler("detail-enrichment", async () => { runs += 1; return { detailsState: { status: "complete" } }; });

  manager.setExecutionEnabled(false);
  const queued = manager.enqueue({ kind: "detail-enrichment", scopeKey: "detail-enrichment", resourceKeys: ["detail-write"] });
  assert.equal(queued.accepted, true);
  await settle();
  assert.equal(runs, 0);
  assert.equal(manager.snapshot().waiting.length, 1);

  manager.setExecutionEnabled(true);
  await settle();
  assert.equal(runs, 1);
  assert.equal(manager.snapshot().waiting.length, 0);
  assert.equal(manager.snapshot().recent[0].state, "complete");

  manager.setAcceptingEnabled(false);
  const blocked = manager.enqueue({ kind: "detail-enrichment", scopeKey: "another" });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, "executor-unavailable");
});

test("the headless queue runtime is injected across Rule34Video while UI styles remain route-scoped", () => {
  const manifest = JSON.parse(read("manifests/base.json"));
  const runtime = manifest.content_scripts.find((entry) => entry.js?.includes("src/content/main.js"));
  const subscriptionsStyles = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/styles.css"));
  const videoStyles = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/video-page-seen.css"));

  assert.deepEqual(runtime.matches, ["https://rule34video.com/*", "https://www.rule34video.com/*"]);
  assert.ok(runtime.js.indexOf("src/jobs/site-queue-runtime.js") > runtime.js.indexOf("src/jobs/job-manager.js"));
  assert.ok(runtime.js.indexOf("src/jobs/queue-persistence.js") > runtime.js.indexOf("src/jobs/site-queue-runtime.js"));
  assert.ok(runtime.js.indexOf("src/content/site-queue-continuation-controller.js") > runtime.js.indexOf("src/content/subscriptions-controller.js"));
  assert.ok(runtime.js.indexOf("src/content/site-queue-continuation-controller.js") < runtime.js.indexOf("src/content/main.js"));
  assert.ok(subscriptionsStyles.matches.every((match) => match.includes("/my/subscriptions")));
  assert.ok(videoStyles.matches.every((match) => /\/videos?\//.test(match)));
});

test("background session runtime elects one queue executor and permits immediate same-tab navigation handoff", () => {
  const source = read("src/background/session-runtime.js");
  assert.match(source, /QUEUE_OWNER_KEY = "r34mf\.siteQueueOwner"/);
  assert.match(source, /QUEUE_OWNER_STALE_MS = 6000/);
  assert.match(source, /r34mf:queue-runtime-claim/);
  assert.match(source, /r34mf:queue-runtime-heartbeat/);
  assert.match(source, /const sameTab = tabId !== null && Number\(current\?\.tabId\) === tabId/);
  assert.match(source, /!stale && !sameToken && !sameTab/);
  assert.match(source, /replacedSameTab/);
});

test("queue persistence stores active and waiting descriptors but only the elected owner may write them", () => {
  const source = read("src/jobs/queue-persistence.js");
  assert.match(source, /snapshot\.active/);
  assert.match(source, /snapshot\.waiting/);
  assert.match(source, /bucket === "active"/);
  assert.match(source, /PROGRESS_FLUSH_MS = 1000/);
  assert.match(source, /if \(!runtime\.isOwner\(\)\) return Promise\.resolve/);
  assert.match(source, /storageLocal\.remove\(STORAGE_KEY\)/);
});

test("navigation continuation restores persisted work and falls back to durable interrupted checkpoints", () => {
  const source = read("src/content/site-queue-continuation-controller.js");
  assert.match(source, /restorePersistedQueue/);
  assert.match(source, /runtime-interrupted/);
  assert.match(source, /kind = "full-rescan-resume"/);
  assert.match(source, /if \(runtime\.isOwner\(\)\) return ownerRefreshCatalogueState/);
  assert.match(source, /const catalogue = await scanner\.refresh\(\)/);
  assert.match(source, /runtime\.setExecutionReady\(true\)/);
  assert.match(source, /manager\.pump\(\)/);
});

test("rate-limit recovery follows the elected site executor instead of requiring the subscriptions UI to remain mounted", () => {
  const source = read("src/content/detail-rate-limit-recovery-controller.js");
  assert.match(source, /siteRuntime\?\.isOwner/);
  assert.match(source, /return siteRuntime\.isOwner\(\) === true/);
  assert.match(source, /restorePaused/);
  assert.match(source, /siteWide/);
});

test("video Seen UI is route-guarded because its script now shares the site-wide runtime", () => {
  const source = read("src/content/video-page-seen.js");
  assert.match(source, /\^\\\/videos\?\\\/\\d\+/);
  assert.match(source, /location\?\.pathname/);
});
