(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before the data-operation lock.");

  let active = null;
  let serial = 0;

  function busyError(label = "data operation") {
    const error = new Error(`Another extension data operation is already running (${active?.label ?? label}).`);
    error.code = "data-operation-busy";
    return error;
  }

  function acquire(label = "data operation") {
    if (active) throw busyError(label);
    const token = Object.freeze({ id: `data-op-${Date.now()}-${++serial}`, label: String(label || "data operation"), startedAt: Date.now() });
    active = token;
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      if (active?.id === token.id) active = null;
      return true;
    };
  }

  async function runExclusive(label, work) {
    if (typeof work !== "function") throw new TypeError("A data-operation callback is required.");
    const release = acquire(label);
    try {
      return await work();
    } finally {
      release();
    }
  }

  app.modules.dataOperationLock = Object.freeze({
    acquire,
    runExclusive,
    isBusy: () => Boolean(active),
    snapshot: () => active ? { ...active } : null
  });
})();
