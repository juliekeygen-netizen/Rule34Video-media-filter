(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const SETTINGS_KEY = "r34mf.settings";
  const CREDENTIALS_KEY = "r34mf.authCredentials";
  const ALLOWED_HOSTS = new Set(["rule34video.com", "www.rule34video.com"]);
  const LOGIN_TEXT = /^(?:log\s*in|login|sign\s*in|signin)$/i;
  const LOGOUT_TEXT = /^(?:log\s*out|logout|sign\s*out|signout)$/i;
  const LOGIN_SEMANTIC = /(?:^|[^a-z])(?:log\s*in|login|sign\s*in|signin)(?:[^a-z]|$)/i;
  const LOGOUT_SEMANTIC = /(?:^|[^a-z])(?:log\s*out|logout|sign\s*out|signout)(?:[^a-z]|$)/i;
  const NON_LOGIN_SEMANTIC = /(?:sign\s*up|register|create\s+(?:an?\s+)?account|forgot|reset|recover|change\s+password)/i;
  const LOGIN_PAGE_PATHS = Object.freeze(["/login/", "/login"]);

  let debugLogging = false;
  function safeDebugValue(value, key = "", depth = 0) {
    if (/(password|credential|cookie|token|secret|authorization|csrf)/i.test(key)) return "[redacted]";
    if (depth > 3) return "[truncated]";
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeDebugValue(item, "", depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 40).map(([name, item]) => [name, safeDebugValue(item, name, depth + 1)]));
    return typeof value === "string" ? value.slice(0, 240) : value;
  }
  function debug(operation, details = {}) {
    if (!debugLogging) return;
    const safe = safeDebugValue(details);
    console.debug("[R34MF]", { subsystem: "automatic-signin", operation, ...safe });
  }

  let notice = null;
  let noticeStyle = null;
  let noticeHidden = false;
  let noticeTimer = null;
  function removeNotice() {
    if (noticeTimer !== null) globalThis.clearTimeout(noticeTimer);
    noticeTimer = null;
    notice?.remove?.();
    notice = null;
  }
  function showNotice(message, { terminal = false, timeoutMs = 3500 } = {}) {
    if (noticeHidden || !document?.documentElement) return null;
    if (!notice) {
      if (!noticeStyle?.isConnected) {
        noticeStyle = document.createElement("style");
        noticeStyle.dataset.r34mfOwned = "true";
        noticeStyle.textContent = ".r34mf-auth-notice{position:fixed;z-index:2147483646;right:18px;bottom:18px;display:grid;grid-template-columns:minmax(0,1fr) 24px;gap:2px 10px;width:min(290px,calc(100vw - 36px));padding:12px 12px 11px 14px;border:1px solid #56616b;border-radius:10px;background:#30373d;color:#fff;box-shadow:0 10px 28px rgba(0,0,0,.38);font-family:Inter,Arial,sans-serif}.r34mf-auth-notice strong{font-size:11px;line-height:1.25}.r34mf-auth-notice span{grid-column:1;color:#b6c0c8;font-size:10px;line-height:1.35}.r34mf-auth-notice button{grid-column:2;grid-row:1/3;align-self:start;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:#b6c0c8;cursor:pointer;font:16px/1 Arial}.r34mf-auth-notice button:hover{background:#46515a;color:#fff}.r34mf-auth-notice button:focus-visible{outline:2px solid #ec796f;outline-offset:1px}";
        document.documentElement.append(noticeStyle);
      }
      const node = document.createElement("aside");
      node.className = "r34mf-auth-notice";
      node.dataset.r34mfOwned = "true";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      const title = document.createElement("strong");
      title.textContent = "Rule34Video Media Filter";
      const state = document.createElement("span");
      const close = document.createElement("button");
      close.type = "button";
      close.setAttribute("aria-label", "Hide automatic sign-in notification");
      close.textContent = "×";
      close.addEventListener("click", () => { noticeHidden = true; removeNotice(); });
      node.append(title, state, close);
      document.documentElement.append(node);
      notice = node;
    }
    notice.querySelector("span").textContent = message;
    if (terminal) noticeTimer = globalThis.setTimeout(removeNotice, timeoutMs);
    return notice;
  }

  function text(node) {
    return String(
      [node?.textContent, node?.value, node?.getAttribute?.("aria-label"), node?.getAttribute?.("title"),
        node?.getAttribute?.("name"), node?.getAttribute?.("id"), node?.getAttribute?.("class"),
        ...(node?.getAttributeNames?.().filter((name) => name.startsWith("data-")).map((name) => node.getAttribute(name)) ?? [])]
        .filter(Boolean).join(" ")
    ).replace(/\s+/g, " ").trim();
  }

  function safeUrl(value, base = globalThis.location?.href) {
    try {
      const url = new URL(value, base);
      if (!["http:", "https:"].includes(url.protocol) || !ALLOWED_HOSTS.has(url.hostname.toLocaleLowerCase())) return null;
      return url;
    } catch {
      return null;
    }
  }

  function sameOrigin(url, origin = globalThis.location?.origin) {
    const parsed = safeUrl(url, origin);
    const base = safeUrl(origin, origin);
    return Boolean(parsed && base && parsed.protocol === "https:" && base.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname.toLocaleLowerCase()) && ALLOWED_HOSTS.has(base.hostname.toLocaleLowerCase()));
  }

  function normalizeToCurrentOrigin(url, locationLike = globalThis.location) {
    const parsed = safeUrl(url, locationLike?.href);
    if (!parsed || !sameOrigin(parsed, locationLike?.origin)) return null;
    const current = new URL(locationLike.origin);
    parsed.protocol = current.protocol;
    parsed.host = current.host;
    return parsed.href;
  }

  function controlLooksLike(node, pattern, hrefWords) {
    const label = text(node);
    const href = String(node?.getAttribute?.("href") ?? "");
    const words = Array.isArray(hrefWords) ? hrefWords : [hrefWords];
    return pattern.test(label) || words.some((word) => new RegExp(`(?:^|[/_-])${word}(?:[/_?#-]|$)`, "i").test(href));
  }

  function isLogoutControl(node) { return controlLooksLike(node, LOGOUT_TEXT, ["logout", "signout", "sign-out"]) || LOGOUT_SEMANTIC.test(text(node)); }
  function isLoginControl(node) { return controlLooksLike(node, LOGIN_TEXT, ["login", "signin", "sign-in"]) || LOGIN_SEMANTIC.test(text(node)); }

  function authControls(documentLike = document) {
    return [...documentLike.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button'], [aria-label], [title], [data-action], [data-target], [data-toggle]")];
  }

  function hasLogoutSignal(documentLike = document) {
    return authControls(documentLike).some(isLogoutControl);
  }

  function hasLoginSignal(documentLike = document) {
    return authControls(documentLike).some(isLoginControl);
  }

  function findLoginControl(documentLike = document) {
    return authControls(documentLike).find((node) => node?.disabled !== true && isLoginControl(node)) ?? null;
  }

  function looksLoggedIn(documentLike = document) {
    return hasLogoutSignal(documentLike);
  }

  function looksLoggedOut(documentLike = document) {
    if (looksLoggedIn(documentLike)) return false;
    return hasLoginSignal(documentLike) || Boolean(findLoginForm(documentLike, globalThis.location?.href));
  }

  function discoverLoginUrl(documentLike = document, locationLike = globalThis.location) {
    const candidates = [...documentLike.querySelectorAll("a[href]")].filter(isLoginControl);
    for (const candidate of candidates) {
      const rawHref = String(candidate.getAttribute("href") ?? "").trim();
      if (!rawHref || rawHref.startsWith("#") || /^javascript:/i.test(rawHref)) continue;
      const url = safeUrl(rawHref, locationLike?.href);
      if (url && sameOrigin(url, locationLike?.origin)) return normalizeToCurrentOrigin(url, locationLike);
    }
    return null;
  }

  function challengePresent(root) {
    if (!root?.querySelector) return false;
    if (root.querySelector(".g-recaptcha, [data-sitekey], iframe[src*='recaptcha' i], iframe[src*='hcaptcha' i], input[autocomplete='one-time-code' i]")) return true;
    return [...root.querySelectorAll("input[name], textarea[name]")].some((input) => {
      const name = String(input.getAttribute("name") ?? "").toLocaleLowerCase();
      return /(captcha|recaptcha|hcaptcha|totp|otp|two.?factor|2fa|verification.?code)/i.test(name);
    });
  }

  function pickPasswordInput(form) {
    return form?.querySelector?.("input[type='password'][name]") ?? null;
  }

  function pickIdentifierInput(form) {
    const inputs = [...(form?.querySelectorAll?.("input[name]") ?? [])]
      .filter((input) => !["hidden", "password", "submit", "button", "checkbox", "radio"].includes(String(input.type ?? "text").toLocaleLowerCase()));
    return inputs.find((input) => /username/i.test(input.autocomplete ?? ""))
      ?? inputs.find((input) => String(input.type).toLocaleLowerCase() === "email")
      ?? inputs.find((input) => /(user|login|email|account|name)/i.test(input.name))
      ?? inputs[0]
      ?? null;
  }

  function formLooksLikeLogin(form, actionUrl = null) {
    if (!form) return false;
    const submitters = [...(form.querySelectorAll?.("button[type='submit'], input[type='submit'], button:not([type])") ?? [])];
    const structuralText = [
      actionUrl?.pathname ?? actionUrl ?? "",
      form.getAttribute?.("action") ?? "",
      form.getAttribute?.("id") ?? "",
      form.getAttribute?.("name") ?? "",
      form.getAttribute?.("class") ?? "",
      ...submitters.flatMap((node) => [text(node), node.getAttribute?.("name") ?? "", node.getAttribute?.("value") ?? "", node.getAttribute?.("aria-label") ?? ""])
    ].join(" ");
    const contextText = text(form.closest?.("[role='dialog'], .modal, .popup") ?? form);
    return (LOGIN_SEMANTIC.test(structuralText) || LOGIN_SEMANTIC.test(contextText)) && !NON_LOGIN_SEMANTIC.test(structuralText);
  }

  function inspectLoginForms(documentLike, baseUrl = globalThis.location?.href) {
    let sawPassword = false;
    let sawChallenge = false;
    let sawUnverified = false;
    for (const form of [...(documentLike?.querySelectorAll?.("form") ?? [])]) {
      const password = pickPasswordInput(form);
      if (!password) continue;
      sawPassword = true;
      if (challengePresent(form)) { sawChallenge = true; continue; }
      const identifier = pickIdentifierInput(form);
      const action = safeUrl(form.getAttribute("action") || baseUrl, baseUrl);
      const method = String(form.getAttribute("method") || "get").toLocaleLowerCase();
      if (!identifier || !action || !sameOrigin(action, new URL(baseUrl).origin) || method !== "post" || !formLooksLikeLogin(form, action)) {
        sawUnverified = true;
        continue;
      }
      return { match: { form, identifier, password, action: normalizeToCurrentOrigin(action, new URL(baseUrl)), method }, reason: null };
    }
    return { match: null, reason: sawChallenge ? "challenge-required" : sawUnverified || sawPassword ? "login-form-unverified" : "login-form-absent" };
  }

  function findLoginForm(documentLike, baseUrl = globalThis.location?.href) {
    return inspectLoginForms(documentLike, baseUrl).match;
  }

  function waitForLoginForm(documentLike = document, baseUrl = globalThis.location?.href, timeoutMs = 6000) {
    const immediate = findLoginForm(documentLike, baseUrl);
    if (immediate) return Promise.resolve(immediate);
    if (typeof MutationObserver !== "function") return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        globalThis.clearTimeout(timer);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        const match = findLoginForm(documentLike, baseUrl);
        if (match) finish(match);
      });
      observer.observe(documentLike.documentElement ?? documentLike, { childList: true, subtree: true, attributes: true });
      const timer = globalThis.setTimeout(() => finish(findLoginForm(documentLike, baseUrl)), Math.max(250, Number(timeoutMs) || 6000));
    });
  }

  function buildFormData(match, credentials) {
    const data = new FormData(match.form);
    data.set(match.identifier.name, credentials.identifier);
    data.set(match.password.name, credentials.password);
    const submitter = match.form.querySelector("button[type='submit'][name], input[type='submit'][name]");
    if (submitter?.name && !data.has(submitter.name)) data.set(submitter.name, submitter.value ?? "");
    return data;
  }

  function buildRequestBody(match, credentials) {
    const data = buildFormData(match, credentials);
    const encoding = String(match.form.getAttribute("enctype") || "application/x-www-form-urlencoded").toLocaleLowerCase();
    if (encoding.includes("multipart/form-data")) return data;
    const body = new URLSearchParams();
    for (const [key, value] of data.entries()) {
      if (typeof value === "string") body.append(key, value);
    }
    return body;
  }

  function sanitizedError(code, message) {
    return { code: String(code).slice(0, 60), message: String(message).slice(0, 180) };
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      try {
        const result = api.storage.local.get(keys);
        if (result?.then) result.then(resolve, reject);
        else api.storage.local.get(keys, (value) => api.runtime?.lastError ? reject(new Error(api.runtime.lastError.message)) : resolve(value));
      } catch (error) { reject(error); }
    });
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      try {
        const result = api.storage.local.set(value);
        if (result?.then) result.then(resolve, reject);
        else api.storage.local.set(value, () => api.runtime?.lastError ? reject(new Error(api.runtime.lastError.message)) : resolve());
      } catch (error) { reject(error); }
    });
  }

  function sameCredentialRecord(current, attempted) {
    if (!current || !attempted) return false;
    return String(current.identifier ?? "") === String(attempted.identifier ?? "")
      && String(current.password ?? "") === String(attempted.password ?? "")
      && Number(current.savedAt ?? 0) === Number(attempted.savedAt ?? 0);
  }

  async function updateCredentialStatus(credentials, changes) {
    const stored = await storageGet(CREDENTIALS_KEY);
    const current = stored?.[CREDENTIALS_KEY] ?? null;
    // A sign-in request may outlive a Settings edit in another tab. Never let the
    // old attempt resurrect or overwrite credentials that were changed/removed.
    if (!sameCredentialRecord(current, credentials)) return current;
    const safe = {
      identifier: current.identifier,
      password: current.password,
      savedAt: current.savedAt ?? Date.now(),
      lastAttemptAt: changes.lastAttemptAt ?? current.lastAttemptAt ?? null,
      lastSuccessAt: changes.lastSuccessAt ?? current.lastSuccessAt ?? null,
      lastError: changes.lastError === undefined ? (current.lastError ?? null) : changes.lastError,
      lastStage: changes.lastStage ?? current.lastStage ?? null,
      lastStatusAt: changes.lastStatusAt ?? current.lastStatusAt ?? null,
      blockedUntil: changes.blockedUntil ?? 0
    };
    await storageSet({ [CREDENTIALS_KEY]: safe });
    return safe;
  }

  async function fetchLoginDocument(loginUrl) {
    let response;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller ? globalThis.setTimeout(() => controller.abort(), 2200) : null;
    try {
      response = await fetch(loginUrl, { credentials: "include", cache: "no-store", redirect: "follow", ...(controller ? { signal: controller.signal } : {}) });
    } catch {
      throw discoveryError("login-network-failure", "Rule34Video's login page could not be reached because of a temporary network failure.");
    } finally {
      if (timeout !== null) globalThis.clearTimeout(timeout);
    }
    if (!response.ok) {
      const error = new Error(`Rule34Video login page returned HTTP ${response.status}.`);
      error.code = `login-http-${response.status}`;
      throw error;
    }
    const html = await response.text();
    return { response, document: new DOMParser().parseFromString(html, "text/html") };
  }

  function unverifiedStateError() {
    const error = new Error("Rule34Video's signed-in state could not be verified safely after the login request.");
    error.code = "login-state-unverified";
    return error;
  }

  async function submitLogin(match, credentials) {
    let response;
    try {
      response = await fetch(match.action, {
        method: "POST",
        body: buildRequestBody(match, credentials),
        credentials: "include",
        cache: "no-store",
        redirect: "follow"
      });
    } catch {
      const error = new Error("Rule34Video sign-in could not be submitted because of a temporary network failure.");
      error.code = "login-network-failure";
      throw error;
    }
    const html = await response.text();
    const resultDocument = new DOMParser().parseFromString(html, "text/html");
    if ([401, 403].includes(response.status)) {
      const error = new Error("Rule34Video rejected the saved credentials.");
      error.code = "credentials-rejected";
      throw error;
    }
    if (response.status === 429) {
      const error = new Error("Rule34Video is rate-limiting sign-in attempts. Automatic sign-in paused.");
      error.code = "login-rate-limited";
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`Rule34Video sign-in returned HTTP ${response.status}.`);
      error.code = `login-http-${response.status}`;
      throw error;
    }
    if (challengePresent(resultDocument)) {
      const error = new Error("Rule34Video requires a CAPTCHA, verification code, or other manual sign-in challenge.");
      error.code = "challenge-required";
      throw error;
    }
    if (looksLoggedOut(resultDocument) || findLoginForm(resultDocument, response.url)) {
      const error = new Error("The sign-in response remained logged out.");
      error.code = "response-remained-logged-out";
      throw error;
    }
    if (!looksLoggedIn(resultDocument)) throw unverifiedStateError();
    return { response, document: resultDocument };
  }

  function bindLogoutRecovery() {
    document.addEventListener("click", (event) => {
      const control = event.target?.closest?.("a, button, [role='button'], [aria-label], [title], [data-action]");
      if (!control || !isLogoutControl(control)) return;
      for (const delay of [0, 250, 1000, 2000]) globalThis.setTimeout(() => run().catch(() => {}), delay);
    }, true);
  }

  function retryDelayFor(code) {
    if (code === "credentials-rejected") return 30 * 60 * 1000;
    if (code === "response-remained-logged-out") return 30 * 60 * 1000;
    if (code === "challenge-required") return 60 * 60 * 1000;
    if (code === "login-rate-limited") return 30 * 60 * 1000;
    if (code === "login-state-unverified") return 15 * 60 * 1000;
    return 5 * 60 * 1000;
  }

  function discoveryError(code, message) {
    return Object.assign(new Error(message), { code, discoveryOnly: true });
  }

  async function discoverRemoteLoginForm(documentLike, locationLike) {
    const discovered = discoverLoginUrl(documentLike, locationLike);
    const seen = new Set();
    const candidates = [discovered, ...LOGIN_PAGE_PATHS.map((path) => normalizeToCurrentOrigin(path, locationLike))]
      .filter(Boolean)
      .filter((value) => {
        const url = new URL(value);
        const key = `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    let sawUnverified = false;
    for (const loginUrl of candidates) {
      debug("login-page-probe", { path: new URL(loginUrl).pathname, discovered: loginUrl === discovered });
      const loaded = await fetchLoginDocument(loginUrl);
      if (challengePresent(loaded.document)) throw discoveryError("challenge-required", "Rule34Video requires a CAPTCHA, verification code, or other manual sign-in challenge.");
      if (looksLoggedIn(loaded.document)) return { loggedIn: true, loaded };
      const inspected = inspectLoginForms(loaded.document, loaded.response.url);
      if (inspected.match) return { match: inspected.match, loaded };
      if (inspected.reason === "login-form-unverified") sawUnverified = true;
    }
    throw discoveryError(
      sawUnverified ? "login-form-unverified" : "login-control-not-found",
      sawUnverified
        ? "A password form was found, but it could not be verified as Rule34Video's sign-in form."
        : "Rule34Video's Login control and verified login page could not be located."
    );
  }

  let discoveryInFlight = false;
  let nextDiscoveryAt = 0;
  async function run() {
    if (discoveryInFlight || !api?.storage?.local || !ALLOWED_HOSTS.has(location.hostname.toLocaleLowerCase())) return false;
    discoveryInFlight = true;
    let submissionStarted = false;

    try {
      const stored = await storageGet([SETTINGS_KEY, CREDENTIALS_KEY]);
      const settings = stored?.[SETTINGS_KEY] ?? {};
      const credentials = stored?.[CREDENTIALS_KEY] ?? {};
      debugLogging = settings?.advanced?.debugLogging === true;
      if (settings.automaticSignIn !== true || !credentials.identifier || !credentials.password) return false;
      if (looksLoggedIn(document)) return false;
      if (Number(credentials.blockedUntil) > Date.now() || Date.now() < nextDiscoveryAt) return false;

      noticeHidden = false;
      showNotice("Finding login…");
      const discoveryStartedAt = Date.now();
      debug("state", { stage: "discovering-login-ui", loggedOutSignal: looksLoggedOut(document) });
      let match = findLoginForm(document, location.href);
      if (!match) {
        const linkedLoginUrl = discoverLoginUrl(document, location);
        const control = findLoginControl(document);
        if (linkedLoginUrl) {
          const remote = await discoverRemoteLoginForm(document, location);
          if (remote.loggedIn) {
            await updateCredentialStatus(credentials, { lastSuccessAt: Date.now(), lastError: null, lastStage: "successful", lastStatusAt: Date.now(), blockedUntil: 0 });
            location.reload();
            return true;
          }
          match = remote.match;
        } else if (control) {
          debug("state", { stage: "activating-login-control", tag: control.tagName ?? null });
          control.click?.();
          match = await waitForLoginForm(document, location.href, 2200);
          if (!match) {
            const inspected = inspectLoginForms(document, location.href);
            if (inspected.reason === "challenge-required" || challengePresent(document)) throw discoveryError("challenge-required", "Rule34Video requires a CAPTCHA, verification code, or other manual sign-in challenge.");
            if (inspected.reason === "login-form-unverified") throw discoveryError("login-form-unverified", "The Login control opened a password form, but it failed safe sign-in verification.");
            throw discoveryError("login-form-not-found", "Rule34Video's Login control was activated, but no sign-in form appeared within the bounded wait.");
          }
        } else {
          const remote = await discoverRemoteLoginForm(document, location);
          if (remote.loggedIn) {
            await updateCredentialStatus(credentials, { lastSuccessAt: Date.now(), lastError: null, lastStage: "successful", lastStatusAt: Date.now(), blockedUntil: 0 });
            location.reload();
            return true;
          }
          match = remote.match;
        }
      }

      const startedAt = Date.now();
      submissionStarted = true;
      showNotice("Signing in automatically…");
      debug("state", { stage: "credentials-submitted", actionPath: new URL(match.action).pathname, discoveryMs: startedAt - discoveryStartedAt });
      await updateCredentialStatus(credentials, { lastAttemptAt: startedAt, lastError: null, lastStage: "credentials-submitted", lastStatusAt: startedAt, blockedUntil: 0 });
      await submitLogin(match, credentials);
      debug("state", { stage: "successful" });
      await updateCredentialStatus(credentials, { lastAttemptAt: startedAt, lastSuccessAt: Date.now(), lastError: null, lastStage: "successful", lastStatusAt: Date.now(), blockedUntil: 0 });
      showNotice("Signed in", { terminal: true, timeoutMs: 750 });
      nextDiscoveryAt = Date.now() + 2000;
      location.reload();
      return true;
    } catch (error) {
      const code = error?.code ?? "automatic-signin-failed";
      const lastError = sanitizedError(code, error?.message ?? "Automatic sign-in failed.");
      debug("state", { stage: code, message: lastError.message });
      const stored = await storageGet(CREDENTIALS_KEY).catch(() => ({}));
      const credentials = stored?.[CREDENTIALS_KEY] ?? null;
      if (credentials) {
        const discoveryOnly = error?.discoveryOnly === true || !submissionStarted;
        if (discoveryOnly) nextDiscoveryAt = Date.now() + (code === "challenge-required" ? retryDelayFor(code) : 1500);
        await updateCredentialStatus(credentials, {
          ...(discoveryOnly ? {} : { lastAttemptAt: Date.now() }),
          lastError,
          lastStage: code,
          lastStatusAt: Date.now(),
          blockedUntil: discoveryOnly ? 0 : Date.now() + retryDelayFor(code)
        }).catch(() => {});
      }
      showNotice(code === "challenge-required" ? "Manual sign-in required" : "Automatic sign-in could not complete", { terminal: true });
      return false;
    } finally {
      discoveryInFlight = false;
    }
  }

  function whenReady(callback) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", callback, { once: true });
    else queueMicrotask(callback);
  }

  let readinessObserver = null;
  let readinessTimer = null;
  let readinessQueued = false;
  function stopReadinessWatch() {
    readinessObserver?.disconnect?.();
    readinessObserver = null;
    if (readinessTimer !== null) globalThis.clearTimeout(readinessTimer);
    readinessTimer = null;
    readinessQueued = false;
  }

  function beginReadinessWatch() {
    stopReadinessWatch();
    const check = () => {
      if (looksLoggedIn(document) && !looksLoggedOut(document)) return;
      if (readinessQueued) return;
      readinessQueued = true;
      readinessTimer = globalThis.setTimeout(() => {
        readinessTimer = null;
        readinessQueued = false;
        run().catch(() => {});
      }, 75);
    };
    check();
    if (typeof MutationObserver !== "function") return;
    readinessObserver = new MutationObserver(check);
    readinessObserver.observe(document.documentElement ?? document, { childList: true, subtree: true });
  }

  globalThis.R34MFAutoSignIn = Object.freeze({
    SETTINGS_KEY,
    CREDENTIALS_KEY,
    safeUrl,
    looksLoggedIn,
    looksLoggedOut,
    discoverLoginUrl,
    findLoginControl,
    waitForLoginForm,
    challengePresent,
    pickIdentifierInput,
    pickPasswordInput,
    formLooksLikeLogin,
    findLoginForm,
    sameCredentialRecord,
    updateCredentialStatus,
    retryDelayFor,
    beginReadinessWatch,
    stopReadinessWatch,
    normalizeToCurrentOrigin,
    inspectLoginForms,
    discoverRemoteLoginForm,
    showNotice,
    removeNotice,
    bindLogoutRecovery,
    run
  });

  if (api?.storage?.local && typeof document !== "undefined" && typeof location !== "undefined") {
    bindLogoutRecovery();
    whenReady(() => beginReadinessWatch());
    globalThis.addEventListener?.("pageshow", () => beginReadinessWatch());
    api.storage?.onChanged?.addListener?.((changes, areaName) => {
      if (areaName !== "local") return;
      const credentialsChange = changes?.[CREDENTIALS_KEY];
      const credentialIdentityChanged = credentialsChange && !sameCredentialRecord(credentialsChange.oldValue, credentialsChange.newValue);
      if (!changes?.[SETTINGS_KEY] && !credentialIdentityChanged) return;
      nextDiscoveryAt = 0;
      beginReadinessWatch();
    });
  }
})();
