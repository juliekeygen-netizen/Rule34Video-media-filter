import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parseHTML, DOMParser } from "linkedom";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [authSource, localGridSource, loggerSource, settingsSource, controllerSource] = await Promise.all([
  read("src/auth/auto-signin.js"), read("src/ui/local-grid.js"), read("src/utils/logger.js"), read("src/storage/settings.js"), read("src/content/subscriptions-controller.js")
]);

class FixtureFormData {
  constructor(form) {
    this.values = new Map();
    for (const input of form?.querySelectorAll?.("input[name]") ?? []) this.values.set(input.name, input.value ?? "");
  }
  set(key, value) { this.values.set(key, String(value)); }
  has(key) { return this.values.has(key); }
  entries() { return this.values.entries(); }
}

function authFixture(markup, { storage = null, fetchImpl = null, DateImpl = Date } = {}) {
  const { document, window } = parseHTML(markup);
  const state = storage ?? {};
  let reloads = 0;
  const browser = { storage: {} };
  const context = {
    browser, document, MutationObserver: window.MutationObserver,
    location: { href: "https://rule34video.com/", origin: "https://rule34video.com", hostname: "rule34video.com", reload() { reloads += 1; } },
    URL, URLSearchParams, FormData: FixtureFormData, DOMParser, Date: DateImpl, AbortController, Math, Set, RegExp, String, Number, Object, Promise,
    console: { debug() {} }, queueMicrotask, setTimeout, clearTimeout, fetch: fetchImpl, globalThis: null
  };
  context.globalThis = context;
  vm.runInNewContext(authSource, context);
  browser.storage.local = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map((key) => [key, state[key]]));
    },
    async set(value) { Object.assign(state, value); }
  };
  return { auth: context.R34MFAutoSignIn, document, state, context, reloads: () => reloads };
}

test("automatic sign-in discovers semantic nested controls and delayed verified modal forms", async () => {
  const fixture = authFixture(`<!doctype html><a href="#login" role="button" data-target="#auth-modal"><span><b>Login</b></span></a><main></main>`);
  const control = fixture.auth.findLoginControl(fixture.document);
  assert.ok(control);
  assert.equal(fixture.auth.discoverLoginUrl(fixture.document, { href: "https://rule34video.com/", origin: "https://rule34video.com" }), null);
  control.addEventListener("click", () => setTimeout(() => {
    fixture.document.querySelector("main").innerHTML = `<div role="dialog"><h2>Sign in</h2><form method="post" action="/login/">
      <input name="username" autocomplete="username"><input name="password" type="password"><button type="submit">Login</button>
    </form></div>`;
  }, 5));
  control.click();
  const match = await fixture.auth.waitForLoginForm(fixture.document, "https://rule34video.com/", 250);
  assert.ok(match);
  assert.equal(match.identifier.name, "username");
});

test("automatic sign-in state machine submits only after verified discovery and records success", async () => {
  const state = {
    "r34mf.settings": { automaticSignIn: true, advanced: { debugLogging: true } },
    "r34mf.authCredentials": { identifier: "alice", password: "private", savedAt: 1, lastAttemptAt: null, blockedUntil: 0 }
  };
  const requests = [];
  const fixture = authFixture("<!doctype html><main>Delayed site shell</main>", {
    storage: state,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method ?? "GET" });
      if (options.method === "POST") return { ok: true, status: 200, url: "https://rule34video.com/", async text() { return `<a href="/logout/">Logout</a>`; } };
      return { ok: true, status: 200, url: "https://rule34video.com/login/", async text() { return `<form method="post" action="/login/"><input name="username"><input name="password" type="password"><button type="submit">Login</button></form>`; } };
    }
  });
  assert.equal(await fixture.auth.run(), true);
  assert.deepEqual(requests.map((entry) => entry.method), ["GET", "POST"]);
  assert.equal(state["r34mf.authCredentials"].lastStage, "successful");
  assert.ok(state["r34mf.authCredentials"].lastAttemptAt);
  assert.equal(fixture.reloads(), 1);
  assert.match(fixture.document.querySelector(".r34mf-auth-notice")?.textContent ?? "", /Signed in/);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(fixture.document.querySelector(".r34mf-auth-notice"), null);
});

