import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/content/video-player-feedback-layer-fix.js", "utf8");
const manifest = JSON.parse(readFileSync("manifests/base.json", "utf8"));

test("seek feedback is primed inside Flowplayer's visible UI overlay", () => {
  assert.match(source, /\.fp-player \.fp-ui, \.fp-ui/);
  assert.match(source, /ui\.append\(layer\)/);
  assert.match(source, /opacity", "1"/);
  assert.match(source, /visibility", "visible"/);
  assert.match(source, /pointer-events", "none"/);
  assert.match(source, /z-index", "50"/);
  assert.match(source, /layer\.append\(existing\)/);
  assert.match(source, /layer\.append\(node\)/);
});

test("custom button and native double-click paths prime the same overlay feedback nodes", () => {
  assert.match(source, /document\.addEventListener\("click", onClickCapture, true\)/);
  assert.match(source, /document\.addEventListener\("dblclick", onDoubleClickCapture, true\)/);
  assert.match(source, /ensureFeedbackNode\(root, button\.classList\.contains\("is-back"\)/);
  assert.match(source, /nativeDoubleClickDirection\(root, event\)/);
  assert.match(source, /if \(delta\) ensureFeedbackNode\(root, delta\)/);
});

test("feedback layer fix loads immediately after base video player controls", () => {
  const scripts = manifest.content_scripts[0].js;
  const baseIndex = scripts.indexOf("src/content/video-player-controls.js");
  const fixIndex = scripts.indexOf("src/content/video-player-feedback-layer-fix.js");
  assert.ok(baseIndex >= 0, "base player controls should be packaged");
  assert.equal(fixIndex, baseIndex + 1, "feedback layer fix should load immediately after base player controls");
});
