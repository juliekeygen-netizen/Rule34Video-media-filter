(() => {
  "use strict";

  const app = globalThis.R34MF;
  const browserApi = app?.modules.browserApi;
  const constants = app?.modules.constants;
  if (!app || !browserApi || !constants) throw new Error("R34MF browser API and constants must load before Seen storage.");

  const KEY = constants.storageKeys.seenVideos ?? "r34mf.seenVideos.v1";
  const listeners = new Set();
  let loaded = false;
  let loadingPromise = null;
  let ids = new Set();
  let updatedAt = 0;
  let storageBound = false;

  const normalizeId = (value) => {
    const id = String(value ?? "").trim();
    return /^\d+$/.test(id) ? id : null;
  };

  function normalize(raw) {
    const values = Array.isArray(raw?.ids) ? raw.ids : [];
    const next = new Set();
    for (const value of values) {
      const id = normalizeId(value);
      if (id) next.add(id);
    }
    return { version: 1, ids: [...next], updatedAt: Math.max(0, Number(raw?.updatedAt) || 0) };
  }

  function snapshot() { return { version: 1, ids: [...ids], updatedAt }; }
  function evaluationContext() { return loaded ? { status: "complete", ids: new Set(ids), updatedAt } : { status: "unavailable", ids: new Set(), updatedAt: 0 }; }
  function emit() { const value = snapshot(); for (const listener of listeners) listener(value); return value; }
  function sameState(next) {
    if (!loaded || Number(next.updatedAt) !== Number(updatedAt) || next.ids.length !== ids.size) return false;
    return next.ids.every((id) => ids.has(id));
  }
  function apply(next, { notify = true } = {}) {
    const normalized = normalize(next);
    if (sameState(normalized)) return snapshot();
    ids = new Set(normalized.ids);
    updatedAt = normalized.updatedAt;
    loaded = true;
    return notify ? emit() : snapshot();
  }
  function nextUpdatedAt() { return Math.max(Date.now(), Number(updatedAt) + 1); }
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };

  function bindStorage() {
    if (storageBound || !browserApi.storage?.onChanged?.addListener) return;
    storageBound = true;
    browserApi.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes?.[KEY]) return;
      apply(changes[KEY].newValue);
    });
  }

  async function load({ force = false } = {}) {
    bindStorage();
    if (loaded && !force) return snapshot();
    if (loadingPromise) return loadingPromise;
    loadingPromise = Promise.resolve(browserApi.storageLocal.get(KEY)).then((stored) => apply(stored?.[KEY])).finally(() => { loadingPromise = null; });
    return loadingPromise;
  }

  async function write(nextIds) {
    const next = { version: 1, ids: [...nextIds], updatedAt: nextUpdatedAt() };
    await browserApi.storageLocal.set({ [KEY]: next });
    // storage.onChanged may have already applied our own write synchronously.
    // apply() dedupes that echo so Local filters get one refresh per real change.
    return apply(next);
  }

  async function setSeen(videoId, seen) {
    const id = normalizeId(videoId);
    if (!id) throw new Error("A numeric Rule34Video video ID is required.");
    await load({ force: true });
    const next = new Set(ids);
    if (seen) next.add(id); else next.delete(id);
    return write(next);
  }

  async function toggle(videoId) {
    const id = normalizeId(videoId);
    if (!id) throw new Error("A numeric Rule34Video video ID is required.");
    await load({ force: true });
    const nextSeen = !ids.has(id);
    const next = new Set(ids);
    if (nextSeen) next.add(id); else next.delete(id);
    await write(next);
    return nextSeen;
  }

  function has(videoId) {
    const id = normalizeId(videoId);
    return Boolean(id && loaded && ids.has(id));
  }

  app.modules.seenStore = Object.freeze({ KEY, normalizeId, normalize, load, snapshot, evaluationContext, subscribe, has, setSeen, toggle, apply, sameState });
})();
