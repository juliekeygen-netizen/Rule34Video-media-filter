import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));
const shell = readFileSync("src/ui/shell.js", "utf8");
const settingsUi = readFileSync("src/ui/settings.js", "utf8");

test("manifest runs the queue runtime site-wide while keeping subscriptions UI styles scoped", () => {
  assert.equal(manifest.manifest_version, 3);
  const runtime = manifest.content_scripts.find((entry) => entry.js?.includes("src/content/main.js"));
  const subscriptionsUi = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/styles.css"));
  assert.ok(runtime?.matches.includes("https://rule34video.com/*"));
  assert.ok(runtime?.matches.includes("https://www.rule34video.com/*"));
  assert.ok(subscriptionsUi?.matches.includes("https://rule34video.com/my/subscriptions*"));
  assert.ok(subscriptionsUi?.matches.includes("https://www.rule34video.com/my/subscriptions*"));
});

test("shell exposes Queue without a separate Scan/Update toolbar action", () => {
  assert.match(shell, /actions\.append\(control\("Queue", "queue"/);
  assert.doesNotMatch(shell, /control\("(?:Scan|Update|Scan\/Update)",/i);
});

test("Settings exposes the four current tabs from runtime source", () => {
  for (const label of ["Scanning & queue", "Local display", "Data & storage", "Advanced"]) {
    assert.match(settingsUi, new RegExp(label.replace(/[&]/g, "\\&"), "i"));
  }
});
