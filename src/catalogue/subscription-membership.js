(() => {
  "use strict";

  const app = globalThis.R34MF;
  const constants = app?.modules.constants;
  const scheduler = app?.modules.requestScheduler;
  if (!app || !constants || !scheduler) throw new Error("R34MF request infrastructure must load before subscription membership.");

  const BLOCK_ID = "list_members_subscriptions_my_subscriptions";
  const CACHE_KEY = "r34mf.currentSubscriptions.v1";
  const FRESH_MS = 5 * 60 * 1000;
  const MAX_PAGES = 100;
  const INITIAL_DISCOVERY_MS = 750;
  const ALLOWED_HOSTS = new Set(["rule34video.com", "www.rule34video.com"]);
  const listeners = new Set();
  let completeSnapshot = null;
  let syncStatus = "idle";
  let lastError = null;
  let refreshPromise = null;
  let generation = 0;
  let attachedDocument = null;
  let nativeObserver = null;
  let mutationTimer = null;
  let discoveryTimer = null;
  let activeController = null;
  let storageBound = false;

  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const nameKey = (value) => clean(value).toLocaleLowerCase();

  function normalizeModelRef(input, base = globalThis.location?.origin ?? "https://rule34video.com") {
    const rawUrl = typeof input === "string" ? input : input?.url;
    let url;
    try { url = new URL(String(rawUrl ?? ""), base); } catch { return null; }
    if (!ALLOWED_HOSTS.has(url.hostname.toLocaleLowerCase())) return null;
    const match = url.pathname.match(/^\/models\/([^/]+)\/?$/i);
    if (!match) return null;
    let slug;
    try { slug = decodeURIComponent(match[1]).trim().toLocaleLowerCase(); } catch { return null; }
    if (!slug || slug.length > 200 || !/^[a-z0-9._~-]+$/i.test(slug)) return null;
    const name = clean(typeof input === "string" ? "" : input?.name);
    return { key: slug, name: name || slug, url: `${url.origin}/models/${encodeURIComponent(slug)}/` };
  }

  function parseParameters(value) {
    const result = {};
    for (const part of String(value ?? "").split(";")) {
      const separator = part.indexOf(":");
      if (separator < 1) continue;
      const key = part.slice(0, separator).trim();
      const item = part.slice(separator + 1).trim();
      if (/^[a-z][a-z0-9_]*$/i.test(key) && item.length <= 500) result[key] = item;
    }
    return result;
  }

  function pageNumber(value) {
    return /^\d{1,3}$/.test(String(value ?? "")) && Number(value) > 0 ? Number(value) : null;
  }

  function parseNativeTotal(block) {
    const text = clean(block?.querySelector?.(".total_results")?.textContent ?? "");
    if (!/\d/.test(text)) return null;
    const number = Number(text.replace(/[^\d]/g, ""));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function parseCurrentPage(block, pagination) {
    const heading = clean(block?.querySelector?.(".current_page")?.textContent).match(/\bpage\s+(\d+)\b/i);
    if (heading) return pageNumber(heading[1]);
    const active = pagination?.querySelector?.(".active [data-parameters], .current [data-parameters], .selected [data-parameters], [aria-current='page'][data-parameters]");
    return pageNumber(parseParameters(active?.getAttribute?.("data-parameters")).from_my_subscriptions);
  }

  function parseDocument(documentLike, { origin = globalThis.location?.origin ?? "https://rule34video.com", expectedPage = null, verifiedPagination = null } = {}) {
    const nativeBlock = documentLike?.querySelector?.(constants.selectors.membershipBlock) ?? null;
    const items = nativeBlock?.querySelector?.(constants.selectors.membershipItems)
      ?? documentLike?.querySelector?.(constants.selectors.membershipItems) ?? null;
    if (!items) return { ok: false, reason: nativeBlock ? "membership-items-missing" : "membership-block-missing" };
    // get_block may legitimately return the verified items fragment without its outer wrapper.
    const block = nativeBlock ?? documentLike;
    const valuesByKey = new Map();
    for (const anchor of items.querySelectorAll("a[href*='/models/']")) {
      const ref = normalizeModelRef({ url: anchor.getAttribute("href"), name: anchor.querySelector(".name")?.textContent ?? anchor.textContent }, origin);
      if (ref && !valuesByKey.has(ref.key)) valuesByKey.set(ref.key, ref);
    }
    const pagination = block.querySelector(constants.selectors.membershipPagination)
      ?? documentLike.querySelector(constants.selectors.membershipPagination);
    const parameterNodes = [...(pagination?.querySelectorAll?.("[data-parameters]") ?? [])]
      .filter((node) => (node.getAttribute("data-block-id") ?? BLOCK_ID) === BLOCK_ID);
    const templates = parameterNodes.map((node) => parseParameters(node.getAttribute("data-parameters")));
    const template = templates.find((value) => Object.hasOwn(value, "from_my_subscriptions")) ?? null;
    const observedPages = [...new Set(templates.map((value) => pageNumber(value.from_my_subscriptions)).filter(Boolean))].sort((a, b) => a - b);
    const currentPage = parseCurrentPage(block, pagination) ?? pageNumber(expectedPage);
    if (!currentPage) return { ok: false, reason: "membership-current-page-missing" };
    if (expectedPage && currentPage !== Number(expectedPage)) return { ok: false, reason: "membership-page-mismatch" };
    const total = parseNativeTotal(block) ?? verifiedPagination?.total ?? null;
    const maxObserved = Math.max(currentPage, ...observedPages);
    const pageCapacity = valuesByKey.size > 0 && (currentPage < maxObserved || (currentPage === 1 && total > valuesByKey.size)) ? valuesByKey.size : null;
    const derivedCount = pageCapacity && total !== null ? Math.ceil(total / pageCapacity) : null;
    const pageCount = verifiedPagination?.pageCount ?? Math.max(maxObserved, derivedCount ?? 0);
    const requestTemplate = template ? { blockId: BLOCK_ID, parameters: template } : verifiedPagination?.requestTemplate ?? null;
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES || (pageCount > 1 && !requestTemplate)) {
      return { ok: false, reason: "membership-pagination-unverified" };
    }
    return {
      ok: true,
      block,
      values: [...valuesByKey.values()],
      total,
      currentPage,
      pageCount,
      pageTargets: Array.from({ length: pageCount }, (_, index) => index + 1),
      requestTemplate
    };
  }

  function buildPageUrl(parsed, targetPage, origin = globalThis.location?.origin ?? "https://rule34video.com") {
    if (!parsed?.requestTemplate || !pageNumber(targetPage)) throw new Error("A verified membership paginator template and page are required.");
    const url = new URL("/my/subscriptions/", origin);
    if (!ALLOWED_HOSTS.has(url.hostname.toLocaleLowerCase())) throw new Error("Membership requests require a Rule34Video origin.");
    url.searchParams.set("mode", "async");
    url.searchParams.set("function", "get_block");
    url.searchParams.set("block_id", parsed.requestTemplate.blockId);
    for (const [key, value] of Object.entries(parsed.requestTemplate.parameters)) {
      url.searchParams.set(key, key === "from_my_subscriptions" ? String(targetPage).padStart(2, "0") : value);
    }
    return url.href;
  }

  function validSnapshot(value) {
    if (!value || value.version !== 1 || value.status !== "complete" || !Array.isArray(value.values)) return null;
    const values = value.values.map((item) => normalizeModelRef(item, item?.url)).filter(Boolean);
    if (values.length !== Number(value.total) || !Number.isFinite(Number(value.refreshedAt))) return null;
    return { version: 1, status: "complete", values, total: values.length, refreshedAt: Number(value.refreshedAt), sourcePageCount: Number(value.sourcePageCount) || 1, accountKey: clean(value.accountKey) || "unknown" };
  }

  function readCache() {
    if (completeSnapshot) return completeSnapshot;
    try { completeSnapshot = validSnapshot(JSON.parse(globalThis.sessionStorage?.getItem(CACHE_KEY) ?? "null")); } catch { completeSnapshot = null; }
    return completeSnapshot;
  }

  function persist(snapshot) {
    try { globalThis.sessionStorage?.setItem(CACHE_KEY, JSON.stringify(snapshot)); } catch { /* the in-memory complete snapshot remains usable */ }
  }

  function accountFingerprint(documentLike = document) {
    const auth = globalThis.R34MFAutoSignIn;
    if (auth?.looksLoggedOut?.(documentLike)) return "logged-out";
    const profile = documentLike.querySelector?.("header a[href*='/members/'], header a[href*='/users/'], #header a[href*='/members/'], #header a[href*='/users/']");
    if (profile) {
      try { return `signed-in:${new URL(profile.getAttribute("href"), globalThis.location?.origin).pathname.toLocaleLowerCase()}`; } catch { /* use the signed-in fallback */ }
    }
    return auth?.looksLoggedIn?.(documentLike) ? "signed-in" : "unknown";
  }

  function publicState() {
    const snapshot = readCache();
    return { snapshot, status: syncStatus, stale: Boolean(snapshot && (Date.now() - snapshot.refreshedAt >= FRESH_MS || lastError)), error: lastError };
  }

  function emit() { const value = publicState(); listeners.forEach((listener) => listener(value)); return value; }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }

  function evaluationContext() {
    const snapshot = readCache();
    if (!snapshot) return { status: "unavailable", keys: new Set(), names: new Set() };
    return {
      status: "complete",
      keys: new Set(snapshot.values.map((value) => value.key)),
      names: new Set(snapshot.values.map((value) => nameKey(value.name)).filter(Boolean))
    };
  }

  function invalidate(reason = "stale", { clear = false } = {}) {
    generation += 1;
    lastError = reason === "stale" ? lastError : { code: reason, message: "Current subscriptions need to be refreshed." };
    if (clear) {
      completeSnapshot = null;
      try { globalThis.sessionStorage?.removeItem(CACHE_KEY); } catch { /* cache is already unavailable */ }
    }
    emit();
  }

  function nativeBlock(documentLike) { return documentLike?.querySelector?.(constants.selectors.membershipBlock) ?? null; }
  function sameMembershipRoute(value, origin) {
    try {
      const url = new URL(value, origin);
      return ALLOWED_HOSTS.has(url.hostname.toLocaleLowerCase()) && url.pathname.replace(/\/+$/, "") === "/my/subscriptions";
    } catch { return false; }
  }
  function scheduleNativeRefresh(documentLike) {
    if (mutationTimer !== null) globalThis.clearTimeout(mutationTimer);
    mutationTimer = globalThis.setTimeout(() => {
      mutationTimer = null;
      invalidate("membership-native-block-changed");
      refresh({ documentLike, force: true }).catch(() => {});
    }, 250);
  }
  function observeNativeBlock(documentLike) {
    nativeObserver?.disconnect();
    nativeObserver = null;
    if (discoveryTimer !== null) globalThis.clearTimeout(discoveryTimer);
    discoveryTimer = null;
    if (typeof MutationObserver !== "function") return;
    const block = nativeBlock(documentLike);
    const target = block ? block.parentElement ?? block : documentLike?.body ?? documentLike?.documentElement;
    if (!target) return;
    nativeObserver = new MutationObserver((records) => {
      const current = nativeBlock(documentLike);
      if (!current) return;
      if (!block || current !== block) {
        observeNativeBlock(documentLike);
        scheduleNativeRefresh(documentLike);
        return;
      }
      const relevant = records.some((record) => record.type === "childList" && (record.target === block || block.contains?.(record.target)));
      if (relevant) scheduleNativeRefresh(documentLike);
    });
    nativeObserver.observe(target, { childList: true, subtree: true });
    if (!block) {
      discoveryTimer = globalThis.setTimeout(() => {
        discoveryTimer = null;
        if (!nativeBlock(documentLike)) { nativeObserver?.disconnect(); nativeObserver = null; }
      }, INITIAL_DISCOVERY_MS);
    }
  }
  function waitForNativeBlock(documentLike, signal) {
    if (nativeBlock(documentLike) || typeof MutationObserver !== "function") return Promise.resolve(documentLike);
    const target = documentLike?.body ?? documentLike?.documentElement;
    if (!target) return Promise.resolve(documentLike);
    return new Promise((resolve, reject) => {
      let timer = null;
      const observer = new MutationObserver(() => { if (nativeBlock(documentLike)) finish(); });
      const abort = () => { cleanup(); reject(new DOMException("Subscription discovery was aborted.", "AbortError")); };
      const cleanup = () => { observer.disconnect(); if (timer !== null) globalThis.clearTimeout(timer); signal?.removeEventListener?.("abort", abort); };
      const finish = () => { cleanup(); resolve(documentLike); };
      observer.observe(target, { childList: true, subtree: true });
      timer = globalThis.setTimeout(finish, INITIAL_DISCOVERY_MS);
      signal?.addEventListener?.("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async function fetchInitialDocument(origin, signal) {
    const url = new URL("/my/subscriptions/", origin).href;
    const response = await scheduler.runWithPolicy({
      signal,
      request: ({ signal: requestSignal }) => fetch(url, { credentials: "include", cache: "no-store", signal: requestSignal })
    });
    if (!response?.ok) throw Object.assign(new Error(`Subscriptions page returned HTTP ${response?.status ?? "unknown"}.`), { code: "membership-http-error" });
    if (!sameMembershipRoute(response.url || url, origin)) throw Object.assign(new Error("Subscriptions response left the verified Rule34Video route."), { code: "membership-response-url-invalid" });
    return new DOMParser().parseFromString(await response.text(), "text/html");
  }

  async function fetchPage(url, expectedPage, signal, origin, verifiedPagination) {
    const response = await scheduler.runWithPolicy({
      signal,
      request: ({ signal: requestSignal }) => fetch(url, { credentials: "include", cache: "no-store", signal: requestSignal })
    });
    if (!response?.ok) throw Object.assign(new Error(`Subscriptions page returned HTTP ${response?.status ?? "unknown"}.`), { code: "membership-http-error" });
    if (!sameMembershipRoute(response.url || url, origin)) {
      throw Object.assign(new Error("Subscriptions response left the verified Rule34Video route."), { code: "membership-response-url-invalid" });
    }
    const documentLike = new DOMParser().parseFromString(await response.text(), "text/html");
    const parsed = parseDocument(documentLike, { origin, expectedPage, verifiedPagination });
    if (!parsed.ok) throw Object.assign(new Error(`Subscriptions response failed validation: ${parsed.reason}.`), { code: parsed.reason });
    return parsed;
  }

  async function refresh({ documentLike = document, signal, force = false } = {}) {
    const cached = readCache();
    const accountKey = accountFingerprint(documentLike);
    if (accountKey === "logged-out") {
      invalidate("membership-account-logged-out", { clear: true });
      return publicState();
    }
    if (!force && cached && cached.accountKey === accountKey && Date.now() - cached.refreshedAt < FRESH_MS) return publicState();
    if (refreshPromise) {
      if (!force) return refreshPromise;
      activeController?.abort();
      return refreshPromise.catch(() => null).then(() => refresh({ documentLike, signal, force: true }));
    }
    const runGeneration = ++generation;
    const controller = new AbortController();
    activeController = controller;
    const relayAbort = () => controller.abort();
    signal?.addEventListener?.("abort", relayAbort, { once: true });
    syncStatus = "refreshing";
    lastError = null;
    app.modules.logger?.debug?.("subscription-membership-sync-start", { cached: Boolean(cached) });
    emit();
    refreshPromise = Promise.resolve().then(async () => {
      try {
        const origin = globalThis.location?.origin ?? "https://rule34video.com";
        let first = parseDocument(documentLike, { origin });
        if (!first.ok && ["membership-block-missing", "membership-items-missing"].includes(first.reason)) {
          const discovered = await waitForNativeBlock(documentLike, controller.signal);
          first = parseDocument(discovered, { origin });
          if (!first.ok && ["membership-block-missing", "membership-items-missing"].includes(first.reason)) {
            const fallback = await fetchInitialDocument(origin, controller.signal);
            first = parseDocument(fallback, { origin });
          }
        }
        if (!first.ok) throw Object.assign(new Error(`Native subscriptions block failed validation: ${first.reason}.`), { code: first.reason });
        const byKey = new Map(first.values.map((value) => [value.key, value]));
        const verifiedPagination = { total: first.total, pageCount: first.pageCount, requestTemplate: first.requestTemplate };
        const seenPages = new Set([first.currentPage]);
        app.modules.logger?.debug?.("subscription-membership-page", { page: first.currentPage, count: first.values.length, source: "native" });
        for (const targetPage of first.pageTargets) {
          if (seenPages.has(targetPage)) continue;
          const url = buildPageUrl(first, targetPage, origin);
          const page = await fetchPage(url, targetPage, controller.signal, origin, verifiedPagination);
          seenPages.add(targetPage);
          page.values.forEach((value) => { if (!byKey.has(value.key)) byKey.set(value.key, value); });
          app.modules.logger?.debug?.("subscription-membership-page", { page: targetPage, count: page.values.length, source: "request" });
        }
        if (seenPages.size !== first.pageCount || first.total === null || byKey.size !== first.total) {
          throw Object.assign(new Error(`Subscriptions snapshot was incomplete (${byKey.size} of ${first.total ?? "unknown"}).`), { code: "membership-total-mismatch" });
        }
        if (runGeneration !== generation || controller.signal.aborted) throw new DOMException("Subscription sync was superseded.", "AbortError");
        completeSnapshot = {
          version: 1,
          status: "complete",
          values: [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name)),
          total: byKey.size,
          refreshedAt: Date.now(),
          sourcePageCount: seenPages.size,
          accountKey
        };
        persist(completeSnapshot);
        syncStatus = "complete";
        lastError = null;
        app.modules.logger?.debug?.("subscription-membership-sync-complete", { total: byKey.size, sourcePageCount: seenPages.size });
        return emit();
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        syncStatus = "failed";
        lastError = { code: String(error?.code ?? "membership-sync-failed"), message: String(error?.message ?? "Could not refresh subscriptions.") };
        app.modules.logger?.warn?.("subscription-membership-sync-failed", { code: lastError.code, message: lastError.message, retainedCompleteSnapshot: Boolean(completeSnapshot) });
        return emit();
      } finally {
        signal?.removeEventListener?.("abort", relayAbort);
        if (activeController === controller) activeController = null;
        refreshPromise = null;
      }
    });
    return refreshPromise;
  }

  function ensureFresh(options = {}) { return refresh({ ...options, force: false }); }

  function attach(documentLike = document) {
    if (attachedDocument === documentLike && nativeObserver) return;
    detach();
    attachedDocument = documentLike;
    observeNativeBlock(documentLike);
    if (!storageBound && app.modules.browserApi?.storage?.onChanged?.addListener) {
      storageBound = true;
      app.modules.browserApi.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes?.[constants.storageKeys.authCredentials]) return;
        invalidate("membership-account-credentials-changed", { clear: true });
        if (attachedDocument) refresh({ documentLike: attachedDocument, force: true }).catch(() => {});
      });
    }
  }

  function detach() {
    nativeObserver?.disconnect();
    nativeObserver = null;
    if (discoveryTimer !== null) globalThis.clearTimeout(discoveryTimer);
    discoveryTimer = null;
    attachedDocument = null;
    if (mutationTimer !== null) globalThis.clearTimeout(mutationTimer);
    mutationTimer = null;
    activeController?.abort();
    activeController = null;
  }

  app.modules.subscriptionMembership = Object.freeze({
    BLOCK_ID, CACHE_KEY, FRESH_MS, MAX_PAGES, INITIAL_DISCOVERY_MS,
    normalizeModelRef, nameKey, parseParameters, pageNumber, parseDocument, buildPageUrl,
    accountFingerprint, publicState, evaluationContext, subscribe, invalidate, waitForNativeBlock, refresh, ensureFresh, attach, detach
  });
})();
