(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) {
    throw new Error("R34MF namespace must load before catalogue parsing helpers.");
  }

  function cleanText(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text || null;
  }

  function parseCompactNumber(value) {
    const text = cleanText(value)?.replace(/,/g, "").replace(/\s/g, "");
    if (!text) return null;
    const match = text.match(/(-?[\d.]+)\s*([kmb])?/i);
    if (!match || !Number.isFinite(Number(match[1]))) return null;
    const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase()] ?? 1;
    return Math.round(Number(match[1]) * multiplier);
  }

  function parsePercentage(value) {
    const match = cleanText(value)?.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
  }

  function parseDuration(value) {
    const match = cleanText(value)?.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
    if (!match) return null;
    const units = match[1].split(":").map(Number);
    if (units.some((part) => !Number.isInteger(part) || part < 0) || units.slice(1).some((part) => part > 59)) return null;
    return units.length === 3 ? units[0] * 3600 + units[1] * 60 + units[2] : units[0] * 60 + units[1];
  }

  function extractVideoId(value) {
    const text = String(value ?? "").trim();
    if (/^\d+$/.test(text)) return text;
    const explicit = !/[/:]/.test(text) ? text.match(/(?:video(?:_|-)?id|id)=([0-9]+)/i) : null;
    if (explicit) return explicit[1];
    const rule34Video = app.modules.rule34VideoIdentity?.parse(text);
    if (rule34Video?.ok) return rule34Video.videoId;
    return null;
  }

  function parseNativeTotal(value) {
    const text = cleanText(value);
    const match = text?.match(/videos?\s+from\s+my\s+subscriptions\s*\(\s*([\d, .kmb]+)\s*\)/i);
    return match ? parseCompactNumber(match[1]) : null;
  }

  function calculatePageCount(total, pageSize) {
    return Number.isInteger(total) && total >= 0 && Number.isInteger(pageSize) && pageSize > 0
      ? Math.ceil(total / pageSize)
      : null;
  }

  function formatPageParameter(pageNumber) {
    const page = Number(pageNumber);
    return Number.isInteger(page) && page > 0 ? String(page).padStart(2, "0") : null;
  }

  function dedupeByVideoId(records) {
    const unique = new Map();
    for (const record of records ?? []) {
      if (record?.videoId && !unique.has(record.videoId)) unique.set(record.videoId, record);
    }
    return [...unique.values()];
  }

  app.modules.catalogueParsing = Object.freeze({
    cleanText,
    parseCompactNumber,
    parsePercentage,
    parseDuration,
    extractVideoId,
    parseNativeTotal,
    calculatePageCount,
    formatPageParameter,
    dedupeByVideoId
  });
})();
