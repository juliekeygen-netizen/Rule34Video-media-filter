(() => {
  "use strict";

  const app = globalThis.R34MF;
  const seenStore = app?.modules.seenStore;
  if (!app || !seenStore) throw new Error("R34MF Seen storage must load before the video-page Seen control.");
  if (!/^\/videos?\/\d+(?:\/|$)/i.test(String(globalThis.location?.pathname ?? ""))) return;

  const SVG_NS = "http://www.w3.org/2000/svg";
  let observer = null;
  let unsubscribe = null;
  let mountedId = null;

  function videoId() {
    const native = document.querySelector(".video_tools [data-video-id], .panel.tabs-menu [data-video-id]")?.getAttribute("data-video-id");
    if (/^\d+$/.test(String(native ?? ""))) return String(native);
    return location.pathname.match(/^\/videos?\/(\d+)(?:\/|$)/i)?.[1] ?? null;
  }

  function icon(seen) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("custom-svg", "r34mf-seen-icon");
    const path = document.createElementNS(SVG_NS, "path");
    if (seen) {
      path.setAttribute("d", "M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z");
      const pupil = document.createElementNS(SVG_NS, "circle");
      pupil.setAttribute("cx", "12");
      pupil.setAttribute("cy", "12");
      pupil.setAttribute("r", "2.6");
      svg.append(path, pupil);
    } else {
      path.setAttribute("d", "M3 15.5c2.3-2.6 5.3-3.9 9-3.9s6.7 1.3 9 3.9M5.2 12.9l-1.5-1.5M9 11.8l-.5-2M15 11.8l.5-2M18.8 12.9l1.5-1.5");
      svg.append(path);
    }
    return svg;
  }

  function updateButton(button, id) {
    const seen = seenStore.has(id);
    button.setAttribute("aria-pressed", seen ? "true" : "false");
    button.dataset.seen = seen ? "true" : "false";
    button.replaceChildren(icon(seen), Object.assign(document.createElement("span"), { textContent: seen ? "Remove from seen" : "Add to seen" }));
  }

  function nativeAnchors() {
    const menu = document.querySelector(".video_tools .panel.tabs-menu, .panel.tabs-menu");
    if (!menu) return null;
    const favourites = [...menu.querySelectorAll(":scope > .btn-favourites")]
      .find((node) => node.querySelector("[data-fav-type='0'], [href='#add_to_fav']"));
    const playlist = [...menu.querySelectorAll(":scope > .btn-favourites")]
      .find((node) => node !== favourites && node.querySelector(".filter_buttons.sorting, [href='#add_to_playlist'], [href='#add_to_new_playlist']"));
    return favourites && playlist ? { menu, favourites, playlist } : null;
  }

  function mount() {
    const id = videoId();
    const anchors = nativeAnchors();
    if (!id || !anchors) return false;

    let wrapper = anchors.menu.querySelector(":scope > .r34mf-seen-control");
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "btn-favourites r34mf-seen-control";
      wrapper.dataset.r34mfOwned = "true";
      const list = document.createElement("ul");
      const item = document.createElement("li");
      item.style.position = "static";
      item.style.zoom = "1";
      const button = document.createElement("a");
      button.href = "#r34mf_seen";
      button.className = "button_fav r34mf-seen-button";
      button.dataset.videoId = id;
      button.setAttribute("role", "button");
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.busy === "true") return;
        button.dataset.busy = "true";
        button.setAttribute("aria-busy", "true");
        try {
          await seenStore.toggle(button.dataset.videoId);
          updateButton(button, button.dataset.videoId);
        } catch (error) {
          app.modules.logger?.warn?.("video-seen-toggle-failed", { videoId: button.dataset.videoId, message: error?.message ?? String(error) });
        } finally {
          delete button.dataset.busy;
          button.removeAttribute("aria-busy");
        }
      });
      item.append(button);
      list.append(item);
      wrapper.append(list);
      anchors.menu.insertBefore(wrapper, anchors.playlist);
    }

    const button = wrapper.querySelector(".r34mf-seen-button");
    if (!button) return false;
    button.dataset.videoId = id;
    updateButton(button, id);
    mountedId = id;
    return true;
  }

  async function start() {
    try { await seenStore.load(); }
    catch (error) { app.modules.logger?.warn?.("video-seen-load-failed", { message: error?.message ?? String(error) }); }
    mount();
    unsubscribe = seenStore.subscribe(() => {
      const button = document.querySelector(".r34mf-seen-button");
      const id = videoId();
      if (button && id) updateButton(button, id);
    });
    observer = new MutationObserver(() => {
      const id = videoId();
      if (id !== mountedId || !document.querySelector(".r34mf-seen-control")) queueMicrotask(mount);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  start();
  app.modules.videoPageSeen = Object.freeze({ videoId, nativeAnchors, mount, stop() { observer?.disconnect(); unsubscribe?.(); } });
})();
