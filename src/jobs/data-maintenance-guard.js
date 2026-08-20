(() => {
  "use strict";

  const app = globalThis.R34MF;
  const manager = app?.modules.jobManager;
  const lock = app?.modules.dataOperationLock;
  if (!app || !manager || !lock) {
    throw new Error("R34MF JobManager and data-operation lock must load before the data-maintenance guard.");
  }

  function enqueue(input) {
    if (lock.isBusy()) {
      return {
        accepted: false,
        reason: "data-operation-busy",
        job: null,
        operation: lock.snapshot()
      };
    }
    return manager.enqueue(input);
  }

  app.modules.jobManager = Object.freeze({ ...manager, enqueue });
  app.modules.dataMaintenanceGuard = Object.freeze({
    enqueue,
    isDataOperationBusy: lock.isBusy,
    snapshot: lock.snapshot
  });
})();
