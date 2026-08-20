(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.settingsUi;
  if (!app || !base) throw new Error("R34MF Settings UI must load before retry-cap polish.");

  let observer = null;
  let observedLayer = null;

  function patch(layer) {
    if (!layer?.isConnected) return;
    const input = layer.querySelector?.("input[type='number'][aria-label='Maximum automatic retries']");
    if (input && input.max !== "100") input.max = "100";
  }

  function observe(layer) {
    if (!layer || typeof MutationObserver !== "function") {
      patch(layer);
      return;
    }
    if (observedLayer === layer && observer) {
      patch(layer);
      return;
    }
    observer?.disconnect?.();
    observer = new MutationObserver(() => patch(layer));
    observer.observe(layer, { childList: true, subtree: true });
    observedLayer = layer;
    patch(layer);
  }

  async function open(options) {
    const layer = await base.open(options);
    observe(layer);
    return layer;
  }

  function close(options) {
    observer?.disconnect?.();
    observer = null;
    observedLayer = null;
    return base.close(options);
  }

  app.modules.settingsUi = Object.freeze({ ...base, open, close, patchRetryMaximum: patch });
})();
