(() => {
  "use strict";

  const app = globalThis.R34MF;
  const constants = app?.modules.constants;
  const parsing = app?.modules.catalogueParsing;
  const urls = app?.modules.urls;
  const uploadDate = app?.modules.uploadDate;
  if (!app || !constants || !parsing || !urls) {
    throw new Error("R34MF catalogue helpers must load before card parser.");
  }

  function firstValue(element, selectors, attributes = []) {
    for (const selector of selectors) {
      const node = element.querySelector(selector);
      if (!node) continue;
      for (const attribute of attributes) {
        const value = node.getAttribute(attribute);
        if (value) return value;
      }
      const text = parsing.cleanText(node.textContent);
      if (text) return text;
    }
    return null;
  }

  function findVideoLink(card) {
    return card.querySelector(constants.selectors.subscriptionsVideoLink)
      ?? card.querySelector(constants.selectors.subscriptionsVideoLinkFallback);
  }

  function sourceFromAttribute(image, attribute) {
    const raw = image?.getAttribute(attribute); if (!raw) return null;
    const candidate = attribute.includes("srcset") ? raw.split(",")[0].trim().split(/\s+/)[0] : raw;
    return urls.thumbnailUrl(candidate);
  }

  function thumbnailSources(image) {
    if (!image) return { preferred: null, fallback: null };
    const preferredOrder = ["data-webp", "data-src", "data-original", "data-lazy-src", "data-source", "data-thumb", "data-srcset", "srcset"];
    const preferred = preferredOrder.map((attribute) => sourceFromAttribute(image, attribute)).find(Boolean) ?? null;
    const fallback = [sourceFromAttribute(image, "data-original"), sourceFromAttribute(image, "src"), ...preferredOrder.map((attribute) => sourceFromAttribute(image, attribute))]
      .find((value) => value && value !== preferred) ?? null;
    return { preferred, fallback };
  }

  function thumbnailSource(image) {
    const { preferred, fallback } = thumbnailSources(image);
    return preferred ?? fallback;
  }

  function legacyThumbnailSource(image) {
    if (!image) return null;
    for (const attribute of ["src", "data-src", "data-original", "data-webp", "data-lazy-src", "data-source", "data-thumb", "srcset", "data-srcset"]) {
      const raw = image.getAttribute(attribute); if (!raw) continue;
      const candidate = attribute.includes("srcset") ? raw.split(",")[0].trim().split(/\s+/)[0] : raw;
      const normalized = urls.thumbnailUrl(candidate); if (normalized) return normalized;
    }
    return null;
  }

  function parseCard(card, context = {}) {
    if (!card?.querySelector) return { ok: false, reason: "card-not-an-element" };
    const link = findVideoLink(card);
    const explicitId = card.getAttribute("data-video-id") ?? card.getAttribute("data-id")
      ?? link?.getAttribute("data-video-id") ?? link?.getAttribute("data-id");
    const href = link?.getAttribute("href") ?? null;
    const videoId = parsing.extractVideoId(explicitId) ?? parsing.extractVideoId(href);
    if (!videoId || !href) return { ok: false, reason: "missing-video-identity" };

    const title = firstValue(card, [constants.selectors.subscriptionsVideoTitle, constants.selectors.subscriptionsVideoLinkFallback], ["title", "data-title"])
      ?? parsing.cleanText(link?.getAttribute("title"))
      ?? null;
    const image = card.querySelector(constants.selectors.subscriptionsVideoThumbnail) ?? card.querySelector("img");
    const sources = thumbnailSources(image);
    const thumbnailUrl = sources.preferred ?? sources.fallback;
    const preview = card.querySelector(constants.selectors.subscriptionsVideoPreview);
    const previewUrl = preview?.getAttribute("data-preview") ?? null;
    const relativeUploadText = parsing.cleanText(card.querySelector(constants.selectors.subscriptionsVideoAdded)?.textContent);
    const observedAt = Number.isFinite(Number(context.observedAt)) ? Number(context.observedAt) : Date.now();
    const uploadObservation = uploadDate?.listingObservationFields?.(relativeUploadText, observedAt) ?? {};
    const ratingText = parsing.cleanText(card.querySelector(constants.selectors.subscriptionsVideoRating)?.textContent);
    const ratingMatch = ratingText?.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:\(\s*([\d,.kmb]+)\s*\))?/i);
    const views = parsing.parseCompactNumber(card.querySelector(constants.selectors.subscriptionsVideoViews)?.textContent);
    const hdAvailable = Boolean(card.querySelector(constants.selectors.subscriptionsVideoQuality));

    return {
      ok: true,
      record: {
        videoId,
        url: urls.rule34VideoUrl(href),
        title,
        durationSec: parsing.parseDuration(firstValue(card, [constants.selectors.subscriptionsVideoDuration])),
        thumbnailUrl,
        thumbnailPreferredUrl: sources.preferred,
        thumbnailFallbackUrl: sources.fallback,
        previewUrl: previewUrl ? urls.rule34VideoUrl(previewUrl) : null,
        hdAvailable,
        relativeUploadText,
        ...uploadObservation,
        ratingPercent: ratingMatch ? parsing.parsePercentage(`${ratingMatch[1]}%`) : null,
        ratingVotes: parsing.parseCompactNumber(ratingMatch?.[2]),
        views,
        nativePage: Number.isInteger(context.pageNumber) ? context.pageNumber : null,
        nativeOrder: Number.isInteger(context.nativeOrder) ? context.nativeOrder : null
      }
    };
  }

  app.modules.cardParser = Object.freeze({
    parseCard,
    thumbnailSource,
    thumbnailSources,
    legacyThumbnailSource
  });
})();