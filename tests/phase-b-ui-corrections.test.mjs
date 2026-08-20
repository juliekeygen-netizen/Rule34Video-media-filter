import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const runtimeFiles = [
  "src/shared/namespace.js",
  "src/filters/filter-engine.js",
  "src/filters/filter-draft.js",
  "src/ui/date-control.js",
  "src/ui/entity-picker.js",
  "src/ui/filters.js",
  "src/ui/advanced-filter-editor.js",
  "src/ui/filter-modals.js",
  "src/ui/filter-modal-polish.js"
];

function runtime() {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  window.console = console;
  window.queueMicrotask = queueMicrotask;
  window.innerWidth = 1280;
  window.innerHeight = 900;
  window.scrollX = 13;
  window.scrollY = 29;
  window.scrollTo = (x, y) => { window.scrollX = x; window.scrollY = y; };
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return this.classList?.contains("r34mf-date-picker")
      ? { top: 0, bottom: 260, left: 0, right: 236, width: 236, height: 260 }
      : { top: 100, bottom: 136, left: 100, right: 320, width: 220, height: 36 };
  };
  const context = vm.createContext(window);
  for (const file of runtimeFiles) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const root = document.createElement("div");
  root.dataset.r34mfRoot = "subscriptions";
  document.body.append(root);
  return { window, document, root, app: context.R34MF };
}

function modalState(env, modal) {
  const filters = env.app.modules.filterEngine.createEmpty();
  return {
    root: env.root,
    filters,
    coverage: { detailed: 0, total: 5142 },
    vocabulary: {},
    preset: { id: "default", name: "Default", filters },
    presets: [{ id: "default", name: "Default", filters }],
    modal
  };
}

function renderAdvanced(env, rule) {
  const filters = env.app.modules.filterEngine.createEmpty();
  filters.advanced.items = [rule];
  const sent = [];
  const layer = env.app.modules.filterModals.render(modalState(env, {
    type: "advanced",
    draft: filters.advanced,
    enableOnApply: false
  }), (action, payload) => sent.push({ action, payload }));
  return { layer, sent };
}

function key(window, target, value) {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value });
  target.dispatchEvent(event);
}

