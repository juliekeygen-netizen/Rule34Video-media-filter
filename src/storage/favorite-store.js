(() => {
  "use strict";

  const app = globalThis.R34MF;
  const browserApi = app?.modules.browserApi;
  const constants = app?.modules.constants;
  if (!app || !browserApi || !constants) throw new Error("R34MF browser API and constants must load before Favorites storage.");

  const KEY = constants.storageKeys.favoriteVideos;
  const listeners = new Set();
  let loaded = false;
  let loadingPromise = null;
  let state = { version: 1, ids: [], updatedAt: 0 };

  const normalizeId = (value) => /^\d+$/.test(String(value ?? "").trim()) ? String(value).trim() : null;

  function normalize(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const ids = [...new Set((Array.isArray(source.ids) ? source.ids : []).map(normalizeId).filter(Boolean))];
    return { version: 1, ids, updatedAt: Math.max(0, Number(source.updatedAt) || 0) };
  }

  function snapshot() {
    return { version: 1, ids: [...state.ids], updatedAt: state.updatedAt };
  }

  function emit(source = "change") {
    const value = snapshot();
    for (const listener of listeners) listener(value, source);
    return value;
  }

  function sameState(next) {
    return loaded
      && Number(next.updatedAt) === Number(state.updatedAt)
      && next.ids.length === state.ids.length
      && next.ids.every((id, index) => id === state.ids[index]);
  }

  function apply(raw, source = "change") {
    const next = normalize(raw);
    if (sameState(next)) return snapshot();
    state = next;
    loaded = true;
    return emit(source);
  }

  function nextUpdatedAt() { return Math.max(Date.now(), Number(state.updatedAt) + 1); }

  async function load({ force = false } = {}) {
    if (loaded && !force) return snapshot();
    if (loadingPromise) return loadingPromise;
    loadingPromise = Promise.resolve(browserApi.storageLocal.get(KEY))
      .then((stored) => apply(stored?.[KEY], "load"))
      .finally(() => { loadingPromise = null; });
    return loadingPromise;
  }

  async function write(ids) {
    await load();
    const next = normalize({ ids, updatedAt: nextUpdatedAt() });
    await browserApi.storageLocal.set({ [KEY]: next });
    return apply(next, "write");
  }

  async function setFavorited(videoId, favorited) {
    const id = normalizeId(videoId);
    if (!id) return snapshot();
    await load({ force: true });
    const already = state.ids.includes(id);
    if (already === (favorited === true)) return snapshot();
    const ids = new Set(state.ids);
    if (favorited) ids.add(id); else ids.delete(id);
    return write([...ids]);
  }

  async function toggle(videoId) {
    const id = normalizeId(videoId);
    if (!id) return false;
    await load({ force: true });
    const next = !state.ids.includes(id);
    const ids = new Set(state.ids);
    if (next) ids.add(id); else ids.delete(id);
    await write([...ids]);
    return next;
  }

  async function has(videoId) {
    const id = normalizeId(videoId);
    if (!id) return false;
    await load();
    return state.ids.includes(id);
  }

  function visible(node) {
    if (!node || node.hidden || node.classList?.contains("hidden") || node.getAttribute?.("aria-hidden") === "true") return false;
    const style = node.getAttribute?.("style") ?? "";
    return !/(?:^|;)\s*display\s*:\s*none\b/i.test(style);
  }

  function nativeState(documentLike) {
    const roots = [...documentLike?.querySelectorAll?.(".btn-favourites") ?? []];
    const root = roots.find((node) => node.querySelector("[data-fav-type='0']"));
    if (!root) return null;
    const removeAnchor = root.querySelector("a[href='#delete'][data-fav-type='0'], a.delete.button_fav[data-fav-type='0']");
    const addAnchor = root.querySelector("a[href='#add_to_fav'][data-fav-type='0']");
    const removeNode = removeAnchor?.closest("li") ?? removeAnchor;
    const addNode = addAnchor?.closest("li") ?? addAnchor;
    const removeVisible = visible(removeNode);
    const addVisible = visible(addNode);
    if (removeVisible && !addVisible) return true;
    if (addVisible && !removeVisible) return false;
    if (removeVisible) return true;
    if (addVisible) return false;
    return null;
  }

  async function syncFromDocument(videoId, documentLike) {
    const value = nativeState(documentLike);
    if (value === null) return null;
    await setFavorited(videoId, value);
    return value;
  }

  function evaluationContext() {
    return loaded
      ? { status: "complete", ids: new Set(state.ids), updatedAt: state.updatedAt }
      : { status: "unavailable", ids: new Set(), updatedAt: 0 };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  browserApi.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local" || !changes?.[KEY]) return;
    apply(changes[KEY].newValue, "storage-change");
  });

  app.modules.favoriteStore = Object.freeze({
    KEY,
    normalize,
    load,
    snapshot,
    write,
    setFavorited,
    toggle,
    has,
    visible,
    nativeState,
    syncFromDocument,
    evaluationContext,
    subscribe,
    apply,
    sameState
  });
})();
