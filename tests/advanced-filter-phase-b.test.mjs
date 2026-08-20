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
  "src/ui/filter-modals.js"
];

function runtime() {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  window.console = console;
  window.queueMicrotask = queueMicrotask;
  window.innerWidth = 1280;
  window.innerHeight = 900;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 132, left: 100, right: 260, width: 160, height: 32 });
  const context = vm.createContext(window);
  for (const file of runtimeFiles) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const root = document.createElement("div");
  root.dataset.r34mfRoot = "subscriptions";
  document.body.append(root);
  return { window, document, root, app: context.R34MF };
}

function renderAdvanced(items, options = {}) {
  const env = runtime();
  const sent = [];
  const filters = env.app.modules.filterEngine.createEmpty();
  filters.advanced = { enabled: options.globallyEnabled === true, items: env.app.modules.filterEngine.clone(items) };
  const state = {
    root: env.root,
    filters,
    coverage: { detailed: 4138, total: 5142 },
    vocabulary: options.vocabulary ?? {},
    modal: { type: "advanced", draft: filters.advanced, enableOnApply: options.enableOnApply === true }
  };
  const layer = env.app.modules.filterModals.render(state, (action, payload) => sent.push({ action, payload }));
  return { ...env, layer, sent, state, debug: () => layer.querySelector(".r34mf-advanced-editor").__r34mfAdvancedDebug };
}

function change(window, control, value) {
  for (const option of control.querySelectorAll("option")) {
    if (option.value === value) option.setAttribute("selected", "");
    else option.removeAttribute("selected");
  }
  control.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function clickByText(root, text) {
  const control = [...root.querySelectorAll("button")].find((button) => button.textContent.trim() === text || button.textContent.trim().startsWith(text));
  assert.ok(control, `Expected a ${text} button`);
  control.click();
  return control;
}

function pointer(window, target, type, { x, id = 1, button = 0 }) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ clientX: x, pointerId: id, button })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

test("Advanced field switching rebuilds Title through Duration, Upload date, Tags, and HD in one draft", () => {
  const first = runtime();
  const rule = first.app.modules.filterDraft.defaultRule("title");
  const { window, layer, sent } = renderAdvanced([rule]);
  let field = layer.querySelector("select[aria-label='Rule field']");
  assert.ok(layer.querySelector(".r34mf-text-options-secondary"));

  change(window, field, "duration");
  assert.equal([...layer.querySelector("select[aria-label='Rule field']").options].find((option) => option.selected)?.value, "duration");
  assert.match(layer.querySelector("select[aria-label='Duration condition']").textContent, /Greater than or equal to/);
  assert.ok(layer.querySelector("select[aria-label='Duration unit']"));
  assert.equal(layer.querySelector(".r34mf-text-options-secondary"), null);

  field = layer.querySelector("select[aria-label='Rule field']");
  change(window, field, "uploadDate");
  assert.ok(layer.querySelector("select[aria-label='Upload date condition']"));
  assert.ok(layer.querySelector(".r34mf-date-control"));
  assert.equal(layer.querySelector("select[aria-label='Duration unit']"), null);

  field = layer.querySelector("select[aria-label='Rule field']");
  change(window, field, "tags");
  assert.ok(layer.querySelector(".r34mf-entity-picker.is-single input[type='search']"));
  assert.equal(layer.querySelector(".r34mf-advanced-condition").children.length, 0);

  field = layer.querySelector("select[aria-label='Rule field']");
  change(window, field, "hdAvailable");
  const hdRow = layer.querySelector(".r34mf-advanced-rule");
  assert.ok(hdRow.classList.contains("is-boolean-only"));
  assert.equal(hdRow.querySelector(".r34mf-advanced-condition").children.length, 0);
  assert.equal(hdRow.querySelector(".r34mf-advanced-value").children.length, 0);
  clickByText(layer, "Apply");
  assert.equal(sent.at(-1).action, "advanced-apply");
  assert.equal(sent.at(-1).payload.advanced.items[0].field, "hdAvailable");
});

