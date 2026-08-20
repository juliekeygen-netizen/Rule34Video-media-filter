(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.localGrid;
  if (!app || !base) throw new Error("R34MF Local grid must load before touch preview support.");

  const SWIPE_X_PX = 28;
  const VERTICAL_CANCEL_PX = 16;
  const AXIS_BIAS_PX = 10;
  const CLICK_SUPPRESS_MS = 750;
  const TOUCH_FOCUS_SUPPRESS_MS = 1000;
  let activeTouchThumb = null;
  const hostStates = new WeakMap();

  function previewFor(thumb) {
    return thumb?.querySelector?.("video[data-preview]") ?? null;
  }

  function stopPreview(thumb) {
    const preview = previewFor(thumb);
    if (!preview) return;
    preview.dataset.previewGeneration = String((Number(preview.dataset.previewGeneration) || 0) + 1);
    preview.pause?.();
    preview.removeAttribute("src");
    preview.load?.();
    preview.classList.remove("is-active");
    if (activeTouchThumb === thumb) activeTouchThumb = null;
  }

  function startPreview(thumb) {
    const preview = previewFor(thumb);
    if (!preview) return false;
    preview.dataset.previewGeneration = String((Number(preview.dataset.previewGeneration) || 0) + 1);
    if (!preview.src) preview.src = preview.dataset.preview;
    preview.classList.add("is-active");
    preview.play?.().catch(() => {});
    return true;
  }

  function toggleTouchPreview(thumb) {
    const preview = previewFor(thumb);
    if (!preview) return false;
    if (activeTouchThumb && (!activeTouchThumb.isConnected || activeTouchThumb !== thumb)) stopPreview(activeTouchThumb);
    if (activeTouchThumb === thumb && preview.classList.contains("is-active")) {
      stopPreview(thumb);
      return false;
    }
    if (startPreview(thumb)) {
      activeTouchThumb = thumb;
      return true;
    }
    return false;
  }

  function localHost(root) {
    if (!root) return null;
    if (root.matches?.(".r34mf-local-host")) return root;
    return root.querySelector?.(":scope > .r34mf-local-host")
      ?? root.querySelector?.(".r34mf-local-host")
      ?? null;
  }

  function touchThumb(host, target) {
    const thumb = target?.closest?.(".r34mf-local-thumb") ?? null;
    return thumb && host?.contains?.(thumb) && previewFor(thumb) ? thumb : null;
  }

  function prepareTouchActions(host) {
    for (const thumb of host?.querySelectorAll?.(".r34mf-local-thumb") ?? []) {
      if (previewFor(thumb)) thumb.style.touchAction = "pan-y";
    }
  }

  function bindTouchPreviews(root) {
    const host = localHost(root);
    if (!host) return;
    if (activeTouchThumb && !activeTouchThumb.isConnected) activeTouchThumb = null;
    prepareTouchActions(host);
    if (hostStates.has(host)) return;

    const state = {
      gesture: null,
      suppressThumb: null,
      suppressClickUntil: 0,
      lastTouchAt: 0
    };
    hostStates.set(host, state);
    host.dataset.r34mfTouchPreviewDelegated = "true";

    // The base Local renderer keeps desktop hover/focus previews. A touch contact
    // can synthesize pointerenter/focusin too, so stop those events before they
    // reach the per-thumbnail desktop listeners. This prevents touch scrolling
    // from accidentally starting multiple preview videos.
    host.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch" || !touchThumb(host, event.target)) return;
      state.lastTouchAt = Date.now();
      event.stopPropagation();
    }, true);

    host.addEventListener("focusin", (event) => {
      if (Date.now() - state.lastTouchAt > TOUCH_FOCUS_SUPPRESS_MS || !touchThumb(host, event.target)) return;
      event.stopPropagation();
    }, true);

    // One delegated passive pointer pipeline serves the whole Local page. We do
    // not call preventDefault() from pointermove and do not capture the pointer,
    // keeping Android's scroll/compositor path free until a swipe is complete.
    host.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" || event.isPrimary === false) return;
      const thumb = touchThumb(host, event.target);
      if (!thumb) return;
      state.lastTouchAt = Date.now();
      state.gesture = {
        pointerId: event.pointerId,
        thumb,
        startX: Number(event.clientX),
        startY: Number(event.clientY),
        qualified: false,
        cancelled: false
      };
    }, { passive: true });

    host.addEventListener("pointermove", (event) => {
      const gesture = state.gesture;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.cancelled) return;
      const dx = Number(event.clientX) - gesture.startX;
      const dy = Number(event.clientY) - gesture.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      if (absY >= VERTICAL_CANCEL_PX && absY > absX) {
        gesture.cancelled = true;
        gesture.qualified = false;
        return;
      }
      if (absX < SWIPE_X_PX || absX <= absY + AXIS_BIAS_PX) return;
      gesture.qualified = true;
    }, { passive: true });

    const finish = (event, cancelled = false) => {
      const gesture = state.gesture;
      if (!gesture || (event?.pointerId !== undefined && gesture.pointerId !== event.pointerId)) return;
      state.gesture = null;
      if (cancelled || gesture.cancelled || !gesture.qualified || !gesture.thumb.isConnected) return;

      const thumb = gesture.thumb;
      state.suppressThumb = thumb;
      state.suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
      toggleTouchPreview(thumb);
    };

    host.addEventListener("pointerup", (event) => finish(event, false), { passive: true });
    host.addEventListener("pointercancel", (event) => finish(event, true), { passive: true });

    host.addEventListener("click", (event) => {
      const thumb = touchThumb(host, event.target);
      if (!thumb || thumb !== state.suppressThumb || Date.now() >= state.suppressClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
      state.suppressThumb = null;
      state.suppressClickUntil = 0;
    }, true);
  }

  async function render(root, options = {}) {
    // Animated Local previews are a permanent capability. Desktop hover/focus
    // stays in the base renderer; touch preview activation is isolated here.
    const result = await base.render(root, { ...options, previews: true });
    if (!result?.aborted) bindTouchPreviews(root);
    return result;
  }

  function hide(root) {
    if (activeTouchThumb && root?.contains?.(activeTouchThumb)) stopPreview(activeTouchThumb);
    return base.hide(root);
  }

  app.modules.localGrid = Object.freeze({
    ...base,
    render,
    hide,
    bindTouchPreviews,
    toggleTouchPreview,
    startTouchPreview: startPreview,
    stopTouchPreview: stopPreview,
    SWIPE_X_PX,
    VERTICAL_CANCEL_PX,
    AXIS_BIAS_PX,
    CLICK_SUPPRESS_MS,
    TOUCH_FOCUS_SUPPRESS_MS
  });
})();
