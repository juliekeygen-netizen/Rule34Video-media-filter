(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.filterModals;
  if (!app || !base) {
    throw new Error("R34MF filter modals must load before modal polish.");
  }

  function render(state, send) {
    return base.render(state, send);
  }

  app.modules.filterModals = Object.freeze({
    ...base,
    render
  });
})();
