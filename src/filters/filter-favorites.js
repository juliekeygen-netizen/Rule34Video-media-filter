(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.filterEngine;
  if (!app || !base) throw new Error("R34MF filter engine must load before Favorites filters.");

  const FIELD = "favorited";
  const FIELD_DEFINITIONS = Object.freeze({
    ...base.FIELD_DEFINITIONS,
    [FIELD]: Object.freeze({ label: "Favorited", source: "local", editor: "boolean", operators: Object.freeze([]), defaultConfig: Object.freeze({}) })
  });

  function categoriesBeforeTags(fields) {
    const result = [...fields].filter((field) => field !== "categories");
    const tagIndex = result.indexOf("tags");
    if (tagIndex >= 0) result.splice(tagIndex, 0, "categories");
    else result.push("categories");
    return result;
  }

  const QUICK_FIELDS = Object.freeze([...base.QUICK_FIELDS.filter((field) => field !== "hdAvailable"), FIELD]);
  const DETAILED_FIELDS = Object.freeze(categoriesBeforeTags(base.DETAILED_FIELDS));
  const normalFields = Object.freeze([...QUICK_FIELDS, ...DETAILED_FIELDS]);
  const DETAIL_FIELDS = new Set(base.DETAIL_FIELDS);

  const reordered = categoriesBeforeTags(base.ALL_FIELDS.filter((field) => field !== FIELD));
  const insertion = Math.max(reordered.indexOf("quality"), reordered.indexOf("hdAvailable"));
  reordered.splice(insertion >= 0 ? insertion + 1 : 0, 0, FIELD);
  const ALL_FIELDS = Object.freeze(reordered);

  function defaultRuleConfig(field) {
    return field === FIELD ? {} : base.defaultRuleConfig(field);
  }

  function configured(field, entry) {
    if (field === FIELD) return true;
    return base.configured(field, entry);
  }

  function createEmpty() {
    const ordinary = base.createEmpty();
    const quick = {};
    for (const field of QUICK_FIELDS) quick[field] = field === FIELD ? { enabled: false, value: true } : ordinary.quick[field];
    const detailed = {};
    for (const field of DETAILED_FIELDS) detailed[field] = ordinary.detailed[field];
    return { quick, detailed, advanced: ordinary.advanced };
  }

  function normalizeRule(raw = {}, connector = null) {
    if (raw.field !== FIELD) return base.normalizeRule(raw, connector);
    return {
      id: raw.id || base.id("rule"),
      kind: "rule",
      enabled: raw.enabled !== false,
      connector,
      field: FIELD,
      polarity: raw.polarity === "exclude" ? "exclude" : "match"
    };
  }

  function normalizeItems(items) {
    const result = [];
    for (const item of items ?? []) {
      if (item?.kind === "group") {
        const children = normalizeItems(item.items);
        if (children.length) {
          result.push({
            id: item.id || base.id("group"),
            kind: "group",
            enabled: item.enabled !== false,
            connector: result.length ? (item.connector === "or" ? "or" : "and") : null,
            items: children
          });
        }
      } else {
        result.push(normalizeRule(item, result.length ? (item?.connector === "or" ? "or" : "and") : null));
      }
    }
    return result;
  }

  function normalize(filters) {
    const source = filters ?? {};
    const ordinary = base.normalize({ ...source, advanced: { enabled: false, items: [] } });
    const quick = {};
    for (const field of QUICK_FIELDS) {
      quick[field] = field === FIELD
        ? { enabled: source.quick?.[FIELD]?.enabled === true, value: true }
        : ordinary.quick[field];
    }
    const detailed = {};
    for (const field of DETAILED_FIELDS) detailed[field] = ordinary.detailed[field];
    const items = normalizeItems(source.advanced?.items);
    return {
      quick,
      detailed,
      advanced: { enabled: source.advanced?.enabled === true && base.hasEffectiveExpression(items), items }
    };
  }

  function favoriteResult(video, context = {}) {
    const state = context.favorited;
    if (state?.status !== "complete") return base.UNKNOWN;
    return state.ids?.has?.(String(video?.videoId ?? "")) ? base.TRUE : base.FALSE;
  }

  function validateRule(rule = {}) {
    return rule.field === FIELD ? { valid: true, message: "" } : base.validateRule(rule);
  }

  function evaluateRule(video, details, rule, now = Date.now(), context = {}) {
    if (rule.field !== FIELD) return base.evaluateRule(video, details, rule, now, context);
    if (!rule.enabled) return base.TRUE;
    const result = favoriteResult(video, context);
    return rule.polarity === "exclude" ? base.negate(result) : result;
  }

  function evaluateItems(video, details, items, now, context = {}) {
    let result = null;
    for (const item of items ?? []) {
      if (!item?.enabled) continue;
      const value = item.kind === "group"
        ? evaluateItems(video, details, item.items, now, context)
        : evaluateRule(video, details, item, now, context);
      result = result === null ? value : item.connector === "or" ? base.triOr(result, value) : base.triAnd(result, value);
    }
    return result ?? base.TRUE;
  }

  function evaluateSimple(video, details, filters, context = {}) {
    // Higher evaluation layers pass an already-normalized filter object here.
    // Re-normalizing it once per video rebuilt the whole filter tree and became
    // a major source of UI stalls on large catalogues.
    const normalized = filters?.quick?.[FIELD] !== undefined && filters?.detailed && filters?.advanced
      ? filters
      : normalize(filters);
    let result = base.evaluateSimple(video, details, normalized, context);
    if (normalized.quick[FIELD]?.enabled) result = base.triAnd(result, favoriteResult(video, context));
    return result;
  }

  function evaluate(video, details, filters, now = Date.now(), context = {}) {
    const normalized = normalize(filters);
    return base.triAnd(
      evaluateSimple(video, details, normalized, context),
      normalized.advanced.enabled ? evaluateItems(video, details, normalized.advanced.items, now, context) : base.TRUE
    );
  }

  function countApplied(filters) {
    const normalized = normalize(filters);
    const normal = normalFields.filter((field) => (normalized.quick[field] ?? normalized.detailed[field])?.enabled).length;
    return normal + (normalized.advanced.enabled && base.hasEffectiveExpression(normalized.advanced.items) ? 1 : 0);
  }

  function disableAll(filters) {
    const normalized = normalize(filters);
    for (const field of QUICK_FIELDS) normalized.quick[field].enabled = false;
    for (const field of DETAILED_FIELDS) normalized.detailed[field].enabled = false;
    normalized.advanced.enabled = false;
    return normalized;
  }

  function createEvaluationContext(records, detailsById, baseContext = {}) {
    return base.createEvaluationContext?.(records, detailsById, baseContext)
      ?? { ...baseContext, records, detailsById };
  }

  app.modules.filterEngine = Object.freeze({
    ...base,
    FIELD_DEFINITIONS,
    QUICK_FIELDS,
    DETAILED_FIELDS,
    ALL_FIELDS,
    DETAIL_FIELDS,
    normalFields,
    FAVORITED_FIELD: FIELD,
    categoriesBeforeTags,
    defaultRuleConfig,
    configured,
    createEmpty,
    normalizeRule,
    normalizeItems,
    normalize,
    favoriteResult,
    validateRule,
    evaluateRule,
    evaluateItems,
    evaluateSimple,
    evaluate,
    countApplied,
    disableAll,
    createEvaluationContext
  });
})();
