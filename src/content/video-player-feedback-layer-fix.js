(() => {
  "use strict";

  const app = globalThis.R34MF;
  const settings = app?.modules.settings;
  if (!app || !settings) throw new Error("R34MF settings must load before player seek-feedback layering.");

  const LAYER_CLASS = "r34mf-player-skip-feedback-layer";
  const SEEK_SECONDS = 10;
  const NATIVE_DBLCLICK_LEFT_EDGE = 0.45;
  const NATIVE_DBLCLICK_RIGHT_EDGE = 0.55;
  let unsubscribe = null;

  function enabled() {
    return settings.value?.improvedPlayerPlaybackControls !== false;
  }

  function playerRootFromNode(node) {
    return node?.closest?.("#kt_player, .kt-player") ?? null;
  }

  function styleLayer(layer) {
    const set = (property, value) => layer.style.setProperty(property, value, "important");
    set("position", "absolute");
    set("inset", "0");
    set("width", "100%");
    set("height", "100%");
    set("display", "block");
    set("visibility", "visible");
    set("opacity", "1");
    set("pointer-events", "none");
    set("transform", "none");
    set("transition", "none");
    set("z-index", "50");
  }

  function feedbackLayer(root) {
    if (!root) return null;
    const ui = root.querySelector?.(".fp-player .fp-ui, .fp-ui") ?? null;
    if (!ui) return root;

    let layer = ui.querySelector?.(`:scope > .${LAYER_CLASS}`) ?? null;
    if (!layer) {
      layer = document.createElement("div");
      layer.className = LAYER_CLASS;
      layer.dataset.r34mfOwned = "true";
      layer.setAttribute("aria-hidden", "true");
      ui.append(layer);
    }
    styleLayer(layer);
    return layer;
  }

  function createFeedbackNode(delta) {
    const back = delta < 0;
    const node = document.createElement("div");
    node.className = `r34mf-player-skip-feedback ${back ? "is-back" : "is-forward"}`;
    node.dataset.r34mfOwned = "true";
    node.setAttribute("aria-hidden", "true");

    const arrows = document.createElement("div");
    arrows.className = "r34mf-player-skip-feedback-icon";
    arrows.textContent = back ? "◀◀" : "▶▶";

    const label = document.createElement("div");
    label.className = "r34mf-player-skip-feedback-label";
    label.textContent = `${SEEK_SECONDS}s`;

    node.append(arrows, label);
    return node;
  }

  function ensureFeedbackNode(root, delta) {
    if (!root || !enabled()) return null;
    const layer = feedbackLayer(root);
    if (!layer) return null;

    const side = delta < 0 ? "is-back" : "is-forward";
    let node = layer.querySelector?.(`:scope > .r34mf-player-skip-feedback.${side}`) ?? null;
    if (node) return node;

    // If an earlier player-control pass created the node on the outer player root,
    // move that same node into Flowplayer's visible UI overlay rather than creating
    // a duplicate. The base control module will then find and animate it normally.
    const existing = root.querySelector?.(`.r34mf-player-skip-feedback.${side}`) ?? null;
    if (existing && existing !== layer && !layer.contains(existing)) {
      layer.append(existing);
      return existing;
    }

    node = createFeedbackNode(delta);
    layer.append(node);
    return node;
  }

  function nativeDoubleClickDirection(root, event) {
    if (!root || !event) return 0;
    const target = event.target;
    if (target?.closest?.(".fp-controls, .r34mf-player-skip-controls")) return 0;
    const rect = root.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0)) return 0;
    const ratio = (Number(event.clientX) - rect.left) / rect.width;
    if (ratio <= NATIVE_DBLCLICK_LEFT_EDGE) return -SEEK_SECONDS;
    if (ratio >= NATIVE_DBLCLICK_RIGHT_EDGE) return SEEK_SECONDS;
    return 0;
  }

  function onClickCapture(event) {
    if (!enabled()) return;
    const button = event.target?.closest?.(".r34mf-player-skip-button");
    if (!button) return;
    const root = playerRootFromNode(button);
    if (!root) return;
    ensureFeedbackNode(root, button.classList.contains("is-back") ? -SEEK_SECONDS : SEEK_SECONDS);
  }

  function onDoubleClickCapture(event) {
    if (!enabled()) return;
    const root = playerRootFromNode(event.target);
    if (!root) return;
    const delta = nativeDoubleClickDirection(root, event);
    if (delta) ensureFeedbackNode(root, delta);
  }

  function cleanup() {
    document.querySelectorAll(`.${LAYER_CLASS}`).forEach((layer) => layer.remove());
  }

  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("dblclick", onDoubleClickCapture, true);
  unsubscribe = settings.subscribe?.((current, previous) => {
    if (current?.improvedPlayerPlaybackControls === previous?.improvedPlayerPlaybackControls) return;
    if (current?.improvedPlayerPlaybackControls === false) cleanup();
  }) ?? null;

  app.modules.videoPlayerFeedbackLayerFix = Object.freeze({
    feedbackLayer,
    ensureFeedbackNode,
    nativeDoubleClickDirection,
    cleanup,
    stop() {
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("dblclick", onDoubleClickCapture, true);
      unsubscribe?.();
      unsubscribe = null;
      cleanup();
    }
  });
})();
