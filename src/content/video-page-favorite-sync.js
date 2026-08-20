(() => {
  "use strict";

  const app = globalThis.R34MF;
  const store = app?.modules.favoriteStore;
  if (!app || !store) throw new Error("R34MF Favorites storage must load before native Favorites sync.");

  const VIDEO_PATH = /^\/videos?\/(\d+)(?:\/|$)/i;
  let observer = null;
  let syncQueued = false;
  let lastState = null;

  function videoIdFromPage() {
    const match = String(globalThis.location?.pathname ?? "").match(VIDEO_PATH);
    return match?.[1] ?? null;
  }

  function favoritesRoot(documentLike = document) {
    return [...documentLike.querySelectorAll?.(".btn-favourites") ?? []].find((node) => node.querySelector("[data-fav-type='0']")) ?? null;
  }

  function visible(node) {
    if (!node || node.hidden || node.classList?.contains("hidden") || node.getAttribute?.("aria-hidden") === "true") return false;
    const style = node.getAttribute?.("style") ?? "";
    return !/(?:^|;)\s*display\s*:\s*none\b/i.test(style);
  }

  function nativeFavoriteState(root) {
    if (!root) return null;
    const removeAnchor = root.querySelector("a[href='#delete'][data-fav-type='0'], a.delete.button_fav[data-fav-type='0']");
    const addAnchor = root.querySelector("a[href='#add_to_fav'][data-fav-type='0']");
    const removeItem = removeAnchor?.closest("li") ?? root.querySelector("#delete_fav_0");
    const addItem = addAnchor?.closest("li") ?? root.querySelector("#add_fav_0");
    const removeVisible = visible(removeItem ?? removeAnchor);
    const addVisible = visible(addItem ?? addAnchor);
    if (removeVisible && !addVisible) return true;
    if (addVisible && !removeVisible) return false;
    if (removeVisible) return true;
    if (addVisible) return false;
    return null;
  }

  async function syncNow() {
    syncQueued = false;
    const id = videoIdFromPage();
    const root = favoritesRoot();
    if (!id || !root) return false;
    const state = nativeFavoriteState(root);
    if (state === null || state === lastState) return false;
    lastState = state;
    try {
      await store.setFavorited(id, state);
      return true;
    } catch (error) {
      app.modules.logger?.warn?.("favorite-native-sync-failed", { message: error?.message ?? String(error), videoId: id });
      return false;
    }
  }

  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(syncNow);
  }

  async function start() {
    const id = videoIdFromPage();
    if (!id) return false;
    try { await store.load(); } catch { /* syncNow will retry the write path */ }
    const root = favoritesRoot();
    if (!root) return false;
    lastState = null;
    await syncNow();
    observer?.disconnect();
    observer = new MutationObserver(scheduleSync);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
    return true;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start(), { once: true });
  else start();

  app.modules.videoPageFavoriteSync = Object.freeze({ videoIdFromPage, favoritesRoot, visible, nativeFavoriteState, syncNow, start });
})();