test("successful automatic sign-in remains eligible after a later logged-out transition", async () => {
  let now = 10_000;
  class Clock extends Date { static now() { return now; } }
  const state = {
    "r34mf.settings": { automaticSignIn: true },
    "r34mf.authCredentials": { identifier: "alice", password: "private", savedAt: 1, blockedUntil: 0 }
  };
  let requests = 0;
  const fixture = authFixture("<!doctype html><a href='/login/'>Login</a>", {
    storage: state,
    DateImpl: Clock,
    fetchImpl: async (_url, options = {}) => {
      requests += 1;
      return options.method === "POST"
        ? { ok: true, status: 200, url: "https://rule34video.com/", async text() { return `<a href='/logout/'>Logout</a>`; } }
        : { ok: true, status: 200, url: "https://rule34video.com/login/", async text() { return `<form method='post' action='/login/'><input name='username'><input name='password' type='password'><button>Login</button></form>`; } };
    }
  });
  assert.equal(await fixture.auth.run(), true);
  now += 2_100;
  assert.equal(await fixture.auth.run(), true);
  assert.equal(requests, 4);
  assert.equal(fixture.reloads(), 2);
});

test("automatic sign-in deduplicates concurrent work, displays a dismissible per-attempt notice, and keeps failure backoff", async () => {
  const state = {
    "r34mf.settings": { automaticSignIn: true },
    "r34mf.authCredentials": { identifier: "alice", password: "wrong", savedAt: 1, blockedUntil: 0 }
  };
  let release;
  let requests = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const fixture = authFixture("<!doctype html><a href='/login/'>Login</a>", {
    storage: state,
    fetchImpl: async (_url, options = {}) => {
      requests += 1;
      if (options.method !== "POST") return pending;
      return { ok: false, status: 401, url: "https://rule34video.com/login/", async text() { return "Login failed"; } };
    }
  });
  const first = fixture.auth.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(fixture.document.querySelector(".r34mf-auth-notice")?.textContent ?? "", /Finding login/);
  fixture.document.querySelector(".r34mf-auth-notice button").click();
  assert.equal(fixture.document.querySelector(".r34mf-auth-notice"), null);
  assert.equal(await fixture.auth.run(), false, "a second concurrent submission is rejected");
  release({ ok: true, status: 200, url: "https://rule34video.com/login/", async text() { return `<form method='post' action='/login/'><input name='username'><input name='password' type='password'><button>Login</button></form>`; } });
  assert.equal(await first, false);
  assert.ok(state["r34mf.authCredentials"].blockedUntil > Date.now());
  const before = requests;
  assert.equal(await fixture.auth.run(), false);
  assert.equal(requests, before, "backoff prevents another network request");
});

