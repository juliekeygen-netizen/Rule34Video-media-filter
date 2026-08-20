(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.filterEngine;
  if (!app || !base) throw new Error("R34MF filter engine must load before Advanced Quality.");

  const QUALITY_OPERATORS = Object.freeze([
    ["equals", "Equals"],
    ["gt", "Greater than"],
    ["gte", "Greater than or equal to"],
    ["lt", "Less than"],
    ["lte", "Less than or equal to"]
  ]);
  const QUALITY_OPTIONS = Object.freeze([
    ["2160p", "2160p"], ["1080p", "1080p"], ["720p", "720p"], ["480p", "480p"], ["360p", "360p"]
  ]);
  const operatorKeys = new Set(QUALITY_OPERATORS.map(([value]) => value));
  const qualityKeys = new Set(QUALITY_OPTIONS.map(([value]) => value));
  const FIELD_DEFINITIONS = Object.freeze({
    ...base.FIELD_DEFINITIONS,
    quality: Object.freeze({ label: "Quality", source: "detail", editor: "quality", operators: QUALITY_OPERATORS, qualities: QUALITY_OPTIONS })
  });
  const ALL_FIELDS = Object.freeze(base.ALL_FIELDS.flatMap((field) => field === "hdAvailable" ? [field, "quality"] : [field]));
  const DETAIL_FIELDS = new Set([...base.DETAIL_FIELDS, "quality"]);

  const parseResolution = (value) => {
    const height = Number(String(value ?? "").toLocaleLowerCase().match(/(?:^|\b)(\d{3,5})p(?:\b|$)/)?.[1]);
    return Number.isFinite(height) && height > 0 ? height : null;
  };

  function qualityResolutions(details) {
    if (!details || details.status !== "complete") return null;
    const result = new Set();
    for (const format of Array.isArray(details.formats) ? details.formats : []) {
      for (const candidate of [format?.resolution, format?.quality, format?.name]) {
        const height = parseResolution(candidate);
        if (height) result.add(height);
      }
    }
    return result.size ? [...result].sort((a, b) => b - a) : null;
  }

  const qualityFingerprint = (details) => qualityResolutions(details)?.join(",") ?? null;
  const highestQuality = (details) => qualityResolutions(details)?.[0] ?? null;

  function defaultRuleConfig(field) {
    return field === "quality" ? { operator: "equals", value: "1080p" } : base.defaultRuleConfig(field);
  }

  function operatorLabel(field, operator) {
    return field === "quality"
      ? QUALITY_OPERATORS.find(([key]) => key === operator)?.[1] ?? "Equals"
      : base.operatorLabel(field, operator);
  }

  function validateRule(rule = {}) {
    if (rule.field !== "quality") return base.validateRule(rule);
    if (!operatorKeys.has(rule.operator)) return { valid: false, message: "Choose a valid quality condition." };
    if (!qualityKeys.has(String(rule.value ?? ""))) return { valid: false, message: "Choose a supported quality." };
    return { valid: true, message: "" };
  }

  function normalizeRule(raw = {}, connector = null) {
    if (raw.field !== "quality") return base.normalizeRule(raw, connector);
    return {
      id: raw.id || base.id("rule"), kind: "rule", enabled: raw.enabled !== false, connector,
      field: "quality", polarity: raw.polarity === "exclude" ? "exclude" : "match",
      operator: operatorKeys.has(raw.operator) ? raw.operator : "equals",
      value: qualityKeys.has(String(raw.value ?? "")) ? String(raw.value) : "1080p"
    };
  }

  function normalizeItems(items) {
    const result = [];
    for (const item of items ?? []) {
      if (item?.kind === "group") {
        const children = normalizeItems(item.items);
        if (children.length) result.push({ id: item.id || base.id("group"), kind: "group", enabled: item.enabled !== false, connector: result.length ? item.connector === "or" ? "or" : "and" : null, items: children });
      } else result.push(normalizeRule(item, result.length ? item?.connector === "or" ? "or" : "and" : null));
    }
    return result;
  }

  function normalize(filters) {
    const source = filters ?? {};
    const ordinary = base.normalize({ ...source, advanced: { enabled: false, items: [] } });
    const items = normalizeItems(source.advanced?.items);
    return { quick: ordinary.quick, detailed: ordinary.detailed, advanced: { enabled: source.advanced?.enabled === true && base.hasEffectiveExpression(items), items } };
  }

  function evaluateRule(video, details, rule, now = Date.now(), context = {}) {
    if (rule.field !== "quality") return base.evaluateRule(video, details, rule, now, context);
    if (!rule.enabled) return base.TRUE;
    const actual = highestQuality(details);
    const wanted = parseResolution(rule.value);
    let result = actual === null ? base.UNKNOWN : wanted === null ? base.FALSE : ({
      equals: actual === wanted, gt: actual > wanted, gte: actual >= wanted, lt: actual < wanted, lte: actual <= wanted
    })[rule.operator] ? base.TRUE : base.FALSE;
    return rule.polarity === "exclude" ? base.negate(result) : result;
  }

  function evaluateItems(video, details, items, now, context = {}) {
    let result = null;
    for (const item of items ?? []) {
      if (!item?.enabled) continue;
      const value = item.kind === "group" ? evaluateItems(video, details, item.items, now, context) : evaluateRule(video, details, item, now, context);
      result = result === null ? value : item.connector === "or" ? base.triOr(result, value) : base.triAnd(result, value);
    }
    return result ?? base.TRUE;
  }

  function evaluate(video, details, filters, now = Date.now(), context = {}) {
    const normalized = normalize(filters);
    return base.triAnd(base.evaluateSimple(video, details, normalized, context), normalized.advanced.enabled ? evaluateItems(video, details, normalized.advanced.items, now, context) : base.TRUE);
  }

  app.modules.filterEngine = Object.freeze({
    ...base, FIELD_DEFINITIONS, ALL_FIELDS, DETAIL_FIELDS, QUALITY_OPERATORS, QUALITY_OPTIONS,
    parseResolution, qualityResolutions, qualityFingerprint, highestQuality, defaultRuleConfig, operatorLabel,
    validateRule, normalizeRule, normalizeItems, normalize, evaluateRule, evaluateItems, evaluate
  });
})();
