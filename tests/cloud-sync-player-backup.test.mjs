import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));

const baseManifest = json("manifests/base.json");
const siteScripts = baseManifest.content_scripts[0].js;
const subscriptionStyles = baseManifest.content_scripts.find((entry) => entry.matches.some((match) => match.includes("/my/subscriptions")))?.css ?? [];
const videoStyles = baseManifest.content_scripts.find((entry) => entry.matches.some((match) => match.includes("/video/*")))?.css ?? [];

function ordered(first, second) {
  assert.ok(siteScripts.indexOf(first) >= 0, `${first} must be in the site runtime`);
  assert.ok(siteScripts.indexOf(second) >= 0, `${second} must be in the site runtime`);
  assert.ok(siteScripts.indexOf(first) < siteScripts.indexOf(second), `${first} must load before ${second}`);
}

test("portable backups include Seen and Favorites without weakening strict storage validation", () => {
  const data = read("src/storage/settings-data-local-state.js");
  const schema = read("src/storage/backup-schema-local-state.js");

  assert.match(data, /seenVideos:\s*seenStore\.normalize/);
  assert.match(data, /favoriteVideos:\s*favoriteStore\.normalize/);
  assert.match(data, /seenStore\.load\(\{ force: true \}\)/);
  assert.match(data, /favoriteStore\.load\(\{ force: true \}\)/);
  assert.match(data, /Older v1 backups that lack these fields leave the[\s\S]*Seen\/Favorites state untouched/);
  assert.match(data, /function mergedSetState/);
  assert.match(data, /replace\s*\?\s*seenStore\.normalize[\s\S]*mergedSetState/);
  assert.match(data, /replace\s*\?\s*favoriteStore\.normalize[\s\S]*mergedSetState/);
  assert.match(data, /Merge[\s\S]*unions the two sets/);

  assert.match(schema, /const normalized = base\.normalizeStorage\(raw\);/);
  assert.match(schema, /normalized\.seenVideos = source\.seenVideos === null \? null : seenStore\.normalize/);
  assert.match(schema, /normalized\.favoriteVideos = source\.favoriteVideos === null \? null : favoriteStore\.normalize/);
});

test("backup and Cloud sync wrappers load on the safe side of Phase 10 hardening", () => {
  ordered("src/storage/settings-data.js", "src/storage/settings-data-local-state.js");
  ordered("src/storage/settings-data-local-state.js", "src/storage/settings-data-hardening.js");
  ordered("src/storage/backup-schema.js", "src/storage/backup-schema-local-state.js");
  ordered("src/storage/backup-schema-local-state.js", "src/storage/settings-data-hardening.js");
  ordered("src/storage/settings-data-hardening.js", "src/storage/cloud-sync.js");
});

