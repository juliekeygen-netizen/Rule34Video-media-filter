(() => {
  "use strict";

  if (globalThis.R34MF) {
    return;
  }

  Object.defineProperty(globalThis, "R34MF", {
    value: {
      version: "0.1.0",
      modules: Object.create(null),
      runtime: Object.create(null)
    },
    configurable: false,
    enumerable: false,
    writable: false
  });
})();