test("Advanced operator changes reactively replace range, date, and entity editor anatomy", () => {
  const env = runtime();
  const draft = env.app.modules.filterDraft;
  let view = renderAdvanced([draft.defaultRule("views")]);
  change(view.window, view.layer.querySelector("select[aria-label='Views condition']"), "between");
  assert.equal(view.layer.querySelectorAll(".r34mf-advanced-range input").length, 2);

  view = renderAdvanced([draft.defaultRule("uploadDate")]);
  change(view.window, view.layer.querySelector("select[aria-label='Upload date condition']"), "between");
  assert.equal(view.layer.querySelectorAll(".r34mf-date-control").length, 2);
  change(view.window, view.layer.querySelector("select[aria-label='Upload date condition']"), "within");
  assert.equal(view.layer.querySelectorAll(".r34mf-date-control").length, 0);
  assert.ok(view.layer.querySelector("select[aria-label='Relative date unit'] option[value='hours']"));

  const artist = draft.defaultRule("artist");
  artist.operator = "contains";
  view = renderAdvanced([artist]);
  assert.ok(view.layer.querySelector("input[aria-label='Artist value']"));
  change(view.window, view.layer.querySelector("select[aria-label='Artist condition']"), "is");
  assert.equal(view.layer.querySelector("input[aria-label='Artist value']"), null);
  assert.ok(view.layer.querySelector(".r34mf-entity-picker.is-single"));
});

test("single Advanced entity selection collapses results and Change restores local search", () => {
  const env = runtime();
  const vocabulary = { tags: { covered: 4138, total: 5142, values: [{ value: "animated", count: 4209 }, { value: "female", count: 1316 }] } };
  const view = renderAdvanced([env.app.modules.filterDraft.defaultRule("tags")], { vocabulary });
  assert.match(view.layer.querySelector(".r34mf-entity-subhead").textContent, /RESULTS/);
  clickByText(view.layer, "animated");
  assert.ok(view.layer.querySelector(".r34mf-entity-selected-compact"));
  assert.equal(view.layer.querySelector(".r34mf-entity-results-wrap"), null);
  assert.equal(view.debug().getDraft().items[0].value, "animated");
  clickByText(view.layer, "Change");
  assert.ok(view.layer.querySelector(".r34mf-entity-results-wrap"));
  assert.equal(view.layer.querySelector(".r34mf-entity-selected-compact"), null);
});

test("normal entity picker orders Search, Results, Selected and Match while retaining counts", () => {
  const env = runtime();
  const filters = env.app.modules.filterEngine.createEmpty();
  filters.detailed.artist = { enabled: true, value: ["Artist A", "Artist B"], matchMode: "all" };
  env.app.modules.filterState = { active: () => ({ filters }) };
  const layer = env.app.modules.filterModals.render({
    root: env.root,
    filters,
    vocabulary: { artist: { covered: 5, total: 6, values: [{ value: "Artist A", count: 4 }, { value: "Artist B", count: 2 }] } },
    modal: { type: "normal", source: "detailed", field: "artist", draft: ["Artist A", "Artist B"] }
  }, () => {});
  const content = layer.querySelector(".r34mf-modal-content");
  const picker = content.querySelector(".r34mf-entity-picker");
  const anatomy = [...picker.children].map((node) => node.className);
  assert.deepEqual(anatomy, ["r34mf-entity-search", "r34mf-entity-results-wrap", "r34mf-entity-selected-wrap"]);
  assert.equal(content.lastElementChild.className, "r34mf-entity-match");
  assert.match(picker.querySelector(".r34mf-entity-chip").textContent, /Artist A\[4\]/);
  assert.equal(content.querySelector("select[aria-label='Artist match mode']").value, "all");
});

