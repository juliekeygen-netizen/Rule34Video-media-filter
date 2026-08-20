import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("Settings follow-up cannot ping-pong Auto-update copy forever", () => {
  const p2 = read("src/ui/settings-p2-ui.js");
  const layout = read("src/ui/settings-layout-followup.js");
  const copy = "Automatically run Recent Update using the schedule below. Each successful run scans the configured newest subscription pages from page 1.";

  assert.ok(p2.includes(copy), "Part 2 Settings owns the canonical Auto-update description");
  assert.ok(layout.includes(copy), "Final layout must not fight Part 2 over the same observed text node");
  assert.doesNotMatch(layout, /new MutationObserver\(scheduleDecorate\)/);
  assert.match(layout, /mutationReplacedSettingsDialog/);
  assert.match(layout, /Only[\s\S]*react to that replacement/);
});

test("temporary Settings-icon emergency reset clears device-local extension state", () => {
  const source = read("src/content/settings-controller.js");

  assert.match(source, /ENABLE_EMERGENCY_STORAGE_RESET = true/);
  assert.match(source, /EMERGENCY_RESET_HOLD_MS = 650/);
  assert.match(source, /addEventListener\("contextmenu", triggerReset\)/);
  assert.match(source, /event\.pointerType !== "touch"/);
  assert.match(source, /clearExtensionDatabase\(\)/);
  assert.match(source, /transaction\.objectStore\(name\)\.clear\(\)/);
  assert.match(source, /clearStorageArea\("session"\)/);
  assert.match(source, /clearStorageArea\("local"\)/);
  assert.doesNotMatch(source, /clearStorageArea\("sync"\)/);
  assert.match(source, /Rule34Video cookies, subscriptions and other site data are NOT changed/);
});
