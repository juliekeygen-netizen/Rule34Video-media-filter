(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) {
    throw new Error("R34MF namespace must load before URL utilities.");
  }

  function rule34VideoUrl(input, origin = globalThis.location?.origin ?? "https://rule34video.com") {
    const base = new URL("/", origin);
    return new URL(String(input), base).href;
  }

  function thumbnailUrl(input, origin) {
    const value = String(input ?? "").trim();
    if (!value || value.startsWith("data:") || /^javascript:/i.test(value)) return null;
    try { return rule34VideoUrl(value, origin); } catch { return null; }
  }

  app.modules.urls = Object.freeze({
    rule34VideoUrl,
    thumbnailUrl
  });
})();
