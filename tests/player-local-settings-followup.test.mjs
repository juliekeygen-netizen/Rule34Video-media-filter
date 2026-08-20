import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));

function preferenceSyncHarness() {
  const state = {
    "r34mf.settings": {
      automaticSignIn: true,
      autoUpdateRecentVideosFrequency: "6h",
      videoColumns: 4
    }
  };
  const writes = [];
  const settings = {
    value: { ...state["r34mf.settings"] },
    normalize(value) {
      return {
        automaticSignIn: value?.automaticSignIn === true,
        autoUpdateRecentVideosFrequency: value?.autoUpdateRecentVideosFrequency ?? "session",
        videoColumns: Number(value?.videoColumns) || 3
      };
    },
    async load() { this.value = this.normalize(state["r34mf.settings"]); return this.value; }
  };
  const data = {
    async storagePayload() {
      return { settings: { automaticSignIn: false, autoUpdateRecentVideosFrequency: "6h", videoColumns: 4 }, seenVideos: ["7"] };
    },
    async buildBackup() {
      return { storage: { settings: { automaticSignIn: false, autoUpdateRecentVideosFrequency: "6h", videoColumns: 4 }, seenVideos: ["7"] }, database: {} };
    },
    async applyBackupStorage() { return "base-applied"; }
  };
  const schema = {
    normalizeStorage(raw) {
      return { settings: raw?.settings ? { ...raw.settings, automaticSignIn: false } : null };
    },
    normalizeBackup(raw) {
      return { ...raw, storage: { ...(raw?.storage ?? {}), settings: raw?.storage?.settings ? { ...raw.storage.settings, automaticSignIn: false } : null } };
    }
  };
  const R34MF = {
    modules: {
      settingsData: data,
      backupSchema: schema,
      settings,
      constants: { storageKeys: { settings: "r34mf.settings" } },
      browserApi: {
        storageLocal: {
          async get(key) { return { [key]: state[key] }; },
          async set(value) { writes.push(value); Object.assign(state, value); }
        }
      }
    }
  };
  const context = vm.createContext({ R34MF, globalThis: null, Object, Promise });
  context.globalThis = context;
  vm.runInContext(read("src/storage/settings-backup-preference-sync.js"), context, { filename: "src/storage/settings-backup-preference-sync.js" });
  return { R34MF, state, writes };
}

test("current Rule34Video Flowplayer controls join the native floated cell row", () => {
  const player = read("src/content/video-player-controls.js");
  const css = read("src/ui/video-player-controls.css");

  assert.match(player, /\.fp-play, \.fp-btns/);
  assert.match(player, /\.fp-volume, \.fp-volume-control/);
  assert.match(player, /createControls\(video, flow\.volumeUnit, "is-flowplayer", root\)/);
  assert.match(css, /\.is-flowplayer[\s\S]*float:\s*left\s*!important/);
  assert.match(css, /flex:\s*0 0 80px\s*!important/);
  assert.match(css, /\.is-flowplayer \.r34mf-player-skip-button[\s\S]*width:\s*40px\s*!important/);
  assert.match(css, /height:\s*36px\s*!important/);
  assert.match(css, /\.is-flowplayer \.r34mf-player-skip-button svg[\s\S]*width:\s*26px\s*!important/);
});

test("seek feedback mirrors Rule34Video and covers extension buttons plus native double-click", () => {
  const player = read("src/content/video-player-controls.js");
  const css = read("src/ui/video-player-controls.css");

  assert.match(player, /function showSeekFeedback/);
  assert.match(player, /seek\(video, delta\);[\s\S]*showSeekFeedback\(root, delta\)/);
  assert.match(player, /root\.addEventListener\("dblclick", handler, true\)/);
  assert.match(player, /nativeSeekFeedbackVisible\(root, delta\)/);
  assert.match(player, /never seek a second time/);
  assert.match(css, /\.r34mf-player-skip-feedback[\s\S]*min-width:\s*64px/);
  assert.match(css, /background:\s*rgba\(0,0,0,\.55\)/);
  assert.match(css, /border-radius:\s*14px/);
  assert.match(css, /\.is-back[\s\S]*left:\s*11%/);
  assert.match(css, /\.is-forward[\s\S]*right:\s*11%/);
});

