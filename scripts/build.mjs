import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browsers = new Set(["chrome", "firefox"]);
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const browserArg = args.find((arg) => arg.startsWith("--browser="));
const requestedBrowser = browserArg?.split("=")[1] ?? "all";
function buildIdentity() { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim() || "dev"; } catch { return "dev"; } }
const buildId = buildIdentity();
const buildTimestamp = new Date().toISOString();

if (requestedBrowser !== "all" && !browsers.has(requestedBrowser)) {
  throw new Error(`Unknown browser target: ${requestedBrowser}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function assertReferencedFilesExist(manifest) {
  for (const contentScript of manifest.content_scripts ?? []) {
    for (const relativePath of [...(contentScript.js ?? []), ...(contentScript.css ?? [])]) {
      if (!existsSync(join(repoRoot, relativePath))) {
        throw new Error(`Manifest references missing file: ${relativePath}`);
      }
    }
  }
}

function validateManifest(browser, manifest, packageJson) {
  if (manifest.manifest_version !== 3) {
    throw new Error(`${browser}: only Manifest V3 is supported.`);
  }

  if (manifest.version !== packageJson.version) {
    throw new Error(`${browser}: manifest version ${manifest.version} does not match package.json ${packageJson.version}.`);
  }

  if (!manifest.host_permissions?.includes("https://rule34video.com/*")) {
    throw new Error(`${browser}: Rule34Video host permission is missing.`);
  }

  assertReferencedFilesExist(manifest);

  if (browser === "firefox") {
    const gecko = manifest.browser_specific_settings?.gecko;
    if (!gecko?.id) {
      throw new Error("firefox: browser_specific_settings.gecko.id is required for signing.");
    }
    if (!gecko.data_collection_permissions?.required?.length) {
      throw new Error("firefox: data_collection_permissions.required must be declared.");
    }
  }

  if (browser === "chrome" && manifest.browser_specific_settings) {
    throw new Error("chrome: Firefox-only browser_specific_settings leaked into the Chrome manifest.");
  }
}

function build(browser, baseManifest, packageJson) {
  const overlay = readJson(join(repoRoot, "manifests", `${browser}.json`));
  const manifest = merge(baseManifest, overlay);
  validateManifest(browser, manifest, packageJson);

  if (checkOnly) {
    return;
  }

  const outputDir = join(repoRoot, "dist", browser);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  for (const runtimePath of ["src", "assets"]) {
    const source = join(repoRoot, runtimePath);
    if (existsSync(source)) {
      cpSync(source, join(outputDir, runtimePath), { recursive: true });
    }
  }
  writeFileSync(join(outputDir, "src", "shared", "build-info.js"), `(() => { "use strict"; const app = globalThis.R34MF; if (app) app.build = Object.freeze({ id: ${JSON.stringify(buildId)}, timestamp: ${JSON.stringify(buildTimestamp)}, browser: ${JSON.stringify(browser)} }); })();\n`);

  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built ${browser} extension -> ${outputDir}`);
}

const packageJson = readJson(join(repoRoot, "package.json"));
const baseManifest = readJson(join(repoRoot, "manifests", "base.json"));
const targets = requestedBrowser === "all" ? [...browsers] : [requestedBrowser];

for (const browser of targets) {
  build(browser, baseManifest, packageJson);
}

if (checkOnly) {
  console.log(`Cross-browser manifest validation passed for: ${targets.join(", ")}.`);
}
