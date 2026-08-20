import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = (path) => readFileSync(path, "utf8");

function settingsHarness() {
  const storageLocal = {
    async get() { return {}; },
    async set() {}
  };
  const app = {
    modules: {
      constants: { storageKeys: { settings: "r34mf.settings" } },
      browserApi: { storageLocal, storage: { onChanged: { addListener() {} } } }
    }
  };
  const context = vm.createContext({ R34MF: app, globalThis: null, Object, Number, String, Math, Set, Date });
  context.globalThis = context;
  vm.runInContext(source("src/storage/settings.js"), context, { filename: "src/storage/settings.js" });
  return app.modules.settings;
}

function backgroundHarness() {
  let now = 1_800_000_000_000;
  const local = Object.create(null);
  const session = Object.create(null);
  const listeners = [];

  class FakeDate extends Date {
    static now() { return now; }
  }

  function area(store) {
    return {
      async get(key) {
        if (typeof key === "string") return { [key]: store[key] };
        return { ...store };
      },
      async set(value) { Object.assign(store, value); },
      async remove(key) { delete store[key]; }
    };
  }

  const browser = {
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      lastError: null
    },
    storage: {
      local: area(local),
      session: area(session),
      onChanged: { addListener() {} }
    }
  };

  const context = vm.createContext({
    browser,
    globalThis: null,
    console,
    URL,
    Date: FakeDate,
    Object,
    Number,
    String,
    Math,
    Set,
    Promise,
    Error,
    fetch: async () => { throw new Error("unused"); }
  });
  context.globalThis = context;
  vm.runInContext(source("src/background/session-runtime.js"), context, { filename: "src/background/session-runtime.js" });

  return {
    runtime: context.R34MFSessionRuntime,
    local,
    session,
    advance(ms) { now += ms; },
    clearSession() { for (const key of Object.keys(session)) delete session[key]; }
  };
}

test("Recent Update frequency setting preserves current session behavior and normalizes hour presets", () => {
  const settings = settingsHarness();
  assert.equal(settings.defaults.autoUpdateRecentVideosFrequency, "session");
  assert.deepEqual(
    Object.keys(settings.AUTO_UPDATE_RECENT_FREQUENCY_MS),
    ["session", "1h", "3h", "6h", "12h", "24h"]
  );
  assert.equal(settings.normalize({ autoUpdateRecentVideosFrequency: "6h" }).autoUpdateRecentVideosFrequency, "6h");
  assert.equal(settings.normalize({ autoUpdateRecentVideosFrequency: "15m" }).autoUpdateRecentVideosFrequency, "session");
  assert.equal(settings.autoUpdateRecentIntervalMs("1h"), 60 * 60 * 1000);
  assert.equal(settings.autoUpdateRecentIntervalMs("24h"), 24 * 60 * 60 * 1000);
  assert.equal(settings.autoUpdateRecentIntervalMs("session"), 0);
});

test("background scheduling keeps once-per-session mode while hour modes use a durable successful-run cooldown", async () => {
  const { runtime, advance, clearSession } = backgroundHarness();

  const firstSession = await runtime.claimRecentUpdate("session");
  assert.equal(firstSession.claimed, true);
  const completedSession = await runtime.completeRecentUpdate("session");
  assert.equal(completedSession.completed, true);
  assert.equal(completedSession.retryAfterMs, 0);

  const secondSession = await runtime.claimRecentUpdate("session");
  assert.equal(secondSession.claimed, false);
  assert.equal(secondSession.status, "complete");

  const immediateHourly = await runtime.claimRecentUpdate("1h");
  assert.equal(immediateHourly.claimed, false);
  assert.equal(immediateHourly.status, "cooldown");
  assert.ok(immediateHourly.retryAfterMs > 0);

  advance(60 * 60 * 1000 + 1);
  const dueHourly = await runtime.claimRecentUpdate("1h");
  assert.equal(dueHourly.claimed, true);
  await runtime.completeRecentUpdate("1h");

  clearSession();
  const afterBrowserRestart = await runtime.claimRecentUpdate("1h");
  assert.equal(afterBrowserRestart.claimed, false, "hourly cooldown must survive storage.session reset");
  assert.equal(afterBrowserRestart.status, "cooldown");

  advance(60 * 60 * 1000 + 1);
  const dueAfterRestart = await runtime.claimRecentUpdate("1h");
  assert.equal(dueAfterRestart.claimed, true);
});

test("Settings UI exposes the frequency directly below Auto-update and disables it when automatic updates are off", () => {
  const ui = source("src/ui/settings-p2-ui.js");
  assert.match(ui, /Auto-update frequency/);
  for (const label of [
    "Once per browser session — Current",
    "Every 1 hour",
    "Every 3 hours",
    "Every 6 hours",
    "Every 12 hours",
    "Every 24 hours"
  ]) assert.ok(ui.includes(label), `missing frequency option: ${label}`);
  assert.match(ui, /autoRecent\?\.after\(frequencyRow\)/);
  assert.match(ui, /frequency\.disabled = draft\?\.autoUpdateRecentVideos !== true/);
  assert.match(ui, /missed intervals run on the next eligible visit/);
});

test("content scheduler asks the background for due state, reschedules cooldowns, and reacts to saved frequency changes", () => {
  const controller = source("src/content/recent-auto-update-controller.js");
  assert.match(controller, /frequency: automaticFrequency\(\)/);
  assert.match(controller, /session\?\.status === "cooldown"/);
  assert.match(controller, /scheduleFromCooldown\(instance, session\.retryAfterMs\)/);
  assert.match(controller, /settings\.subscribe\(\(current, previous\)/);
  assert.match(controller, /autoUpdateRecentVideosFrequency !== previous\?\.autoUpdateRecentVideosFrequency/);
  assert.match(controller, /automaticAttemptedThisPage = false;[\s\S]*scheduleFromCooldown/);
});
