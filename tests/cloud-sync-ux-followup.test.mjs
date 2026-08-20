import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const manifest = JSON.parse(read("manifests/base.json"));

function cloudHarness() {
  const messages = [];
  let buildBackupCalls = 0;
  const stored = new Map();
  const app = {
    version: "0.1.0",
    modules: {
      browserApi: {
        storageLocal: {
          async get(key) {
            if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, stored.get(item)]));
            return { [key]: stored.get(key) };
          },
          async set(values) {
            for (const [key, value] of Object.entries(values ?? {})) stored.set(key, value);
          },
          async remove(key) { stored.delete(key); }
        },
        async runtimeSendMessage(message) {
          messages.push(message);
          return {
            ok: true,
            repository: { fullName: "owner/private-backup" },
            backupPath: "rule34video-media-filter-backup.r34mfbackup",
            remote: {
              sha: "remote-file-sha",
              size: 2_000_000,
              commit: {
                sha: "1234567890abcdef",
                shortSha: "1234567",
                date: "2026-08-18T12:00:00Z",
                message: "Update backup"
              }
            }
          };
        }
      },
      settingsData: {
        summaryFromBackup() {
          return { indexed: 0, detailed: 0, approximateBytes: 0, approximateStorage: "0 B" };
        },
        async buildBackup() {
          buildBackupCalls += 1;
          return { storage: {}, database: {} };
        },
        async importBackup() { return {}; },
        async withIdleDataLock(_name, callback) { return callback(); }
      },
      db: {
        async getCatalogueState() { return { indexedCount: 7453, detailedCount: 7448 }; }
      },
      seenStore: {
        async load() { return { ids: ["1", "2", "2"] }; }
      },
      favoriteStore: {
        async load() { return { ids: ["9", "10"] }; }
      }
    }
  };

  const context = {
    R34MF: app,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Blob,
    Response,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    btoa,
    atob,
    Set,
    Date,
    Object,
    Math,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    console
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(read("src/storage/cloud-sync.js"), context, { filename: "cloud-sync.js" });
  return { cloud: context.R34MF.modules.cloudSync, messages, getBuildBackupCalls: () => buildBackupCalls };
}

test("Cloud repository input accepts canonical slugs and normal GitHub repository URLs", () => {
  const { cloud } = cloudHarness();
  const token = "github_pat_test";
  const cases = new Map([
    ["owner/private-backup", "owner/private-backup"],
    ["https://github.com/owner/private-backup", "owner/private-backup"],
    ["https://github.com/owner/private-backup/", "owner/private-backup"],
    ["https://github.com/owner/private-backup.git", "owner/private-backup"],
    ["github.com/owner/private-backup", "owner/private-backup"]
  ]);
  for (const [input, expected] of cases) {
    const normalized = cloud.normalizeConfig({ repository: input, token });
    assert.equal(normalized.repository, expected);
    assert.equal(normalized.valid, true);
  }
  assert.equal(cloud.normalizeConfig({ repository: "https://example.com/owner/repo", token }).valid, false);
});

test("Cloud confirmation preview uses lightweight counts and does not build or download a full backup", async () => {
  const { cloud, messages, getBuildBackupCalls } = cloudHarness();
  const preview = await cloud.preview();

  assert.equal(getBuildBackupCalls(), 0, "opening the confirmation must not serialize the full local backup");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "r34mf-cloud-status");
  assert.equal(messages[0].includeBackupMeta, false, "opening the confirmation must not download the full remote backup");
  assert.deepEqual(
    { indexed: preview.local.indexed, detailed: preview.local.detailed, seen: preview.local.seen, favorites: preview.local.favorites },
    { indexed: 7453, detailed: 7448, seen: 2, favorites: 2 }
  );
  assert.equal(preview.local.current, true);
  assert.equal(preview.local.bytes, null);
});

