(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime || !api?.storage?.session) return;

  const CLAIM_KEY = "r34mf.autoRecentVideosClaimed";
  const RECENT_LAST_COMPLETE_KEY = "r34mf.autoRecentVideosLastComplete.v1";
  const CLAIM_STALE_MS = 15 * 60 * 1000;
  const RECENT_FREQUENCY_MS = Object.freeze({
    session: 0,
    "1h": 60 * 60 * 1000,
    "3h": 3 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000
  });
  const QUEUE_OWNER_KEY = "r34mf.siteQueueOwner";
  const QUEUE_OWNER_STALE_MS = 6000;
  const ALLOWED_HOSTS = new Set(["rule34video.com", "www.rule34video.com"]);
  const EXPECTED_BLOCK = "list_videos_videos_from_my_subscriptions";
  const MAX_RESPONSE_CHARS = 6_000_000;
  const SETTINGS_KEY = "r34mf.settings";
  let claimChain = Promise.resolve();
  let queueClaimChain = Promise.resolve();
  let debugLogging = false;

  function debug(operation, details = {}) {
    if (!debugLogging) return;
    console.debug("[R34MF]", { subsystem: "background", operation, ...details });
  }

  function localGet(key) {
    if (globalThis.browser?.storage?.local) return globalThis.browser.storage.local.get(key);
    return new Promise((resolve, reject) => api.storage.local.get(key, (value) => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    }));
  }

  function localSet(value) {
    if (globalThis.browser?.storage?.local) return globalThis.browser.storage.local.set(value);
    return new Promise((resolve, reject) => api.storage.local.set(value, () => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    }));
  }

  localGet(SETTINGS_KEY).then((stored) => {
    debugLogging = stored?.[SETTINGS_KEY]?.advanced?.debugLogging === true;
  }).catch(() => {});
  api.storage.onChanged?.addListener?.((changes, areaName) => {
    if (areaName === "local" && changes?.[SETTINGS_KEY]) {
      debugLogging = changes[SETTINGS_KEY].newValue?.advanced?.debugLogging === true;
      debug("settings-applied", { debugLogging });
    }
  });

  function sessionGet(key) {
    if (globalThis.browser?.storage?.session) return globalThis.browser.storage.session.get(key);
    return new Promise((resolve, reject) => api.storage.session.get(key, (value) => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    }));
  }

  function sessionSet(value) {
    if (globalThis.browser?.storage?.session) return globalThis.browser.storage.session.set(value);
    return new Promise((resolve, reject) => api.storage.session.set(value, () => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    }));
  }

  function sessionRemove(key) {
    if (globalThis.browser?.storage?.session) return globalThis.browser.storage.session.remove(key);
    return new Promise((resolve, reject) => api.storage.session.remove(key, () => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    }));
  }

  function normalizeRecentFrequency(value) {
    const key = String(value ?? "session");
    return Object.hasOwn(RECENT_FREQUENCY_MS, key) ? key : "session";
  }

  function recentFrequencyMs(value) {
    return RECENT_FREQUENCY_MS[normalizeRecentFrequency(value)];
  }

  function serializeRecent(run) {
    const next = claimChain.then(run, run);
    claimChain = next.catch(() => {});
    return next;
  }

  async function lastRecentCompletion() {
    const stored = await localGet(RECENT_LAST_COMPLETE_KEY);
    const raw = stored?.[RECENT_LAST_COMPLETE_KEY];
    if (raw && typeof raw === "object") {
      return {
        completedAt: Math.max(0, Number(raw.completedAt) || 0),
        frequency: normalizeRecentFrequency(raw.frequency)
      };
    }
    return { completedAt: Math.max(0, Number(raw) || 0), frequency: "session" };
  }

  async function claimRecentUpdate(frequency = "session") {
    const requestedFrequency = normalizeRecentFrequency(frequency);
    return serializeRecent(async () => {
      const stored = await sessionGet(CLAIM_KEY);
      const current = stored?.[CLAIM_KEY] ?? null;
      const now = Date.now();
      const claimedAt = Number(current?.claimedAt) || 0;
      const completed = current?.status === "complete";
      const inProgressFresh = Boolean(current) && !completed && claimedAt > 0 && now - claimedAt < CLAIM_STALE_MS;

      if (inProgressFresh) {
        const retryAfterMs = Math.max(250, CLAIM_STALE_MS - (now - claimedAt));
        debug("recent-update-claim", { claimed: false, status: "claimed", claimedAt, frequency: requestedFrequency, retryAfterMs });
        return { claimed: false, status: "claimed", claimedAt, frequency: requestedFrequency, retryAfterMs };
      }

      if (requestedFrequency === "session" && completed) {
        const completedAt = Number(current?.completedAt) || 0;
        debug("recent-update-claim", { claimed: false, status: "complete", claimedAt: claimedAt || null, completedAt: completedAt || null, frequency: requestedFrequency });
        return { claimed: false, status: "complete", claimedAt: claimedAt || null, completedAt: completedAt || null, frequency: requestedFrequency };
      }

      const intervalMs = recentFrequencyMs(requestedFrequency);
      if (intervalMs > 0) {
        const last = await lastRecentCompletion();
        const elapsed = last.completedAt > 0 ? now - last.completedAt : Number.POSITIVE_INFINITY;
        if (elapsed < intervalMs) {
          const retryAfterMs = Math.max(250, intervalMs - Math.max(0, elapsed));
          debug("recent-update-claim", {
            claimed: false,
            status: "cooldown",
            completedAt: last.completedAt,
            frequency: requestedFrequency,
            retryAfterMs
          });
          return {
            claimed: false,
            status: "cooldown",
            completedAt: last.completedAt,
            frequency: requestedFrequency,
            retryAfterMs,
            nextEligibleAt: last.completedAt + intervalMs
          };
        }
      }

      const record = {
        status: "claimed",
        frequency: requestedFrequency,
        claimedAt: now,
        completedAt: null
      };
      await sessionSet({ [CLAIM_KEY]: record });
      debug("recent-update-claim", {
        claimed: true,
        claimedAt: record.claimedAt,
        frequency: requestedFrequency,
        recoveredStaleClaim: Boolean(current && !completed)
      });
      return { claimed: true, status: "claimed", claimedAt: record.claimedAt, frequency: requestedFrequency };
    });
  }

  async function completeRecentUpdate(frequency = "session") {
    return serializeRecent(async () => {
      const stored = await sessionGet(CLAIM_KEY);
      const current = stored?.[CLAIM_KEY] ?? {};
      const completedAt = Date.now();
      const resolvedFrequency = normalizeRecentFrequency(current.frequency ?? frequency);
      const intervalMs = recentFrequencyMs(resolvedFrequency);
      const record = {
        status: "complete",
        frequency: resolvedFrequency,
        claimedAt: Number(current.claimedAt) || completedAt,
        completedAt
      };

      // Persist the last successful automatic run across browser restarts so the
      // hour-based schedules remain real minimum intervals instead of per-session timers.
      // Write this before marking the session claim complete so another tab can never
      // observe a completed interval claim without the durable cooldown timestamp.
      await localSet({
        [RECENT_LAST_COMPLETE_KEY]: {
          completedAt,
          frequency: resolvedFrequency
        }
      });
      await sessionSet({ [CLAIM_KEY]: record });
      debug("recent-update-claim-complete", {
        claimedAt: record.claimedAt,
        completedAt,
        frequency: resolvedFrequency,
        intervalMs
      });
      return {
        completed: true,
        completedAt,
        frequency: resolvedFrequency,
        retryAfterMs: intervalMs || 0,
        nextEligibleAt: intervalMs ? completedAt + intervalMs : null
      };
    });
  }

  async function releaseRecentUpdate() {
    return serializeRecent(async () => {
      await sessionRemove(CLAIM_KEY);
      return { released: true };
    });
  }

  function senderTabId(sender) {
    const id = Number(sender?.tab?.id);
    return Number.isInteger(id) && id >= 0 ? id : null;
  }

  async function claimQueueRuntime(token, sender) {
    const normalizedToken = String(token ?? "").slice(0, 160);
    if (!normalizedToken) return { claimed: false, reason: "missing-token" };
    const tabId = senderTabId(sender);
    const run = async () => {
      const stored = await sessionGet(QUEUE_OWNER_KEY);
      const current = stored?.[QUEUE_OWNER_KEY] ?? null;
      const now = Date.now();
      const lastSeenAt = Number(current?.lastSeenAt) || 0;
      const stale = !current || !lastSeenAt || now - lastSeenAt >= QUEUE_OWNER_STALE_MS;
      const sameToken = current?.token === normalizedToken;
      const sameTab = tabId !== null && Number(current?.tabId) === tabId;
      if (current && !stale && !sameToken && !sameTab) {
        debug("queue-runtime-claim", { claimed: false, tabId, ownerTabId: current.tabId ?? null, ageMs: now - lastSeenAt });
        return { claimed: false, reason: "owned-by-another-tab", retryAfterMs: Math.max(250, QUEUE_OWNER_STALE_MS - (now - lastSeenAt)) };
      }
      const record = {
        token: normalizedToken,
        tabId,
        claimedAt: sameToken ? Number(current?.claimedAt) || now : now,
        lastSeenAt: now
      };
      await sessionSet({ [QUEUE_OWNER_KEY]: record });
      debug("queue-runtime-claim", { claimed: true, tabId, replacedSameTab: Boolean(current && sameTab && !sameToken), recoveredStaleOwner: Boolean(current && stale) });
      return { claimed: true, tabId, claimedAt: record.claimedAt, staleAfterMs: QUEUE_OWNER_STALE_MS };
    };
    const next = queueClaimChain.then(run, run);
    queueClaimChain = next.catch(() => {});
    return next;
  }

  async function heartbeatQueueRuntime(token, sender) {
    const normalizedToken = String(token ?? "").slice(0, 160);
    const tabId = senderTabId(sender);
    const run = async () => {
      const stored = await sessionGet(QUEUE_OWNER_KEY);
      const current = stored?.[QUEUE_OWNER_KEY] ?? null;
      const matches = Boolean(current)
        && current.token === normalizedToken
        && (tabId === null || current.tabId === null || Number(current.tabId) === tabId);
      if (!matches) return { owned: false };
      const next = { ...current, lastSeenAt: Date.now() };
      await sessionSet({ [QUEUE_OWNER_KEY]: next });
      return { owned: true, lastSeenAt: next.lastSeenAt, staleAfterMs: QUEUE_OWNER_STALE_MS };
    };
    const next = queueClaimChain.then(run, run);
    queueClaimChain = next.catch(() => {});
    return next;
  }

  async function releaseQueueRuntime(token, sender) {
    const normalizedToken = String(token ?? "").slice(0, 160);
    const tabId = senderTabId(sender);
    const run = async () => {
      const stored = await sessionGet(QUEUE_OWNER_KEY);
      const current = stored?.[QUEUE_OWNER_KEY] ?? null;
      const matches = Boolean(current)
        && current.token === normalizedToken
        && (tabId === null || current.tabId === null || Number(current.tabId) === tabId);
      if (!matches) return { released: false };
      await sessionRemove(QUEUE_OWNER_KEY);
      return { released: true };
    };
    const next = queueClaimChain.then(run, run);
    queueClaimChain = next.catch(() => {});
    return next;
  }

  function validatedCatalogueUrl(value) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      return null;
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLocaleLowerCase()) || path !== "/my/subscriptions") return null;
    if (url.searchParams.get("mode") !== "async") return null;
    if (url.searchParams.get("function") !== "get_block") return null;
    if (url.searchParams.get("block_id") !== EXPECTED_BLOCK) return null;
    return url;
  }

  function alternateHost(url) {
    const next = new URL(url.href);
    next.hostname = next.hostname === "www.rule34video.com" ? "rule34video.com" : "www.rule34video.com";
    return next;
  }

  function safeError(error) {
    return {
      code: String(error?.code ?? "background-fetch-failed").slice(0, 80),
      message: String(error?.message ?? error ?? "Rule34Video request failed.").slice(0, 240)
    };
  }

  async function fetchCataloguePage(value) {
    const url = validatedCatalogueUrl(value);
    if (!url) {
      debug("catalogue-proxy-rejected", { reason: "invalid-url" });
      return {
        ok: false,
        status: 0,
        error: safeError(Object.assign(new Error("Blocked an invalid catalogue proxy URL."), { code: "proxy-url-rejected" }))
      };
    }

    let lastError = null;
    for (const candidate of [url, alternateHost(url)]) {
      try {
        debug("catalogue-proxy-request", { host: candidate.hostname, page: candidate.searchParams.get("from") ?? "1" });
        const response = await fetch(candidate.href, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "follow"
        });
        const text = await response.text();
        if (text.length > MAX_RESPONSE_CHARS) {
          return {
            ok: false,
            status: 0,
            error: safeError(Object.assign(new Error("Catalogue response was unexpectedly large."), { code: "proxy-response-too-large" }))
          };
        }
        return {
          ok: response.ok,
          status: response.status,
          url: response.url,
          retryAfter: response.headers.get("Retry-After"),
          text
        };
      } catch (error) {
        debug("catalogue-proxy-network-failure", { host: candidate.hostname, name: error?.name ?? null, message: String(error?.message ?? error).slice(0, 180) });
        lastError = error;
      }
    }

    return {
      ok: false,
      status: 0,
      error: safeError(Object.assign(
        new Error(lastError?.message || "Rule34Video could not be reached from the extension request context."),
        { code: "network-fetch-failed" }
      ))
    };
  }

  async function handle(message, sender) {
    if (message?.type === "r34mf:auto-recent-claim") return claimRecentUpdate(message.frequency);
    if (message?.type === "r34mf:auto-recent-complete") return completeRecentUpdate(message.frequency);
    if (message?.type === "r34mf:auto-recent-release") return releaseRecentUpdate();
    if (message?.type === "r34mf:queue-runtime-claim") return claimQueueRuntime(message.token, sender);
    if (message?.type === "r34mf:queue-runtime-heartbeat") return heartbeatQueueRuntime(message.token, sender);
    if (message?.type === "r34mf:queue-runtime-release") return releaseQueueRuntime(message.token, sender);
    if (message?.type === "r34mf:fetch-subscriptions-page") return fetchCataloguePage(message.url);
    return undefined;
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type?.startsWith?.("r34mf:")) return undefined;
    handle(message, sender).then(
      sendResponse,
      (error) => sendResponse({ ok: false, status: 0, error: safeError(error) })
    );
    return true;
  });

  globalThis.R34MFSessionRuntime = Object.freeze({
    CLAIM_KEY,
    RECENT_LAST_COMPLETE_KEY,
    CLAIM_STALE_MS,
    RECENT_FREQUENCY_MS,
    QUEUE_OWNER_KEY,
    QUEUE_OWNER_STALE_MS,
    normalizeRecentFrequency,
    recentFrequencyMs,
    lastRecentCompletion,
    validatedCatalogueUrl,
    claimRecentUpdate,
    completeRecentUpdate,
    releaseRecentUpdate,
    claimQueueRuntime,
    heartbeatQueueRuntime,
    releaseQueueRuntime,
    fetchCataloguePage
  });
})();
