(() => {
  "use strict";

  const app = globalThis.R34MF;
  const identity = app?.modules.rule34VideoIdentity;
  if (!app || !identity) throw new Error("R34MF video identity helpers must load before detail parser.");

  const AUTH_TEXT = /(?:checking your browser|verify you are human|access denied|sign in to continue|log in to continue|cloudflare|captcha)/i;
  const RELATIVE_DATE = /\b(?:ago|today|yesterday|just now|minutes?|hours?|days?|weeks?|months?)\b/i;
  const GENERIC_DESCRIPTION = /^rule34video(?:\.com)?\b|watch and download/i;
  const TRUSTED_ENTITY_SCHEMA = 5;

  function compactText(value) { return String(value ?? "").replace(/\u00a0/g, " ").replace(/[ \t\f\v]+/g, " ").trim(); }
  function readableText(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n").split("\n").map(compactText)
      .filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n").trim();
  }
  function plainText(_documentLike, value) {
    const source = String(value ?? "");
    if (!/[<>]/.test(source)) return readableText(source);
    return readableText(source
      .replace(/<(?:script|style|template)\b[^>]*>[\s\S]*?<\/(?:script|style|template)>/gi, " ")
      .replace(/<br\s*\/?>|<\/(?:p|div|li|section)>/gi, "\n").replace(/<[^>]*>/g, " "));
  }
  function unique(values) {
    const seen = new Set(); const result = [];
    for (const value of values ?? []) {
      const normalized = compactText(value); const key = normalized.toLocaleLowerCase();
      if (normalized && !seen.has(key)) { seen.add(key); result.push(normalized); }
    }
    return result;
  }
  function videoIdFromUrl(value, base) { const parsed = identity.parse(value, { base }); return parsed.ok ? parsed.videoId : null; }

  function normalizeExactDate(value) {
    const text = compactText(value);
    if (!text || RELATIVE_DATE.test(text)) return null;
    const dateOnly = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (dateOnly && !/[T ]\d{2}:\d{2}/.test(text)) {
      const parsed = new Date(`${dateOnly[1]}T00:00:00Z`);
      return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateOnly[1] ? null : dateOnly[1];
    }
    const timestamp = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})\b/i)?.[0];
    if (timestamp) { const parsed = new Date(timestamp); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(); }
    if (/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(text) && /\b\d{4}\b/.test(text)) {
      const parsed = new Date(text); if (Number.isNaN(parsed.getTime())) return null;
      if (!/\b\d{1,2}:\d{2}\b/.test(text)) return parsed.toISOString().slice(0, 10);
      return /\b(?:GMT|UTC|Z)\b|[+-]\d{2}:?\d{2}\b/i.test(text) ? parsed.toISOString() : null;
    }
    return null;
  }

  function jsonLdObjects(documentLike) {
    const values = [];
    for (const node of documentLike.querySelectorAll?.("script[type='application/ld+json']") ?? []) {
      try {
        const parsed = JSON.parse(node.textContent ?? "null"); const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) { const item = queue.shift(); if (!item || typeof item !== "object") continue; values.push(item); if (Array.isArray(item["@graph"])) queue.push(...item["@graph"]); }
      } catch { /* Optional invalid structured metadata is represented by diagnostics. */ }
    }
    return values;
  }
  function isVideoObject(value) { return (Array.isArray(value?.["@type"]) ? value["@type"] : [value?.["@type"]]).some((type) => String(type).toLocaleLowerCase() === "videoobject"); }
  function firstAttribute(documentLike, selectors, attribute = "content") {
    for (const selector of selectors) { const value = documentLike.querySelector?.(selector)?.getAttribute?.(attribute); if (compactText(value)) return compactText(value); }
    return null;
  }
  function firstText(documentLike, selectors) {
    for (const selector of selectors) { const value = readableText(documentLike.querySelector?.(selector)?.textContent); if (value) return value; }
    return null;
  }
  function linkTexts(root, selectors) { const values = []; for (const selector of selectors) for (const node of root?.querySelectorAll?.(selector) ?? []) values.push(node.textContent); return unique(values); }
  function sameVideo(node, expectedVideoId) { return !expectedVideoId || String(node?.getAttribute?.("data-video-id") ?? "") === String(expectedVideoId); }
  function getVideoSuggestionContainer(documentLike, expectedVideoId, type) { return [...(documentLike?.querySelectorAll?.(`[data-suggest-type='${type}']`) ?? [])].filter((node) => sameVideo(node, expectedVideoId)); }
  function verifiedEntityAnchors(containers, expectedVideoId, type) {
    const path = type === "model" ? "/models/" : type === "category" ? "/categories/" : "/tags/";
    return (containers ?? []).flatMap((container) => [...container.querySelectorAll("[data-item-type]")]
      .filter((chip) => chip.getAttribute("data-item-type") === type && sameVideo(chip, expectedVideoId) && chip.getAttribute("data-status") !== "pending")
      .filter((chip) => !chip.matches(".tag_suggestion_chip, .tag_suggestion_item, .video-suggest-panel *, .suggest-tags *"))
      .flatMap((chip) => [...chip.querySelectorAll(`a[href*='${path}']`)])
      .filter((anchor) => !anchor.matches(".tag_item_load_more, .tag_item_suggest")));
  }
  function modelRefs(nodes, base) {
    const result = []; const seen = new Set();
    for (const node of nodes ?? []) {
      let url;
      try { url = new URL(node.getAttribute("href"), base); } catch { continue; }
      if (!["rule34video.com", "www.rule34video.com"].includes(url.hostname.toLocaleLowerCase())) continue;
      const match = url.pathname.match(/^\/models\/([^/]+)\/?$/i);
      if (!match) continue;
      let key;
      try { key = decodeURIComponent(match[1]).trim().toLocaleLowerCase(); } catch { continue; }
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push({ key, name: compactText(node.querySelector?.(".name")?.textContent ?? node.textContent) || key, url: `${url.origin}/models/${encodeURIComponent(key)}/` });
    }
    return result;
  }
  function entityValue(node) { return compactText(node?.querySelector?.(".name, [data-entity-name]")?.textContent ?? node?.textContent); }

  function uploaderColumns(region) {
    return [...(region?.querySelectorAll?.(".col, .info-row, .row") ?? [])].filter((column) =>
      compactText(column.querySelector?.(":scope > .label, :scope > strong, :scope > dt")?.textContent).replace(/:$/, "").toLocaleLowerCase() === "uploaded by");
  }
  function scopedUploaderValues(columns, expectedVideoId, base) {
    const values = [];
    for (const column of columns ?? []) {
      for (const anchor of column.querySelectorAll("a[href*='/members/'], a[href*='/users/']")) {
        try { const url = new URL(anchor.getAttribute("href"), base); const owner = column.closest?.("[data-video-id]"); if ((!owner || sameVideo(owner, expectedVideoId)) && /^\/(?:members|users)\/\d+\/?$/i.test(url.pathname) && ["rule34video.com", "www.rule34video.com"].includes(url.hostname.toLocaleLowerCase())) values.push(anchor.textContent); } catch { /* invalid links are not metadata */ }
      }
    }
    return unique(values);
  }
  function downloadFormats(region) {
    const values = []; const seen = new Set();
    for (const block of region?.querySelectorAll?.(".col, .wrap, section, div") ?? []) {
      if (compactText(block.querySelector?.(":scope > .label")?.textContent).replace(/:$/, "").toLocaleLowerCase() !== "download") continue;
      for (const node of block.querySelectorAll(".tag_item_download")) {
        const text = compactText(node.textContent); const resolution = text.match(/\b(\d{3,5}p)\b/i)?.[1]?.toLocaleLowerCase(); const format = text.match(/^\s*([a-z0-9][a-z0-9._+-]*)\b/i)?.[1]?.toLocaleLowerCase();
        const value = { ...(format ? { format } : {}), ...(resolution ? { resolution } : {}) }; const key = JSON.stringify(value);
        if (Object.keys(value).length && !seen.has(key)) { seen.add(key); values.push(value); }
      }
    }
    return values;
  }
  function labelRows(documentLike) {
    const result = new Map();
    for (const row of documentLike.querySelectorAll?.("[data-label], [data-field], .video-info .row, .video-info .item, .details .row, .info-row, dl") ?? []) {
      const explicit = row.getAttribute?.("data-label") ?? row.getAttribute?.("data-field");
      const labelNode = row.querySelector?.("dt, .label, .name, strong, b");
      const label = compactText(explicit ?? labelNode?.textContent).replace(/:$/, "").toLocaleLowerCase();
      if (!label || label.length > 40) continue;
      let values = linkTexts(row, ["a"]);
      if (!values.length) { const copy = row.cloneNode?.(true); copy?.querySelector?.("dt, .label, .name, strong, b")?.remove?.(); values = unique([copy?.textContent ?? row.textContent]); }
      if (values.length) result.set(label, values);
    }
    return result;
  }
  function rowValues(rows, labels) { for (const [label, values] of rows) if (labels.some((candidate) => label === candidate || label.startsWith(`${candidate} `))) return values; return []; }
  function jsonText(value) { return compactText(typeof value === "string" ? value : value?.name); }
  function jsonValues(value) { return unique(Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? item.split(",") : [jsonText(item)]) : typeof value === "string" ? value.split(",") : [jsonText(value)]); }
  function commentsFromJson(videoObject) {
    for (const statistic of Array.isArray(videoObject?.interactionStatistic) ? videoObject.interactionStatistic : [videoObject?.interactionStatistic]) {
      if (/comment/i.test(String(statistic?.interactionType?.["@type"] ?? statistic?.interactionType ?? ""))) { const count = Number(statistic?.userInteractionCount); if (Number.isFinite(count) && count >= 0) return count; }
    }
    return null;
  }
  function commentsFromTab(documentLike) {
    const text = compactText(documentLike.querySelector?.("a[href='#tab_comments'], a[href$='#tab_comments']")?.textContent);
    const count = Number(text.match(/\(\s*([\d,]+)\s*\)/)?.[1]?.replace(/,/g, ""));
    return Number.isFinite(count) && count >= 0 ? count : null;
  }
  function formatMetadata(videoObject, region) {
    const formats = [];
    const descriptor = (value) => { const text = compactText(value); return /^https?:\/\//i.test(text) ? "" : text; };
    for (const encoding of Array.isArray(videoObject?.encoding) ? videoObject.encoding : [videoObject?.encoding]) {
      if (!encoding || typeof encoding !== "object") continue;
      const format = descriptor(encoding.encodingFormat); const name = descriptor(encoding.name);
      if (format || name) formats.push({ ...(name ? { name } : {}), ...(format ? { format } : {}) });
    }
    formats.push(...downloadFormats(region));
    const seen = new Set(); return formats.filter((format) => { const key = JSON.stringify(format); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 20);
  }
  function pageLooksAuthenticated(documentLike) {
    const title = compactText(documentLike.querySelector?.("title")?.textContent); const body = compactText(documentLike.body?.textContent).slice(0, 2000); const password = documentLike.querySelector?.("input[type='password']");
    return AUTH_TEXT.test(`${title} ${body}`) || Boolean(password && /log\s*in|sign\s*in/i.test(body));
  }

  function parseDocument(documentLike, context = {}) {
    const expectedVideoId = compactText(context.expectedVideoId); const base = context.url ?? "https://rule34video.com/";
    const structured = jsonLdObjects(documentLike); const videoObject = structured.find(isVideoObject) ?? null;
    const canonical = firstAttribute(documentLike, ["link[rel='canonical']"], "href"); const openGraphUrl = firstAttribute(documentLike, ["meta[property='og:url']"]);
    const rawIdentity = [context.url, canonical, openGraphUrl, videoObject?.url, videoObject?.mainEntityOfPage?.["@id"], typeof videoObject?.mainEntityOfPage === "string" ? videoObject.mainEntityOfPage : null];
    const identityEvidence = rawIdentity.filter(Boolean).slice(0, 8).map((url) => { const parsed = identity.parse(url, { base }); return { source: url === context.url ? "final-url" : url === canonical ? "canonical" : url === openGraphUrl ? "og:url" : "json-ld", valid: parsed.ok, videoId: parsed.ok ? parsed.videoId : null }; });
    const explicitId = compactText(documentLike.querySelector?.("[data-video-id]")?.getAttribute?.("data-video-id"));
    const identityIds = unique([...identityEvidence.filter((item) => item.valid).map((item) => item.videoId), ...(/^\d+$/.test(explicitId) ? [explicitId] : [])]);
    const rootCandidates = [...(documentLike.querySelectorAll?.("#video_view, .block-video, .video-holder, .video-container, [itemprop='video']") ?? [])]
      .filter((node) => !expectedVideoId || !node.hasAttribute?.("data-video-id") || sameVideo(node, expectedVideoId));
    const allArtistContainers = getVideoSuggestionContainer(documentLike, expectedVideoId, "model");
    const allCategoryContainers = getVideoSuggestionContainer(documentLike, expectedVideoId, "category");
    const allTagContainers = getVideoSuggestionContainer(documentLike, expectedVideoId, "tag");
    const detailRoot = rootCandidates.find((node) => [...allArtistContainers, ...allCategoryContainers, ...allTagContainers].some((container) => node.contains?.(container)) || uploaderColumns(node).length > 0) ?? rootCandidates[0] ?? null;
    const artistContainers = allArtistContainers.filter((node) => detailRoot?.contains?.(node));
    const categoryContainers = allCategoryContainers.filter((node) => detailRoot?.contains?.(node));
    const tagContainers = allTagContainers.filter((node) => detailRoot?.contains?.(node));
    const uploaderColumnsInRoot = uploaderColumns(detailRoot);
    const entityTrust = {
      artist: artistContainers.length > 0,
      uploader: uploaderColumnsInRoot.length > 0,
      tags: tagContainers.length > 0,
      categories: categoryContainers.length > 0
    };
    const entityStructureVerified = Object.values(entityTrust).some(Boolean);
    const knownRoot = Boolean(documentLike.querySelector?.("#kt_player, #video_view, .block-video, .video-holder, .video-container, [itemprop='video'], [data-video-id]"));
    const diagnostics = {
      expectedVideoId: expectedVideoId || null, finalUrl: context.url ?? null, canonicalUrl: canonical,
      identityCandidates: identityIds, identityEvidence, expectedDetailRootFound: knownRoot,
      jsonLdVideoObjectFound: Boolean(videoObject), strictEntityContainers: { artist: artistContainers.length, category: categoryContainers.length, tag: tagContainers.length }, entityTrust, entityStructureVerified,
      artistCandidates: 0, uploaderCandidates: 0, tagCandidates: 0, categoryCandidates: 0,
      descriptionEvidence: null, uploadDateCandidateFound: false, commentsCandidateFound: false
    };
    if (pageLooksAuthenticated(documentLike)) return { ok: false, reason: "authentication-required", diagnostics };
    if (!identityIds.length) return { ok: false, reason: "unexpected-detail-structure", diagnostics };
    if (expectedVideoId && identityIds.some((id) => id !== expectedVideoId)) return { ok: false, reason: "video-id-mismatch", diagnostics };
    if (!videoObject && !knownRoot && !detailRoot) return { ok: false, reason: "unexpected-detail-structure", diagnostics };

    const rows = labelRows(documentLike);
    const artistAnchors = verifiedEntityAnchors(artistContainers, expectedVideoId, "model");
    const artistRefs = modelRefs(artistAnchors, base);
    const artistValues = unique(artistAnchors.map(entityValue));
    const uploaderValues = scopedUploaderValues(uploaderColumnsInRoot, expectedVideoId, base);
    const tags = unique(verifiedEntityAnchors(tagContainers, expectedVideoId, "tag").map(entityValue));
    const categories = unique(verifiedEntityAnchors(categoryContainers, expectedVideoId, "category").map(entityValue));
    const descriptionSources = [
      ["json-ld", videoObject?.description],
      ["itemprop", firstAttribute(documentLike, ["meta[itemprop='description']"]) ?? firstText(documentLike, ["[itemprop='description']:not(meta)"])],
      ["detail-root", firstText(documentLike, ["[data-field='description']", ".video-info .description", ".description"])],
      ["open-graph", firstAttribute(documentLike, ["meta[property='og:description']"])],
      ["meta", firstAttribute(documentLike, ["meta[name='description']"])]
    ];
    const selectedDescription = descriptionSources.find(([source, value]) => compactText(value) && (!(source === "meta" || source === "open-graph") || !GENERIC_DESCRIPTION.test(compactText(value))));
    const description = plainText(documentLike, selectedDescription?.[1] ?? "");
    const dateCandidates = unique([videoObject?.uploadDate, videoObject?.datePublished, firstAttribute(documentLike, ["meta[itemprop='uploadDate']", "meta[itemprop='datePublished']"]), documentLike.querySelector?.("time[itemprop='uploadDate'], time[itemprop='datePublished'], time[datetime]")?.getAttribute?.("datetime"), ...rowValues(rows, ["uploaded", "upload date", "date added", "added"])]);
    const exactUploadDate = dateCandidates.map(normalizeExactDate).find(Boolean) ?? null;
    const jsonComments = commentsFromJson(videoObject); const tabComments = commentsFromTab(documentLike);
    diagnostics.artistCandidates = artistValues.length; diagnostics.uploaderCandidates = uploaderValues.length; diagnostics.tagCandidates = tags.length; diagnostics.categoryCandidates = categories.length;
    diagnostics.descriptionEvidence = selectedDescription?.[0] ?? null; diagnostics.uploadDateCandidateFound = dateCandidates.length > 0; diagnostics.commentsCandidateFound = jsonComments !== null || tabComments !== null;
    return { ok: true, record: { videoId: expectedVideoId || identityIds[0], artist: artistValues[0] ?? null, artists: artistValues, artistRefs, uploader: uploaderValues[0] ?? null, uploaders: uploaderValues, tags, categories, entityTrust, description, exactUploadDate, commentsCount: jsonComments ?? tabComments, formats: formatMetadata(videoObject, detailRoot), status: "complete", schemaVersion: TRUSTED_ENTITY_SCHEMA, lastError: null }, diagnostics };
  }

  app.modules.detailParser = Object.freeze({ TRUSTED_ENTITY_SCHEMA, parseDocument, normalizeExactDate, compactText, readableText, plainText, unique, videoIdFromUrl, jsonLdObjects, getVideoSuggestionContainer, verifiedEntityAnchors, modelRefs, commentsFromTab });
})();
