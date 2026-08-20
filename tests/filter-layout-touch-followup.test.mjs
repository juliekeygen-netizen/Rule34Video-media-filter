import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Filters parent is two-column everywhere and Advanced stays inside Detailed metadata", async () => {
  const [ui, css] = await Promise.all([
    read("src/ui/filter-layout-followup.js"),
    read("src/ui/filter-layout-followup.css")
  ]);
  assert.match(ui, /trim\(\)\.toUpperCase\(\) === "ADVANCED"/);
  assert.match(ui, /heading\.remove\(\)/);
  assert.match(css, /\.r34mf-filter-columns\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.r34mf-filter-column \.r34mf-filter-section\s*\{[\s\S]*white-space:\s*nowrap/);
});

test("desktop Filters and Sort anchors stay wide enough without the oversized Sort control", async () => {
  const css = await read("src/ui/filter-layout-followup.css");
  assert.match(css, /@media \(min-width: 761px\)/);
  assert.match(css, /data-r34mf-action="filters"[\s\S]*width:\s*132px[\s\S]*min-width:\s*132px/);
  assert.match(css, /r34mf-sort-control\[data-r34mf-action="sort"\][\s\S]*width:\s*224px[\s\S]*min-width:\s*224px/);
  assert.doesNotMatch(css, /r34mf-sort-control\[data-r34mf-action="sort"\][\s\S]*width:\s*260px/);
});

test("sort label is centered and the right chevron carries ascending or descending direction", async () => {
  const [shell, ui, css] = await Promise.all([
    read("src/ui/shell.js"),
    read("src/ui/filter-layout-followup.js"),
    read("src/ui/filter-layout-followup.css")
  ]);
  assert.match(shell, /const TITLE = "SUBSCRIPTION FILTER"/);
  assert.match(shell, /control\(`Sort: \$\{sortField\}`/);
  assert.match(shell, /className: `r34mf-sort-control is-sort-\$\{sortDirection\}`/);
  assert.doesNotMatch(shell, /Sort:.*[↑↓]/);
  assert.match(ui, /replace\(\/\\s\+\[↑↓\]\\s\*\$\/, ""\)/);
  assert.match(ui, /classList\.contains\("is-sort-asc"\)/);
  assert.match(ui, /classList\.toggle\("is-sort-asc"/);
  assert.match(ui, /classList\.toggle\("is-sort-desc"/);
  assert.match(ui, /ascending.*descending/);
  assert.match(css, /\.r34mf-sort-control\s*\{[\s\S]*justify-content:\s*center[\s\S]*text-align:\s*center/);
  assert.match(css, /\.r34mf-sort-control::after\s*\{[\s\S]*position:\s*absolute[\s\S]*right:\s*15px/);
  assert.match(css, /\.r34mf-sort-control\.is-sort-desc::after[\s\S]*rotate\(45deg\)/);
  assert.match(css, /\.r34mf-sort-control\.is-sort-asc::after[\s\S]*rotate\(225deg\)/);
});

test("mobile shell removes the redundant summary and uses the shortened title", async () => {
  const [ui, css] = await Promise.all([
    read("src/ui/filter-layout-followup.js"),
    read("src/ui/filter-layout-followup.css")
  ]);
  assert.match(ui, /SUBSCRIPTION FILTER/);
  assert.match(css, /\.r34mf-shell-summary\s*\{\s*display:\s*none !important/);
});

test("mobile Advanced polarity, condition, values and Group menu use explicit full-row geometry", async () => {
  const css = await read("src/ui/filter-layout-followup.css");
  assert.match(css, /\.r34mf-advanced-rule \.r34mf-advanced-polarity\s*\{[\s\S]*grid-column:\s*1 \/ -1 !important[\s\S]*grid-row:\s*2 !important/);
  assert.match(css, /\.r34mf-advanced-rule \.r34mf-advanced-condition\s*\{[\s\S]*grid-column:\s*1 \/ -1 !important[\s\S]*grid-row:\s*3 !important/);
  assert.match(css, /\.r34mf-advanced-rule \.r34mf-advanced-value,[\s\S]*grid-column:\s*1 \/ -1 !important[\s\S]*grid-row:\s*4 !important/);
  assert.match(css, /is-text \.r34mf-advanced-value,[\s\S]*is-entityOrText \.r34mf-advanced-value[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) !important/);
  assert.match(css, /is-entityOrText \.r34mf-advanced-value > \*[\s\S]*width:\s*100% !important/);
  assert.match(css, /is-date \.r34mf-date-control[\s\S]*width:\s*100% !important/);
  assert.match(css, /\.r34mf-advanced-logic \.r34mf-filter-select\s*\{[\s\S]*padding-right:\s*24px !important/);
  assert.match(css, /\.r34mf-group-header > \.r34mf-advanced-menu-toggle\s*\{[\s\S]*grid-column:\s*5 !important[\s\S]*grid-row:\s*1 !important/);
});

test("filter chips right-click editors except toggle-only chips", async () => {
  const ui = await read("src/ui/filter-layout-followup.js");
  assert.match(ui, /contextmenu/);
  assert.match(ui, /source === "advanced"\) return "advanced"/);
  assert.match(ui, /\["favorited", "hideSeenVideos", "hdAvailable"\]\.includes\(field\)/);
  assert.match(ui, /return `edit:\$\{source\}:\$\{field\}`/);
});

test("outside touch drag waits for pointerup only on mobile and Filters geometry spans Filters through Sort", async () => {
  const source = await read("src/content/filter-touch-followup-controller.js");
  assert.match(source, /DRAG_THRESHOLD = 8/);
  assert.match(source, /sortBox\.right - filterBox\.left/);
  assert.match(source, /setProperty\("left"[\s\S]*"important"\)/);
  assert.match(source, /if \(!isMobileViewport\(\)\) return basePointerDown\.call\(this, event\)/);
  assert.match(source, /document\.addEventListener\("pointermove"/);
  assert.match(source, /document\.addEventListener\("pointerup"/);
  assert.match(source, /if \(gesture\.moved \|\| movedEnough\(gesture, event\)/);
  assert.match(source, /controller\.closeFilters\?\.\(\)/);
  assert.match(source, /controller\.closeSort\?\.\(\)/);
});

test("manifest loads follow-ups after their base UI/runtime layers", async () => {
  const manifest = JSON.parse(await read("manifests/base.json"));
  const runtime = manifest.content_scripts.find((entry) => entry.js?.includes("src/content/main.js"));
  const styles = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/styles.css"));
  const css = styles.css;
  const js = runtime.js;
  assert.ok(css.indexOf("src/ui/filter-layout-followup.css") > css.indexOf("src/ui/mobile-followup.css"));
  assert.ok(js.indexOf("src/ui/filter-layout-followup.js") > js.indexOf("src/ui/filter-modal-polish.js"));
  assert.ok(js.indexOf("src/content/filter-touch-followup-controller.js") > js.indexOf("src/content/mobile-runtime-stability-controller.js"));
  assert.ok(js.indexOf("src/content/filter-touch-followup-controller.js") < js.indexOf("src/content/main.js"));
});
