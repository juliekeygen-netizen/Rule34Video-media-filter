(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.localGrid;
  const db = app?.modules.db;
  const engine = app?.modules.filterEngine;
  const settings = app?.modules.settings;
  if (!app || !base || !db || !engine || !settings) throw new Error("R34MF Local grid dependencies must load before Artist thumbnail labels.");

  let resizeObserver = null;

  function videoIdFromThumb(thumb) {
    try {
      const path = new URL(thumb?.getAttribute?.("href") ?? "", globalThis.location?.origin ?? "https://rule34video.com").pathname;
      return path.match(/^\/videos?\/(\d+)(?:\/|$)/i)?.[1] ?? null;
    } catch { return null; }
  }

  function artistNames(details) {
    if (details?.status !== "complete" || !engine.isTrustedEntityField?.(details, "artist")) return [];
    return [...new Set((engine.entityValues?.(details, "artist") ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))];
  }

  function labelSize() {
    const value = String(settings.value.artistThumbnailLabelSize ?? "medium");
    return ["small", "medium", "big"].includes(value) ? value : "medium";
  }

  function pill(text, more = false) {
    const node = document.createElement("span");
    node.className = more ? "r34mf-local-artist-more" : "r34mf-local-artist";
    node.textContent = text;
    return node;
  }

  function pack(container) {
    const names = Array.isArray(container?.__r34mfArtistNames) ? container.__r34mfArtistNames : [];
    if (!container || !names.length) return;
    container.replaceChildren(...names.map((name) => pill(name)));
    if (!(container.clientWidth > 0)) return;

    let hidden = 0;
    let more = null;
    const overflows = () => container.scrollWidth > container.clientWidth + 1;
    while (overflows() && container.querySelectorAll(".r34mf-local-artist").length > 1) {
      const artists = container.querySelectorAll(".r34mf-local-artist");
      artists[artists.length - 1]?.remove();
      hidden += 1;
      if (!more) {
        more = pill(`+${hidden}`, true);
        container.append(more);
      } else more.textContent = `+${hidden}`;
    }

    if (more) {
      const remaining = [...container.querySelectorAll(".r34mf-local-artist")];
      if (overflows() && remaining.length) remaining[remaining.length - 1].style.flex = "1 1 auto";
    }
  }

  async function decorate(root, guard, suppliedDetailsById = null) {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (settings.value.artistThumbnailLabels === false || !root?.isConnected || guard?.() === false) return;
    const thumbs = [...root.querySelectorAll(".r34mf-local-card .r34mf-local-thumb")];
    const ids = thumbs.map(videoIdFromThumb).filter(Boolean);
    if (!ids.length) return;

    let byId = suppliedDetailsById;
    if (!byId?.get) {
      const details = await db.getDetailsByIds(ids);
      if (!root?.isConnected || guard?.() === false) return;
      byId = new Map(details.map((detail) => [String(detail.videoId), detail]));
    }

    const observed = [];
    const size = labelSize();

    for (const thumb of thumbs) {
      const id = videoIdFromThumb(thumb);
      const names = artistNames(byId.get(String(id)));
      thumb.querySelector(":scope > .r34mf-local-artists")?.remove();
      if (!names.length) continue;
      const container = document.createElement("div");
      container.className = `r34mf-local-artists is-size-${size}`;
      container.setAttribute("aria-label", `Artists: ${names.join(", ")}`);
      container.__r34mfArtistNames = names;
      thumb.append(container);
      pack(container);
      observed.push(container);
    }

    if (typeof ResizeObserver === "function" && observed.length) {
      resizeObserver = new ResizeObserver((entries) => entries.forEach((entry) => pack(entry.target)));
      observed.forEach((container) => resizeObserver.observe(container));
    }
  }

  async function render(root, options = {}) {
    const result = await base.render(root, options);
    await decorate(root, options.guard, options.detailsById ?? result?.detailsById ?? null);
    return result;
  }

  function hide(root) {
    resizeObserver?.disconnect();
    resizeObserver = null;
    return base.hide(root);
  }

  app.modules.localGrid = Object.freeze({
    ...base,
    render,
    hide,
    artistNames,
    pack,
    labelSize,
    decorateArtistLabels: decorate,
    videoIdFromThumb
  });
})();
