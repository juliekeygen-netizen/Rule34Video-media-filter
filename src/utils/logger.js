(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) {
    throw new Error("R34MF namespace must load before logger.");
  }

  function debugEnabled() {
    return Boolean(app.modules.settings?.value?.advanced?.debugLogging);
  }

  const SENSITIVE_KEY = /(password|credential|cookie|authorization|token|secret|csrf)/i;

  function sanitize(value, seen = new WeakSet()) {
    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (value instanceof Error) return { name: value.name, code: value.code ?? null, message: String(value.message ?? value).slice(0, 240) };
    if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitize(item, seen));
    return Object.fromEntries(Object.entries(value).slice(0, 60).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : sanitize(item, seen)
    ]));
  }

  function debug(operation, details = {}) {
    if (!debugEnabled()) {
      return;
    }

    console.debug("[R34MF]", sanitize({
      operation,
      ...details
    }));
  }

  function warn(operation, details = {}) {
    const message = details.message ? `: ${details.message}` : "";
    const structured = sanitize({
      operation,
      ...details,
      ...(details.error?.stack && !details.stack ? { stack: details.error.stack } : {})
    });
    console.warn(`[R34MF] ${operation}${message}`, structured);
  }

  app.modules.logger = Object.freeze({
    debug,
    warn,
    enabled: debugEnabled,
    sanitize
  });
})();
