(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.detailParser;
  if (!app || !base) throw new Error("R34MF detail parser must load before schema-6 topology hardening.");

  const TRUSTED_ENTITY_SCHEMA = 6;
  const RULE34_HOSTS = new Set(["rule34video.com", "www.rule34video.com"]);

  function compactText(value) {
    return base.compactText?.(value) ?? String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function sameVideo(node, expectedVideoId) {
    return !expectedVideoId || String(node?.getAttribute?.("data-video-id") ?? "") === String(expectedVideoId);
  }

  function unique(values) {
    return base.unique?.(values) ?? [...new Set((values ?? []).map((value) => compactText(value)).filter(Boolean))];
  }

  function directLabel(node) {
    return compactText(node?.querySelector?.(":scope > .label, :scope > strong, :scope > dt")?.textContent)
      .replace(/:$/, "")
      .toLocaleLowerCase();
  }

  function strictContainers(documentLike, expectedVideoId, type) {
    const labels = type === "model" ? new Set(["artist", "artists"])
      : type === "category" ? new Set(["category", "categories"])
        : new Set(["tag", "tags"]);
    return base.getVideoSuggestionContainer(documentLike, expectedVideoId, type)
      .filter((container) => labels.has(directLabel(container)));
  }

  function entityValue(node) {
    return compactText(node?.querySelector?.(".name, [data-entity-name]")?.textContent ?? node?.textContent);
  }

  function canonicalEntityAnchor(anchor, type, baseUrl) {
    if (!anchor || anchor.matches?.(".tag_item_load_more, .tag_item_suggest")) return false;
    let url;
    try { url = new URL(anchor.getAttribute("href"), baseUrl); }
    catch { return false; }
    if (!RULE34_HOSTS.has(url.hostname.toLocaleLowerCase())) return false;
    const segment = type === "model" ? "models" : type === "category" ? "categories" : "tags";
    return new RegExp(`^/${segment}/[^/]+/?$`, "i").test(url.pathname);
  }

  function entityEvidence(containers, expectedVideoId, type, baseUrl) {
    const anchors = [];
    let malformedItems = 0;
    let genuineItems = 0;

    for (const container of containers ?? []) {
      const chips = [...(container.querySelectorAll?.("[data-item-type]") ?? [])]
        .filter((chip) => chip.getAttribute("data-item-type") === type)
        .filter((chip) => chip.getAttribute("data-status") !== "pending")
        .filter((chip) => !chip.matches?.(".tag_suggestion_chip, .tag_suggestion_item, .video-suggest-panel *, .suggest-tags *"));

      for (const chip of chips) {
        genuineItems += 1;
        if (!sameVideo(chip, expectedVideoId)) {
          malformedItems += 1;
          continue;
        }
        const candidates = [
          ...(chip.matches?.("a[href]") ? [chip] : []),
          ...(chip.querySelectorAll?.("a[href]") ?? [])
        ].filter((anchor) => canonicalEntityAnchor(anchor, type, baseUrl));
        if (!candidates.length) {
          malformedItems += 1;
          continue;
        }
        anchors.push(...candidates);
      }
    }

    const deduped = [];
    const seen = new Set();
    for (const anchor of anchors) {
      let key;
      try { key = new URL(anchor.getAttribute("href"), baseUrl).href; }
      catch { continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(anchor);
    }

    return {
      trusted: Boolean(containers?.length) && malformedItems === 0,
      anchors: deduped,
      genuineItems,
      malformedItems
    };
  }

  function uploaderColumns(region) {
    return [...(region?.querySelectorAll?.(".col, .info-row, .row") ?? [])]
      .filter((column) => directLabel(column) === "uploaded by");
  }

  function downloadBlocks(region) {
    return [...(region?.querySelectorAll?.(".col, .wrap, section, div") ?? [])]
      .filter((block) => directLabel(block) === "download");
  }

  // Find the smallest non-document ancestor that groups the strict current-video
  // entity containers. Prefer the first ancestor that also contains the unkeyed
  // Uploaded by / Download rows visible in Rule34Video's Info panel.
  function metadataRegion(documentLike, containers) {
    if (!containers?.length) return null;
    const body = documentLike?.body ?? null;
    const html = documentLike?.documentElement ?? null;
    let fallback = null;
    let node = containers[0]?.parentElement ?? null;

    while (node && node !== body && node !== html) {
      if (containers.every((container) => node.contains?.(container))) {
        fallback ??= node;
        if (uploaderColumns(node).length || downloadBlocks(node).length) return node;
      }
      node = node.parentElement;
    }
    return fallback;
  }

  function scopedUploaderValues(columns, expectedVideoId, baseUrl) {
    const values = [];
    for (const column of columns ?? []) {
      for (const anchor of column.querySelectorAll?.("a[href*='/members/'], a[href*='/users/']") ?? []) {
        try {
          const url = new URL(anchor.getAttribute("href"), baseUrl);
          const owner = column.closest?.("[data-video-id]");
          if (owner && !sameVideo(owner, expectedVideoId)) continue;
          if (!RULE34_HOSTS.has(url.hostname.toLocaleLowerCase())) continue;
          if (!/^\/(?:members|users)\/\d+\/?$/i.test(url.pathname)) continue;
          values.push(anchor.textContent);
        } catch {
          // Invalid links are not uploader metadata.
        }
      }
    }
    return unique(values);
  }

  function downloadFormats(region) {
    const values = [];
    const seen = new Set();
    for (const block of downloadBlocks(region)) {
      for (const node of block.querySelectorAll?.(".tag_item_download") ?? []) {
        const text = compactText(node.textContent);
        const resolution = text.match(/\b(\d{3,5}p)\b/i)?.[1]?.toLocaleLowerCase();
        const format = text.match(/^\s*([a-z0-9][a-z0-9._+-]*)\b/i)?.[1]?.toLocaleLowerCase();
        const value = { ...(format ? { format } : {}), ...(resolution ? { resolution } : {}) };
        const key = JSON.stringify(value);
        if (Object.keys(value).length && !seen.has(key)) {
          seen.add(key);
          values.push(value);
        }
      }
    }
    return values;
  }

  function mergeFormats(existing, discovered) {
    const result = [];
    const seen = new Set();
    for (const value of [...(existing ?? []), ...(discovered ?? [])]) {
      if (!value || typeof value !== "object") continue;
      const safe = {
        ...(compactText(value.name) ? { name: compactText(value.name) } : {}),
        ...(compactText(value.format) ? { format: compactText(value.format).toLocaleLowerCase() } : {}),
        ...(compactText(value.quality) ? { quality: compactText(value.quality) } : {}),
        ...(compactText(value.resolution) ? { resolution: compactText(value.resolution).toLocaleLowerCase() } : {})
      };
      if (!Object.keys(safe).length) continue;
      const key = JSON.stringify(safe);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(safe);
      }
    }
    return result.slice(0, 20);
  }

  function parseDocument(documentLike, context = {}) {
    const parsed = base.parseDocument(documentLike, context);
    if (!parsed?.ok) return parsed;

    const expectedVideoId = compactText(context.expectedVideoId || parsed.record?.videoId);
    const baseUrl = context.url ?? "https://rule34video.com/";

    // These structures are already tied to the expected current video. Do not
    // additionally require them to sit beneath #video_view/the player root: on
    // the live site the Info panel is a sibling region.
    const artistContainers = strictContainers(documentLike, expectedVideoId, "model");
    const categoryContainers = strictContainers(documentLike, expectedVideoId, "category");
    const tagContainers = strictContainers(documentLike, expectedVideoId, "tag");
    const keyedContainers = [...artistContainers, ...categoryContainers, ...tagContainers];
    const region = metadataRegion(documentLike, keyedContainers);
    const regionUploaderColumns = uploaderColumns(region);

    const artistEvidence = entityEvidence(artistContainers, expectedVideoId, "model", baseUrl);
    const categoryEvidence = entityEvidence(categoryContainers, expectedVideoId, "category", baseUrl);
    const tagEvidence = entityEvidence(tagContainers, expectedVideoId, "tag", baseUrl);

    const artists = unique(artistEvidence.anchors.map(entityValue));
    const artistRefs = base.modelRefs(artistEvidence.anchors, baseUrl);
    const tags = unique(tagEvidence.anchors.map(entityValue));
    const categories = unique(categoryEvidence.anchors.map(entityValue));

    const regionUploaders = scopedUploaderValues(regionUploaderColumns, expectedVideoId, baseUrl);
    const baseUploaders = unique(parsed.record?.uploaders?.length
      ? parsed.record.uploaders
      : parsed.record?.uploader ? [parsed.record.uploader] : []);
    const uploaders = regionUploaders.length ? regionUploaders : baseUploaders;
    // Uploader has no current-video data attribute. Treat it as authoritative
    // only when the exact Uploaded by structure produced a canonical member/user
    // value; an unrecognized or empty-looking row remains UNKNOWN, not false.
    const uploaderTrusted = uploaders.length > 0
      && (regionUploaderColumns.length > 0 || parsed.record?.entityTrust?.uploader === true);

    const entityTrust = {
      artist: artistEvidence.trusted,
      uploader: uploaderTrusted,
      tags: tagEvidence.trusted,
      categories: categoryEvidence.trusted
    };
    const entityStructureVerified = Object.values(entityTrust).some(Boolean);
    const diagnostics = {
      ...(parsed.diagnostics ?? {}),
      strictEntityContainers: {
        artist: artistContainers.length,
        category: categoryContainers.length,
        tag: tagContainers.length
      },
      entityTrust,
      entityStructureVerified,
      metadataRegionFound: Boolean(region),
      entityMalformedItems: {
        artist: artistEvidence.malformedItems,
        category: categoryEvidence.malformedItems,
        tag: tagEvidence.malformedItems
      }
    };

    // Schema 5 showed that accepting a page with every entity structure
    // unrecognized can silently convert a site-wide DOM change into thousands
    // of apparently successful empty records. Reuse the scanner's existing
    // structural failure code so its authenticated canary/circuit breaker stops
    // before bulk work.
    if (!entityStructureVerified) {
      return { ok: false, reason: "unexpected-detail-structure", diagnostics };
    }

    diagnostics.artistCandidates = artists.length;
    diagnostics.uploaderCandidates = uploaders.length;
    diagnostics.tagCandidates = tags.length;
    diagnostics.categoryCandidates = categories.length;

    return {
      ok: true,
      record: {
        ...parsed.record,
        videoId: expectedVideoId || parsed.record.videoId,
        artist: artists[0] ?? null,
        artists,
        artistRefs,
        uploader: uploaders[0] ?? null,
        uploaders,
        tags,
        categories,
        entityTrust,
        formats: mergeFormats(parsed.record?.formats, downloadFormats(region)),
        schemaVersion: TRUSTED_ENTITY_SCHEMA,
        lastError: null
      },
      diagnostics
    };
  }

  app.modules.detailParser = Object.freeze({
    ...base,
    TRUSTED_ENTITY_SCHEMA,
    parseDocument,
    strictContainers,
    entityEvidence,
    metadataRegion,
    uploaderColumns,
    downloadFormats
  });
})();