(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before upload-date helpers.");

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH_APPROX = 30.4375 * DAY;
  const YEAR_APPROX = 365.25 * DAY;

  function finiteTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clean(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text || null;
  }

  function daysInUtcMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }

  function shiftUtcMonths(timestamp, deltaMonths) {
    const source = new Date(timestamp);
    if (Number.isNaN(source.getTime())) return null;
    const year = source.getUTCFullYear();
    const month = source.getUTCMonth();
    const total = year * 12 + month + Number(deltaMonths);
    const targetYear = Math.floor(total / 12);
    const targetMonth = ((total % 12) + 12) % 12;
    const targetDay = Math.min(source.getUTCDate(), daysInUtcMonth(targetYear, targetMonth));
    return Date.UTC(
      targetYear,
      targetMonth,
      targetDay,
      source.getUTCHours(),
      source.getUTCMinutes(),
      source.getUTCSeconds(),
      source.getUTCMilliseconds()
    );
  }

  function relativeParts(value) {
    const text = clean(value)?.toLocaleLowerCase();
    if (!text) return null;
    if (text === "just now") return { amount: 0, unit: "minute", special: "just-now" };
    if (/^less than (?:an?|1) hour ago$/.test(text)) return { amount: 0, unit: "hour", special: "under-hour" };

    const word = text.match(/^(?:an?|one)\s+(minute|hour|day|week|month|year)\s+ago$/);
    if (word) return { amount: 1, unit: word[1] };

    const match = text.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/);
    if (!match) return null;
    const amount = Number(match[1]);
    return Number.isSafeInteger(amount) && amount >= 0 ? { amount, unit: match[2] } : null;
  }

  function relativeRange(value, observedAt = Date.now()) {
    const observed = finiteTimestamp(observedAt);
    const parts = relativeParts(value);
    if (observed === null || !parts) return null;

    if (parts.special === "just-now") {
      return { earliestAt: observed - MINUTE, latestAt: observed, amount: 0, unit: "minute" };
    }
    if (parts.special === "under-hour") {
      return { earliestAt: observed - HOUR, latestAt: observed, amount: 0, unit: "hour" };
    }

    const { amount, unit } = parts;
    if (["minute", "hour", "day", "week"].includes(unit)) {
      const scale = { minute: MINUTE, hour: HOUR, day: DAY, week: WEEK }[unit];
      return {
        earliestAt: observed - (amount + 1) * scale,
        latestAt: observed - amount * scale,
        amount,
        unit
      };
    }

    const months = unit === "year" ? amount * 12 : amount;
    const nextMonths = unit === "year" ? (amount + 1) * 12 : amount + 1;
    const earliestAt = shiftUtcMonths(observed, -nextMonths);
    const latestAt = shiftUtcMonths(observed, -months);
    if (![earliestAt, latestAt].every(Number.isFinite)) return null;
    return { earliestAt, latestAt, amount, unit };
  }

  function listingObservationFields(relativeUploadText, observedAt = Date.now()) {
    const observed = finiteTimestamp(observedAt);
    const range = relativeRange(relativeUploadText, observed);
    if (observed === null) return {};
    const result = { relativeUploadObservedAt: observed };
    if (!range) return result;
    return {
      ...result,
      listingUploadEarliestAt: range.earliestAt,
      listingUploadLatestAt: range.latestAt,
      listingUploadUnit: range.unit,
      listingUploadAmount: range.amount
    };
  }

  function listingRange(video) {
    const earliest = finiteTimestamp(video?.listingUploadEarliestAt);
    const latest = finiteTimestamp(video?.listingUploadLatestAt);
    if (earliest !== null && latest !== null && earliest <= latest) {
      return {
        earliestAt: earliest,
        latestAt: latest,
        observedAt: finiteTimestamp(video?.relativeUploadObservedAt),
        rawText: clean(video?.relativeUploadText)
      };
    }

    const observedAt = finiteTimestamp(video?.relativeUploadObservedAt)
      ?? finiteTimestamp(video?.listingUpdatedAt)
      ?? finiteTimestamp(video?.lastSeenAt)
      ?? finiteTimestamp(video?.firstSeenAt);
    if (observedAt === null) return null;
    const range = relativeRange(video?.relativeUploadText, observedAt);
    return range ? { ...range, observedAt, rawText: clean(video?.relativeUploadText) } : null;
  }

  function parseDateOnly(value) {
    const text = String(value ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const start = Date.parse(`${text}T00:00:00.000Z`);
    if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== text) return null;
    return { value: text, start, end: start + DAY - 1 };
  }

  function exactDetailRange(details) {
    if (details?.status !== "complete" || !details.exactUploadDate) return null;
    const raw = String(details.exactUploadDate).trim();
    const dateOnly = parseDateOnly(raw);
    if (dateOnly) {
      return {
        source: "detail-exact",
        precision: "date",
        earliestAt: dateOnly.start,
        latestAt: dateOnly.end,
        sortTimestamp: dateOnly.start + DAY / 2
      };
    }
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) return null;
    return {
      source: "detail-exact",
      precision: "timestamp",
      earliestAt: timestamp,
      latestAt: timestamp,
      sortTimestamp: timestamp
    };
  }

  function resolve(video, details) {
    const exact = exactDetailRange(details);
    if (exact) return exact;

    const listing = listingRange(video);
    if (!listing) {
      return {
        source: "unknown",
        precision: "unknown",
        earliestAt: null,
        latestAt: null,
        sortTimestamp: null
      };
    }
    return {
      source: "listing-estimate",
      precision: "range",
      earliestAt: listing.earliestAt,
      latestAt: listing.latestAt,
      sortTimestamp: listing.earliestAt + (listing.latestAt - listing.earliestAt) / 2,
      observedAt: listing.observedAt,
      rawText: listing.rawText
    };
  }

  function displayResolved(video, details) {
    const exact = exactDetailRange(details);
    if (!exact) return resolve(video, details);
    if (exact.precision !== "date") return exact;

    const listing = listingRange(video);
    if (!listing) return exact;
    const earliestAt = Math.max(exact.earliestAt, listing.earliestAt);
    const latestAt = Math.min(exact.latestAt, listing.latestAt);
    if (!Number.isFinite(earliestAt) || !Number.isFinite(latestAt) || earliestAt > latestAt) return exact;

    return {
      source: "detail-date+listing-estimate",
      precision: "range",
      earliestAt,
      latestAt,
      sortTimestamp: earliestAt + (latestAt - earliestAt) / 2,
      observedAt: listing.observedAt,
      rawText: listing.rawText
    };
  }

  function targetDay(value) {
    const parsed = parseDateOnly(value);
    return parsed ? { start: parsed.start, end: parsed.end } : null;
  }

  function withinCutoff(now, amount, unit) {
    const current = finiteTimestamp(now);
    const count = Number(amount);
    if (current === null || !Number.isFinite(count) || count <= 0) return null;
    if (unit === "months") return shiftUtcMonths(current, -count);
    if (unit === "years") return shiftUtcMonths(current, -count * 12);
    const scale = { minutes: MINUTE, hours: HOUR, days: DAY, weeks: WEEK }[unit];
    return scale ? current - count * scale : null;
  }

  function containedOrDisjoint(range, targetStart, targetEnd) {
    if (range.earliestAt >= targetStart && range.latestAt <= targetEnd) return true;
    if (range.latestAt < targetStart || range.earliestAt > targetEnd) return false;
    return null;
  }

  function evaluateResolved(resolved, operator, value, valueTo, unit, now = Date.now()) {
    if (!resolved || resolved.source === "unknown" || !Number.isFinite(resolved.earliestAt) || !Number.isFinite(resolved.latestAt)) return null;

    if (operator === "within") {
      const cutoff = withinCutoff(now, value, unit);
      if (!Number.isFinite(cutoff)) return false;
      if (resolved.earliestAt >= cutoff) return true;
      if (resolved.latestAt < cutoff) return false;
      return null;
    }

    const from = targetDay(value);
    if (!from) return false;
    if (operator === "on") return containedOrDisjoint(resolved, from.start, from.end);
    if (operator === "after") {
      if (resolved.earliestAt > from.end) return true;
      if (resolved.latestAt <= from.end) return false;
      return null;
    }
    if (operator === "before") {
      if (resolved.latestAt < from.start) return true;
      if (resolved.earliestAt >= from.start) return false;
      return null;
    }
    if (operator === "between") {
      const to = targetDay(valueTo);
      if (!to) return false;
      return containedOrDisjoint(resolved, from.start, to.end);
    }
    return false;
  }

  function evaluate(video, details, config, now = Date.now()) {
    return evaluateResolved(resolve(video, details), config?.operator ?? "on", config?.value, config?.valueTo, config?.unit, now);
  }

  function plural(value, unit) {
    return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  }

  function formatAgeFromMs(ageMs) {
    const age = Math.max(0, Number(ageMs) || 0);
    if (age < HOUR) return "less than 1 hour ago";
    if (age < DAY) return plural(Math.max(1, Math.floor(age / HOUR)), "hour");
    if (age < 7 * DAY) return plural(Math.max(1, Math.floor(age / DAY)), "day");
    if (age < 4 * WEEK) return plural(Math.max(1, Math.floor(age / WEEK)), "week");
    if (age < 12 * MONTH_APPROX) return plural(Math.max(1, Math.floor(age / MONTH_APPROX)), "month");
    return plural(Math.max(1, Math.floor(age / YEAR_APPROX)), "year");
  }

  function formatRelativeResolved(resolved, now = Date.now()) {
    if (!resolved || resolved.source === "unknown") return null;
    const current = finiteTimestamp(now);
    if (current === null) return null;

    if (resolved.precision === "date") {
      const currentDate = new Date(current);
      const currentDay = Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate());
      const sourceDay = resolved.earliestAt;
      const days = Math.max(0, Math.floor((currentDay - sourceDay) / DAY));
      if (days === 0) return "Today";
      if (days < 7) return plural(days, "day");
      if (days < 28) return plural(Math.max(1, Math.floor(days / 7)), "week");
      const age = currentDay - sourceDay;
      if (age < 12 * MONTH_APPROX) return plural(Math.max(1, Math.floor(age / MONTH_APPROX)), "month");
      return plural(Math.max(1, Math.floor(age / YEAR_APPROX)), "year");
    }

    return formatAgeFromMs(current - resolved.sortTimestamp);
  }

  function formatRelative(video, details, now = Date.now()) {
    return formatRelativeResolved(displayResolved(video, details), now) ?? clean(video?.relativeUploadText);
  }

  function sortValue(video, details) {
    const resolved = displayResolved(video, details);
    return Number.isFinite(resolved.sortTimestamp) ? resolved.sortTimestamp : null;
  }

  app.modules.uploadDate = Object.freeze({
    MINUTE,
    HOUR,
    DAY,
    WEEK,
    MONTH_APPROX,
    YEAR_APPROX,
    relativeParts,
    relativeRange,
    listingObservationFields,
    listingRange,
    parseDateOnly,
    exactDetailRange,
    resolve,
    displayResolved,
    targetDay,
    withinCutoff,
    evaluateResolved,
    evaluate,
    formatAgeFromMs,
    formatRelativeResolved,
    formatRelative,
    sortValue
  });
})();