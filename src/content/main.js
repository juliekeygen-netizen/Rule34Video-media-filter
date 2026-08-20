(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) {
    return;
  }

  async function init() {
    const controller = app.modules.subscriptionsController;
    if (!controller) {
      return;
    }

    await app.modules.settings.load();
    await app.modules.siteQueueRuntime?.start?.();

    app.runtime.startedAt = Date.now();
    await controller.start();

    app.modules.logger?.debug("extension-scaffold-ready", {
      version: app.version,
      build: app.build?.id ?? "dev",
      browser: app.build?.browser ?? "unknown",
      queueOwner: app.modules.siteQueueRuntime?.isOwner?.() === true
    });
  }

  init().catch((error) => {
    app.modules.logger?.warn("extension-init-failed", {
      message: error?.message ?? String(error),
      stack: error?.stack
    });
  });
})();
