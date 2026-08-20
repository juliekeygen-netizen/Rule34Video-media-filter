(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  if (!app || !controller) {
    throw new Error("R34MF subscriptions controller must load before filter touch follow-up support.");
  }

  const MOBILE_MAX = 760;
  const DRAG_THRESHOLD = 8;
  let outsideGesture = null;

  function isMobileViewport() {
    return (window.innerWidth || document.documentElement.clientWidth || 0) <= MOBILE_MAX;
  }

  function toolGeometry(instance = controller) {
    if (!instance.root?.isConnected) return null;
    const filter = instance.resolveToolAnchor?.("filters");
    const sort = instance.resolveToolAnchor?.("sort");
    const rootBox = instance.root.getBoundingClientRect?.();
    const filterBox = filter?.getBoundingClientRect?.();
    const sortBox = sort?.getBoundingClientRect?.();
    const viewport = window.innerWidth || document.documentElement.clientWidth;
    if (!rootBox || !filterBox || !sortBox || filterBox.width <= 0 || sortBox.width <= 0) return null;
    const width = Math.min(Math.max(0, sortBox.right - filterBox.left), rootBox.width, Math.max(0, viewport - 12));
    if (!(width > 0)) return null;
    const wanted = filterBox.left - rootBox.left;
    return {
      width,
      left: Math.min(Math.max(0, wanted), Math.max(0, rootBox.width - width)),
      top: Math.max(0, filterBox.bottom - rootBox.top + 7)
    };
  }

  const basePlaceTool = controller.placeTool;
  controller.placeTool = function placeToolWithMobileFilterAlignment(host, anchor, wide = false) {
    const result = basePlaceTool.call(this, host, anchor, wide);
    if (wide || !isMobileViewport() || !host?.classList?.contains("r34mf-tool-layer")) return result;
    const geometry = toolGeometry(this);
    if (!geometry) return result;
    host.style.setProperty("width", `${Math.round(geometry.width)}px`, "important");
    host.style.setProperty("--r34mf-filter-popover-width", `${Math.round(geometry.width)}px`);
    host.style.setProperty("left", `${Math.round(geometry.left)}px`, "important");
    host.style.setProperty("top", `${Math.round(geometry.top)}px`);
    return result;
  };

  function openTransientTool(instance = controller) {
    return instance.root?.querySelector?.(":scope > .r34mf-tool-layer, :scope > .r34mf-sort-surface") ?? null;
  }

  function isInsideToolOrTrigger(target) {
    return Boolean(target?.closest?.(".r34mf-tool-layer, .r34mf-sort-surface, [data-r34mf-action='filters'], [data-r34mf-action='sort']"));
  }

  function movedEnough(gesture, event) {
    const dx = Number(event.clientX ?? gesture.x) - gesture.x;
    const dy = Number(event.clientY ?? gesture.y) - gesture.y;
    return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
  }

  const basePointerDown = controller.onDocumentPointerDown;
  controller.onDocumentPointerDown = function gestureAwareOutsidePointerDown(event) {
    // Preserve the established immediate desktop dismissal behavior. The delayed
    // pointerup decision exists only to distinguish a phone swipe from a tap.
    if (!isMobileViewport()) return basePointerDown.call(this, event);
    if (this.filterModal || event.target.closest?.(".r34mf-modal-layer")) return;
    if (!openTransientTool(this) || !this.root?.isConnected || (this.filterView?.view && this.filterView.view !== "parent")) {
      return basePointerDown.call(this, event);
    }
    if (isInsideToolOrTrigger(event.target)) return;

    // Delay outside dismissal until pointerup. A finger drag must remain a normal
    // page/menu scroll gesture instead of closing Filters/Sort on touch-down.
    outsideGesture = {
      pointerId: event.pointerId,
      x: Number(event.clientX) || 0,
      y: Number(event.clientY) || 0,
      moved: false
    };
  };

  function onPointerMove(event) {
    if (!outsideGesture || event.pointerId !== outsideGesture.pointerId) return;
    if (movedEnough(outsideGesture, event)) outsideGesture.moved = true;
  }

  function onPointerUp(event) {
    if (!outsideGesture || event.pointerId !== outsideGesture.pointerId) return;
    const gesture = outsideGesture;
    outsideGesture = null;
    if (gesture.moved || movedEnough(gesture, event) || isInsideToolOrTrigger(event.target)) return;
    controller.closeFilters?.();
    controller.closeSort?.();
  }

  function onPointerCancel(event) {
    if (outsideGesture && event.pointerId === outsideGesture.pointerId) outsideGesture = null;
  }

  const baseBindLifecycle = controller.bindLifecycle;
  controller.bindLifecycle = function bindLifecycleWithTouchDismissal() {
    baseBindLifecycle.call(this);
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerup", onPointerUp, { passive: true });
    document.addEventListener("pointercancel", onPointerCancel, { passive: true });
  };

  const baseUnbindLifecycle = controller.unbindLifecycle;
  controller.unbindLifecycle = function unbindLifecycleWithTouchDismissal() {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerCancel);
    outsideGesture = null;
    return baseUnbindLifecycle.call(this);
  };

  app.modules.filterTouchFollowupController = Object.freeze({
    MOBILE_MAX,
    DRAG_THRESHOLD,
    isMobileViewport,
    toolGeometry,
    movedEnough
  });
})();