test("automatic sign-in rejects unrelated and challenge password forms without consuming an attempt", async () => {
  const unrelated = authFixture(`<!doctype html><form method="post" action="/account/update"><input name="email"><input name="password" type="password"><button type="submit">Save account</button></form>`);
  assert.equal(unrelated.auth.inspectLoginForms(unrelated.document, "https://rule34video.com/account/").reason, "login-form-unverified");
  const challenge = authFixture(`<!doctype html><form method="post" action="/login/"><input name="email"><input name="password" type="password"><input name="otp"><button type="submit">Login</button></form>`);
  assert.equal(challenge.auth.inspectLoginForms(challenge.document, "https://rule34video.com/login/").reason, "challenge-required");

  const state = {
    "r34mf.settings": { automaticSignIn: true },
    "r34mf.authCredentials": { identifier: "alice", password: "private", savedAt: 1, lastAttemptAt: null, blockedUntil: 0 }
  };
  const failed = authFixture("<!doctype html><main>Shell only</main>", { storage: state, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(await failed.auth.run(), false);
  assert.equal(state["r34mf.authCredentials"].lastAttemptAt, null);
});

test("hover previews release media and restore the exact static thumbnail on leave", () => {
  const { document, window } = parseHTML("<!doctype html><div id='host'></div>");
  const R34MF = { modules: { db: {}, paginatorModel: { clampPage: (v) => v, paginationModel: () => ({ items: [] }) } } };
  const context = { R34MF, document, window, URL, Date, Math, Number, String, Object, globalThis: null, setInterval, clearInterval };
  context.globalThis = context;
  vm.runInNewContext(localGridSource, context);
  const host = document.querySelector("#host");
  const card = R34MF.modules.localGrid.card({ videoId: "1", url: "https://rule34video.com/video/1/", title: "One", thumbnailUrl: "https://cdn.example/static.jpg", previewUrl: "https://cdn.example/preview.mp4" });
  host.append(card);
  const thumb = host.querySelector(".r34mf-local-thumb");
  const image = thumb.querySelector("img");
  const video = thumb.querySelector("video");
  let pauses = 0, loads = 0;
  Object.defineProperty(video, "src", {
    configurable: true,
    get() { return this.getAttribute("src") ?? ""; },
    set(value) { this.setAttribute("src", value); }
  });
  video.play = async () => {};
  video.pause = () => { pauses += 1; };
  video.load = () => { loads += 1; };
  R34MF.modules.localGrid.bindPreviews(host, true);
  thumb.dispatchEvent(new window.Event("pointerenter"));
  assert.equal(video.getAttribute("src"), "https://cdn.example/preview.mp4");
  assert.equal(video.classList.contains("is-active"), true);
  thumb.dispatchEvent(new window.Event("pointerleave"));
  assert.equal(video.hasAttribute("src"), false);
  assert.equal(video.classList.contains("is-active"), false);
  assert.equal(image.getAttribute("src"), "https://cdn.example/static.jpg");
  assert.ok(pauses >= 1 && loads >= 1);
  thumb.dispatchEvent(new window.Event("pointerenter"));
  assert.equal(video.getAttribute("src"), "https://cdn.example/preview.mp4");
});

test("debug logger follows saved Settings immediately and redacts sensitive fields", async () => {
  const calls = [];
  const storage = {};
  const R34MF = { modules: {
    constants: { storageKeys: { settings: "r34mf.settings" } },
    browserApi: { storage: {}, storageLocal: { async get() { return storage; }, async set(value) { Object.assign(storage, value); } } }
  } };
  const context = { R34MF, console: { debug: (...args) => calls.push(args), warn() {} }, Object, String, Boolean, WeakSet, Set, Error, Number, Math, JSON };
  vm.runInNewContext(loggerSource, context);
  vm.runInNewContext(settingsSource, context);
  R34MF.modules.logger.debug("off", { value: 1 });
  assert.equal(calls.length, 0);
  await R34MF.modules.settings.save({ ...R34MF.modules.settings.value, advanced: { ...R34MF.modules.settings.value.advanced, debugLogging: true } });
  R34MF.modules.logger.debug("on", { password: "never-log-me", nested: { credentialToken: "also-secret", ok: 2 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "[R34MF]");
  assert.equal(JSON.stringify(calls[0]).includes("never-log-me"), false);
  assert.equal(JSON.stringify(calls[0]).includes("also-secret"), false);
});

test("successful Recent Update uses the shared post-commit missing-detail enqueue and dedupes", async () => {
  const enqueued = [];
  const R34MF = { modules: {
    constants: { selectors: {} },
    settings: { value: { autoFetchMissingDetails: true } },
    catalogueScanner: { async refresh() { return { catalogueReady: true, indexedCount: 5, detailedCount: 3, scanStatus: "idle" }; } },
    db: { async getMissingDetailTargets() { return [{ videoId: "4" }]; }, async readRecentHistory() { return []; } },
    jobManager: { enqueue(input) { const duplicate = enqueued.length > 0; if (!duplicate) enqueued.push(input); return duplicate ? { accepted: false, reason: "duplicate" } : { accepted: true }; }, snapshot() { return { active: [], waiting: [] }; } },
    logger: { debug() {}, warn() {} }
  } };
  const context = { R34MF, URL, Object, Number, Math, Set, Map, Node: { ELEMENT_NODE: 1 }, globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(controllerSource, context);
  const controller = R34MF.modules.subscriptionsController;
  controller.state.catalogue = { catalogueReady: true, indexedCount: 5, detailedCount: 3 };
  assert.equal(await controller.afterSuccessfulCatalogueMutation({ kind: "smart-update", updateMode: "recent" }), true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].scopeKey, "details-missing");
  assert.equal(await controller.afterSuccessfulCatalogueMutation({ kind: "smart-update", updateMode: "recent" }), false);
  assert.equal(enqueued.length, 1);
});
