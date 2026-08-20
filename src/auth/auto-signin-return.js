(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.storage?.local) return;

  const SETTINGS_KEY = "r34mf.settings";
  const CREDENTIALS_KEY = "r34mf.authCredentials";
  const RETURN_KEY = "r34mf.autoSignIn.returnSubscriptions.v1";
  const RETURN_PATH = "/my/subscriptions/";
  const MAX_AGE_MS = 60 * 60 * 1000;
  const ALLOWED_HOSTS = new Set(["rule34video.com", "www.rule34video.com"]);

  const storageGet = (keys) => {
    try {
      const value = api.storage.local.get(keys);
      if (value?.then) return value;
    } catch { /* callback fallback */ }
    return new Promise((resolve) => api.storage.local.get(keys, (result) => resolve(result ?? {})));
  };

  function readHint() {
    try {
      const parsed = JSON.parse(globalThis.sessionStorage?.getItem(RETURN_KEY) ?? "null");
      if (!parsed || parsed.path !== RETURN_PATH || !Number.isFinite(Number(parsed.createdAt))) return null;
      if (Date.now() - Number(parsed.createdAt) > MAX_AGE_MS) { clearHint(); return null; }
      return { path: RETURN_PATH, createdAt: Number(parsed.createdAt) };
    } catch { return null; }
  }

  function writeHint() {
    try { globalThis.sessionStorage?.setItem(RETURN_KEY, JSON.stringify({ path: RETURN_PATH, createdAt: Date.now() })); } catch { /* same-tab return is best effort */ }
  }

  function clearHint() {
    try { globalThis.sessionStorage?.removeItem(RETURN_KEY); } catch { /* already unavailable */ }
  }

  function onSubscriptionsRoute() {
    return String(globalThis.location?.pathname ?? "").replace(/\/+$/, "") === RETURN_PATH.replace(/\/+$/, "");
  }

  async function maybeReturn(credentials = null) {
    const hint = readHint();
    if (!hint) return false;
    const stored = credentials ? { [CREDENTIALS_KEY]: credentials } : await storageGet([SETTINGS_KEY, CREDENTIALS_KEY]);
    const auth = stored?.[CREDENTIALS_KEY];
    if (auth?.lastStage !== "successful" || Number(auth?.lastSuccessAt) < hint.createdAt) return false;
    const settingsResult = stored?.[SETTINGS_KEY] === undefined ? await storageGet(SETTINGS_KEY) : stored;
    const enabled = settingsResult?.[SETTINGS_KEY]?.openSubscriptionsAfterAutomaticSignIn === true;
    clearHint();
    if (!enabled || onSubscriptionsRoute() || !ALLOWED_HOSTS.has(String(globalThis.location?.hostname ?? "").toLocaleLowerCase())) return false;
    globalThis.location.assign?.(new URL(RETURN_PATH, globalThis.location.origin).href);
    return true;
  }

  if (onSubscriptionsRoute()) writeHint();

  api.storage.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local" || !changes?.[CREDENTIALS_KEY]?.newValue) return;
    maybeReturn(changes[CREDENTIALS_KEY].newValue).catch(() => {});
  });

  queueMicrotask(() => maybeReturn().catch(() => {}));

  globalThis.R34MFAutoSignInReturn = Object.freeze({ readHint, writeHint, clearHint, maybeReturn, onSubscriptionsRoute });
})();
