(() => {
  "use strict";
  const app = globalThis.R34MF;
  const db = app?.modules.db;
  const paginatorModel = app?.modules.paginatorModel;
  const uploadDate = app?.modules.uploadDate;
  if (!app || !db || !paginatorModel) throw new Error("R34MF Local grid dependencies must load first.");

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function formatDuration(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total < 0) return null;
    const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = Math.floor(total) % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function formatCompact(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (Math.abs(number) < 1000) return String(Math.round(number));
    const [n, suffix] = Math.abs(number) >= 1e6 ? [1e6, "M"] : [1e3, "K"];
    return `${Math.round(number / n * 10) / 10}${suffix}`;
  }

  function legacyThumbnailUrl(videoId) {
    const id = Number(videoId);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const bucket = Math.floor(id / 1000) * 1000;
    return `https://rule34video.com/contents/videos_screenshots/${bucket}/${id}/336x189/1.jpg`;
  }

  function thumbnailCandidateEntries(record = {}) {
    const stored = [record.thumbnailPreferredUrl, record.thumbnailUrl, record.thumbnailFallbackUrl]
      .filter((url) => typeof url === "string" && /^https?:/i.test(url))
      .map((url) => ({ url, legacy: false }));
    if (!stored.length) {
      const fallback = legacyThumbnailUrl(record.videoId);
      if (fallback) stored.push({ url: fallback, legacy: true });
    }
    return stored.filter((candidate, index, all) => all.findIndex((other) => other.url === candidate.url) === index);
  }

  function thumbnailCandidates(record = {}) { return thumbnailCandidateEntries(record).map((candidate) => candidate.url); }

  function setThumbnailSource(image, candidates, index = 0) {
    const source = candidates[index];
    if (!source) {
      image.removeAttribute("src");
      image.classList.add("is-unavailable");
      image.dataset.thumbnailState = "unavailable";
      return;
    }
    image.dataset.thumbnailIndex = String(index);
    image.dataset.thumbnailLegacy = candidates[index].legacy ? "true" : "false";
    image.dataset.thumbnailState = "loading";
    image.src = candidates[index].url;
  }

  function card(record, { eager = false, details = null, ageEntries = null, now = Date.now() } = {}) {
    const node = el("article", "r34mf-local-card");
    const anchor = el("a", "r34mf-local-thumb");
    anchor.href = record.url;
    anchor.setAttribute("aria-label", record.title || "Open video");

    const image = el("img");
    const candidates = thumbnailCandidateEntries(record);
    image.alt = "";
    image.setAttribute("role", "presentation");
    image.loading = eager ? "eager" : "lazy";
    image.decoding = "async";
    image.dataset.thumbnailState = "placeholder";
    image.addEventListener("load", () => {
      image.classList.remove("is-unavailable");
      image.dataset.thumbnailState = "loaded";
      if (image.dataset.thumbnailLegacy === "true") db.repairThumbnail?.(record.videoId, image.currentSrc || image.src).catch(() => {});
    });
    image.addEventListener("error", () => {
      const next = Number(image.dataset.thumbnailIndex || 0) + 1;
      if (next < candidates.length) setThumbnailSource(image, candidates, next);
      else setThumbnailSource(image, candidates, candidates.length);
    });
    setThumbnailSource(image, candidates);
    anchor.append(image);

    if (record.hdAvailable) anchor.append(el("span", "r34mf-local-hd", "HD"));
    const duration = formatDuration(record.durationSec);
    if (duration) anchor.append(el("span", "r34mf-local-duration", duration));

    if (record.previewUrl) {
      const preview = el("video", "r34mf-local-preview");
      preview.muted = true;
      preview.playsInline = true;
      preview.loop = true;
      preview.preload = "none";
      preview.dataset.preview = record.previewUrl;
      anchor.append(preview);
    }

    const title = el("a", "r34mf-local-title", record.title || "Untitled video");
    title.href = record.url;
    const meta = el("div", "r34mf-local-meta");

    const ageText = uploadDate?.formatRelative?.(record, details, now) ?? record.relativeUploadText;
    if (ageText) {
      const age = el("span", "r34mf-local-age", ageText);
      age.dataset.videoId = String(record.videoId);
      meta.append(age);
      ageEntries?.push?.({ node: age, record, details });
    }

    if (record.ratingPercent != null) {
      meta.append(el("span", "", `${record.ratingPercent}%${record.ratingVotes != null ? ` (${formatCompact(record.ratingVotes)})` : ""}`));
    }
    const views = formatCompact(record.views);
    if (views) meta.append(el("span", "", views));

    node.append(anchor, title, meta);
    return node;
  }

  function paginator(page, pageCount, onPage) {
    const model = paginatorModel.paginationModel(page, pageCount);
    if (!model.pageCount) return null;
    const nav = el("nav", "r34mf-local-pagination");
    nav.setAttribute("aria-label", "Local catalogue pages");
    for (const item of model.items) {
      if (item.type === "ellipsis") {
        nav.append(el("span", "r34mf-local-ellipsis", item.label));
        continue;
      }
      const button = el("button", `r34mf-local-page r34mf-local-${item.type}`, item.label);
      button.type = "button";
      button.addEventListener("click", () => onPage(item.value));
      if (item.type === "page" && item.value === model.page) {
        button.classList.add("is-current");
        button.setAttribute("aria-current", "page");
      }
      nav.append(button);
    }

    const jump = el("form", "r34mf-local-jump");
    const input = el("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.pattern = "[0-9]*";
    input.setAttribute("aria-label", "Page number");
    const ok = el("button", "r34mf-local-jump-ok", "OK");
    ok.type = "submit";
    jump.append("Jump to ", input, ok);
    jump.addEventListener("submit", (event) => {
      event.preventDefault();
      const target = paginatorModel.parseJump(input.value, model.pageCount);
      if (target) {
        input.removeAttribute("aria-invalid");
        onPage(target);
      } else {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    });
    nav.append(jump);
    return nav;
  }

  function bindPreviews(host, enabled) {
    const stopPreview = (thumb) => {
      const preview = thumb?.querySelector?.("video[data-preview]");
      if (!preview) return;
      preview.dataset.previewGeneration = String((Number(preview.dataset.previewGeneration) || 0) + 1);
      preview.pause?.();
      preview.removeAttribute("src");
      preview.load?.();
      preview.classList.remove("is-active");
    };
    host.querySelectorAll(".r34mf-local-thumb").forEach((node) => stopPreview(node));
    if (!enabled) return;
    const start = (event) => {
      const preview = event.currentTarget.querySelector("video[data-preview]");
      if (!preview) return;
      preview.dataset.previewGeneration = String((Number(preview.dataset.previewGeneration) || 0) + 1);
      if (!preview.src) preview.src = preview.dataset.preview;
      preview.classList.add("is-active");
      preview.play?.().catch(() => {});
    };
    const stop = (event) => stopPreview(event.currentTarget);
    const stopFocus = (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) stopPreview(event.currentTarget);
    };
    host.querySelectorAll(".r34mf-local-thumb").forEach((node) => {
      node.addEventListener("pointerenter", start);
      node.addEventListener("focusin", start);
      node.addEventListener("pointerleave", stop);
      node.addEventListener("focusout", stopFocus);
    });
  }

  function stopAgeTimer(host) {
    if (!host) return;
    if (host.__r34mfAgeTimer) globalThis.clearInterval(host.__r34mfAgeTimer);
    host.__r34mfAgeTimer = null;
    host.__r34mfAgeEntries = null;
  }

  function refreshAgeEntries(host, entries, now = Date.now()) {
    if (!host?.isConnected) {
      stopAgeTimer(host);
      return;
    }
    for (const entry of entries ?? []) {
      if (!entry.node?.isConnected) continue;
      const text = uploadDate?.formatRelative?.(entry.record, entry.details, now) ?? entry.record.relativeUploadText;
      if (text) entry.node.textContent = text;
    }
  }

  function startAgeTimer(host, entries) {
    stopAgeTimer(host);
    if (!entries?.length || typeof globalThis.setInterval !== "function") return;
    host.__r34mfAgeEntries = entries;
    refreshAgeEntries(host, entries);
    host.__r34mfAgeTimer = globalThis.setInterval(() => refreshAgeEntries(host, entries), 60_000);
  }

  const ASPECT_RATIOS = Object.freeze({ "16:9": "16 / 9", "16:10": "16 / 10", "3:2": "3 / 2", "4:3": "4 / 3", "5:4": "5 / 4", "1:1": "1 / 1" });

  function normalizeAspectRatio(value) {
    const key = String(value ?? "16:9");
    return Object.hasOwn(ASPECT_RATIOS, key) ? key : "16:9";
  }

  async function render(root, { page = 1, pageSize = 24, previews = true, columns = 3, aspectRatio = "16:9", onPage, records = null, detailsById = null, guard = null } = {}) {
    const canCommit = () => typeof guard !== "function" || guard() !== false;
    let host = root.querySelector(":scope > .r34mf-local-host");
    if (!host) {
      host = el("section", "r34mf-local-host");
      host.dataset.r34mfOwned = "true";
      root.append(host);
    }
    stopAgeTimer(host);
    host.hidden = false;
    host.replaceChildren(el("p", "r34mf-local-loading", "Loading local catalogue…"));

    try {
      let source = null;
      let all = records;
      if (!all) {
        source = await db.getAllLocalRecords();
        if (!canCommit()) return { aborted: true };
        all = source.records;
      }

      const size = [24, 48, 72].includes(Number(pageSize)) ? Number(pageSize) : 24;
      const pageCount = Math.max(1, Math.ceil(all.length / size));
      const current = paginatorModel.clampPage(page, pageCount);
      const currentRecords = all.slice((current - 1) * size, current * size);
      let resolvedDetailsById = detailsById ?? source?.detailsById ?? new Map();

      if (!source && !detailsById && currentRecords.length && typeof db.getDetailsByIds === "function") {
        const details = await db.getDetailsByIds(currentRecords.map((record) => record.videoId));
        if (!canCommit()) return { aborted: true };
        resolvedDetailsById = new Map(details.map((detail) => [String(detail.videoId), detail]));
      }

      if (!canCommit()) return { aborted: true };
      host.replaceChildren();
      const ageEntries = [];
      if (!all.length) {
        host.append(el("p", "r34mf-local-empty", "No Local matches."));
      } else {
        const grid = el("div", "r34mf-local-grid");
        grid.style.setProperty("--r34mf-local-columns", String([1, 2, 3, 4, 5, 6].includes(Number(columns)) ? Number(columns) : 3));
        grid.style.setProperty("--r34mf-local-aspect-ratio", ASPECT_RATIOS[normalizeAspectRatio(aspectRatio)]);
        const now = Date.now();
        if (!uploadDate) {
          currentRecords.forEach((record) => grid.append(card(record, { eager: true })));
        } else {
          currentRecords.forEach((record) => grid.append(card(record, {
            eager: true,
            details: resolvedDetailsById.get?.(String(record.videoId)) ?? resolvedDetailsById?.[record.videoId],
            ageEntries,
            now
          })));
        }
        host.append(grid, paginator(current, pageCount, onPage));
        bindPreviews(host, previews);
        startAgeTimer(host, ageEntries);
      }

      return { records: currentRecords, total: all.length, page: current, pageCount, pageSize: size, detailsById: resolvedDetailsById };
    } catch (error) {
      if (!canCommit()) return { aborted: true };
      stopAgeTimer(host);
      host.replaceChildren(el("p", "r34mf-local-error", "Could not read the local catalogue. Switch to Native mode to recover."));
      throw error;
    }
  }

  function hide(root) {
    const host = root.querySelector(":scope > .r34mf-local-host");
    if (!host) return;
    stopAgeTimer(host);
    host.setAttribute("hidden", "");
  }

  function pageWindow(page, pageCount) {
    return paginatorModel.paginationModel(page, pageCount).items.filter((item) => item.type === "page" || item.type === "ellipsis");
  }

  app.modules.localGrid = Object.freeze({
    render,
    hide,
    formatDuration,
    formatCompact,
    legacyThumbnailUrl,
    thumbnailCandidates,
    setThumbnailSource,
    card,
    paginator,
    stopAgeTimer,
    refreshAgeEntries,
    startAgeTimer,
    bindPreviews,
    normalizeAspectRatio,
    ASPECT_RATIOS,
    clampPage: paginatorModel.clampPage,
    pageWindow
  });
})();