import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("site-wide Queue startup does not repeat the initial catalogue refresh", () => {
  const source = read("src/content/site-queue-continuation-controller.js");
  assert.match(source, /async function activate\(target = controller, \{ refresh = true \} = \{\}\)/);
  assert.match(source, /if \(refresh\) await target\.refreshCatalogueState\(\)/);
  assert.match(source, /activate\(this, \{ refresh: true \}\)/);
  assert.match(source, /if \(runtime\.isOwner\(\)\) await activate\(this, \{ refresh: false \}\)/);
  assert.match(source, /maintenance\.scheduleMaintenanceCounts\?\.\(this\)/);
  assert.doesNotMatch(source, /await maintenance\.refreshMaintenanceCounts\(this\)/);
});

test("site-wide Queue pages do not repeatedly unmount the subscriptions UI every route-timer tick", () => {
  const source = read("src/content/mobile-runtime-stability-controller.js");
  assert.match(source, /onRouteMaybeChangedWithoutRepeatedOffPageUnmount/);
  assert.match(source, /if \(this\.mounted \|\| this\.root\?\.isConnected\) this\.unmount\?\.\(\)/);
  assert.match(source, /site-wide Queue runtime intentionally stays alive/);
});

test("Local rendering coalesces catalogue/detail bursts instead of stacking full filter passes", () => {
  const source = read("src/content/local-filter-context.js");
  assert.match(source, /let localRenderPromise = null/);
  assert.match(source, /let localRenderPending = false/);
  assert.match(source, /if \(localRenderPromise\) \{[\s\S]*phase10LocalRenderEpoch \+= 1/);
  assert.match(source, /do \{[\s\S]*await renderLocalOnce\(instance\)[\s\S]*\} while \(localRenderPending/);
  assert.match(source, /EVALUATION_SLICE_MS = 12/);
});

test("automatic Recent Update yields startup to UI and waits for Queue ownership", () => {
  const source = read("src/content/recent-auto-update-controller.js");
  assert.match(source, /AUTO_START_DELAY_MS = 1400/);
  assert.match(source, /function queueRuntimeReady\(\)/);
  assert.match(source, /requestIdleCallback/);
  assert.match(source, /scheduleAutomaticAttempt\(this\)/);
  assert.doesNotMatch(source, /queueMicrotask\(tryAutomatic\)/);
  assert.doesNotMatch(source, /setTimeout\?\.\(tryAutomatic, 750\)/);
});

test("maintenance counts use one cached Local snapshot and do not block startup", () => {
  const source = read("src/content/maintenance-controller.js");
  assert.match(source, /function maintenanceCountsFromSource/);
  assert.match(source, /const source = await db\.getAllLocalRecords\(\)/);
  assert.match(source, /scheduleMaintenanceCounts\(this\)/);
  assert.doesNotMatch(source, /Promise\.all\(\[[\s\S]*countFailedDetails[\s\S]*countOutdatedDetails/);
  assert.doesNotMatch(source, /await refreshMaintenanceCounts\(this\)/);
});

test("JobManager progress presentation is coalesced and catalogue status does not restart Local filtering", () => {
  const manifest = JSON.parse(read("manifests/base.json"));
  const scripts = manifest.content_scripts[0].js;
  const source = read("src/content/runtime-presentation-performance.js");
  const modulePath = "src/content/runtime-presentation-performance.js";
  assert.ok(scripts.indexOf(modulePath) > scripts.indexOf("src/content/mobile-runtime-stability-controller.js"));
  assert.ok(scripts.indexOf(modulePath) < scripts.indexOf("src/content/site-queue-continuation-controller.js"));
  assert.match(source, /PROGRESS_UI_INTERVAL_MS = 120/);
  assert.match(source, /instance\.updateShell\?\.\(\)/);
  assert.match(source, /presentationSubscriptionIntercepted/);
  assert.match(source, /refreshLocal:\s*false/);
  assert.doesNotMatch(source, /instance\.renderQueue\?\.\(\)[\s\S]*instance\.updateShell/);
});

test("Settings decorators cannot continuously trigger their own subtree observers", () => {
  for (const path of ["src/ui/settings-p2-ui.js", "src/ui/settings-cloud-player-ui.js"]) {
    const source = read(path);
    assert.match(source, /let decorateQueued = false/);
    assert.match(source, /function setTextIfChanged/);
    assert.match(source, /function scheduleDecorate/);
    assert.match(source, /new MutationObserver\(scheduleDecorate\)/);
    assert.doesNotMatch(source, /new MutationObserver\(\(\) => queueMicrotask\(decorate\)\)/);
  }
});

test("passive Cloud status checking no longer competes with initial startup work", () => {
  const source = read("src/content/cloud-sync-controller.js");
  assert.match(source, /CLOUD_START_DELAY_MS = 3200/);
  assert.match(source, /requestIdleCallback/);
  assert.match(source, /document\.visibilityState === "hidden"/);
});

test("Duplicates uses ranked representatives and binary-searched duration buckets without losing UNKNOWN", () => {
  const source = read("src/filters/filter-duplicates.js");
  assert.match(source, /representativeRank/);
  assert.match(source, /function lowerDurationBound/);
  assert.match(source, /function durationCandidateIds/);
  assert.match(source, /byArtistDuration\.set\(artist, \[\.\.\.durationMap\.entries\(\)\]\.sort/);
  assert.match(source, /lowerDurationBound\(entries, minimum\)/);
  assert.match(source, /if \(Number\(duration\) > maximum\) break/);
  assert.match(source, /if \(result === base\.UNKNOWN\) \{[\s\S]*unknown = true/);
  assert.match(source, /if \(result === base\.TRUE && \(index\.representativeRank\?\.get\(id\) \?\? Infinity\) < currentRank\) return base\.TRUE/);
  assert.doesNotMatch(source, /function earlierArtistCandidateIds/);
});

test("player enhancement never observes the entire subscriptions document", () => {
  const source = read("src/content/video-player-controls.js");
  assert.match(source, /rootObserver\.observe\(root, \{ childList: true, subtree: true \}\)/);
  assert.match(source, /parentObserver\.observe\(root\.parentElement, \{ childList: true \}\)/);
  assert.doesNotMatch(source, /observe\(document\.documentElement/);
  assert.match(source, /MAX_RETRIES = 24/);
  assert.doesNotMatch(source, /await settings\.load\(\)/);
});

test("mobile main-card Cloud actions stay compact despite the generic phone flex rule", () => {
  const css = read("src/ui/cloud-sync.css");
  assert.match(css, /\.r34mf-cloud-main-control \{[\s\S]*flex:\s*0 0 auto !important;[\s\S]*min-width:\s*58px/);
});