test("entity rails distinguish click from a drag that starts on a result or remove button", () => {
  const { app, document, window } = runtime();
  let selected = [];
  const picker = app.modules.entityPicker.create({
    field: "tags",
    selected,
    multiple: true,
    vocabulary: { covered: 3, total: 3, values: [{ value: "animated", count: 3 }, { value: "female", count: 2 }] },
    onChange: (value) => { selected = value; }
  });
  document.body.append(picker);
  let rail = picker.querySelector(".r34mf-entity-results");
  let result = rail.querySelector("button");
  rail.scrollLeft = 100;
  pointer(window, result, "pointerdown", { x: 100 });
  pointer(window, rail, "pointermove", { x: 130 });
  pointer(window, rail, "pointerup", { x: 130 });
  result.click();
  assert.equal(rail.scrollLeft, 70);
  assert.deepEqual(selected, []);

  result = picker.querySelector(".r34mf-entity-result");
  pointer(window, result, "pointerdown", { x: 100, id: 2 });
  pointer(window, result, "pointerup", { x: 100, id: 2 });
  result.click();
  assert.deepEqual([...selected], ["animated"]);

  const selectedRail = picker.querySelector(".r34mf-entity-selected-list");
  const remove = selectedRail.querySelector("button");
  selectedRail.scrollLeft = 80;
  pointer(window, remove, "pointerdown", { x: 80, id: 3 });
  pointer(window, selectedRail, "pointermove", { x: 100, id: 3 });
  pointer(window, selectedRail, "pointerup", { x: 100, id: 3 });
  remove.click();
  assert.equal(selectedRail.scrollLeft, 60);
  assert.deepEqual([...selected], ["animated"]);
  remove.click();
  assert.deepEqual([...selected], []);
});

test("Group DOM retains enable and logic controls, collapses transiently, and separates child/root additions", () => {
  const env = runtime();
  const draft = env.app.modules.filterDraft;
  const group = draft.createGroup("and");
  const view = renderAdvanced([draft.defaultRule("title"), group]);
  const header = view.layer.querySelector(".r34mf-group-header");
  assert.ok(header.querySelector("input[aria-label='Enable group']"));
  assert.equal([...header.querySelector("select[aria-label='Group logic']").options].find((option) => option.selected)?.value, "and");
  assert.match(header.textContent, /GROUP · 1 rule/);
  assert.equal(header.querySelector(".r34mf-group-disclosure"), null);
  header.click();
  assert.equal(view.layer.querySelector(".r34mf-group-children"), null);
  assert.equal(Object.hasOwn(view.debug().getDraft().items[1], "collapsed"), false);
  view.layer.querySelector(".r34mf-group-header").click();
  clickByText(view.layer.querySelector(".r34mf-group-children"), "+ Add rule to group");
  assert.equal(view.debug().getDraft().items[1].items.length, 2);
  const children = view.layer.querySelectorAll(".r34mf-group-children > .r34mf-advanced-rule");
  assert.ok(children[0].querySelector("input[aria-label^='Enable']"));
  assert.equal(children[0].querySelector(".r34mf-rule-logic-spacer") !== null, true);
  assert.ok(children[1].querySelector("input[aria-label^='Enable']"));
  assert.ok(children[1].querySelector("select[aria-label='Rule logic']"));
  assert.equal(view.debug().getDraft().items.length, 2);
  clickByText(view.layer.querySelector(".r34mf-advanced-actions"), "+ Add rule");
  assert.equal(view.debug().getDraft().items.length, 3);
});

test("Advanced rule and Group menus are portalled, actionable, and Escape closes a menu before the modal", () => {
  const env = runtime();
  const group = env.app.modules.filterDraft.createGroup();
  const view = renderAdvanced([group]);
  view.layer.querySelector(".r34mf-group-header .r34mf-advanced-menu-toggle").click();
  const menu = view.layer.querySelector(":scope > .r34mf-advanced-menu");
  assert.ok(menu);
  assert.equal(view.layer.querySelector(".r34mf-modal-advanced").contains(menu), false);
  assert.match(menu.textContent, /Add rule/);
  const firstEscape = new view.window.Event("keydown", { bubbles: true });
  Object.defineProperty(firstEscape, "key", { value: "Escape" });
  view.layer.dispatchEvent(firstEscape);
  assert.equal(view.layer.querySelector(".r34mf-advanced-menu"), null);
  assert.equal(view.sent.length, 0);
  const secondEscape = new view.window.Event("keydown", { bubbles: true });
  Object.defineProperty(secondEscape, "key", { value: "Escape" });
  view.layer.dispatchEvent(secondEscape);
  assert.equal(view.sent.at(-1).action, "modal-cancel");
});

