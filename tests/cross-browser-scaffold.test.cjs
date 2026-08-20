const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const test = require("node:test");

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("browser manifests share one base and Firefox declares signing metadata", () => {
  const base = json("manifests/base.json");
  const chrome = json("manifests/chrome.json");
  const firefox = json("manifests/firefox.json");

  assert.equal(base.manifest_version, 3);
  assert.equal(base.browser_specific_settings, undefined);
  assert.equal(chrome.background.service_worker, "src/background/chrome-runtime.js");
  assert.deepEqual(firefox.background.scripts, ["src/background/session-runtime.js", "src/background/cloud-runtime.js"]);
  assert.match(readFileSync("src/background/chrome-runtime.js", "utf8"), /importScripts\("session-runtime\.js", "cloud-runtime\.js"\)/);
  assert.equal(typeof firefox.browser_specific_settings.gecko.id, "string");
  assert.deepEqual(
    firefox.browser_specific_settings.gecko.data_collection_permissions.required,
    ["none"]
  );
  assert.equal(existsSync("manifest.json"), false, "root manifest must not become a second source of truth");
});

test("shared content-script order loads compatibility helpers before consumers", () => {
  const base = json("manifests/base.json");
  const scripts = base.content_scripts[0].js;

  assert.ok(scripts.indexOf("src/shared/browser-api.js") > scripts.indexOf("src/shared/namespace.js"));
  assert.ok(scripts.indexOf("src/shared/browser-api.js") < scripts.indexOf("src/storage/settings.js"));
  assert.ok(scripts.indexOf("src/shared/browser-api.js") < scripts.indexOf("src/storage/ui-state.js"));
  assert.ok(scripts.indexOf("src/utils/url.js") < scripts.indexOf("src/jobs/request-scheduler.js"));
});

test("settings use the browser abstraction instead of a Chrome-only storage call", () => {
  for (const path of ["src/storage/settings.js", "src/storage/ui-state.js"]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /browserApi\.storageLocal/);
    assert.doesNotMatch(source, /chrome\.storage\.local/);
  }
});

test("package exposes both browser build targets", () => {
  const packageJson = json("package.json");

  assert.ok(packageJson.scripts["build:chrome"]);
  assert.ok(packageJson.scripts["build:firefox"]);
  assert.ok(packageJson.scripts["lint:firefox"]);
});

test("build tooling generates a runtime build identity for both packages", () => {
  const build = readFileSync("scripts/build.mjs", "utf8");
  assert.match(build, /"git", \["rev-parse", "--short", "HEAD"\]/);
  assert.match(build, /build-info\.js/);
});
