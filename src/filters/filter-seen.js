(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.filterEngine;
  if (!app || !base) throw new Error("R34MF filter engine must load before Seen filters.");

  const HIDE_FIELD = "hideSeenVideos";
  const ADVANCED_FIELD = "seenVideos";
  const FIELD_DEFINITIONS = Object.freeze({
    ...base.FIELD_DEFINITIONS,
    [HIDE_FIELD]: Object.freeze({ label: "Hide seen videos", source: "local", editor: "boolean", operators: Object.freeze([]), defaultConfig: {} }),
    [ADVANCED_FIELD]: Object.freeze({ label: "Seen videos", source: "local", editor: "boolean", operators: Object.freeze([]), defaultConfig: {} })
  });
  const QUICK_FIELDS = Object.freeze((() => {
    const fields = [...base.QUICK_FIELDS].filter((field) => field !== HIDE_FIELD);
    const favoriteIndex = fields.indexOf("favorited");
    if (favoriteIndex >= 0) fields.splice(favoriteIndex + 1, 0, HIDE_FIELD);
    else {
      const hdIndex = fields.indexOf("hdAvailable");
      fields.splice(hdIndex >= 0 ? hdIndex + 1 : fields.length, 0, HIDE_FIELD);
    }
    return fields;
  })());
  const normalFields = Object.freeze([...base.normalFields.filter((field) => field !== HIDE_FIELD), HIDE_FIELD]);
  const ALL_FIELDS = Object.freeze((() => {
    const fields = base.ALL_FIELDS.filter((field) => field !== ADVANCED_FIELD && field !== HIDE_FIELD);
    const favoriteIndex = fields.indexOf("favorited");
    const qualityIndex = fields.indexOf("quality");
    const hdIndex = fields.indexOf("hdAvailable");
    const anchor = favoriteIndex >= 0 ? favoriteIndex : (qualityIndex >= 0 ? qualityIndex : hdIndex);
    fields.splice(anchor >= 0 ? anchor + 1 : 0, 0, ADVANCED_FIELD);
    return fields;
  })());

  const normalizeQuick = (raw) => ({
    enabled: raw?.enabled === true || raw === true,
    value: true
  });

  function defaultRuleConfig(field) {
    return field === ADVANCED_FIELD ? {} : base.defaultRuleConfig(field);
  }

  function configured(field, entry) {
    if (field === HIDE_FIELD) return true;
    return base.configured(field, entry);
  }

  function createEmpty() {
    const empty = base.createEmpty();
    empty.quick = { ...empty.quick };
    const ordered = {};
    for (const field of QUICK_FIELDS) ordered[field] = field === HIDE_FIELD ? { enabled: false, value: true } : empty.quick[field];
    empty.quick = ordered;
    return empty;
  }

  function disableAll(filters) {
    const next = normalize(filters);
    for (const entry of Object.values(next.quick ?? {})) if (entry && typeof entry === "object") entry.enabled = false;
    for (const entry of Object.values(next.detailed ?? {})) if (entry && typeof entry === "object") entry.enabled = false;
    if (next.advanced) next.advanced.enabled = false;
    return next;
  }

  function normalizeRule(raw = {}, connector = null) {
    if (raw.field !== ADVANCED_FIELD) return base.normalizeRule(raw, connector);
    return {
      id: raw.id || base.id("rule"),
      kind: "rule",
      enabled: raw.enabled !== false,
      connector,
      field: ADVANCED_FIELD,
      polarity: raw.polarity === "exclude" ? "exclude" : "match"
    };
  }

  function normalizeItems(items) {
    const result = [];
    for (const item of items ?? []) {
      if (item?.kind === "group") {
        const children = normalizeItems(item.items);
        if (!children.length) continue;
        result.push({
          id: item.id || base.id("group"),
          kind: "group",
          enabled: item.enabled !== false,
          connector: result.length ? item.connector === "or" ? "or" : "and" : null,
          items: children
        });
      } else {
        result.push(normalizeRule(item, result.length ? item?.connector === "or" ? "or" : "and" : null));
      }
    }
    return result;
  }

  function normalize(filters) {
    const raw = filters ?? {};
    const ordinary = base.normalize({ ...raw, advanced: { enabled: false, items: [] } });
    const quick = {};
    for (const field of QUICK_FIELDS) {
      quick[field] = field === HIDE_FIELD ? normalizeQuick(raw.quick?.[field]) : ordinary.quick[field];
    }
    const items = normalizeItems(raw.advanced?.items);
    return {
      quick,
      detailed: ordinary.detailed,
      advanced: {
        enabled: raw.advanced?.enabled === true && base.hasEffectiveExpression(items),
        items
      }
    };
  }

  function validateRule(rule = {}) {
    return rule.field === ADVANCED_FIELD ? { valid: true, message: "" } : base.validateRule(rule);
  }

  function seenResult(video, context = {}) {
    const videoId = String(video?.videoId ?? "");
    if (!videoId) return base.FALSE;
    if (context.seen?.status !== "complete") return base.UNKNOWN;
    const ids = context.seen.ids instanceof Set ? context.seen.ids : new Set(context.seen.ids ?? []);
    return ids.has(videoId) ? base.TRUE : base.FALSE;
  }

  function evaluateRule(video, details, rule, now = Date.now(), context = {}) {
    if (rule.field !== ADVANCED_FIELD) return base.evaluateRule(video, details, rule, now, context);
    if (!rule.enabled) return base.TRUE;
    const result = seenResult(video, context);
    return rule.polarity === "exclude" ? base.negate(result) : result;
  }

  function evaluateItems(video, details, items, now = Date.now(), context = {}) {
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
    const normalized = filters?.quick?.[HIDE_FIELD] !== undefined ? filters : normalize(filters);
    const ordinary = {
      ...normalized,
      quick: { ...normalized.quick, [HIDE_FIELD]: { enabled: false, value: true } }
    };
    let result = base.evaluateSimple(video, details, ordinary, context);
    if (normalized.quick?.[HIDE_FIELD]?.enabled) {
      const seen = seenResult(video, context);
      // If Seen storage is temporarily unavailable, do not make the whole catalogue disappear.
      result = base.triAnd(result, seen === base.UNKNOWN ? base.TRUE : base.negate(seen));
    }
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

  function createEvaluationContext(records, detailsById, baseContext = {}) {
    const context = base.createEvaluationContext?.(records, detailsById, baseContext) ?? { ...baseContext, records, detailsById };
    return { ...context, ...baseContext, records, detailsById };
  }

  app.modules.filterEngine = Object.freeze({
    ...base,
    FIELD_DEFINITIONS,
    QUICK_FIELDS,
    ALL_FIELDS,
    normalFields,
    HIDE_SEEN_FIELD: HIDE_FIELD,
    SEEN_FIELD: ADVANCED_FIELD,
    defaultRuleConfig,
    configured,
    createEmpty,
    disableAll,
    validateRule,
    normalizeRule,
    normalizeItems,
    normalize,
    seenResult,
    evaluateRule,
    evaluateItems,
    evaluateSimple,
    evaluate,
    countApplied,
    createEvaluationContext
  });
})();