test("Cloud sync is private-repo only, conflict-safe, and Pull always uses Replace", () => {
  const runtime = read("src/background/cloud-runtime.js");
  const client = read("src/storage/cloud-sync.js");

  assert.match(runtime, /repo\?\.private !== true/);
  assert.match(runtime, /Cloud sync only supports private GitHub repositories/);
  assert.match(runtime, /currentSha !== expected/);
  assert.match(runtime, /cloud-remote-changed/);
  assert.match(runtime, /r34mf-cloud-status/);
  assert.match(runtime, /r34mf-cloud-push/);
  assert.match(runtime, /r34mf-cloud-pull/);
  assert.match(runtime, /rule34video-media-filter-backup\.r34mfbackup/);
  assert.match(runtime, /application\/vnd\.github\.raw\+json/);
  assert.match(runtime, /ENCODING_GZIP = "gzip"/);
  assert.doesNotMatch(runtime, /r34mf:cloud-/);

  assert.match(client, /data\.importBackup\(parsed, "replace"\)/);
  assert.doesNotMatch(client, /importBackup\(parsed, "merge"\)/);
  assert.match(client, /withIdleDataLock\("cloud-push"/);
  assert.match(client, /function normalizeRepository/);
  assert.match(client, /hostname\.toLocaleLowerCase\(\) !== "github\.com"/);
  assert.match(client, /status\(\{ includeBackupMeta: false \}\)/);
  assert.match(client, /quickLocalMeta\(\)/);
  assert.match(client, /CompressionStream/);
  assert.match(client, /DecompressionStream/);
});

test("Chrome and Firefox both load Cloud background support and request GitHub API access", () => {
  const chrome = json("manifests/chrome.json");
  const firefox = json("manifests/firefox.json");
  const chromeRuntime = read("src/background/chrome-runtime.js");

  assert.equal(chrome.background.service_worker, "src/background/chrome-runtime.js");
  assert.deepEqual(firefox.background.scripts, ["src/background/session-runtime.js", "src/background/cloud-runtime.js"]);
  assert.match(chromeRuntime, /importScripts\("session-runtime\.js", "cloud-runtime\.js"\)/);
  assert.ok(baseManifest.host_permissions.includes("https://api.github.com/*"));
});

test("Cloud drawer and optional main-card Pull Push controls follow the requested UI contract", () => {
  const settingsUi = read("src/ui/settings-cloud-player-ui.js");
  const shell = read("src/ui/cloud-main-buttons.js");
  const cloudUi = read("src/ui/cloud-sync-ui.js");
  const css = read("src/ui/cloud-sync.css");

  assert.match(settingsUi, /Cloud sync/);
  assert.match(settingsUi, /GitHub private repository/);
  assert.match(settingsUi, /Show Push and Pull buttons in main card/);
  assert.match(settingsUi, /Configure cloud sync/);
  assert.match(settingsUi, /Check connection/);
  assert.match(settingsUi, /Fine-grained access token/);
  assert.match(settingsUi, /username\/private-repo/);
  assert.match(settingsUi, /github_pat_\.\.\./);
  assert.match(settingsUi, /full github\.com URL/);
  assert.match(settingsUi, /if \(base\.isOpen\(\)\)/);
  assert.match(settingsUi, /if \(cloudSession !== session\) return/);
  assert.match(settingsUi, /if \(!dialog \|\| !base\.isOpen\(\)\) return/);

  assert.match(shell, /button\("Pull", "cloud-pull"\)/);
  assert.match(shell, /button\("Push", "cloud-push"\)/);
  assert.match(shell, /showCloudSyncMainButtons !== true/);
  assert.match(shell, /modeGroup\.classList\.add\("has-cloud-actions"\)/);
  assert.match(css, /\.r34mf-cloud-main-actions[\s\S]*right:\s*0/);
  assert.match(css, /\.r34mf-cloud-main-control[\s\S]*height:\s*36px/);
  assert.match(css, /\.r34mf-mode-group\.has-cloud-actions[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(css, /\.r34mf-settings-cloud-actions[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.r34mf-settings-cloud-section\s*\{[\s\S]*margin-top:\s*34px/);
  assert.match(css, /\.r34mf-mode-controls \.r34mf-control\.is-selected:hover:not\(:disabled\)/);

  assert.match(cloudUi, /Pull always uses Replace/);
  assert.match(cloudUi, /Replace from cloud/);
  assert.match(cloudUi, /Cloud backup pushed successfully/);
  assert.match(cloudUi, /Cloud backup pulled and local data replaced/);
  assert.match(cloudUi, /Uploading backup to GitHub/);
  assert.match(cloudUi, /Downloading cloud backup/);
  assert.match(cloudUi, /Optimizing backup for transfer/);
  assert.match(cloudUi, /current stage rather than a made-up percentage/);
  assert.match(cloudUi, /remoteInspected/);
  assert.match(cloudUi, /confirm\.disabled = action === "pull" && !remote/);
  assert.doesNotMatch(cloudUi, /"18%"|"62%"|"88%"/);
});

test("new display settings normalize safely and keep Cloud main buttons opt-in", () => {
  const settings = read("src/storage/settings.js");
  const settingsUi = read("src/ui/settings-cloud-player-ui.js");
  assert.match(settings, /improvedPlayerPlaybackControls:\s*true/);
  assert.match(settings, /showCloudSyncMainButtons:\s*false/);
  assert.match(settings, /next\.improvedPlayerPlaybackControls = raw\.improvedPlayerPlaybackControls !== false/);
  assert.match(settings, /next\.showCloudSyncMainButtons = raw\.showCloudSyncMainButtons === true/);
  assert.match(settingsUi, /Improved video player controls/);
});

test("10-second player controls heal stale runtimes, enforce Flowplayer placement and stay compact", () => {
  const player = read("src/content/video-player-controls.js");
  const css = read("src/ui/video-player-controls.css");

  assert.match(player, /VIDEO_PATH = \/\^\\\/videos\?\\\/\\d\+/);
  assert.match(player, /#kt_player/);
  assert.match(player, /function flowplayerAnchors/);
  assert.match(player, /\.fp-controls/);
  assert.match(player, /\.fp-btns, \.fp-small-switch/);
  assert.match(player, /\.fp-volume-control/);
  assert.match(player, /data.*r34mfPlayerRuntime|dataset\.r34mfPlayerRuntime/);
  assert.match(player, /function controlsBetween/);
  assert.match(player, /function placeFlowplayerControls/);
  assert.match(player, /placeFlowplayerControls\(flow, controls\)/);
  assert.match(player, /existing\?\.dataset\?\.r34mfPlayerRuntime !== RUNTIME_TOKEN/);
  assert.match(player, /controls\.append\(skipButton\(video, -SEEK_SECONDS, root\), skipButton\(video, SEEK_SECONDS, root\)\)/);
  assert.match(player, /document\.addEventListener\("fullscreenchange", schedule\)/);
  assert.match(player, /rootObserver\.observe\(root, \{ childList: true, subtree: true \}\)/);
  assert.doesNotMatch(player, /observer\.observe\(document\.documentElement/);
  assert.match(player, /Math\.max\(0, Math\.min\(upper, current \+ delta\)\)/);
  assert.doesNotMatch(player, /await settings\.load\(\)/);

  assert.match(css, /\.r34mf-player-skip-button[\s\S]*width:\s*26px\s*!important/);
  assert.match(css, /height:\s*26px\s*!important/);
  assert.match(css, /\.fp-controls > \.r34mf-player-skip-controls\.is-flowplayer/);
  assert.doesNotMatch(css, /order:\s*initial\s*!important/);
  assert.ok(videoStyles.includes("src/ui/video-player-controls.css"));
});

test("Cloud and player modules are ordered after their dependencies", () => {
  ordered("src/ui/shell.js", "src/ui/cloud-main-buttons.js");
  ordered("src/ui/cloud-sync-ui.js", "src/ui/settings-cloud-player-ui.js");
  ordered("src/ui/settings-p2-ui.js", "src/ui/settings-cloud-player-ui.js");
  ordered("src/content/settings-controller.js", "src/content/cloud-sync-controller.js");
  ordered("src/storage/settings.js", "src/content/video-player-controls.js");
  assert.ok(subscriptionStyles.includes("src/ui/cloud-sync.css"));
  assert.ok(subscriptionStyles.includes("src/ui/cloud-sync-followup.css"));
});