test("Advanced scrim is inert while invalid enabled rules block Apply and disabled incomplete rules persist", () => {
  const env = runtime();
  const incomplete = env.app.modules.filterDraft.defaultRule("title");
  let view = renderAdvanced([incomplete]);
  view.layer.click();
  assert.equal(view.sent.length, 0);
  clickByText(view.layer, "Apply");
  assert.equal(view.sent.length, 0);
  assert.ok(view.layer.querySelector(".r34mf-advanced-rule.is-invalid"));

  incomplete.enabled = false;
  view = renderAdvanced([incomplete]);
  clickByText(view.layer, "Apply");
  assert.equal(view.sent.at(-1).action, "advanced-apply");
  assert.equal(view.sent.at(-1).payload.advanced.items[0].enabled, false);
  assert.equal(view.sent.at(-1).payload.advanced.items[0].value, "");
});

test("drag and menu Move actions share same-level connector-normalizing reorder semantics", () => {
  const env = runtime();
  const draft = env.app.modules.filterDraft;
  const first = draft.defaultRule("title"); first.value = "one";
  const second = draft.defaultRule("views", "or"); second.value = "1K";
  const third = draft.defaultRule("rating", "and"); third.value = "90";
  const view = renderAdvanced([first, second, third]);
  const rows = view.layer.querySelectorAll(".r34mf-advanced-modal-body > .r34mf-advanced-rule");
  const dragstart = new view.window.Event("dragstart", { bubbles: true });
  Object.defineProperty(dragstart, "dataTransfer", { value: { setData() {}, effectAllowed: "" } });
  rows[0].querySelector(".r34mf-drag").dispatchEvent(dragstart);
  const dragover = new view.window.Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(dragover, "clientY", { value: 140 });
  rows[1].dispatchEvent(dragover);
  const drop = new view.window.Event("drop", { bubbles: true, cancelable: true });
  rows[1].dispatchEvent(drop);
  let items = view.debug().getDraft().items;
  assert.deepEqual(items.map((item) => item.id), [second.id, first.id, third.id]);
  assert.deepEqual(items.map((item) => item.connector), [null, "and", "and"]);

  view.layer.querySelector(".r34mf-advanced-modal-body > .r34mf-advanced-rule .r34mf-advanced-menu-toggle").click();
  clickByText(view.layer.querySelector(".r34mf-advanced-menu"), "Move down");
  items = view.debug().getDraft().items;
  assert.deepEqual(items.map((item) => item.id), [first.id, second.id, third.id]);
});

test("left-fold evaluation, disabled Groups, global disablement, counts, and preview stay aligned", () => {
  const { app } = runtime();
  const f = app.modules.filterEngine;
  const d = app.modules.filterDraft;
  const a = d.defaultRule("title"); a.value = "a";
  const b = d.defaultRule("title", "or"); b.value = "b";
  const c = d.defaultRule("hdAvailable", "and");
  const items = [a, b, c];
  assert.equal(f.evaluateItems({ title: "a", hdAvailable: false }, null, items), f.FALSE, "A OR B AND C must left-fold as (A OR B) AND C");
  assert.match(d.preview(items).join("\n"), /\([\s\S]*OR[\s\S]*\)[\s\S]*AND/);

  const group = { id: "g", kind: "group", enabled: false, connector: "and", items: [d.defaultRule("description")] };
  const filters = f.createEmpty();
  filters.advanced = { enabled: true, items: [a, group] };
  assert.equal(d.counts(filters.advanced.items).enabled, 1);
  assert.equal(f.evaluate({ title: "a" }, null, filters), f.TRUE);
  filters.advanced.enabled = false;
  assert.equal(f.evaluate({ title: "no" }, null, filters), f.TRUE);
  assert.equal(f.countApplied(filters), 0);
});

