(() => {
  "use strict";

  const app = globalThis.R34MF;
  const engine = app?.modules.filterEngine;
  if (!app || !engine) throw new Error("R34MF filter engine must load before filter drafts.");

  const numericFields = new Set(["duration", "views", "rating", "ratingVotes"]);
  const textFields = new Set(["title", "description"]);
  const entityFields = new Set(["artist", "uploader", "tags", "categories"]);
  const clone = engine.clone;

  const universal = (rule) => ({
    id: rule?.id || engine.id("rule"),
    kind: "rule",
    enabled: rule?.enabled !== false,
    connector: rule?.connector === "or" ? "or" : rule?.connector === "and" ? "and" : null,
    polarity: rule?.polarity === "exclude" ? "exclude" : "match"
  });

  const defaultConfig = (field) => engine.defaultRuleConfig(field);
  const normalDraft = (entry, field) => clone(entry?.value ?? defaultConfig(field));
  const updateNormalDraft = (draft, change) => ({ ...clone(draft), ...change });

  function defaultRule(field = "title", connector = null) {
    return { ...universal({ connector }), field, ...defaultConfig(field) };
  }

  function resetRuleField(rule, field) {
    return { ...universal(rule), field, ...defaultConfig(field) };
  }

  function changeRuleOperator(rule, operator) {
    const definition = engine.FIELD_DEFINITIONS[rule.field];
    if (!definition?.operators.some(([key]) => key === operator)) return clone(rule);
    const next = { ...universal(rule), field: rule.field, ...defaultConfig(rule.field), operator };
    const sameTextFamily = ["text", "entityOrText"].includes(definition.editor)
      && (rule.operator === "is") === (operator === "is");
    const sameDateFamily = definition.editor === "date" && (rule.operator === "within") === (operator === "within");
    if (["numeric", "compactNumeric", "rating"].includes(definition.editor) || sameTextFamily || sameDateFamily) {
      if (Object.hasOwn(next, "value")) next.value = rule.value ?? "";
      if (Object.hasOwn(next, "valueTo")) next.valueTo = rule.valueTo ?? "";
      if (Object.hasOwn(next, "unit") && rule.unit) next.unit = rule.unit;
      if (Object.hasOwn(next, "options")) {
        const allowed = engine.textOptionKeys(operator);
        next.options = Object.fromEntries(allowed.filter((key) => rule.options?.[key] === true).map((key) => [key, true]));
      }
    }
    if (rule.field === "artist" && operator === "amountOf") {
      next.value = "";
      next.countComparator = ["gt", "gte", "lte", "lt"].includes(rule.countComparator) ? rule.countComparator : "gt";
      delete next.options;
    }
    return next;
  }

  function listFor(draft, parentId = "root") {
    return parentId === "root" || !parentId ? draft.items : draft.items.find((item) => item.id === parentId && item.kind === "group")?.items;
  }

  function normalizeConnectors(items) {
    (items ?? []).forEach((item, index) => { item.connector = index ? item.connector === "or" ? "or" : "and" : null; });
    return items;
  }

  function reorder(draft, { parentId = "root", id, beforeId = null }) {
    const next = clone(draft);
    const items = listFor(next, parentId);
    if (!items) return next;
    const from = items.findIndex((item) => item.id === id);
    if (from < 0 || (beforeId && !items.some((item) => item.id === beforeId))) return next;
    const [item] = items.splice(from, 1);
    let target = beforeId ? items.findIndex((candidate) => candidate.id === beforeId) : items.length;
    if (target < 0) target = items.length;
    items.splice(target, 0, item);
    normalizeConnectors(items);
    return next;
  }

  function move(draft, { parentId = "root", id, direction }) {
    const items = listFor(draft, parentId);
    const index = items?.findIndex((item) => item.id === id) ?? -1;
    const target = index + (direction === "up" ? -1 : 1);
    if (index < 0 || target < 0 || target >= items.length) return clone(draft);
    return direction === "up"
      ? reorder(draft, { parentId, id, beforeId: items[target].id })
      : reorder(draft, { parentId, id, beforeId: items[target + 1]?.id ?? null });
  }

  function counts(items, parentEnabled = true) {
    let rules = 0, enabled = 0, groups = 0;
    for (const item of items ?? []) {
      if (item.kind === "group") {
        groups += 1;
        const child = counts(item.items, parentEnabled && item.enabled !== false);
        rules += child.rules;
        enabled += child.enabled;
        groups += child.groups;
      } else {
        rules += 1;
        if (parentEnabled && item.enabled !== false) enabled += 1;
      }
    }
    return { rules, enabled, groups };
  }

  function detailedCount(items, globallyEnabled = true, parentEnabled = true) {
    if (!globallyEnabled) return 0;
    let total = 0;
    for (const item of items ?? []) {
      if (item.kind === "group") total += detailedCount(item.items, true, parentEnabled && item.enabled !== false);
      else if (parentEnabled && item.enabled !== false && engine.DETAIL_FIELDS.has(item.field)) total += 1;
    }
    return total;
  }

  function quote(value) {
    return `"${String(value ?? "").replace(/"/g, '\\"')}"`;
  }

  function compact(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) < 1000) return String(value ?? "");
    const [scale, suffix] = Math.abs(number) >= 1e9 ? [1e9, "B"] : Math.abs(number) >= 1e6 ? [1e6, "M"] : [1e3, "K"];
    return `${Math.round(number / scale * 10) / 10}${suffix}`;
  }

  function formatRule(rule) {
    const definition = engine.FIELD_DEFINITIONS[rule.field] ?? engine.FIELD_DEFINITIONS.title;
    const prefix = rule.polarity === "exclude" ? "Exclude " : "";
    if (["boolean", "membership"].includes(definition.editor)) {
      const unknown = definition.editor === "membership" && rule.options?.includeWithoutDetails === true ? " + unknown details" : "";
      return `${prefix}${definition.label}${unknown}`;
    }
    if (definition.editor === "entity") return `${prefix}${definition.label} includes ${quote(rule.value)}`;
    if (rule.field === "artist" && rule.operator === "amountOf") {
      const comparator = ({ gt: ">", gte: "≥", lte: "≤", lt: "<" })[rule.countComparator] ?? ">";
      return `${prefix}Artist amount ${comparator} ${rule.value ?? ""}`.trim();
    }
    const operator = engine.operatorLabel(rule.field, rule.operator).toLocaleLowerCase();
    let value = rule.value ?? "";
    if (["views", "ratingVotes"].includes(rule.field)) value = compact(value);
    if (["text", "entityOrText"].includes(definition.editor)) {
      if (rule.operator === "contains" && rule.options?.separateByCommas === true) {
        const terms = engine.commaTerms(rule.value);
        const shown = terms.slice(0, 3).map(quote).join(", ");
        value = `${shown}${terms.length > 3 ? `, +${terms.length - 3} more` : ""}${rule.options?.matchAnyWord ? " (words within each)" : ""}`;
        return `${prefix}${definition.label} contains any of ${value}`;
      }
      value = quote(value);
    }
    if (rule.field === "rating") value = `${value}%`;
    if (rule.operator === "between") {
      let end = rule.valueTo ?? "";
      if (["views", "ratingVotes"].includes(rule.field)) end = compact(end);
      if (rule.field === "rating") end = `${end}%`;
      const unit = rule.field === "duration" ? ` ${rule.unit ?? "minutes"}` : "";
      return `${prefix}${definition.label} is ${operator} ${value} and ${end}${unit}`;
    }
    if (rule.field === "duration") value = `${value} ${rule.unit ?? "minutes"}`;
    if (rule.field === "uploadDate" && rule.operator === "within") value = `${value} ${rule.unit ?? "days"}`;
    return `${prefix}${definition.label} ${["gt", "gte", "lt", "lte", "between"].includes(rule.operator) ? "is " : ""}${operator} ${value}`.trim();
  }

  function expressionNode(items) {
    const effective = (items ?? []).filter((item) => item.enabled !== false && (item.kind !== "group" || engine.hasEffectiveExpression(item.items)));
    if (!effective.length) return null;
    const leaf = (item) => item.kind === "group" ? { type: "group", child: expressionNode(item.items) } : { type: "rule", text: formatRule(item) };
    let result = leaf(effective[0]);
    for (let index = 1; index < effective.length; index += 1) result = { type: "binary", connector: effective[index].connector === "or" ? "OR" : "AND", left: result, right: leaf(effective[index]) };
    return result;
  }

  function renderExpression(node, depth = 0, explicit = false) {
    const indent = "  ".repeat(depth);
    if (!node) return `${indent}No enabled rules.`;
    if (node.type === "rule") return `${indent}${node.text}`;
    if (node.type === "group") {
      const inside = renderExpression(node.child, depth + 1, false);
      return `${indent}(\n${inside}\n${indent})`;
    }
    const left = renderExpression(node.left, depth + (explicit ? 1 : 0), explicit);
    const right = renderExpression(node.right, depth + (explicit ? 1 : 0), false);
    const body = `${left}\n${"  ".repeat(depth + (explicit ? 1 : 0))}${node.connector}\n${right}`;
    return explicit ? `${indent}(\n${body}\n${indent})` : body;
  }

  function preview(items) {
    const node = expressionNode(items);
    if (!node) return ["No enabled rules."];
    const mixed = new Set();
    const visit = (current) => { if (!current) return; if (current.type === "binary") { mixed.add(current.connector); visit(current.left); visit(current.right); } else if (current.type === "group") visit(current.child); };
    visit(node);
    return renderExpression(node, 0, mixed.size > 1).split("\n");
  }

  function validate(items, parentEnabled = true, path = []) {
    const errors = [];
    for (const item of items ?? []) {
      const nextPath = [...path, item.id];
      if (item.kind === "group") {
        if (parentEnabled && item.enabled !== false) errors.push(...validate(item.items, true, nextPath));
      } else if (parentEnabled && item.enabled !== false) {
        const result = engine.validateRule(item);
        if (!result.valid) errors.push({ id: item.id, path: nextPath, message: result.message });
      }
    }
    return errors;
  }

  function createGroup(connector = null) {
    return { id: engine.id("group"), kind: "group", enabled: true, connector, items: [defaultRule("title", null)] };
  }

  function duplicateItem(item) {
    const copy = clone(item);
    copy.id = engine.id(item.kind === "group" ? "group" : "rule");
    if (copy.kind === "group") copy.items = copy.items.map((child) => ({ ...clone(child), id: engine.id("rule") }));
    return copy;
  }

  function mutate(draft, operation) {
    let next = clone(draft);
    const parentId = operation.parentId ?? "root";
    const items = listFor(next, parentId);
    if (!items) return next;
    const index = items.findIndex((item) => item.id === operation.id);
    if (operation.type === "addRule") items.push(defaultRule("title", items.length ? "and" : null));
    else if (operation.type === "addGroup" && parentId === "root") items.push(createGroup(items.length ? "and" : null));
    else if (index >= 0 && operation.type === "delete") items.splice(index, 1);
    else if (index >= 0 && operation.type === "duplicate") items.splice(index + 1, 0, duplicateItem(items[index]));
    else if (index >= 0 && operation.type === "toggle") items[index].enabled = !items[index].enabled;
    normalizeConnectors(items);
    return next;
  }

  function serialize(draft) {
    return { enabled: draft?.enabled === true, items: engine.normalizeItems(draft?.items) };
  }

  app.modules.filterDraft = Object.freeze({
    numericFields, textFields, entityFields, defaultConfig, normalDraft, updateNormalDraft, defaultRule,
    resetRuleField, changeRuleOperator, listFor, normalizeConnectors, reorder, move, counts, detailedCount,
    formatRule, preview, validate, createGroup, duplicateItem, mutate, serialize
  });
})();
