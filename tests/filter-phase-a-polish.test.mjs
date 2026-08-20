import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filters = await readFile(new URL("../src/ui/filters.js", import.meta.url), "utf8");
const hooks = await readFile(new URL("../src/content/filter-ui-hooks.js", import.meta.url), "utf8");
const controller = await readFile(new URL("../src/content/subscriptions-controller.js", import.meta.url), "utf8");
const modals = await readFile(new URL("../src/ui/filter-modals.js", import.meta.url), "utf8");
const modalPolish = await readFile(new URL("../src/ui/filter-modal-polish.js", import.meta.url), "utf8");
const css = await readFile(new URL("../src/ui/filters-polish.css", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifests/base.json", import.meta.url), "utf8"));

test("Filters width is derived from the Filters-to-Sort trigger span", () => {
  assert.match(filters, /sortBox\.right - filterBox\.left/);
  assert.match(hooks, /sortBox\.right - filterBox\.left/);
  assert.doesNotMatch(hooks, /Math\.min\(390/);
});

test("Sort popover follows the actual Sort trigger width", () => {
  assert.match(hooks, /host\.classList\?\.contains\("r34mf-sort-surface"\)/);
  assert.match(hooks, /width = anchorBox\?\.width/);
  assert.match(css, /--r34mf-sort-popover-width/);
});

test("tool anchoring resolves live toolbar controls instead of detached cached nodes", () => {
  assert.match(controller, /resolveToolAnchor\(action, preferredNode = null\)/);
  assert.match(controller, /preferredNode\?\.isConnected === true && this\.root\.contains\(preferredNode\)/);
  assert.match(controller, /resolveToolAnchor\("filters"\)/);
  assert.match(controller, /resolveToolAnchor\("sort"\)/);
  assert.match(controller, /repositionOpenTool\(\)/);
  assert.doesNotMatch(controller, /toolTrigger/);
  assert.match(hooks, /this\.resolveToolAnchor\(anchorAction, anchor\)/);
});

test("shell rerenders and window resize reposition open tools using live anchors", () => {
  assert.match(controller, /window\.addEventListener\("resize", this\.boundWindowResize\)/);
  assert.match(controller, /this\.repositionOpenTool\(\);/);
});

test("Unconfigured filter checkbox clicks suppress the browser's transient default toggle", () => {
  assert.match(filters, /action\.startsWith\("filter-toggle:"\)/);
  assert.match(filters, /event\.preventDefault\(\)/);
});

test("Normal modal backdrop is inert and singular filter Clear is absent from the renderer", () => {
  assert.match(modals, /event\.target === layer/);
  assert.doesNotMatch(modals, /button\("Clear", "clear"\)/);
  assert.doesNotMatch(modalPolish, /\[data-modal-action='clear'\]/);
  assert.match(modals, /type === "presets"/);
});

test("Preset CRUD keeps the Presets modal open", () => {
  assert.match(hooks, /filterModal = \{ type: "presets" \}/);
  for (const action of ["preset-create", "preset-select:", "preset-duplicate:", "preset-delete:", "preset-rename-submit"]) {
    assert.ok(hooks.includes(action), `expected preset action ${action}`);
  }
});

test("Preset rows use a visual active checkbox and a portal-style context menu", () => {
  assert.match(css, /\.r34mf-preset-row::before/);
  assert.match(css, /\.r34mf-preset-row\.is-active::before/);
  assert.match(css, /\.r34mf-preset-select small[\s\S]*display: none/);
  assert.match(css, /\.r34mf-preset-menu[\s\S]*position: fixed/);
  assert.match(modals, /overlayHost\.append\(menu\)/);
  assert.doesNotMatch(modals, /row\.append\(actions\)/);
  assert.match(modals, /!openMenu\.node\.contains\(event\.target\) && !openMenu\.trigger\.contains\(event\.target\)/);
  assert.match(modals, /event\.key === "Escape" && openMenu/);
});

test("Preset action control is a centered utility target with a subtle hover fill", () => {
  assert.match(css, /\.r34mf-preset-row \{[\s\S]*padding: 4px 8px 4px 9px/);
  assert.match(css, /\.r34mf-preset-menu-toggle \{[\s\S]*grid-column: 3/);
  assert.match(css, /\.r34mf-preset-menu-toggle \{[\s\S]*display: inline-flex[\s\S]*align-items: center[\s\S]*justify-content: center[\s\S]*width: 28px/);
  assert.match(css, /\.r34mf-preset-menu-toggle:hover,[\s\S]*background: rgba\(255,255,255,\.055\) !important/);
  assert.doesNotMatch(modals, /el\("small", "", "Active"\)/);
});

test("Phase A polish files load after the base filter UI", () => {
  const runtime = manifest.content_scripts.find((entry) => entry.js?.includes("src/content/main.js"));
  const styles = manifest.content_scripts.find((entry) => entry.css?.includes("src/ui/styles.css"));
  assert.ok(styles.css.indexOf("src/ui/filters-polish.css") > styles.css.indexOf("src/ui/filters.css"));
  assert.ok(styles.css.indexOf("src/ui/advanced-filter.css") > styles.css.indexOf("src/ui/filters-polish.css"));
  assert.ok(runtime.js.indexOf("src/ui/filter-modal-polish.js") > runtime.js.indexOf("src/ui/filter-modals.js"));
  assert.ok(runtime.js.indexOf("src/content/filter-ui-hooks.js") > runtime.js.indexOf("src/content/subscriptions-controller.js"));
});