test("Cloud transfer codec gzips repetitive JSON and still decodes legacy raw backups", { skip: typeof CompressionStream !== "function" || typeof DecompressionStream !== "function" }, async () => {
  const { cloud } = cloudHarness();
  const text = JSON.stringify({
    format: "r34mf-backup",
    version: 1,
    database: {
      videos: Array.from({ length: 2500 }, (_, index) => ({
        videoId: String(index + 1),
        title: `Repeated catalogue title ${index % 20}`,
        thumbnailUrl: "https://rule34video.com/contents/videos_screenshots/repeated/repeated.jpg"
      }))
    }
  });

  const encoded = await cloud.encodeTransfer(text);
  assert.equal(encoded.encoding, "gzip");
  assert.ok(encoded.bytes < encoded.originalBytes / 2, "catalogue-shaped JSON should compress substantially");
  assert.equal(await cloud.decodeTransfer(encoded), text);
  assert.equal(await cloud.decodeTransfer({ encoding: "json", text }), text, "pre-compression cloud backups must remain readable");
});

test("Cloud background accepts gzip payloads, recognizes old JSON downloads, and skips redundant commit lookup during transfer", () => {
  const runtime = read("src/background/cloud-runtime.js");
  assert.match(runtime, /ENCODING_GZIP = "gzip"/);
  assert.match(runtime, /function isGzip\(bytes\)/);
  assert.match(runtime, /bytes\[0\] === 0x1f && bytes\[1\] === 0x8b/);
  assert.match(runtime, /payload\.encoding === ENCODING_JSON \? boundedBackupMeta/);
  assert.match(runtime, /async function transferSnapshot/);
  const transfer = runtime.slice(runtime.indexOf("async function transferSnapshot"), runtime.indexOf("function normalizeUpload"));
  assert.doesNotMatch(transfer, /latestFileCommit/);
  assert.match(runtime, /content: upload\.content/);
});

test("opening Settings preserves an already-open Queue drawer", () => {
  const controller = read("src/content/settings-controller.js");
  assert.doesNotMatch(controller, /closeQueue/);
  assert.match(controller, /Keep an open Queue/);
});

test("Cloud progress is stage-based and selected MODE controls retain the accent on hover", () => {
  const ui = read("src/ui/cloud-sync-ui.js");
  const css = read("src/ui/cloud-sync.css");

  assert.match(ui, /is-indeterminate/);
  assert.match(ui, /real current stage rather than a made-up percentage/);
  assert.match(ui, /Optimizing backup for transfer/);
  assert.match(ui, /Decompressing cloud backup/);
  assert.doesNotMatch(ui, /bar\.style\.width/);
  assert.match(css, /@keyframes r34mf-cloud-progress-slide/);
  assert.match(css, /\.r34mf-mode-controls \.r34mf-control\.is-selected:hover:not\(:disabled\)[\s\S]*background:\s*var\(--r34mf-accent-bright\)/);
});

test("Cloud Sync and Danger zone use the same standard Settings section gap", () => {
  const baseCss = read("src/ui/settings.css");
  const fixCss = read("src/ui/cloud-sync-followup.css");
  const styles = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/cloud-sync.css"))?.css ?? [];

  assert.match(baseCss, /\.r34mf-settings-section\s*\{\s*margin-top:\s*22px/);
  assert.match(baseCss, /\.r34mf-settings-section:first-of-type\s*\{\s*margin-top:\s*0/);
  assert.match(fixCss, /\.r34mf-settings-section\.r34mf-settings-cloud-section,[\s\S]*\.r34mf-settings-danger\s*\{\s*margin-top:\s*22px/);
  assert.doesNotMatch(fixCss, /margin-top:\s*(?:28|34)px/);
  assert.ok(styles.indexOf("src/ui/cloud-sync-followup.css") > styles.indexOf("src/ui/cloud-sync.css"));
});

test("extension cannot alter browser proxy routing", () => {
  const permissions = new Set(manifest.permissions ?? []);
  const allSource = [
    read("src/shared/browser-api.js"),
    read("src/storage/cloud-sync.js"),
    read("src/background/session-runtime.js"),
    read("src/background/cloud-runtime.js")
  ].join("\n");

  assert.equal(permissions.has("proxy"), false);
  assert.doesNotMatch(allSource, /(?:chrome|browser)\.proxy|proxy\.settings/);
});