test("Advanced headings, text options, Logic geometry, and Rating suffix use the corrected structure", () => {
  const env = runtime();
  const title = env.app.modules.filterDraft.defaultRule("title");
  title.value = "animation";
  let view = renderAdvanced(env, title);
  const headings = view.layer.querySelector(".r34mf-advanced-columns").textContent;
  assert.match(headings, /LOGIC/);
  assert.match(headings, /FIELD/);
  assert.match(headings, /MATCH \/ EXCLUDE/);
  assert.match(headings, /OPTIONS/);
  assert.doesNotMatch(headings, /CONDITION|VALUE \/ OPTIONS/);
  assert.equal(view.layer.textContent.includes("TEXT OPTIONS"), false);
  assert.ok(view.layer.querySelector(".r34mf-text-options input[type='checkbox']"));

  env.app.modules.filterModals.render({ ...modalState(env, null), modal: null }, () => {});
  const rating = env.app.modules.filterDraft.defaultRule("rating");
  rating.value = "90";
  view = renderAdvanced(env, rating);
  const suffix = view.layer.querySelector(".r34mf-rating-suffix");
  assert.equal(suffix.textContent, "%");

  const css = readFileSync("src/ui/advanced-filter.css", "utf8");
  assert.match(css, /--r34mf-advanced-columns:[^;]*84px/);
  assert.doesNotMatch(css, /--r34mf-advanced-columns:[^;]*68px/);
  assert.match(css, /\.r34mf-rating-suffix \{ padding-right: 10px/);
});

test("Advanced single entity picker stays compact without shrinking normal multi-select rails", () => {
  const env = runtime();
  const view = renderAdvanced(env, env.app.modules.filterDraft.defaultRule("tags"));
  const picker = view.layer.querySelector(".r34mf-entity-picker");
  assert.ok(picker.classList.contains("is-compact-single"));
  assert.ok(picker.querySelector("input[type='search']"));
  assert.match(picker.querySelector(".r34mf-entity-results-wrap").textContent, /RESULTS.*0 \/ 5\D?142 detailed.*No detailed tag metadata yet\./s);

  const css = readFileSync("src/ui/advanced-filter.css", "utf8");
  assert.match(css, /\.is-compact-single \.r34mf-entity-results \{ min-height: 30px/);
  assert.doesNotMatch(css, /\.is-compact-single[^}]*min-height:\s*68px/);
  assert.match(readFileSync("src/ui/filters.css", "utf8"), /\.r34mf-entity-results \{[\s\S]*min-height: 30px/);
});

test("date pickers portal above the modal, close independently, and only one can be open", () => {
  const env = runtime();
  const rule = env.app.modules.filterDraft.defaultRule("uploadDate");
  rule.operator = "between";
  const { layer, sent } = renderAdvanced(env, rule);
  const controls = layer.querySelectorAll(".r34mf-date-control");
  const bodyChildren = layer.querySelector(".r34mf-advanced-modal-body").children.length;

  controls[0].querySelector(".r34mf-date-toggle").click();
  let picker = layer.querySelector(":scope > .r34mf-date-picker");
  assert.ok(picker);
  assert.equal(controls[0].contains(picker), false);
  assert.equal(layer.querySelector(".r34mf-advanced-modal-body").children.length, bodyChildren);

  controls[1].querySelector(".r34mf-date-toggle").click();
  picker = layer.querySelector(":scope > .r34mf-date-picker");
  assert.ok(picker);
  assert.equal(layer.querySelectorAll(":scope > .r34mf-date-picker").length, 1);
  assert.equal(controls[0].querySelector(".r34mf-date-toggle").getAttribute("aria-expanded"), "false");

  key(env.window, layer, "Escape");
  assert.equal(layer.querySelector(".r34mf-date-picker"), null);
  assert.equal(sent.length, 0);
  controls[0].querySelector(".r34mf-date-toggle").click();
  layer.dispatchEvent(new env.window.Event("pointerdown", { bubbles: true }));
  assert.equal(layer.querySelector(".r34mf-date-picker"), null);
  assert.equal(sent.length, 0);
});

test("normal, Presets, and Advanced modals lock page scrolling and final close restores it", () => {
  for (const modal of [
    { type: "normal", source: "quick", field: "title", draft: { operator: "contains", value: "", options: {} } },
    { type: "presets" },
    { type: "advanced", draft: { enabled: false, items: [] } }
  ]) {
    const env = runtime();
    env.document.documentElement.style.overflow = "visible";
    env.document.body.style.overflow = "clip";
    env.app.modules.filterModals.render(modalState(env, modal), () => {});
    assert.equal(env.document.body.dataset.r34mfModalScrollLock, "true");
    assert.equal(env.document.documentElement.style.overflow, "hidden");
    assert.equal(env.document.body.style.position, "fixed");
    env.app.modules.filterModals.render(modalState(env, null), () => {});
    assert.equal(env.document.body.dataset.r34mfModalScrollLock, undefined);
    assert.equal(env.document.documentElement.style.overflow, "visible");
    assert.equal(env.document.body.style.overflow, "clip");
    assert.deepEqual([env.window.scrollX, env.window.scrollY], [13, 29]);
  }
  const css = readFileSync("src/ui/filters.css", "utf8");
  assert.match(css, /\.r34mf-modal-content \{[\s\S]*overscroll-behavior: contain/);
  assert.match(css, /\.r34mf-modal-layer \{[\s\S]*overscroll-behavior: none/);
});

test("normal modal has only Cancel and Apply and ignores its scrim", () => {
  const env = runtime();
  const sent = [];
  const layer = env.app.modules.filterModals.render(modalState(env, {
    type: "normal",
    source: "quick",
    field: "title",
    draft: { operator: "contains", value: "saved", options: {} }
  }), (action) => sent.push(action));
  const footer = [...layer.querySelectorAll(".r34mf-modal-footer button")].map((button) => button.textContent.trim());
  assert.deepEqual(footer, ["Cancel", "Apply"]);
  layer.click();
  assert.deepEqual(sent, []);
});

test("Disable all clears enable flags while deeply preserving configured filter and preset data", () => {
  const env = runtime();
  const f = env.app.modules.filterEngine;
  const configured = f.createEmpty();
  configured.quick.title = { enabled: true, value: { operator: "contains", value: "animation", options: { wholeWord: true } } };
  configured.quick.views = { enabled: true, value: { operator: "gte", value: "100K", valueTo: "" } };
  configured.detailed.tags = { enabled: true, value: ["animated", "female"], tagMatch: "all" };
  const rule = env.app.modules.filterDraft.defaultRule("rating");
  Object.assign(rule, { value: "90", polarity: "exclude" });
  configured.advanced = { enabled: true, items: [rule] };
  const before = f.clone(configured);
  const disabled = f.disableAll(configured);

  assert.equal(f.countApplied(disabled), 0);
  assert.ok(Object.values(disabled.quick).every((entry) => entry.enabled === false));
  assert.ok(Object.values(disabled.detailed).every((entry) => entry.enabled === false));
  assert.equal(disabled.advanced.enabled, false);
  assert.deepEqual(disabled.quick.title.value, before.quick.title.value);
  assert.deepEqual(disabled.quick.views.value, before.quick.views.value);
  assert.deepEqual(disabled.detailed.tags, { ...before.detailed.tags, enabled: false });
  assert.deepEqual(disabled.advanced.items, before.advanced.items);
  assert.equal(JSON.stringify(configured), JSON.stringify(before), "Disable all must not mutate the active preset source object");

  const surface = env.app.modules.filtersUi.render({ ...modalState(env, null), filters: disabled }, () => {});
  assert.equal(surface.querySelector("[data-action='disable-all']").disabled, true);
  assert.match(surface.querySelector("[data-filter-field='title'] .r34mf-filter-row-summary").textContent, /animation/);
});

test("normal and Advanced Upload date Within share the full engine unit vocabulary", () => {
  const expected = ["minutes", "hours", "days", "weeks", "months", "years"];
  const env = runtime();
  let layer = env.app.modules.filterModals.render(modalState(env, {
    type: "normal",
    source: "detailed",
    field: "uploadDate",
    draft: { operator: "within", value: "2", unit: "hours" }
  }), () => {});
  assert.deepEqual([...layer.querySelector("select[aria-label='Relative date unit']").options].map((option) => option.value), expected);

  env.app.modules.filterModals.render(modalState(env, null), () => {});
  const rule = env.app.modules.filterDraft.defaultRule("uploadDate");
  Object.assign(rule, { operator: "within", value: "2", unit: "hours" });
  layer = renderAdvanced(env, rule).layer;
  assert.deepEqual([...layer.querySelector("select[aria-label='Relative date unit']").options].map((option) => option.value), expected);
});

test("Preset ellipsis shares the Advanced utility geometry and restores only its own hover surface", () => {
  const css = readFileSync("src/ui/filters-polish.css", "utf8");
  assert.match(css, /\.r34mf-preset-row \{[\s\S]*padding: 4px 8px 4px 9px/);
  assert.match(css, /\.r34mf-preset-menu-toggle \{[\s\S]*justify-self: end[\s\S]*width: 28px[\s\S]*min-height: 28px/);
  assert.match(css, /display: inline-flex[\s\S]*align-items: center[\s\S]*justify-content: center/);
  assert.match(css, /\.r34mf-preset-menu-toggle:hover,[\s\S]*rgba\(255,255,255,\.055\)/);
  assert.doesNotMatch(css, /\.r34mf-preset-row:hover[^}]*rgba\(255,255,255,\.055\)/s);
});
