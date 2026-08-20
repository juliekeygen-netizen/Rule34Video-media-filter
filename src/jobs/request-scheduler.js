(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before request scheduler.");

  function abortError() { return new DOMException("The request wait was aborted.", "AbortError"); }

  function schedulerError(error) {
    if (error?.name === "AbortError") return error;
    const wrapped = new Error(error?.message || "The request scheduler failed.");
    wrapped.code = "request-scheduler-error";
    wrapped.cause = error;
    return wrapped;
  }

  function defaultClock() {
    return {
      now: () => Date.now(),
      // Browser Window timer methods can require Window as their receiver. Do not
      // copy them unbound onto a plain object and later invoke them as object methods.
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args)
    };
  }

  function waitFor(ms, signal, timers = defaultClock()) {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let timer;
      function done() { signal?.removeEventListener("abort", cancelled); resolve(); }
      function cancelled() {
        try { timers.clearTimeout(timer); } catch { /* the wait is already being aborted */ }
        signal?.removeEventListener("abort", cancelled);
        reject(abortError());
      }
      try {
        timer = timers.setTimeout(done, ms);
      } catch (error) {
        reject(schedulerError(error));
        return;
      }
      signal?.addEventListener("abort", cancelled, { once: true });
    });
  }

  function parseRetryAfter(value, now = Date.now()) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return now + Number(text) * 1000;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > now ? parsed : null;
  }

  function createRequestScheduler(options = {}) {
    const clock = options.clock ?? defaultClock();
    const getSpacing = options.getMinimumSpacingMs ?? (() => app.modules.settings?.value?.advanced?.minimumRequestSpacingMs ?? 250);
    const getRetries = options.getMaximumAutomaticRetries ?? (() => app.modules.settings?.value?.advanced?.maximumAutomaticRetries ?? 2);
    const listeners = new Set();
    const state = { nextAllowedAt: 0, cooldownUntil: 0 };

    function snapshot() { return { ...state }; }
    function emit() { const value = snapshot(); listeners.forEach((listener) => listener(value)); return value; }
    function spacing(value) { return Math.max(0, Number(value ?? getSpacing()) || 0); }

    async function waitTurn({ signal, minimumSpacingMs } = {}) {
      if (signal?.aborted) throw abortError();
      while (true) {
        let now;
        let startAt;
        try {
          now = clock.now();
          startAt = Math.max(now, state.nextAllowedAt, state.cooldownUntil);
          state.nextAllowedAt = startAt + spacing(minimumSpacingMs);
          if (startAt > now) app.modules.logger?.debug?.("scheduler-wait", { waitMs: startAt - now, cooldown: state.cooldownUntil > now });
          emit();
          await waitFor(startAt - now, signal, clock);
        } catch (error) {
          throw schedulerError(error);
        }
        if (signal?.aborted) throw abortError();
        let after;
        try { after = clock.now(); } catch (error) { throw schedulerError(error); }
        if (after >= state.cooldownUntil) return snapshot();
      }
    }

    function applyRateLimit(until) {
      state.cooldownUntil = Math.max(state.cooldownUntil, Number(until) || 0);
      app.modules.logger?.debug?.("scheduler-rate-limit", { cooldownUntil: state.cooldownUntil });
      emit();
      return snapshot();
    }

    function applyRetryAfter(value, now = clock.now()) {
      return applyRateLimit(parseRetryAfter(value, now) ?? (now + 5000));
    }

    function transientStatus(status) { return [408, 425, 429, 500, 502, 503, 504].includes(Number(status)); }

    async function runWithPolicy({ signal, request, minimumSpacingMs, maximumRetries } = {}) {
      if (typeof request !== "function") throw new TypeError("request must be a function.");
      const retries = Math.max(0, Number(maximumRetries ?? getRetries()) || 0);
      let attempt = 0;
      while (true) {
        await waitTurn({ signal, minimumSpacingMs });
        try {
          const response = await request({ signal, attempt });
          if (response?.status === 429) applyRetryAfter(response.headers?.get?.("Retry-After"));
          if (!transientStatus(response?.status) || attempt >= retries) return response;
          app.modules.logger?.debug?.("scheduler-retry", { attempt: attempt + 1, status: Number(response?.status) || null, maximumRetries: retries });
        } catch (error) {
          if (error?.name === "AbortError" || attempt >= retries) throw error;
          app.modules.logger?.debug?.("scheduler-retry", { attempt: attempt + 1, error: { name: error?.name, code: error?.code, message: error?.message }, maximumRetries: retries });
        }
        attempt += 1;
        let now;
        try { now = clock.now(); } catch (error) { throw schedulerError(error); }
        if (state.cooldownUntil <= now) {
          try {
            await waitFor(Math.min(4000, 1000 * (2 ** (attempt - 1))), signal, clock);
          } catch (error) {
            throw schedulerError(error);
          }
        }
      }
    }

    function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    return { snapshot, waitTurn, runWithPolicy, applyRateLimit, applyRetryAfter, parseRetryAfter, subscribe, abortError };
  }

  app.modules.requestScheduler = Object.freeze(createRequestScheduler());
  app.modules.createRequestScheduler = createRequestScheduler;
})();
