import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { DOMParser, parseHTML } from "linkedom";

function html({ page, members, pages = [1, 2, 3] }) {
  return `<!doctype html><html><body>
    <div id="list_members_subscriptions_my_subscriptions">
      <div class="filters-panel__body"><div id="list_members_subscriptions_my_subscriptions_items">
        ${members.map(([slug, name]) => `<div class="item"><a href="https://rule34video.com/models/${slug}/" class="title wrap-item"><span class="name">${name}</span></a></div>`).join("")}
      </div></div>
      <div class="pagination" id="list_members_subscriptions_my_subscriptions_pagination">
        ${pages.map((value) => `<div class="item${value === page ? " active" : ""}"><a data-action="ajax" data-block-id="list_members_subscriptions_my_subscriptions" data-parameters="sort_by:added_date;from_my_subscriptions:${String(value).padStart(2, "0")}">${String(value).padStart(2, "0")}</a></div>`).join("")}
        ${page < pages.at(-1) ? `<div class="item pager next"><a data-action="ajax" data-block-id="list_members_subscriptions_my_subscriptions" data-parameters="sort_by:added_date;from_my_subscriptions:${page + 1}">Next</a></div>` : ""}
      </div>
    </div>
  </body></html>`;
}

function runtime(fetchImpl) {
  const storage = new Map();
  const context = { console, Date, JSON, Math, RegExp, String, Number, Set, Map, URL, URLSearchParams, DOMException, AbortController, DOMParser, fetch: fetchImpl,
    location: { origin: "https://rule34video.com", href: "https://rule34video.com/my/subscriptions/" },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setTimeout, clearTimeout, queueMicrotask };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["src/shared/namespace.js", "src/shared/constants.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  context.R34MF.modules.requestScheduler = { runWithPolicy: ({ request, signal }) => request({ signal }) };
  context.R34MF.modules.logger = { debug() {}, warn() {} };
  for (const file of ["src/catalogue/subscription-membership.js", "src/catalogue/subscription-membership-harden.js"]) vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return context.R34MF.modules.subscriptionMembership;
}

test("Subscriptions only membership accepts the real total-free native paginator after visiting every verified page", async () => {
  const first = parseHTML(html({ page: 1, members: [["artist-a", "Artist A"], ["artist-b", "Artist B"]] })).document;
  const calls = [];
  const membership = runtime(async (url) => {
    const page = Number(new URL(url).searchParams.get("from_my_subscriptions"));
    calls.push(page);
    const members = page === 2 ? [["artist-c", "Artist C"], ["artist-d", "Artist D"]] : [["artist-e", "Artist E"]];
    return { ok: true, status: 200, url, text: async () => html({ page, members }) };
  });
  const parsed = membership.parseDocument(first);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.total, null);
  assert.equal(parsed.pageCount, 3);
  const result = await membership.refresh({ documentLike: first, force: true });
  assert.equal(result.status, "complete");
  assert.equal(result.snapshot.total, 5);
  assert.deepEqual(calls, [2, 3]);
  assert.deepEqual([...membership.evaluationContext().keys], ["artist-a", "artist-b", "artist-c", "artist-d", "artist-e"]);
});

test("Subscriptions only notices a changed live membership page even while the session snapshot is still fresh", async () => {
  const first = parseHTML(html({ page: 1, members: [["artist-a", "Artist A"], ["artist-b", "Artist B"]] })).document;
  const calls = [];
  const membership = runtime(async (url) => {
    const page = Number(new URL(url).searchParams.get("from_my_subscriptions"));
    calls.push(page);
    const members = page === 2 ? [["artist-c", "Artist C"]] : [["artist-d", "Artist D"]];
    return { ok: true, status: 200, url, text: async () => html({ page, members }) };
  });
  await membership.refresh({ documentLike: first, force: true });
  assert.equal(membership.publicState().snapshot.total, 4);
  assert.equal(membership.evaluationContext().keys.has("artist-b"), true);

  first.querySelector("#list_members_subscriptions_my_subscriptions_items").innerHTML = `<div class="item"><a href="https://rule34video.com/models/artist-a/" class="title wrap-item"><span class="name">Artist A</span></a></div>`;
  await membership.ensureFresh({ documentLike: first });
  assert.equal(membership.publicState().snapshot.total, 3);
  assert.equal(membership.evaluationContext().keys.has("artist-b"), false, "unsubscribed Artist must leave the fresh evaluation set immediately");
  assert.deepEqual(calls, [2, 3, 2, 3]);
});

test("Subscriptions only membership still rejects incomplete total-free recovery instead of inventing membership", async () => {
  const first = parseHTML(html({ page: 1, members: [["artist-a", "Artist A"]] })).document;
  const membership = runtime(async (url) => {
    const page = Number(new URL(url).searchParams.get("from_my_subscriptions"));
    if (page === 2) return { ok: false, status: 500, url, text: async () => "" };
    return { ok: true, status: 200, url, text: async () => html({ page, members: [["artist-c", "Artist C"]] }) };
  });
  await assert.rejects(membership.refresh({ documentLike: first, force: true }), (error) => error?.code === "membership-http-error");
  assert.notEqual(membership.publicState().status, "complete");
  assert.equal(membership.evaluationContext().status, "unavailable");
});
