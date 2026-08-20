(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before filter engine.");

  const TRUE = "true";
  const FALSE = "false";
  const UNKNOWN = "unknown";

  const TEXT_OPERATORS = Object.freeze([
    ["contains", "Contains"],
    ["equals", "Equals"],
    ["startsWith", "Starts with"],
    ["endsWith", "Ends with"],
    ["wildcard", "Wildcard"],
    ["regex", "Regular expression"]
  ]);
  const NUMERIC_OPERATORS = Object.freeze([
    ["equals", "Equals"],
    ["gt", "Greater than"],
    ["gte", "Greater than or equal to"],
    ["lt", "Less than"],
    ["lte", "Less than or equal to"],
    ["between", "Between"]
  ]);
  const DATE_OPERATORS = Object.freeze([
    ["on", "On"],
    ["after", "After"],
    ["before", "Before"],
    ["between", "Between"],
    ["within", "Within"]
  ]);
  const ENTITY_TEXT_OPERATORS = Object.freeze([
    ["is", "Is"],
    ["contains", "Contains"],
    ["startsWith", "Starts with"],
    ["regex", "Regular expression"]
  ]);
  const ARTIST_OPERATORS = Object.freeze([...ENTITY_TEXT_OPERATORS, ["amountOf", "Amount of"]]);
  const DURATION_UNITS = Object.freeze([
    ["seconds", "Seconds"],
    ["minutes", "Minutes"],
    ["hours", "Hours"]
  ]);
  const DATE_WITHIN_UNITS = Object.freeze([
    ["minutes", "Minutes"],
    ["hours", "Hours"],
    ["days", "Days"],
    ["weeks", "Weeks"],
    ["months", "Months"],
    ["years", "Years"]
  ]);

  const FIELD_DEFINITIONS = Object.freeze({
    title: Object.freeze({ label: "Title", source: "listing", editor: "text", operators: TEXT_OPERATORS, defaultConfig: { operator: "contains", value: "", options: {} } }),
    duration: Object.freeze({ label: "Duration", source: "listing", editor: "numeric", operators: NUMERIC_OPERATORS, units: DURATION_UNITS, defaultConfig: { operator: "gte", value: "", valueTo: "", unit: "minutes" } }),
    views: Object.freeze({ label: "Views", source: "listing", editor: "compactNumeric", operators: NUMERIC_OPERATORS, defaultConfig: { operator: "gte", value: "", valueTo: "" } }),
    rating: Object.freeze({ label: "Rating", source: "listing", editor: "rating", operators: NUMERIC_OPERATORS, defaultConfig: { operator: "gte", value: "", valueTo: "" } }),
    ratingVotes: Object.freeze({ label: "Rating votes", source: "listing", editor: "compactNumeric", operators: NUMERIC_OPERATORS, defaultConfig: { operator: "gte", value: "", valueTo: "" } }),
    hdAvailable: Object.freeze({ label: "HD available", source: "listing", editor: "boolean", operators: Object.freeze([]), defaultConfig: {} }),
    uploadDate: Object.freeze({ label: "Upload date", source: "detail", editor: "date", operators: DATE_OPERATORS, units: DATE_WITHIN_UNITS, defaultConfig: { operator: "on", value: "", valueTo: "", unit: "days" } }),
    artist: Object.freeze({ label: "Artist", source: "detail", editor: "entityOrText", operators: ARTIST_OPERATORS, defaultConfig: { operator: "is", value: "", options: {} } }),
    uploader: Object.freeze({ label: "Uploader", source: "detail", editor: "entityOrText", operators: ENTITY_TEXT_OPERATORS, defaultConfig: { operator: "is", value: "", options: {} } }),
    tags: Object.freeze({ label: "Tags", source: "detail", editor: "entity", operators: Object.freeze([]), defaultConfig: { value: "" } }),
    categories: Object.freeze({ label: "Categories", source: "detail", editor: "entity", operators: Object.freeze([]), defaultConfig: { value: "" } }),
    subscriptionsOnly: Object.freeze({ label: "Subscriptions only", source: "detail", editor: "membership", operators: Object.freeze([]), defaultConfig: { options: { includeWithoutDetails: false } } }),
    description: Object.freeze({ label: "Description", source: "detail", editor: "text", operators: TEXT_OPERATORS, defaultConfig: { operator: "contains", value: "", options: {} } })
  });

  const DETAIL_FIELDS = new Set(Object.entries(FIELD_DEFINITIONS).filter(([, definition]) => definition.source === "detail").map(([field]) => field));
  const QUICK_FIELDS = ["title", "duration", "views", "rating", "ratingVotes", "hdAvailable"];
  const DETAILED_FIELDS = ["uploadDate", "artist", "uploader", "tags", "categories", "subscriptionsOnly"];
  const ALL_FIELDS = Object.keys(FIELD_DEFINITIONS);
  const normalFields = [...QUICK_FIELDS, ...DETAILED_FIELDS];
  const numericFields = new Set(["duration", "views", "rating", "ratingVotes"]);
  const textFields = new Set(["title", "description", "artist", "uploader"]);
  const normalEntityFields = new Set(["artist", "uploader", "tags", "categories"]);

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const id = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const defaultRuleConfig = (field) => clone(FIELD_DEFINITIONS[field]?.defaultConfig ?? FIELD_DEFINITIONS.title.defaultConfig);
  const operatorLabel = (field, operator) => FIELD_DEFINITIONS[field]?.operators.find(([key]) => key === operator)?.[1] ?? operator ?? "";

  function textOptionKeys(operator) {
    if (operator === "contains") return ["caseSensitive", "wholeWord", "matchAnyWord", "separateByCommas"];
    if (["equals", "startsWith", "endsWith", "wildcard", "regex"].includes(operator)) return ["caseSensitive"];
    return [];
  }

  const emptyEntry = (field) => field === "hdAvailable"
    ? { enabled: false, value: true }
    : field === "subscriptionsOnly"
      ? { enabled: false, value: defaultRuleConfig(field) }
      : { enabled: false, value: null };

  function createEmpty() {
    return {
      quick: Object.fromEntries(QUICK_FIELDS.map((field) => [field, emptyEntry(field)])),
      detailed: Object.fromEntries(DETAILED_FIELDS.map((field) => [field, emptyEntry(field)])),
      advanced: { enabled: false, items: [] }
    };
  }

  function disableAll(filters) {
    const next = clone(filters ?? createEmpty());
    for (const source of ["quick", "detailed"]) {
      for (const entry of Object.values(next[source] ?? {})) {
        if (entry && typeof entry === "object") entry.enabled = false;
      }
    }
    if (next.advanced && typeof next.advanced === "object") next.advanced.enabled = false;
    return next;
  }

  function parseCompactNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    const match = String(value ?? "").trim().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
    if (!match) return null;
    const result = Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? "").toLowerCase()] ?? 1);
    return Number.isFinite(result) && result >= 0 ? result : null;
  }

  function parseDate(value) {
    const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
  }

  function dateFromSegments(day, month, year) {
    return parseDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }

  function triAnd(left, right) {
    if (left === FALSE || right === FALSE) return FALSE;
    return left === UNKNOWN || right === UNKNOWN ? UNKNOWN : TRUE;
  }

  function triOr(left, right) {
    if (left === TRUE || right === TRUE) return TRUE;
    return left === UNKNOWN || right === UNKNOWN ? UNKNOWN : FALSE;
  }

  function negate(value) {
    return value === UNKNOWN ? UNKNOWN : value === TRUE ? FALSE : TRUE;
  }

  function comparison(actual, operator, value, valueTo) {
    if (![actual, value].every(Number.isFinite)) return FALSE;
    if (operator === "between") return Number.isFinite(valueTo) && actual >= value && actual <= valueTo ? TRUE : FALSE;
    return ({ equals: actual === value, gt: actual > value, gte: actual >= value, lt: actual < value, lte: actual <= value })[operator] ? TRUE : FALSE;
  }

  function commaTerms(value) {
    return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  }

  const TRUSTED_ENTITY_SCHEMA = 5;
  function isTrustedEntityDetail(detail) { return detail?.status === "complete" && Number(detail.schemaVersion) >= TRUSTED_ENTITY_SCHEMA; }
  function isTrustedEntityField(detail, field) { return normalEntityFields.has(field) && isTrustedEntityDetail(detail) && detail?.entityTrust?.[field] === true; }
  function isWordCharacter(character) { return Boolean(character) && /[\p{L}\p{N}\p{M}_]/u.test(character); }
  function exactWordOrPhrase(source, needle) {
    let index = source.indexOf(needle);
    while (index >= 0) {
      const before = source[index - 1]; const after = source[index + needle.length];
      if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
      index = source.indexOf(needle, index + Math.max(1, needle.length));
    }
    return false;
  }

  function textMatch(actual, operator, value, options = {}) {
    if (typeof actual !== "string") return FALSE;
    if (options.separateByCommas && operator === "contains") {
      const terms = commaTerms(value);
      if (!terms.length) return FALSE;
      const nestedOptions = { ...options, separateByCommas: false };
      return terms.some((term) => textMatch(actual, operator, term, nestedOptions) === TRUE) ? TRUE : FALSE;
    }
    let source = actual;
    let needle = String(value ?? "");
    if (!options.caseSensitive) {
      source = source.toLocaleLowerCase();
      needle = needle.toLocaleLowerCase();
    }
    try {
      if (operator === "regex") return new RegExp(String(value ?? ""), options.caseSensitive ? "" : "i").test(actual) ? TRUE : FALSE;
      if (operator === "wildcard") {
        const expression = `^${needle.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`;
        return new RegExp(expression, options.caseSensitive ? "" : "i").test(actual) ? TRUE : FALSE;
      }
    } catch {
      return FALSE;
    }

    const parts = options.matchAnyWord ? needle.split(/\s+/).filter(Boolean) : [needle];
    const matchPart = (part) => {
      const basic = operator === "equals" ? source === part
        : operator === "startsWith" ? source.startsWith(part)
          : operator === "endsWith" ? source.endsWith(part)
            : source.includes(part);
      if (!basic || !options.wholeWord) return basic;
      return exactWordOrPhrase(source, part);
    };
    return (options.matchAnyWord ? parts.some(matchPart) : matchPart(needle)) ? TRUE : FALSE;
  }

  function detailValue(video, details, field) {
    if (field === "subscriptionsOnly") return details?.status === "complete" ? details : undefined;
    if (!DETAIL_FIELDS.has(field)) return video[{ duration: "durationSec", rating: "ratingPercent" }[field] ?? field];
    if (!details || details.status !== "complete") return undefined;
    if (normalEntityFields.has(field) && !isTrustedEntityField(details, field)) return undefined;
    if (field === "artist" || field === "uploader") return entityValues(details, field);
    return details[field === "uploadDate" ? "exactUploadDate" : field];
  }

  function entityValues(details, field) {
    if (!isTrustedEntityField(details, field)) return [];
    const plural = field === "artist" ? "artists" : field === "uploader" ? "uploaders" : field;
    const raw = Array.isArray(details[plural]) && details[plural].length ? details[plural] : Array.isArray(details[field]) ? details[field] : details[field] ? [details[field]] : [];
    const seen = new Set();
    return raw.map((value) => String(value ?? "").trim()).filter((value) => {
      const key = value.toLocaleLowerCase();
      if (!value || seen.has(key)) return false;
      if (field === "uploader" && Number(details.schemaVersion ?? 1) < 2 && key === "community") return false;
      seen.add(key);
      return true;
    });
  }

  const meaningful = (value) => value !== "" && value != null;

  function configured(field, entry) {
    if (field === "hdAvailable") return true;
    if (field === "subscriptionsOnly") return true;
    const value = entry?.value;
    if (Array.isArray(value)) return value.length > 0;
    if (value == null) return false;
    if (typeof value !== "object") return String(value).trim().length > 0;
    if (numericFields.has(field)) return meaningful(value.value) && (value.operator !== "between" || meaningful(value.valueTo));
    if (field === "uploadDate") return meaningful(value.value) && (value.operator !== "between" || meaningful(value.valueTo));
    if (textFields.has(field)) return value.options?.separateByCommas === true
      ? commaTerms(value.value).length > 0
      : String(value.value ?? "").trim().length > 0;
    return Object.values(value).some(meaningful);
  }

  function normalizeEntry(field, raw, legacyTagMatch) {
    if (field === "subscriptionsOnly") {
      const wrapped = raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "enabled") ? raw : { enabled: false, value: raw };
      return { enabled: wrapped.enabled === true, value: { options: { includeWithoutDetails: wrapped.value?.options?.includeWithoutDetails === true || wrapped.value?.includeWithoutDetails === true } } };
    }
    if (normalEntityFields.has(field)) {
      const wrapped = raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "enabled") ? raw : { enabled: raw != null, value: raw };
      const legacyValue = wrapped.value && typeof wrapped.value === "object" && !Array.isArray(wrapped.value) ? wrapped.value.value : wrapped.value;
      const seen = new Set();
      const values = (Array.isArray(legacyValue) ? legacyValue : [legacyValue]).map((value) => String(value ?? "").trim()).filter((value) => {
        const key = value.toLocaleLowerCase();
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const matchMode = wrapped.matchMode === "all" || wrapped.tagMatch === "all" || legacyTagMatch === "all" ? "all" : "any";
      return { enabled: wrapped.enabled === true && values.length > 0, value: values, matchMode };
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "enabled") && Object.hasOwn(raw, "value")) {
      return { enabled: raw.enabled === true && configured(field, raw), value: clone(raw.value) };
    }
    const value = field === "hdAvailable" ? true : clone(raw);
    return { enabled: configured(field, { value }) && (field === "hdAvailable" ? raw === true : true), value };
  }

  function validateRule(rule = {}) {
    const definition = FIELD_DEFINITIONS[rule.field];
    if (!definition) return { valid: false, message: "Choose a supported field." };
    if (["boolean", "membership"].includes(definition.editor)) return { valid: true, message: "" };
    if (definition.operators.length && !definition.operators.some(([operator]) => operator === rule.operator)) return { valid: false, message: "Choose a valid condition." };

    if (rule.field === "artist" && rule.operator === "amountOf") {
      if (!/^\d+$/.test(String(rule.value ?? "")) || !["gt", "gte", "lte", "lt"].includes(rule.countComparator)) return { valid: false, message: "Enter a non-negative amount and comparator." };
      return { valid: true, message: "" };
    }
    if (["numeric", "compactNumeric", "rating"].includes(definition.editor)) {
      const parse = definition.editor === "compactNumeric" ? parseCompactNumber : (value) => meaningful(value) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
      const from = parse(rule.value);
      const to = rule.operator === "between" ? parse(rule.valueTo) : from;
      if (from === null || to === null) return { valid: false, message: rule.operator === "between" ? "Enter both valid range values." : "Enter a valid value." };
      if (definition.editor === "rating" && (from > 100 || to > 100)) return { valid: false, message: "Rating must be between 0 and 100." };
      if (rule.operator === "between" && from > to) return { valid: false, message: "The first range value must not exceed the second." };
      return { valid: true, message: "" };
    }

    if (definition.editor === "date") {
      if (rule.operator === "within") {
        const amount = Number(rule.value);
        if (!Number.isFinite(amount) || amount <= 0) return { valid: false, message: "Enter a positive time amount." };
        if (!DATE_WITHIN_UNITS.some(([unit]) => unit === rule.unit)) return { valid: false, message: "Choose a valid time unit." };
        return { valid: true, message: "" };
      }
      const from = parseDate(rule.value);
      const to = rule.operator === "between" ? parseDate(rule.valueTo) : from;
      if (!from || !to) return { valid: false, message: rule.operator === "between" ? "Enter both valid dates." : "Enter a valid date." };
      if (rule.operator === "between" && from > to) return { valid: false, message: "The first date must not follow the second." };
      return { valid: true, message: "" };
    }

    if (rule.options?.separateByCommas === true && rule.operator === "contains" && !commaTerms(rule.value).length) return { valid: false, message: "Enter at least one non-empty comma-separated value." };
    if (!String(rule.value ?? "").trim()) return { valid: false, message: definition.editor === "entity" || rule.operator === "is" ? `Choose a local ${definition.label.toLocaleLowerCase()}.` : "Enter a value." };
    if (rule.operator === "regex") {
      try { new RegExp(String(rule.value), rule.options?.caseSensitive ? "" : "i"); } catch { return { valid: false, message: "Enter a valid regular expression." }; }
    }
    return { valid: true, message: "" };
  }

  function evaluateSubscriptionMembership(details, membership, includeWithoutDetails = false) {
    if (!isTrustedEntityField(details, "artist")) return includeWithoutDetails ? TRUE : UNKNOWN;
    const artists = entityValues(details, "artist");
    const refs = Array.isArray(details.artistRefs) ? details.artistRefs : [];
    if (!artists.length && !refs.length) return FALSE;
    if (membership?.status !== "complete") return UNKNOWN;
    const keys = membership.keys instanceof Set ? membership.keys : new Set(membership.keys ?? []);
    const names = membership.names instanceof Set ? membership.names : new Set(membership.names ?? []);
    const canonicalMatch = refs.some((ref) => keys.has(String(ref?.key ?? "").toLocaleLowerCase()));
    const nameMatch = artists.some((artist) => names.has(String(artist).trim().toLocaleLowerCase()));
    return canonicalMatch || nameMatch ? TRUE : FALSE;
  }

  function evaluateRule(video, details, rule, now = Date.now(), context = {}) {
    if (!rule?.enabled) return TRUE;
    const field = rule.field;
    if (field === "subscriptionsOnly") {
      const base = evaluateSubscriptionMembership(details, context.membership, rule.options?.includeWithoutDetails === true);
      return rule.polarity === "exclude" ? negate(base) : base;
    }
    const actual = detailValue(video, details, field);
    if (DETAIL_FIELDS.has(field) && actual === undefined) return UNKNOWN;
    let result = FALSE;

    if (field === "hdAvailable") result = actual === true ? TRUE : FALSE;
    else if (numericFields.has(field)) {
      const scale = field === "duration" ? ({ seconds: 1, minutes: 60, hours: 3600 }[rule.unit] ?? 1) : 1;
      const parse = ["views", "ratingVotes"].includes(field) ? parseCompactNumber : Number;
      result = comparison(Number(actual), rule.operator ?? "equals", parse(rule.value) * scale, parse(rule.valueTo) * scale);
    } else if (field === "uploadDate") {
      const timestamp = new Date(actual).getTime();
      const date = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
      if (!date) result = FALSE;
      else if (rule.operator === "within") {
        const scale = { minutes: 6e4, hours: 36e5, days: 864e5, weeks: 6048e5, months: 26298e5, years: 315576e5 }[rule.unit] ?? 864e5;
        result = timestamp >= now - Number(rule.value) * scale ? TRUE : FALSE;
      } else if (rule.operator === "between") result = date >= rule.value && date <= rule.valueTo ? TRUE : FALSE;
      else result = rule.operator === "on" ? date === rule.value ? TRUE : FALSE : rule.operator === "after" ? date > rule.value ? TRUE : FALSE : date < rule.value ? TRUE : FALSE;
    } else if (["tags", "categories"].includes(field)) result = Array.isArray(actual) && actual.includes(rule.value) ? TRUE : FALSE;
    else if (field === "artist" && rule.operator === "amountOf") {
      result = comparison(entityValues(details, "artist").length, rule.countComparator, Number(rule.value));
    } else if (["artist", "uploader"].includes(field)) {
      const actualValues = Array.isArray(actual) ? actual : [actual].filter(Boolean);
      result = actualValues.some((item) => rule.operator === "is"
        ? String(item).toLocaleLowerCase() === String(rule.value ?? "").toLocaleLowerCase()
        : textMatch(String(item), rule.operator ?? "contains", rule.value, rule.options) === TRUE) ? TRUE : FALSE;
    } else result = textMatch(String(actual ?? ""), rule.operator ?? "contains", rule.value, rule.options);

    return rule.polarity === "exclude" ? negate(result) : result;
  }

  function evaluateItems(video, details, items, now, context = {}) {
    let result = null;
    for (const item of items ?? []) {
      if (!item?.enabled) continue;
      const value = item.kind === "group" ? evaluateItems(video, details, item.items, now, context) : evaluateRule(video, details, item, now, context);
      result = result === null ? value : item.connector === "or" ? triOr(result, value) : triAnd(result, value);
    }
    return result ?? TRUE;
  }

  function evaluateSimple(video, details, filters, context = {}) {
    let result = TRUE;
    for (const field of QUICK_FIELDS) {
      const entry = filters.quick[field];
      if (!entry?.enabled) continue;
      if (field === "hdAvailable") { result = triAnd(result, video.hdAvailable === true ? TRUE : FALSE); continue; }
      const value = entry.value;
      if (field === "title") result = triAnd(result, textMatch(video.title ?? "", value.operator ?? "contains", value.value, value.options));
      else {
        const actual = Number(video[{ duration: "durationSec", views: "views", rating: "ratingPercent", ratingVotes: "ratingVotes" }[field]]);
        const scale = field === "duration" ? ({ seconds: 1, minutes: 60, hours: 3600 }[value.unit] ?? 1) : 1;
        const parse = ["views", "ratingVotes"].includes(field) ? parseCompactNumber : Number;
        result = triAnd(result, comparison(actual, value.operator ?? "gte", parse(value.value) * scale, parse(value.valueTo) * scale));
      }
    }
    for (const field of DETAILED_FIELDS) {
      const entry = filters.detailed[field];
      if (!entry?.enabled) continue;
      if (field === "subscriptionsOnly") {
        result = triAnd(result, evaluateSubscriptionMembership(details, context.membership, entry.value?.options?.includeWithoutDetails === true));
        continue;
      }
      const actual = detailValue(video, details, field);
      if (actual === undefined) { result = triAnd(result, UNKNOWN); continue; }
      const value = entry.value;
      if (field === "uploadDate") result = triAnd(result, evaluateRule(video, details, { enabled: true, field, ...value }));
      else if (normalEntityFields.has(field)) {
        const wanted = Array.isArray(value) ? value : [value].filter(Boolean);
        const actualValues = (Array.isArray(actual) ? actual : []).map((item) => String(item).toLocaleLowerCase());
        const tests = wanted.map((item) => actualValues.includes(String(item).toLocaleLowerCase()));
        result = triAnd(result, (entry.matchMode === "all" ? tests.every(Boolean) : tests.some(Boolean)) ? TRUE : FALSE);
      }
    }
    return result;
  }

  function normalizeRule(raw = {}, connector = null) {
    const field = FIELD_DEFINITIONS[raw.field] ? raw.field : "title";
    const definition = FIELD_DEFINITIONS[field];
    const rule = { id: raw.id || id("rule"), kind: "rule", enabled: raw.enabled !== false, connector, field, polarity: raw.polarity === "exclude" ? "exclude" : "match", ...defaultRuleConfig(field) };
    if (definition.editor === "membership") {
      rule.options = { includeWithoutDetails: raw.options?.includeWithoutDetails === true || raw.includeWithoutDetails === true };
    } else if (definition.editor !== "boolean") {
      if (definition.operators.some(([operator]) => operator === raw.operator)) rule.operator = raw.operator;
      rule.value = raw.value ?? "";
      if (field === "artist" && rule.operator === "amountOf") { rule.value = String(raw.value ?? "").replace(/\D/g, ""); rule.countComparator = ["gt", "gte", "lte", "lt"].includes(raw.countComparator) ? raw.countComparator : "gt"; delete rule.options; }
      if (Object.hasOwn(rule, "valueTo")) rule.valueTo = raw.valueTo ?? "";
      if (Object.hasOwn(rule, "unit") && definition.units.some(([unit]) => unit === raw.unit)) rule.unit = raw.unit;
      if (Object.hasOwn(rule, "options")) {
        const keys = textOptionKeys(rule.operator);
        rule.options = Object.fromEntries(keys.filter((key) => raw.options?.[key] === true).map((key) => [key, true]));
      }
    }
    const validation = validateRule(rule);
    if (validation.valid && definition.editor === "compactNumeric") {
      rule.value = parseCompactNumber(rule.value);
      if (rule.operator === "between") rule.valueTo = parseCompactNumber(rule.valueTo);
    }
    if (rule.enabled && !validation.valid) rule.enabled = false;
    return rule;
  }

  function normalizeItems(items) {
    const result = [];
    for (const item of items ?? []) {
      if (item?.kind === "group") {
        const children = normalizeItems(item.items);
        if (!children.length) continue;
        result.push({ id: item.id || id("group"), kind: "group", enabled: item.enabled !== false, connector: result.length ? item.connector === "or" ? "or" : "and" : null, items: children });
      } else {
        result.push(normalizeRule(item, result.length ? item?.connector === "or" ? "or" : "and" : null));
      }
    }
    return result;
  }

  function normalize(filters) {
    const raw = filters ?? {};
    const quick = {}, detailed = {};
    QUICK_FIELDS.forEach((field) => { quick[field] = normalizeEntry(field, raw.quick?.[field]); });
    DETAILED_FIELDS.forEach((field) => { detailed[field] = normalizeEntry(field, raw.detailed?.[field], raw.detailed?.tagMatch); });
    const items = normalizeItems(raw.advanced?.items);
    return { quick, detailed, advanced: { enabled: raw.advanced?.enabled === true && hasEffectiveExpression(items), items } };
  }

  function hasEffectiveExpression(items) {
    return (items ?? []).some((item) => item?.enabled && (item.kind !== "group" || hasEffectiveExpression(item.items)));
  }

  function evaluate(video, details, filters, now, context = {}) {
    const normalized = normalize(filters);
    return triAnd(evaluateSimple(video, details, normalized, context), normalized.advanced.enabled ? evaluateItems(video, details, normalized.advanced.items, now, context) : TRUE);
  }

  function countApplied(filters) {
    const normal = normalize(filters);
    return normalFields.filter((field) => (normal.quick[field] ?? normal.detailed[field])?.enabled).length + (normal.advanced.enabled && hasEffectiveExpression(normal.advanced.items) ? 1 : 0);
  }

  function vocabulary(records, detailsById, field, query = "", limit = 60) {
    const counts = new Map();
    let covered = 0;
    for (const video of records ?? []) {
      const detail = detailsById?.get?.(video.videoId) ?? detailsById?.[video.videoId];
      if (normalEntityFields.has(field) && !isTrustedEntityField(detail, field)) continue;
      covered += 1;
      const values = normalEntityFields.has(field) ? entityValues(detail, field) : Array.isArray(detail[field]) ? detail[field] : detail[field] ? [detail[field]] : [];
      for (const value of new Set(values.map((item) => String(item).trim()).filter(Boolean))) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const search = String(query).trim().toLocaleLowerCase();
    return {
      covered,
      values: [...counts]
        .filter(([value]) => !search || value.toLocaleLowerCase().includes(search))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.max(1, limit))
        .map(([value, count]) => ({ value, count }))
    };
  }

  app.modules.filterEngine = Object.freeze({
    TRUE, FALSE, UNKNOWN, TRUSTED_ENTITY_SCHEMA, DETAIL_FIELDS, QUICK_FIELDS, DETAILED_FIELDS, ALL_FIELDS, normalFields,
    FIELD_DEFINITIONS, TEXT_OPERATORS, NUMERIC_OPERATORS, DATE_OPERATORS, ENTITY_TEXT_OPERATORS, DURATION_UNITS, DATE_WITHIN_UNITS,
    createEmpty, disableAll, clone, id, defaultRuleConfig, operatorLabel, textOptionKeys, parseCompactNumber, parseDate, dateFromSegments, commaTerms,
    triAnd, triOr, negate, configured, isTrustedEntityDetail, isTrustedEntityField, isWordCharacter, exactWordOrPhrase, entityValues, evaluateSubscriptionMembership, validateRule, evaluateRule, evaluateItems, evaluateSimple, evaluate,
    normalizeRule, normalizeItems, normalize, hasEffectiveExpression, countApplied, vocabulary
  });
})();
