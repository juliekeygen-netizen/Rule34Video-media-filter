(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.filterEngine;
  const uploadDate = app?.modules.uploadDate;
  if (!app || !base || !uploadDate) throw new Error("R34MF Upload Date helpers must load after the filter engine.");

  const FIELD_DEFINITIONS = Object.freeze({
    ...base.FIELD_DEFINITIONS,
    uploadDate: Object.freeze({ ...base.FIELD_DEFINITIONS.uploadDate, source: "hybrid" })
  });
  const DETAIL_FIELDS = new Set([...base.DETAIL_FIELDS].filter((field) => field !== "uploadDate"));

  function dateRuleResult(video, details, rule, now) {
    const value = uploadDate.evaluate(video, details, rule, now);
    const tri = value === null ? base.UNKNOWN : value ? base.TRUE : base.FALSE;
    return rule?.polarity === "exclude" ? base.negate(tri) : tri;
  }

  function evaluateRule(video, details, rule, now = Date.now(), context = {}) {
    if (!rule?.enabled) return base.TRUE;
    if (rule.field === "uploadDate") return dateRuleResult(video, details, rule, now);
    return base.evaluateRule(video, details, rule, now, context);
  }

  function evaluateItems(video, details, items, now = Date.now(), context = {}) {
    let result = null;
    for (const item of items ?? []) {
      if (!item?.enabled) continue;
      const value = item.kind === "group"
        ? evaluateItems(video, details, item.items, now, context)
        : evaluateRule(video, details, item, now, context);
      result = result === null
        ? value
        : item.connector === "or"
          ? base.triOr(result, value)
          : base.triAnd(result, value);
    }
    return result ?? base.TRUE;
  }

  function evaluateSimple(video, details, filters, now = Date.now(), context = {}) {
    const source = filters?.quick && filters?.detailed ? filters : base.normalize(filters);
    const uploadEntry = source.detailed?.uploadDate;
    const detailed = {
      ...(source.detailed ?? {}),
      uploadDate: uploadEntry ? { ...uploadEntry, enabled: false } : uploadEntry
    };
    let result = base.evaluateSimple(video, details, { ...source, detailed }, context);
    if (uploadEntry?.enabled) {
      const config = uploadEntry.value && typeof uploadEntry.value === "object" ? uploadEntry.value : {};
      result = base.triAnd(result, evaluateRule(video, details, {
        enabled: true,
        field: "uploadDate",
        polarity: "match",
        ...config
      }, now));
    }
    return result;
  }

  function evaluate(video, details, filters, now = Date.now(), context = {}) {
    const normalized = base.normalize(filters);
    const currentNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return base.triAnd(
      evaluateSimple(video, details, normalized, currentNow, context),
      normalized.advanced.enabled
        ? evaluateItems(video, details, normalized.advanced.items, currentNow, context)
        : base.TRUE
    );
  }

  app.modules.filterEngine = Object.freeze({
    ...base,
    FIELD_DEFINITIONS,
    DETAIL_FIELDS,
    evaluateRule,
    evaluateItems,
    evaluateSimple,
    evaluate
  });
})();