test("Upload date Within supports Hours in validation, evaluation, and preview", () => {
  const { app } = runtime();
  const f = app.modules.filterEngine;
  const d = app.modules.filterDraft;
  const rule = d.defaultRule("uploadDate");
  Object.assign(rule, { operator: "within", value: "12", unit: "hours" });
  assert.equal(f.validateRule(rule).valid, true);
  const now = Date.parse("2026-08-11T12:00:00Z");
  const details = { status: "complete", exactUploadDate: "2026-08-11T01:30:00Z" };
  assert.equal(f.evaluateRule({}, details, rule, now), f.TRUE);
  assert.match(d.preview([rule]).join("\n"), /within 12 hours/i);
});

test("preview formats normalized compact-number values with user-facing suffixes", () => {
  const { app } = runtime();
  const rule = app.modules.filterEngine.normalizeRule({ field: "views", enabled: true, operator: "gte", value: "100K" });
  assert.equal(rule.value, 100000);
  assert.match(app.modules.filterDraft.preview([rule]).join("\n"), /100K/);
});

test("empty groups normalize away, empty Advanced disables, and transient collapse never serializes", () => {
  const { app } = runtime();
  const f = app.modules.filterEngine;
  const normalized = f.normalize({ advanced: { enabled: true, items: [{ id: "g", kind: "group", enabled: false, collapsed: true, items: [] }] } });
  assert.equal(normalized.advanced.items.length, 0);
  assert.equal(normalized.advanced.enabled, false);
  const group = app.modules.filterDraft.createGroup();
  group.collapsed = true;
  const saved = app.modules.filterDraft.serialize({ enabled: true, items: [group] });
  assert.equal(Object.hasOwn(saved.items[0], "collapsed"), false);
});

test("field reset preserves only universal state and removes incompatible editor properties", () => {
  const { app } = runtime();
  const title = app.modules.filterDraft.defaultRule("title", "or");
  Object.assign(title, { value: "animation", options: { caseSensitive: true, wholeWord: true }, stray: "remove me" });
  const duration = app.modules.filterDraft.resetRuleField(title, "duration");
  assert.deepEqual(
    { id: duration.id, enabled: duration.enabled, connector: duration.connector, polarity: duration.polarity },
    { id: title.id, enabled: true, connector: "or", polarity: "match" }
  );
  assert.equal(duration.field, "duration");
  assert.equal(duration.operator, "gte");
  assert.equal(Object.hasOwn(duration, "options"), false);
  assert.equal(Object.hasOwn(duration, "stray"), false);
});

test("Group duplication creates fresh IDs and disable/re-enable preserves every child config", () => {
  const { app } = runtime();
  const d = app.modules.filterDraft;
  const group = d.createGroup();
  group.items[0].value = "saved child";
  let expression = { enabled: true, items: [group] };
  expression = d.mutate(expression, { type: "duplicate", parentId: "root", id: group.id });
  assert.equal(expression.items.length, 2);
  assert.notEqual(expression.items[0].id, expression.items[1].id);
  assert.notEqual(expression.items[0].items[0].id, expression.items[1].items[0].id);
  expression = d.mutate(expression, { type: "toggle", parentId: "root", id: expression.items[0].id });
  assert.equal(expression.items[0].enabled, false);
  assert.equal(expression.items[0].items[0].value, "saved child");
  expression = d.mutate(expression, { type: "toggle", parentId: "root", id: expression.items[0].id });
  assert.equal(expression.items[0].enabled, true);
  assert.equal(expression.items[0].items[0].value, "saved child");
});

test("same-level reorder handles roots, Groups, and children while rejecting cross-level moves", () => {
  const { app } = runtime();
  const d = app.modules.filterDraft;
  const a = d.defaultRule("title");
  const group = d.createGroup("and");
  group.items.push(d.defaultRule("views", "or"));
  const expression = { enabled: true, items: [a, group] };
  const groupFirst = d.reorder(expression, { parentId: "root", id: group.id, beforeId: a.id });
  assert.deepEqual(groupFirst.items.map((item) => item.id), [group.id, a.id]);
  assert.deepEqual(groupFirst.items.map((item) => item.connector), [null, "and"]);
  const childrenReordered = d.reorder(groupFirst, { parentId: group.id, id: group.items[1].id, beforeId: group.items[0].id });
  assert.equal(childrenReordered.items[0].items[0].connector, null);
  const rejected = d.reorder(childrenReordered, { parentId: "root", id: group.items[0].id, beforeId: a.id });
  assert.deepEqual(rejected, childrenReordered);
});

