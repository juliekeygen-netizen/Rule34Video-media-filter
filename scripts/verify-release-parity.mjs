import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeRoot = join(repoRoot, "dist", "chrome");
const firefoxRoot = join(repoRoot, "dist", "firefox");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

function manifest(root) {
  return JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
}

function files(root, dir = root) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) result.push(...files(root, path));
    else result.push(relative(root, path).replaceAll("\\", "/"));
  }
  return result.sort();
}

function sharedFiles(root) {
  return files(root).filter((path) => path !== "manifest.json" && path !== "src/shared/build-info.js");
}

function backgroundScripts(value) {
  if (value?.background?.service_worker === "src/background/chrome-runtime.js") {
    return ["src/background/session-runtime.js", "src/background/cloud-runtime.js"];
  }
  if (value?.background?.service_worker) return [value.background.service_worker];
  return [...(value?.background?.scripts ?? [])];
}

function sanitizeManifest(value) {
  const copy = structuredClone(value);
  delete copy.browser_specific_settings;
  if (copy.background) copy.background = { shared_scripts: backgroundScripts(value) };
  return copy;
}

function buildIdentity(root) {
  const source = readFileSync(join(root, "src", "shared", "build-info.js"), "utf8");
  const id = source.match(/id:\s*("[^"]*"|'[^']*')/)?.[1];
  const timestamp = source.match(/timestamp:\s*("[^"]*"|'[^']*')/)?.[1];
  const browser = source.match(/browser:\s*("[^"]*"|'[^']*')/)?.[1];
  if (!id || !timestamp || !browser) throw new Error("Generated build-info.js is missing release identity fields.");
  return { id: JSON.parse(id.replace(/^'/, '"').replace(/'$/, '"')), timestamp: JSON.parse(timestamp.replace(/^'/, '"').replace(/'$/, '"')), browser: JSON.parse(browser.replace(/^'/, '"').replace(/'$/, '"')) };
}

const chrome = manifest(chromeRoot);
const firefox = manifest(firefoxRoot);

assert.equal(chrome.version, packageJson.version, "Chrome package version must match package.json");
assert.equal(firefox.version, packageJson.version, "Firefox package version must match package.json");
assert.deepEqual(sanitizeManifest(firefox), sanitizeManifest(chrome), "Chrome and Firefox manifests differ outside declared browser overlays");
assert.equal(chrome.background?.service_worker, "src/background/chrome-runtime.js", "Chrome background runtime changed unexpectedly");
assert.deepEqual(firefox.background?.scripts, ["src/background/session-runtime.js", "src/background/cloud-runtime.js"], "Firefox background runtime changed unexpectedly");
assert.equal(chrome.browser_specific_settings, undefined, "Firefox-only manifest metadata leaked into Chrome");
assert.ok(firefox.browser_specific_settings?.gecko?.id, "Firefox Gecko ID is missing");
assert.deepEqual(firefox.browser_specific_settings?.gecko?.data_collection_permissions?.required, ["none"], "Firefox data-collection declaration changed unexpectedly");

const chromeFiles = sharedFiles(chromeRoot);
const firefoxFiles = sharedFiles(firefoxRoot);
assert.deepEqual(firefoxFiles, chromeFiles, "Generated browser packages do not contain the same shared runtime files");
for (const path of chromeFiles) {
  assert.deepEqual(readFileSync(join(firefoxRoot, path)), readFileSync(join(chromeRoot, path)), `Shared generated file differs between browsers: ${path}`);
}

const chromeBuild = buildIdentity(chromeRoot);
const firefoxBuild = buildIdentity(firefoxRoot);
assert.equal(chromeBuild.id, firefoxBuild.id, "Chrome and Firefox were not generated from the same source identity");
assert.equal(chromeBuild.timestamp, firefoxBuild.timestamp, "Chrome and Firefox were not generated in the same build pass");
assert.equal(chromeBuild.browser, "chrome");
assert.equal(firefoxBuild.browser, "firefox");

console.log(`Release parity verified: ${packageJson.version} @ ${chromeBuild.id} (${chromeFiles.length} shared files).`);