test("Local display is finalized at runtime and player controls live under Other", () => {
  const layout = read("src/ui/settings-layout-followup.js");
  assert.match(layout, /findRow\(grid, "Animated hover previews"\)\?\.remove\(\)/);
  const ordered = [
    "Videos per page",
    "Video column amount",
    "Thumbnail aspect ratio",
    "Artist label\/s on video thumbnails",
    "Artist label text size"
  ];
  let previous = -1;
  for (const label of ordered) {
    const index = layout.indexOf(label);
    assert.ok(index > previous, `${label} should follow the requested Local display order`);
    previous = index;
  }
  assert.match(layout, /ensureOtherSection/);
  assert.match(layout, /title\.textContent = "Other"/);
  assert.match(layout, /improvedPlayerPlaybackControls/);
  assert.match(layout, /data-r34mf-settings-followup/);
});

test("Recent Update frequency is moved beside Recent Update pages without losing its draft control", () => {
  const layout = read("src/ui/settings-layout-followup.js");
  assert.match(layout, /recentUpdatePageLimit/);
  assert.match(layout, /autoUpdateRecentVideosFrequency/);
  assert.match(layout, /recentPages\.nextElementSibling !== frequency/);
  assert.match(layout, /recentPages\.after\(frequency\)/);
  assert.match(layout, /Automatically run Recent Update using the schedule below/);
});

test("animated previews are permanent and a horizontal touch swipe toggles one Local preview", () => {
  const touch = read("src/ui/local-grid-touch-previews.js");
  assert.match(touch, /base\.render\(root, \{ \.\.\.options, previews: true \}\)/);
  assert.match(touch, /thumb\.style\.touchAction = "pan-y"/);
  assert.match(touch, /event\.pointerType !== "touch"/);
  assert.match(touch, /SWIPE_X_PX = 28/);
  assert.match(touch, /absX <= absY \+ AXIS_BIAS_PX/);
  assert.match(touch, /toggleTouchPreview\(thumb\)/);
  assert.match(touch, /event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\)/);
  assert.match(touch, /activeTouchThumb/);
});

test("portable backup and Cloud sync preserve Automatic sign-in preference but not credentials", async () => {
  const { R34MF, state } = preferenceSyncHarness();
  const data = R34MF.modules.settingsData;
  const schema = R34MF.modules.backupSchema;

  const storage = await data.storagePayload();
  assert.equal(storage.settings.automaticSignIn, true);
  assert.equal(storage.settings.autoUpdateRecentVideosFrequency, "6h");
  assert.deepEqual(Array.from(storage.seenVideos), ["7"]);

  const backup = await data.buildBackup();
  assert.equal(backup.storage.settings.automaticSignIn, true);
  assert.equal(backup.storage.settings.autoUpdateRecentVideosFrequency, "6h");
  assert.deepEqual(Array.from(backup.storage.seenVideos), ["7"]);

  const normalized = schema.normalizeBackup({ storage: { settings: { automaticSignIn: true, autoUpdateRecentVideosFrequency: "12h" } }, database: {} });
  assert.equal(normalized.storage.settings.automaticSignIn, true);

  await data.applyBackupStorage({ settings: { automaticSignIn: true, autoUpdateRecentVideosFrequency: "24h", videoColumns: 5 } });
  assert.equal(state["r34mf.settings"].automaticSignIn, true);
  assert.equal(state["r34mf.settings"].autoUpdateRecentVideosFrequency, "24h");

  const source = read("src/storage/settings-backup-preference-sync.js");
  assert.doesNotMatch(source, /authCredentials/);
  assert.match(source, /Credentials stay device-local/);
});

test("manifest loads preference, touch-preview and Settings layout follow-ups before consumers", () => {
  const manifest = json("manifests/base.json");
  const scripts = manifest.content_scripts[0].js;
  const index = (path) => scripts.indexOf(path);

  for (const path of [
    "src/storage/settings-backup-preference-sync.js",
    "src/ui/local-grid-touch-previews.js",
    "src/ui/settings-layout-followup.js"
  ]) assert.ok(index(path) >= 0, `${path} should be packaged`);

  assert.ok(index("src/storage/backup-schema-local-state.js") < index("src/storage/settings-backup-preference-sync.js"));
  assert.ok(index("src/storage/settings-backup-preference-sync.js") < index("src/storage/settings-data-hardening.js"));
  assert.ok(index("src/ui/local-grid-artist-labels.js") < index("src/ui/local-grid-touch-previews.js"));
  assert.ok(index("src/ui/local-grid-touch-previews.js") < index("src/content/subscriptions-controller.js"));
  assert.ok(index("src/ui/settings-cloud-player-ui.js") < index("src/ui/settings-layout-followup.js"));
});
