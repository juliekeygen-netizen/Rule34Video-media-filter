import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = () => JSON.parse(readFileSync("manifests/base.json", "utf8"));

test("video pages receive native-style Seen UI through the shared site runtime", () => {
  const value = manifest();
  const runtime = value.content_scripts.find((entry) => entry.js?.includes("src/content/main.js"));
  const videoStyles = value.content_scripts.find((entry) => entry.css?.includes("src/ui/video-page-seen.css"));
  assert.ok(runtime?.matches.includes("https://rule34video.com/*"));
  assert.ok(runtime?.js.includes("src/storage/seen-store.js"));
  assert.ok(runtime?.js.includes("src/content/video-page-seen.js"));
  assert.deepEqual(videoStyles?.css, ["src/ui/video-page-seen.css", "src/ui/video-player-controls.css"]);
  assert.ok(videoStyles?.matches.some((entry) => entry.includes("/video/*")));

  const source = readFileSync("src/content/video-page-seen.js", "utf8");
  assert.match(source, /\^\\\/videos\?\\\/\\d\+/);
  assert.match(source, /anchors\.menu\.insertBefore\(wrapper, anchors\.playlist\)/);
  assert.match(source, /className = "btn-favourites r34mf-seen-control"/);
  assert.match(source, /className = "button_fav r34mf-seen-button"/);
  assert.match(source, /Add to seen/);
  assert.match(source, /Remove from seen/);
  assert.match(source, /aria-pressed/);
});

test("Seen icon keeps the native 24px action-icon footprint without restyling native action cards", () => {
  const css = readFileSync("src/ui/video-page-seen.css", "utf8");
  assert.match(css, /\.r34mf-seen-icon[\s\S]*width:\s*24px;[\s\S]*height:\s*24px;/);
  assert.doesNotMatch(css, /background\s*:/, "native .button_fav background/hover styling should remain authoritative");
});
