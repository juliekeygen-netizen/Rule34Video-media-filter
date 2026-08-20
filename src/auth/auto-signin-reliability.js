(() => {
  "use strict";

  const auth = globalThis.R34MFAutoSignIn;
  if (!auth?.run || typeof document === "undefined") return;

  const FAST_RETRY_MS = 3000;
  const IDLE_RETRY_MS = 20_000;
  const FAST_WINDOW_MS = 60_000;
  let timer = null;
  let activeWindowStartedAt = Date.now();
  let stopped = false;

  function clearTimer() {
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = null;
  }

  function signedIn() {
    try { return auth.looksLoggedIn?.(document) === true && auth.looksLoggedOut?.(document) !== true; }
    catch { return false; }
  }

  function delayForWindow() {
    return Date.now() - activeWindowStartedAt < FAST_WINDOW_MS ? FAST_RETRY_MS : IDLE_RETRY_MS;
  }

  function schedule(delay = delayForWindow()) {
    if (stopped || document.visibilityState === "hidden" || signedIn()) { clearTimer(); return; }
    clearTimer();
    timer = globalThis.setTimeout(() => {
      timer = null;
      tick().catch(() => schedule());
    }, Math.max(250, Number(delay) || FAST_RETRY_MS));
  }

  async function tick() {
    if (stopped || document.visibilityState === "hidden" || signedIn()) { clearTimer(); return false; }
    try { await auth.run(); } catch { /* the base module records sanitized status */ }
    if (signedIn()) { clearTimer(); return true; }
    schedule();
    return false;
  }

  function poke() {
    if (stopped || document.visibilityState === "hidden") return;
    activeWindowStartedAt = Date.now();
    schedule(100);
  }

  function onVisibility() {
    if (document.visibilityState === "visible") poke();
    else clearTimer();
  }

  document.addEventListener("visibilitychange", onVisibility, { passive: true });
  globalThis.addEventListener?.("focus", poke, { passive: true });
  globalThis.addEventListener?.("online", poke, { passive: true });
  globalThis.addEventListener?.("pageshow", poke, { passive: true });
  globalThis.addEventListener?.("pagehide", () => clearTimer(), { passive: true });

  // The base module already starts immediately. This delayed first pass catches
  // mobile pages whose login controls/forms settle only after initial readiness.
  schedule(1500);

  globalThis.R34MFAutoSignInReliability = Object.freeze({
    FAST_RETRY_MS,
    IDLE_RETRY_MS,
    FAST_WINDOW_MS,
    tick,
    poke,
    schedule,
    stop() { stopped = true; clearTimer(); }
  });
})();