test("Logic Preview updates from live draft input and enable changes before Apply", () => {
  const env = runtime();
  const d = env.app.modules.filterDraft;
  const title = d.defaultRule("title"); title.value = "animation";
  const views = d.defaultRule("views", "or"); views.value = "100K";
  const view = renderAdvanced([title, views]);
  view.layer.querySelector(".r34mf-logic-preview summary").click();
  const viewsInput = view.layer.querySelectorAll(".r34mf-advanced-rule")[1].querySelector(".r34mf-advanced-range input");
  viewsInput.value = "200K";
  viewsInput.dispatchEvent(new view.window.Event("input", { bubbles: true }));
  assert.match(view.layer.querySelector(".r34mf-logic-preview pre").textContent, /200K/);
  const enabled = view.layer.querySelectorAll(".r34mf-advanced-rule")[1].querySelector("input[type='checkbox']");
  enabled.checked = false;
  enabled.dispatchEvent(new view.window.Event("change", { bubbles: true }));
  assert.doesNotMatch(view.layer.querySelector(".r34mf-logic-preview pre").textContent, /200K/);
  assert.equal(view.sent.length, 0);
});

test("Group connector cells follow effective expression order and children retain the shared rule anatomy", () => {
  const env = runtime(); const d = env.app.modules.filterDraft;
  const first = d.createGroup();
  let view = renderAdvanced([first]);
  assert.ok(view.layer.querySelector(".r34mf-group-header .r34mf-rule-logic-spacer"));
  assert.equal(view.layer.querySelector(".r34mf-group-children > .r34mf-advanced-rule .r34mf-rule-primary").children.length >= 7, true);
  const disabled = d.defaultRule("title"); disabled.enabled = false;
  view = renderAdvanced([disabled, d.createGroup("or")]);
  assert.ok(view.layer.querySelectorAll(".r34mf-group-header")[0].querySelector(".r34mf-rule-logic-spacer"));
  const active = d.defaultRule("title"); active.value = "x";
  view = renderAdvanced([active, d.createGroup("or")]);
  assert.ok(view.layer.querySelector(".r34mf-group-header select[aria-label='Group logic']"));
  const group = d.createGroup(); group.items[0].enabled = false; group.items.push(d.defaultRule("views", "or"));
  view = renderAdvanced([group]);
  assert.ok(view.layer.querySelector(".r34mf-group-children > .r34mf-advanced-rule .r34mf-rule-logic-spacer"));
});

test("Group children retain the root rule positioning contract at desktop and responsive breakpoints", () => {
  const env = runtime(); const d = env.app.modules.filterDraft;
  const root = d.defaultRule("title"); root.value = "root";
  const group = d.createGroup(); group.items[0].value = "child";
  const view = renderAdvanced([root, group]);
  const rootPrimary = view.layer.querySelector(".r34mf-advanced-rule > .r34mf-rule-primary");
  const childPrimary = view.layer.querySelector(".r34mf-group-children > .r34mf-advanced-rule > .r34mf-rule-primary");
  assert.deepEqual([...childPrimary.children].map((node) => node.className), [...rootPrimary.children].map((node) => node.className));

  const css = readFileSync("src/ui/advanced-filter.css", "utf8");
  const childrenRule = [...css.matchAll(/\.r34mf-group-children \{[^}]*\}/g)].map((match) => match[0]).find((rule) => /margin:/.test(rule)) ?? "";
  const childRule = css.match(/\.r34mf-group-children > \.r34mf-advanced-rule \{[^}]*\}/)?.[0] ?? "";
  assert.match(childrenRule, /margin:\s*0/);
  assert.match(childrenRule, /padding:\s*0/);
  assert.doesNotMatch(childrenRule, /margin-left|padding-left|border-left/);
  assert.match(childRule, /margin:\s*0 -1px/);
  assert.doesNotMatch(css, /r34mf-group-disclosure/);
  assert.doesNotMatch(css, /@media \(max-width: 920px\)[\s\S]*r34mf-group-children[^}]*margin-left/);
  assert.doesNotMatch(css, /@media \(max-width: 620px\)[\s\S]*r34mf-group-children[^}]*margin-left/);
});

