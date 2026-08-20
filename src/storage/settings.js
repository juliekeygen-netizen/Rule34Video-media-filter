(() => {
  "use strict";

  const app = globalThis.R34MF;
  const constants = app?.modules.constants;
  const browserApi = app?.modules.browserApi;
  if (!app || !constants || !browserApi) {
    throw new Error("R34MF constants and browser API adapter must load before settings.");
  }

  const REQUEST_PACE_SPACING_MS = Object.freeze({
    conservative: 500,
    recommended: 250,
    faster: 125
  });

  const AUTO_UPDATE_RECENT_FREQUENCY_MS = Object.freeze({
    session: 0,
    "1h": 60 * 60 * 1000,
    "3h": 3 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000
  });

  const THUMBNAIL_ASPECT_RATIOS = Object.freeze(["16:9", "16:10", "3:2", "4:3", "5:4", "1:1"]);
  const ARTIST_THUMBNAIL_LABEL_SIZES = Object.freeze(["small", "medium", "big"]);

  const defaults = Object.freeze({
    version: 3,
    concurrentQueueJobs: 1,
    concurrentDetailRequests: 2,
    recentUpdatePageLimit: 3,
    retryTemporaryDetailFailures: true,
    requestPace: "recommended",
    autoFetchMissingDetails: false,
    autoUpdateRecentVideos: false,
    autoUpdateRecentVideosFrequency: "session",
    videosPerPage: 24,
    videoColumns: 3,
    thumbnailAspectRatio: "16:9",
    animatedHoverPreviews: true,
    improvedPlayerPlaybackControls: true,
    artistThumbnailLabels: true,
    artistThumbnailLabelSize: "medium",
    showCloudSyncMainButtons: false,
    automaticSignIn: false,
    openSubscriptionsAfterAutomaticSignIn: false,
    advanced: Object.freeze({
      minimumRequestSpacingMs: REQUEST_PACE_SPACING_MS.recommended,
      maximumAutomaticRetries: 2,
      smartUpdateKnownPageThreshold: 3,
      debugLogging: false
    })
  });

  function cloneDefaults() {
    return { ...defaults, advanced: { ...defaults.advanced } };
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function paceForSpacing(value) {
    const spacing = Number(value);
    return Object.entries(REQUEST_PACE_SPACING_MS)
      .find(([, milliseconds]) => milliseconds === spacing)?.[0] ?? "custom";
  }

  function applyRequestPace(raw, pace) {
    if (!Object.hasOwn(REQUEST_PACE_SPACING_MS, pace)) return normalize(raw);
    return normalize({
      ...(raw ?? {}),
      requestPace: pace,
      advanced: {
        ...(raw?.advanced ?? {}),
        minimumRequestSpacingMs: REQUEST_PACE_SPACING_MS[pace]
      }
    });
  }

  function autoUpdateRecentIntervalMs(value) {
    const key = String(value ?? "session");
    return Object.hasOwn(AUTO_UPDATE_RECENT_FREQUENCY_MS, key)
      ? AUTO_UPDATE_RECENT_FREQUENCY_MS[key]
      : AUTO_UPDATE_RECENT_FREQUENCY_MS.session;
  }

  function normalize(raw = {}) {
    raw = raw ?? {};
    const next = cloneDefaults();

    next.concurrentQueueJobs = Number(raw.concurrentQueueJobs) === 2 ? 2 : 1;
    next.concurrentDetailRequests = Math.round(clampNumber(raw.concurrentDetailRequests, 1, 3, 2));
    next.recentUpdatePageLimit = Math.round(clampNumber(raw.recentUpdatePageLimit, 1, 20, 3));
    next.retryTemporaryDetailFailures = raw.retryTemporaryDetailFailures !== false;
    next.autoFetchMissingDetails = raw.autoFetchMissingDetails === true;
    next.autoUpdateRecentVideos = raw.autoUpdateRecentVideos === true;
    next.autoUpdateRecentVideosFrequency = Object.hasOwn(AUTO_UPDATE_RECENT_FREQUENCY_MS, String(raw.autoUpdateRecentVideosFrequency))
      ? String(raw.autoUpdateRecentVideosFrequency)
      : "session";
    next.videosPerPage = [24, 48, 72].includes(Number(raw.videosPerPage)) ? Number(raw.videosPerPage) : 24;
    next.videoColumns = Math.round(clampNumber(raw.videoColumns, 1, 6, 3));
    next.thumbnailAspectRatio = THUMBNAIL_ASPECT_RATIOS.includes(String(raw.thumbnailAspectRatio)) ? String(raw.thumbnailAspectRatio) : "16:9";
    next.animatedHoverPreviews = raw.animatedHoverPreviews !== false;
    next.improvedPlayerPlaybackControls = raw.improvedPlayerPlaybackControls !== false;
    next.artistThumbnailLabels = raw.artistThumbnailLabels !== false;
    next.artistThumbnailLabelSize = ARTIST_THUMBNAIL_LABEL_SIZES.includes(String(raw.artistThumbnailLabelSize))
      ? String(raw.artistThumbnailLabelSize)
      : "medium";
    next.showCloudSyncMainButtons = raw.showCloudSyncMainButtons === true;
    next.automaticSignIn = raw.automaticSignIn === true;
    next.openSubscriptionsAfterAutomaticSignIn = raw.openSubscriptionsAfterAutomaticSignIn === true;

    const advanced = raw.advanced ?? {};
    next.advanced.minimumRequestSpacingMs = Math.round(clampNumber(advanced.minimumRequestSpacingMs, 0, 10_000, REQUEST_PACE_SPACING_MS.recommended));
    next.advanced.maximumAutomaticRetries = Math.round(clampNumber(advanced.maximumAutomaticRetries, 0, 100, 2));
    next.advanced.smartUpdateKnownPageThreshold = Math.round(clampNumber(advanced.smartUpdateKnownPageThreshold, 1, 20, 3));
    next.advanced.debugLogging = advanced.debugLogging === true;

    // Custom is derived; it is never a fourth user-selectable preset.
    next.requestPace = paceForSpacing(next.advanced.minimumRequestSpacingMs);
    return next;
  }

  const settings = {
    defaults,
    REQUEST_PACE_SPACING_MS,
    AUTO_UPDATE_RECENT_FREQUENCY_MS,
    THUMBNAIL_ASPECT_RATIOS,
    ARTIST_THUMBNAIL_LABEL_SIZES,
    value: cloneDefaults(),
    listeners: new Set(),

    emit(previous, source) {
      const current = this.value;
      for (const listener of this.listeners) listener(current, previous, source);
      return current;
    },

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },

    async load() {
      const result = await browserApi.storageLocal.get(constants.storageKeys.settings);
      const previous = this.value;
      this.value = normalize(result[constants.storageKeys.settings]);
      this.emit(previous, "load");
      return this.value;
    },

    async save(value, extraStorage = {}) {
      const normalized = normalize(value);
      await browserApi.storageLocal.set({
        ...(extraStorage && typeof extraStorage === "object" ? extraStorage : {}),
        [constants.storageKeys.settings]: normalized
      });
      const previous = this.value;
      this.value = normalized;
      this.emit(previous, "save");
      return this.value;
    },

    normalize,
    paceForSpacing,
    applyRequestPace,
    autoUpdateRecentIntervalMs,
    resetPreview() { return cloneDefaults(); }
  };

  browserApi.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local" || !changes?.[constants.storageKeys.settings]) return;
    const previous = settings.value;
    settings.value = normalize(changes[constants.storageKeys.settings].newValue);
    settings.emit(previous, "storage-change");
  });

  app.modules.settings = settings;
})();
