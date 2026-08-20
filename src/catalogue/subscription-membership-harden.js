(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.subscriptionMembership;
  const scheduler = app?.modules.requestScheduler;
  if (!app || !base || !scheduler) throw new Error("R34MF subscription membership must load before membership hardening.");

  const CACHE_KEY = `${base.CACHE_KEY}.totalFree`;
  const listeners = new Set();
  let fallback = null;
  let recoveryPromise = null;
  let attachedDocument = null;
  let lastVerifiedLiveSignature = null;

  function parsedSignature(parsed) {
    if (!parsed?.ok) return null;
    const keys = parsed.values.map((item) => String(item.key ?? "").toLocaleLowerCase()).filter(Boolean).sort();
    return `${parsed.currentPage}|${parsed.pageCount}|${parsed.total ?? "?"}|${keys.join(",")}`;
  }

  function documentSignature(documentLike) {
    try { return parsedSignature(base.parseDocument(documentLike, { origin: globalThis.location?.origin ?? "https://rule34video.com" })); }
    catch { return null; }
  }

  const read = () => {
    if (fallback) return fallback;
    try {
      const raw = JSON.parse(globalThis.sessionStorage?.getItem(CACHE_KEY) ?? "null");
      if (raw?.version === 1 && raw.status === "complete" && Array.isArray(raw.values)) {
        const values = raw.values.map((item) => base.normalizeModelRef(item, item?.url)).filter(Boolean);
        if (values.length === Number(raw.total)) fallback = { ...raw, values, total: values.length };
      }
    } catch { /* no usable session cache */ }
    return fallback;
  };

  function clearFallback() {
    fallback = null;
    try { globalThis.sessionStorage?.removeItem(CACHE_KEY); } catch { /* ignore */ }
  }

  function save(snapshot) {
    fallback = snapshot;
    try { globalThis.sessionStorage?.setItem(CACHE_KEY, JSON.stringify(snapshot)); } catch { /* in-memory copy remains usable */ }
  }

  function effectiveSnapshot() {
    const state = base.publicState();
    return state.status === "complete" && state.snapshot ? state.snapshot : read() ?? state.snapshot ?? null;
  }

  function publicState() {
    const state = base.publicState();
    if (state.status === "complete" && state.snapshot) return state;
    const snapshot = read();
    if (!snapshot) return state;
    return {
      snapshot,
      status: recoveryPromise ? "refreshing" : "complete",
      stale: Date.now() - Number(snapshot.refreshedAt || 0) >= base.FRESH_MS,
      error: null
    };
  }

  function evaluationContext() {
    const snapshot = effectiveSnapshot();
    if (!snapshot) return { status: "unavailable", keys: new Set(), names: new Set() };
    return {
      status: "complete",
      keys: new Set(snapshot.values.map((item) => String(item.key ?? "").toLocaleLowerCase()).filter(Boolean)),
      names: new Set(snapshot.values.map((item) => base.nameKey(item.name)).filter(Boolean))
    };
  }

  function emit() {
    const state = publicState();
    for (const listener of listeners) listener(state);
    return state;
  }

  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };

  async function fetchRootDocument(origin, signal) {
    const url = new URL("/my/subscriptions/", origin).href;
    const response = await scheduler.runWithPolicy({
      signal,
      request: ({ signal: requestSignal }) => fetch(url, { credentials: "include", cache: "no-store", signal: requestSignal })
    });
    if (!response?.ok) throw Object.assign(new Error(`Subscriptions page returned HTTP ${response?.status ?? "unknown"}.`), { code: "membership-http-error" });
    const resolved = new URL(response.url || url, origin);
    if (!/^(?:www\.)?rule34video\.com$/i.test(resolved.hostname) || resolved.pathname.replace(/\/+$/, "") !== "/my/subscriptions") {
      throw Object.assign(new Error("Subscriptions response left the verified Rule34Video route."), { code: "membership-response-url-invalid" });
    }
    return new DOMParser().parseFromString(await response.text(), "text/html");
  }

  async function fetchParsed(url, page, first, signal) {
    const response = await scheduler.runWithPolicy({
      signal,
      request: ({ signal: requestSignal }) => fetch(url, { credentials: "include", cache: "no-store", signal: requestSignal })
    });
    if (!response?.ok) throw Object.assign(new Error(`Subscriptions page returned HTTP ${response?.status ?? "unknown"}.`), { code: "membership-http-error" });
    const resolved = new URL(response.url || url, globalThis.location?.origin ?? "https://rule34video.com");
    if (!/^(?:www\.)?rule34video\.com$/i.test(resolved.hostname) || resolved.pathname.replace(/\/+$/, "") !== "/my/subscriptions") {
      throw Object.assign(new Error("Subscriptions response left the verified Rule34Video route."), { code: "membership-response-url-invalid" });
    }
    const documentLike = new DOMParser().parseFromString(await response.text(), "text/html");
    const parsed = base.parseDocument(documentLike, {
      origin: resolved.origin,
      expectedPage: page,
      verifiedPagination: { total: null, pageCount: first.pageCount, requestTemplate: first.requestTemplate }
    });
    if (!parsed.ok) throw Object.assign(new Error(`Subscriptions page ${page} failed validation: ${parsed.reason}.`), { code: parsed.reason });
    return parsed;
  }

  async function recover(documentLike, signal) {
    const origin = globalThis.location?.origin ?? "https://rule34video.com";
    const first = base.parseDocument(documentLike, { origin });
    if (!first.ok || first.total !== null || !first.values.length) {
      throw Object.assign(new Error(`Total-free subscriptions recovery is unavailable: ${first.reason ?? "unexpected-native-shape"}.`), { code: first.reason ?? "membership-total-free-unavailable" });
    }
    const byKey = new Map(first.values.map((item) => [item.key, item]));
    const seen = new Set([first.currentPage]);
    for (const page of first.pageTargets) {
      if (seen.has(page)) continue;
      const parsed = await fetchParsed(base.buildPageUrl(first, page, origin), page, first, signal);
      if (!parsed.values.length) throw Object.assign(new Error(`Subscriptions page ${page} was unexpectedly empty.`), { code: "membership-total-free-empty-page" });
      seen.add(page);
      for (const item of parsed.values) if (!byKey.has(item.key)) byKey.set(item.key, item);
    }
    if (seen.size !== first.pageCount) throw Object.assign(new Error("Not every verified subscriptions page was visited."), { code: "membership-page-count-mismatch" });
    return {
      version: 1,
      status: "complete",
      values: [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name)),
      total: byKey.size,
      refreshedAt: Date.now(),
      sourcePageCount: seen.size,
      accountKey: base.accountFingerprint?.(documentLike) ?? "signed-in"
    };
  }

  async function refresh(options = {}) {
    if (recoveryPromise) return recoveryPromise;
    const documentLike = options.documentLike ?? attachedDocument ?? globalThis.document;
    const origin = globalThis.location?.origin ?? "https://rule34video.com";
    let recoveryDocument = documentLike;
    let native = base.parseDocument(recoveryDocument, { origin });

    if (!native.ok && ["membership-block-missing", "membership-items-missing"].includes(native.reason)) {
      try {
        recoveryDocument = await fetchRootDocument(origin, options.signal);
        native = base.parseDocument(recoveryDocument, { origin });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        app.modules.logger?.debug?.("subscription-membership-total-free-root-fallback-failed", { code: error?.code ?? "request-failed" });
      }
    }

    if (!native.ok || native.total !== null) {
      const state = await base.refresh({ ...options, documentLike: recoveryDocument });
      if (state.status === "complete" && state.snapshot) {
        clearFallback();
        lastVerifiedLiveSignature = parsedSignature(native) ?? documentSignature(recoveryDocument);
      }
      emit();
      return state;
    }
    recoveryPromise = (async () => {
      try {
        save(await recover(recoveryDocument, options.signal));
        lastVerifiedLiveSignature = parsedSignature(native);
      } catch (error) {
        app.modules.logger?.warn?.("subscription-membership-total-free-recovery-failed", { code: error?.code, message: error?.message });
        throw error;
      } finally { recoveryPromise = null; }
      return emit();
    })();
    emit();
    return recoveryPromise;
  }

  function ensureFresh(options = {}) {
    const documentLike = options.documentLike ?? attachedDocument ?? globalThis.document;
    const state = publicState();
    const account = base.accountFingerprint?.(documentLike) ?? "unknown";
    const sameAccount = !state.snapshot || account === "unknown" || state.snapshot.accountKey === account;
    const liveSignature = documentSignature(documentLike);
    const liveChanged = Boolean(liveSignature && liveSignature !== lastVerifiedLiveSignature);
    if (state.snapshot && !state.stale && state.status === "complete" && sameAccount && !liveChanged) return Promise.resolve(state);
    if (!sameAccount) clearFallback();
    return refresh({ ...options, documentLike, force: !sameAccount || liveChanged });
  }

  function invalidate(reason = "stale", options = {}) {
    if (options.clear) clearFallback();
    if (reason === "membership-native-block-changed") lastVerifiedLiveSignature = null;
    base.invalidate(reason, options);
    emit();
  }

  function attach(documentLike = document) {
    if (attachedDocument !== documentLike) lastVerifiedLiveSignature = null;
    attachedDocument = documentLike;
    base.attach(documentLike);
  }
  function detach() {
    attachedDocument = null;
    lastVerifiedLiveSignature = null;
    base.detach();
  }

  base.subscribe((state) => {
    const code = state?.error?.code ?? "";
    if (["membership-account-logged-out", "membership-account-credentials-changed", "membership-native-block-changed"].includes(code)) clearFallback();
    if (code === "membership-native-block-changed") lastVerifiedLiveSignature = null;
    if (code === "membership-total-mismatch" && attachedDocument && !recoveryPromise) {
      queueMicrotask(() => refresh({ documentLike: attachedDocument, force: true }).catch(() => {}));
    }
    emit();
  });

  app.modules.subscriptionMembership = Object.freeze({
    ...base,
    TOTAL_FREE_CACHE_KEY: CACHE_KEY,
    parsedSignature,
    documentSignature,
    publicState,
    evaluationContext,
    subscribe,
    refresh,
    ensureFresh,
    invalidate,
    attach,
    detach
  });
})();