test("Artist Amount of initializes its comparator, validates without comparator interaction, and previews it", () => {
  const env = runtime(); const d = env.app.modules.filterDraft; const f = env.app.modules.filterEngine;
  let rule = d.defaultRule("artist"); rule = d.changeRuleOperator(rule, "amountOf");
  assert.equal(rule.countComparator, "gt");
  rule.value = "2";
  assert.equal(f.validateRule(rule).valid, true);
  assert.match(d.formatRule(rule), /Artist amount > 2/);
  for (const [countComparator, symbol] of [["gte", "≥"], ["lte", "≤"], ["lt", "<"]]) assert.match(d.formatRule({ ...rule, countComparator }), new RegExp(`Artist amount ${symbol} 2`));
  assert.equal(d.changeRuleOperator(rule, "contains").countComparator, undefined);
});

test("normal and Advanced numeric editors preserve compact values while removing invalid characters", () => {
  const env = runtime(); const filters = env.app.modules.filterEngine.createEmpty(); const sent = [];
  const layer = env.app.modules.filterModals.render({
    root: env.root, filters, coverage: {}, vocabulary: {},
    modal: { type: "normal", source: "quick", field: "views", draft: { operator: "gte", value: "" } }
  }, (action, payload) => sent.push({ action, payload }));
  const normal = layer.querySelector(".r34mf-filter-input");
  normal.value = "1.5K!";
  normal.dispatchEvent(new env.window.Event("input", { bubbles: true }));
  assert.equal(normal.value, "1.5K");
  clickByText(layer, "Apply");
  assert.equal(sent.at(-1).payload.value.value, "1.5K");

  const advanced = renderAdvanced([env.app.modules.filterDraft.defaultRule("rating")]);
  const rating = advanced.layer.querySelector("input[aria-label='Rating value']");
  rating.value = "99.5%?";
  rating.dispatchEvent(new advanced.window.Event("input", { bubbles: true }));
  assert.equal(rating.value, "99.5");
  assert.equal(advanced.debug().getDraft().items[0].value, "99.5");
});

test("normal Tags remain multi-select while Advanced Tags store exactly one canonical value", () => {
  const { app, document } = runtime();
  let selected = [];
  const picker = app.modules.entityPicker.create({
    field: "tags",
    selected,
    multiple: true,
    vocabulary: { covered: 2, total: 2, values: [{ value: "animated", count: 2 }, { value: "female", count: 1 }] },
    onChange: (value) => { selected = value; }
  });
  document.body.append(picker);
  clickByText(picker, "animated");
  clickByText(picker, "female");
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), ["animated", "female"]);

  const advanced = renderAdvanced([app.modules.filterDraft.defaultRule("tags")], { vocabulary: { tags: { covered: 2, total: 2, values: [{ value: "animated", count: 2 }, { value: "female", count: 1 }] } } });
  clickByText(advanced.layer, "animated");
  assert.equal(typeof advanced.debug().getDraft().items[0].value, "string");
  assert.equal(advanced.debug().getDraft().items[0].value, "animated");
});

test("Filters parent uses recursive leaf grammar and Advanced remains one shell-level category", () => {
  const { app, root } = runtime();
  const d = app.modules.filterDraft;
  const filters = app.modules.filterEngine.createEmpty();
  const group = d.createGroup("and");
  filters.advanced = { enabled: true, items: [d.defaultRule("hdAvailable"), group] };
  const host = app.modules.filtersUi.render({ root, filters, preset: { name: "Default" }, coverage: {}, presets: [] }, () => {});
  assert.equal(host.querySelector("[data-filter-source='advanced'] .r34mf-filter-row-summary").textContent, "2 rules");
  assert.equal(host.querySelector("[data-filter-section='detailed']").textContent, "DETAILED METADATA");
  assert.equal(app.modules.filtersUi.configuredSummary({ value: [] }, "artist"), "Any");
  assert.equal(app.modules.filtersUi.configuredSummary({ value: ["Nagoanimation"] }, "artist"), "Nagoanimation");
  assert.equal(app.modules.filtersUi.configuredSummary({ value: ["A", "B", "C"] }, "artist"), "A  B  C");
  filters.quick.hdAvailable.enabled = true;
  assert.equal(app.modules.filterEngine.countApplied(filters), 2, "one normal filter plus the whole Advanced block");
  group.items.length = 0;
  filters.advanced.items = [d.defaultRule("hdAvailable")];
  app.modules.filtersUi.patchParent(host.querySelector(".r34mf-filters-surface"), { filters, preset: { name: "Default" }, coverage: {} });
  assert.equal(host.querySelector("[data-filter-source='advanced'] .r34mf-filter-row-summary").textContent, "1 rule");
});

