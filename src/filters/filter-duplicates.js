(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.filterEngine;
  const uploadDate = app?.modules.uploadDate;
  if (!app || !base) throw new Error("R34MF filter engine must load before Advanced Duplicates.");

  const DUPLICATE_OPTIONS = Object.freeze([
    ["matchingDuration", "Matching duration"],
    ["matchingQuality", "Matching quality"],
    ["matchingCategory", "Matching category"],
    ["matchingTag", "Matching tag"],
    ["matchingTitleWords", "Matching words on title"]
  ]);
  const FIELD_DEFINITIONS = Object.freeze({
    ...base.FIELD_DEFINITIONS,
    duplicates: Object.freeze({ label: "Duplicates", source: "detail", editor: "duplicates", operators: Object.freeze([]) })
  });
  const ALL_FIELDS = Object.freeze([...base.ALL_FIELDS, "duplicates"]);
  const DETAIL_FIELDS = new Set([...base.DETAIL_FIELDS, "duplicates"]);

  function positiveWordCount(value) {
    const number = Number.parseInt(String(value ?? ""), 10);
    return Number.isSafeInteger(number) && number > 0 ? number : 1;
  }

  function nonNegativeInteger(value) {
    const number = Number.parseInt(String(value ?? ""), 10);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  }

  function duplicateOptions(raw = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      ...Object.fromEntries(DUPLICATE_OPTIONS.map(([key]) => [key, source[key] === true || (key === "matchingDuration" && source[key] !== false)])),
      matchingDurationSecDifference: nonNegativeInteger(source.matchingDurationSecDifference),
      matchingTagCount: positiveWordCount(source.matchingTagCount),
      matchingTitleWordCount: positiveWordCount(source.matchingTitleWordCount)
    };
  }

  function defaultRuleConfig(field) {
    return field === "duplicates" ? { options: duplicateOptions() } : base.defaultRuleConfig(field);
  }

  function normalizeRule(raw = {}, connector = null) {
    if (raw.field !== "duplicates") return base.normalizeRule(raw, connector);
    return {
      id: raw.id || base.id("rule"), kind: "rule", enabled: raw.enabled !== false, connector,
      field: "duplicates", polarity: raw.polarity === "exclude" ? "exclude" : "match", options: duplicateOptions(raw.options)
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

  const lower = (value) => String(value ?? "").trim().toLocaleLowerCase();
  const trustedValues = (details, field) => base.isTrustedEntityField(details, field)
    ? [...new Set(base.entityValues(details, field).map(lower).filter(Boolean))] : null;

  function artistTokens(details) {
    if (!base.isTrustedEntityField(details, "artist")) return null;
    const refs = [...new Set((Array.isArray(details.artistRefs) ? details.artistRefs : []).map((ref) => lower(ref?.key)).filter(Boolean))];
    return refs.length ? refs.map((value) => `ref:${value}`) : trustedValues(details, "artist").map((value) => `name:${value}`);
  }

  const BRACKET_PATTERNS = Object.freeze([
    /\[[^\]]*\]/gu,
    /\([^)]*\)/gu,
    /\{[^}]*\}/gu,
    /【[^】]*】/gu,
    /〔[^〕]*〕/gu,
    /［[^］]*］/gu,
    /（[^）]*）/gu,
    /｛[^｝]*｝/gu,
    /〈[^〉]*〉/gu,
    /《[^》]*》/gu,
    /「[^」]*」/gu,
    /『[^』]*』/gu,
    /〖[^〗]*〗/gu,
    /〘[^〙]*〙/gu,
    /〚[^〛]*〛/gu,
    /⟦[^⟧]*⟧/gu,
    /⟨[^⟩]*⟩/gu,
    /〈[^〉]*〉/gu,
    /<[^>]*>/gu
  ]);

  function stripBracketedTitleParts(value) {
    let text = String(value ?? "");
    for (const pattern of BRACKET_PATTERNS) text = text.replace(pattern, " ");
    return text;
  }

  const titleWords = (title) => [...new Set((stripBracketedTitleParts(title).toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu) ?? []).filter(Boolean))];
  const overlap = (left, right) => {
    const rightSet = right instanceof Set ? right : new Set(right ?? []);
    return (left ?? []).some((value) => rightSet.has(value));
  };
  const sharedCount = (left, right) => {
    const rightSet = right instanceof Set ? right : new Set(right ?? []);
    return (left ?? []).reduce((count, value) => count + (rightSet.has(value) ? 1 : 0), 0);
  };
  const sharedWordCount = sharedCount;

  function uploadSortTimestamp(video, details) {
    const timestamp = uploadDate?.sortValue?.(video, details);
    return Number.isFinite(Number(timestamp)) ? Number(timestamp) : null;
  }

  function descriptor(video, details) {
    const duration = Number(video?.durationSec);
    const title = String(video?.title ?? "").trim();
    const categories = trustedValues(details, "categories");
    const tags = trustedValues(details, "tags");
    const words = titleWords(title);
    return {
      id: String(video?.videoId ?? ""),
      artists: artistTokens(details),
      duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
      quality: base.qualityFingerprint?.(details) ?? null,
      categories,
      categorySet: categories === null ? null : new Set(categories),
      tags,
      tagSet: tags === null ? null : new Set(tags),
      words,
      wordSet: new Set(words),
      uploadAt: uploadSortTimestamp(video, details),
      titleLength: title.length
    };
  }

  function compareRepresentative(left, right) {
    const leftHasDate = Number.isFinite(left?.uploadAt);
    const rightHasDate = Number.isFinite(right?.uploadAt);
    if (leftHasDate && rightHasDate && left.uploadAt !== right.uploadAt) return left.uploadAt - right.uploadAt;
    if (leftHasDate !== rightHasDate) return leftHasDate ? -1 : 1;
    if ((left?.titleLength ?? 0) !== (right?.titleLength ?? 0)) return (left?.titleLength ?? 0) - (right?.titleLength ?? 0);
    const leftNumber = Number(left?.id);
    const rightNumber = Number(right?.id);
    if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
    return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
  }

  function createDuplicateIndex(records = [], detailsById) {
    const descriptors = new Map();
    const byArtist = new Map();
    const byArtistDuration = new Map();
    const unknownDurationByArtist = new Map();
    for (const video of records ?? []) {
      const id = String(video?.videoId ?? "");
      if (!id) continue;
      const details = detailsById?.get?.(id) ?? detailsById?.[id] ?? null;
      const item = descriptor(video, details);
      descriptors.set(id, item);
      for (const artist of item.artists ?? []) {
        const set = byArtist.get(artist) ?? new Set();
        set.add(id);
        byArtist.set(artist, set);
      }
    }

    const representativeRank = new Map(
      [...descriptors.keys()]
        .sort((left, right) => compareRepresentative(descriptors.get(left), descriptors.get(right)))
        .map((id, index) => [id, index])
    );

    // Candidate iteration is hottest for Duplicates. Reuse a global representative
    // rank and build numerically sorted duration buckets. The default duration rule
    // can then jump to nearby buckets instead of walking an artist's full history.
    for (const [artist, ids] of byArtist) {
      const ordered = [...ids].sort((left, right) => (representativeRank.get(left) ?? Infinity) - (representativeRank.get(right) ?? Infinity));
      byArtist.set(artist, new Set(ordered));
      const durationMap = new Map();
      const unknown = new Set();
      for (const id of ordered) {
        const duration = descriptors.get(id)?.duration;
        if (duration === null || duration === undefined) {
          unknown.add(id);
          continue;
        }
        const bucket = durationMap.get(duration) ?? new Set();
        bucket.add(id);
        durationMap.set(duration, bucket);
      }
      byArtistDuration.set(artist, [...durationMap.entries()].sort((left, right) => Number(left[0]) - Number(right[0])));
      unknownDurationByArtist.set(artist, unknown);
    }
    return { descriptors, byArtist, byArtistDuration, unknownDurationByArtist, representativeRank };
  }

  function candidateIds(index, artists) {
    const result = new Set();
    for (const artist of artists ?? []) for (const id of index.byArtist.get(artist) ?? []) result.add(id);
    return result;
  }

  function lowerDurationBound(entries, minimum) {
    let low = 0;
    let high = entries?.length ?? 0;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (Number(entries[middle]?.[0]) < minimum) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function durationCandidateIds(index, current, difference) {
    if (current?.duration === null || current?.duration === undefined) return null;
    const diff = nonNegativeInteger(difference);
    // Extremely large ranges are cheaper through the already-ranked artist list.
    if (diff > 600) return null;
    const result = new Set();
    const minimum = Number(current.duration) - diff;
    const maximum = Number(current.duration) + diff;
    for (const artist of current.artists ?? []) {
      const entries = index.byArtistDuration?.get(artist) ?? [];
      for (let position = lowerDurationBound(entries, minimum); position < entries.length; position += 1) {
        const [duration, ids] = entries[position];
        if (Number(duration) > maximum) break;
        for (const id of ids) result.add(id);
      }
      // Missing candidate duration is still semantically UNKNOWN and must remain
      // in the pool if that candidate could participate in the relation.
      for (const id of index.unknownDurationByArtist?.get(artist) ?? []) result.add(id);
    }
    result.delete(current.id);
    return result;
  }

  function compareCandidate(current, candidate, options) {
    if (!candidate) return base.FALSE;
    // Every enabled toggle is conjunctive: one candidate must satisfy ALL enabled criteria.
    if (options.matchingDuration && (current.duration === null || candidate.duration === null)) return base.UNKNOWN;
    if (options.matchingDuration && Math.abs(current.duration - candidate.duration) > nonNegativeInteger(options.matchingDurationSecDifference)) return base.FALSE;
    if (options.matchingQuality && (!current.quality || !candidate.quality)) return base.UNKNOWN;
    if (options.matchingQuality && current.quality !== candidate.quality) return base.FALSE;
    if (options.matchingCategory && (current.categories === null || candidate.categories === null)) return base.UNKNOWN;
    if (options.matchingCategory && !overlap(current.categories, candidate.categorySet ?? candidate.categories)) return base.FALSE;
    if (options.matchingTag && (current.tags === null || candidate.tags === null)) return base.UNKNOWN;
    if (options.matchingTag && sharedCount(current.tags, candidate.tagSet ?? candidate.tags) < positiveWordCount(options.matchingTagCount)) return base.FALSE;
    if (options.matchingTitleWords && sharedWordCount(current.words, candidate.wordSet ?? candidate.words) < positiveWordCount(options.matchingTitleWordCount)) return base.FALSE;
    return base.TRUE;
  }

  function canonicalRepresentative(items) {
    return [...items].sort(compareRepresentative)[0] ?? null;
  }

  function duplicateResult(video, rule, context = {}) {
    let index = context.duplicateIndex;
    if (!index && Array.isArray(context.records) && context.detailsById) {
      index = createDuplicateIndex(context.records, context.detailsById);
      try { context.duplicateIndex = index; } catch { /* read-only context */ }
    }
    if (!index) return base.UNKNOWN;
    const current = index.descriptors.get(String(video?.videoId ?? ""));
    if (!current?.artists?.length) return base.UNKNOWN;
    const options = duplicateOptions(rule.options);
    if (options.matchingDuration && current.duration === null) return base.UNKNOWN;

    const ids = options.matchingDuration
      ? (durationCandidateIds(index, current, options.matchingDurationSecDifference) ?? candidateIds(index, current.artists))
      : candidateIds(index, current.artists);
    const currentRank = index.representativeRank?.get(current.id) ?? Infinity;
    let unknown = false;
    for (const id of ids) {
      if (id === current.id) continue;
      const candidate = index.descriptors.get(id);
      if (!candidate) continue;
      const result = compareCandidate(current, candidate, options);
      // UNKNOWN is epistemic: a later candidate with unavailable enabled metadata
      // still means the duplicate relationship itself cannot be proven false. Keep
      // that behavior while only allowing an earlier/better TRUE candidate to flag
      // the current video as redundant.
      if (result === base.UNKNOWN) {
        unknown = true;
        continue;
      }
      if (result === base.TRUE && (index.representativeRank?.get(id) ?? Infinity) < currentRank) return base.TRUE;
    }
    return unknown ? base.UNKNOWN : base.FALSE;
  }

  function validateRule(rule = {}) { return rule.field === "duplicates" ? { valid: true, message: "" } : base.validateRule(rule); }

  function evaluateRule(video, details, rule, now = Date.now(), context = {}) {
    if (rule.field !== "duplicates") return base.evaluateRule(video, details, rule, now, context);
    if (!rule.enabled) return base.TRUE;
    const result = duplicateResult(video, rule, context);
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

  function countApplied(filters) {
    const normalized = normalize(filters);
    const normal = base.normalFields.filter((field) => (normalized.quick[field] ?? normalized.detailed[field])?.enabled).length;
    return normal + (normalized.advanced.enabled && base.hasEffectiveExpression(normalized.advanced.items) ? 1 : 0);
  }

  function createEvaluationContext(records, detailsById, baseContext = {}) {
    return { ...baseContext, records, detailsById, duplicateIndex: null };
  }

  app.modules.filterEngine = Object.freeze({
    ...base, FIELD_DEFINITIONS, ALL_FIELDS, DETAIL_FIELDS, DUPLICATE_OPTIONS, duplicateOptions,
    positiveWordCount, nonNegativeInteger, stripBracketedTitleParts, titleWords, sharedWordCount, createDuplicateIndex,
    candidateIds, lowerDurationBound, durationCandidateIds,
    compareCandidate, compareRepresentative, canonicalRepresentative, duplicateResult,
    defaultRuleConfig, validateRule, normalizeRule, normalizeItems, normalize, evaluateRule,
    evaluateItems, evaluate, countApplied, createEvaluationContext
  });
})();