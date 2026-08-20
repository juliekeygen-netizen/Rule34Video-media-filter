(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before Rule34Video video URL helpers.");

  const HOSTS = new Set(["rule34video.com", "www.rule34video.com"]);
  const VIDEO_PATH = /^\/videos?\/(\d+)(?:\/|$)/i;

  function parse(value, { base = "https://rule34video.com/" } = {}) {
    const raw = String(value ?? "").trim();
    if (!raw) return { ok: false, reason: "missing-url" };
    let url;
    try { url = new URL(raw, base); }
    catch { return { ok: false, reason: "malformed-url" }; }
    if (!new Set(["http:", "https:"]).has(url.protocol)) return { ok: false, reason: "invalid-protocol" };
    const hostname = url.hostname.toLocaleLowerCase();
    if (!HOSTS.has(hostname)) return { ok: false, reason: "invalid-host" };
    const match = url.pathname.match(VIDEO_PATH);
    if (!match) return { ok: false, reason: "invalid-video-path" };
    url.hash = "";
    return {
      ok: true,
      videoId: match[1],
      url: url.href,
      hostname,
      pathShape: /^\/videos\//i.test(url.pathname) ? "/videos/" : "/video/"
    };
  }

  function validateRecord(video) {
    const parsed = parse(video?.url);
    if (!parsed.ok) return parsed;
    const expected = String(video?.videoId ?? "").trim();
    if (!/^\d+$/.test(expected) || parsed.videoId !== expected) {
      return { ok: false, reason: "video-id-mismatch", actualVideoId: parsed.videoId };
    }
    return parsed;
  }

  function shape(value) {
    const parsed = parse(value);
    return parsed.ok ? parsed.pathShape : "invalid/other";
  }

  app.modules.rule34VideoIdentity = Object.freeze({ parse, validateRecord, shape, HOSTS, VIDEO_PATH });
})();