test("entity filter summaries pack by available width and retain the complete accessible selection", () => {
  const { app, root } = runtime();
  const summary = { clientWidth: 110, textContent: "", get scrollWidth() { return this.textContent.length * 8; } };
  assert.equal(app.modules.filtersUi.entitySummary(["Artist A", "Artist B", "Artist C", "Artist D"], summary), "Artist A  +3");
  const filters = app.modules.filterEngine.createEmpty();
  filters.detailed.artist = { enabled: true, value: ["Artist A", "Artist B", "Artist C"], matchMode: "all" };
  const host = app.modules.filtersUi.render({ root, filters, preset: { name: "Default" }, coverage: {}, presets: [] }, () => {});
  const rendered = host.querySelector("[data-filter-field='artist'] .r34mf-filter-row-summary");
  assert.match(rendered.title, /Artist A, Artist B, Artist C.*All selected/);
  assert.equal(rendered.getAttribute("aria-label"), rendered.title);
});

test("Advanced Apply commits the active preset, resets Local page, and emptiness disables the block", async () => {
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, queueMicrotask, Node: { ELEMENT_NODE: 1 } };
  context.globalThis = context;
  context.window = { location: { href: "https://rule34video.com/my/subscriptions/" }, innerWidth: 1280 };
  context.document = { documentElement: { clientWidth: 1280 }, querySelectorAll: () => [] };
  vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/shared/constants.js", "src/filters/filter-engine.js", "src/content/subscriptions-controller.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  const engine = context.R34MF.modules.filterEngine;
  const active = { id: "preset", filters: engine.createEmpty() };
  context.R34MF.modules.filterState = {
    value: { activePresetId: "preset" },
    commitFilters: async (filters) => { active.filters = engine.clone(filters); }
  };
  context.R34MF.modules.uiState = { save: async (value) => value };
  const controller = context.R34MF.modules.subscriptionsController;
  controller.state = { ...controller.state, localPage: 9, filters: engine.createEmpty() };
  controller.openFilters = async () => {};
  const rule = engine.normalizeRule({ field: "hdAvailable", enabled: true });
  await controller.handleIntent("advanced-apply", { advanced: { enabled: false, items: [rule] }, enableOnApply: true });
  assert.equal(active.filters.advanced.enabled, true);
  assert.equal(active.filters.advanced.items[0].field, "hdAvailable");
  assert.equal(controller.state.localPage, 1);
  await controller.handleIntent("advanced-apply", { advanced: { enabled: true, items: [] }, enableOnApply: false });
  assert.equal(active.filters.advanced.enabled, false);
  assert.equal(active.filters.advanced.items.length, 0);
});

test("responsive CSS reserves readable menu/logic tracks without obsolete Value headings", () => {
  const css = readFileSync("src/ui/advanced-filter.css", "utf8");
  const shared = readFileSync("src/ui/styles.css", "utf8");
  assert.match(css, /--r34mf-advanced-columns:/);
  assert.match(css, /grid-template-areas:[\s\S]*drag enabled logic field polarity menu/);
  assert.doesNotMatch(css, /VALUE \/ OPTIONS/);
  assert.doesNotMatch(css, /68px/);
  assert.match(css, /overflow-x: hidden/);
  assert.doesNotMatch(shared, /r34mf-advanced-value \{ display: contents/);
});
