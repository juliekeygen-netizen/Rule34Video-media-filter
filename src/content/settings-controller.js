(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const settingsUi = app?.modules.settingsUi;
  if (!app || !controller || !settingsUi) {
    throw new Error("R34MF subscriptions controller and Settings UI must load before Settings integration.");
  }

  // TEMPORARY DEVELOPMENT ESCAPE HATCH.
  // Set this to false (or remove the emergency-reset helpers below) once device
  // storage testing is finished.
  const ENABLE_EMERGENCY_STORAGE_RESET = true;
  const EMERGENCY_RESET_HOLD_MS = 650;
  const EMERGENCY_RESET_MOVE_CANCEL_PX = 14;
  let emergencyResetInProgress = false;

  function clearStorageArea(name) {
    const browserApi = app.modules.browserApi;
    const area = browserApi?.storage?.[name];
    if (!area?.clear) return Promise.resolve();

    // Firefox's browser.* API is promise-native. Chromium accepts callbacks and
    // this branch also works in Chromium-based Android extension browsers.
    if (globalThis.browser?.storage) return Promise.resolve(area.clear());
    return new Promise((resolve, reject) => {
      try {
        area.clear(() => {
          const error = browserApi?.runtime?.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function clearExtensionDatabase() {
    const dbModule = app.modules.db;
    if (!dbModule?.open) return;
    const database = await dbModule.open();
    const storeNames = [...database.objectStoreNames];
    if (!storeNames.length) return;
    const transaction = database.transaction(storeNames, "readwrite");
    for (const name of storeNames) transaction.objectStore(name).clear();
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Extension database reset was aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Extension database reset failed."));
    });
    dbModule.invalidateCatalogueOrder?.();
  }

  async function stopRuntimeWork() {
    const jobs = app.modules.jobManager;
    if (!jobs?.snapshot) return;
    jobs.setAcceptingEnabled?.(false);
    jobs.setExecutionEnabled?.(false);
    const snapshot = jobs.snapshot();
    for (const job of snapshot.active ?? []) jobs.stop?.(job.id);
    for (const job of snapshot.waiting ?? []) jobs.remove?.(job.id);

    // Give abort-aware workers a brief chance to unwind before stores are cleared.
    const startedAt = Date.now();
    while ((jobs.snapshot().active?.length ?? 0) && Date.now() - startedAt < 1200) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    }
  }

  async function runEmergencyStorageReset(trigger = null) {
    if (!ENABLE_EMERGENCY_STORAGE_RESET || emergencyResetInProgress) return false;
    const first = globalThis.confirm?.(
      "Erase ALL Rule34Video Media Filter data on this browser?\n\nThis deletes the local catalogue, detailed metadata, settings, filters, Seen/Favorites, Queue state, Cloud connection and saved automatic sign-in credentials.\n\nRule34Video cookies, subscriptions and other site data are NOT changed."
    );
    if (!first) return false;
    const second = globalThis.confirm?.(
      "Final confirmation: wipe this extension's local data now?\n\nOnly continue if you have a backup/Cloud copy you want to restore afterward."
    );
    if (!second) return false;

    emergencyResetInProgress = true;
    if (trigger) trigger.disabled = true;
    try {
      settingsUi.close?.({ returnFocus: false, force: true });
      await stopRuntimeWork();
      await clearExtensionDatabase();
      // Keep this device-local: do not touch any browser-account sync area.
      await clearStorageArea("session");
      await clearStorageArea("local");
      globalThis.alert?.("Rule34Video Media Filter data was cleared from this browser. The page will reload now.");
      globalThis.location?.reload?.();
      return true;
    } catch (error) {
      emergencyResetInProgress = false;
      if (trigger) trigger.disabled = false;
      globalThis.alert?.(`Could not completely reset extension data: ${error?.message ?? error}`);
      return false;
    }
  }

  function bindEmergencyReset(button) {
    if (!ENABLE_EMERGENCY_STORAGE_RESET || !button || button.dataset.r34mfEmergencyResetBound === "true") return;
    button.dataset.r34mfEmergencyResetBound = "true";

    let holdTimer = null;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let suppressClickUntil = 0;
    let lastTriggeredAt = 0;

    const cancelHold = () => {
      if (holdTimer !== null) globalThis.clearTimeout(holdTimer);
      holdTimer = null;
      pointerId = null;
    };

    const triggerReset = (event = null) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const now = Date.now();
      if (now - lastTriggeredAt < 1200) return;
      lastTriggeredAt = now;
      suppressClickUntil = now + 1200;
      cancelHold();
      void runEmergencyStorageReset(button);
    };

    button.addEventListener("contextmenu", triggerReset);
    button.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" || event.isPrimary === false) return;
      cancelHold();
      pointerId = event.pointerId;
      startX = Number(event.clientX);
      startY = Number(event.clientY);
      holdTimer = globalThis.setTimeout(() => triggerReset(), EMERGENCY_RESET_HOLD_MS);
    }, { passive: true });
    button.addEventListener("pointermove", (event) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      if (Math.abs(Number(event.clientX) - startX) > EMERGENCY_RESET_MOVE_CANCEL_PX
        || Math.abs(Number(event.clientY) - startY) > EMERGENCY_RESET_MOVE_CANCEL_PX) cancelHold();
    }, { passive: true });
    button.addEventListener("pointerup", cancelHold, { passive: true });
    button.addEventListener("pointercancel", cancelHold, { passive: true });
    button.addEventListener("click", (event) => {
      if (Date.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  function enableSettingsButton(instance) {
    const button = instance?.root?.querySelector?.("[data-r34mf-action='settings']");
    if (!button) return;
    button.disabled = false;
    button.removeAttribute("aria-disabled");
    bindEmergencyReset(button);
  }

  const originalUpdateShell = controller.updateShell;
  controller.updateShell = function (...args) {
    const result = originalUpdateShell.apply(this, args);
    enableSettingsButton(this);
    return result;
  };

  const originalHandleIntent = controller.handleIntent;
  controller.handleIntent = async function (action, trigger) {
    if (action !== "settings") return originalHandleIntent.call(this, action, trigger);

    this.closeFilters?.();
    this.closeSort?.();
    // Settings is an overlay, not a Queue navigation action. Keep an open Queue
    // mounted underneath so opening Settings does not flash/close the drawer or
    // discard its current subpage/scroll state.

    await settingsUi.open({
      returnFocus: trigger,
      onSaved: async () => {
        app.modules.jobManager?.pump?.();
        await this.refreshCatalogueState?.();
        await this.maybeAutoUpdateRecentVideos?.();
        if (this.state?.mode === "local") await this.renderLocal?.();
        this.updateShell?.();
      },
      onDataChanged: async () => {
        await this.restoreState?.();
        await this.refreshCatalogueState?.();
        if (this.state?.catalogue?.catalogueReady !== true && this.state?.mode === "local") {
          await this.setUiState?.({ mode: "native", localPage: 1 });
        } else if (this.state?.mode === "local") {
          await this.renderLocal?.();
        }
        this.renderQueue?.();
        this.updateShell?.();
      }
    });
    return undefined;
  };

  const originalUnmount = controller.unmount;
  controller.unmount = function (...args) {
    settingsUi.close({ returnFocus: false, force: true });
    return originalUnmount.apply(this, args);
  };

  app.modules.settingsController = Object.freeze({
    enableSettingsButton,
    bindEmergencyReset,
    runEmergencyStorageReset,
    ENABLE_EMERGENCY_STORAGE_RESET,
    EMERGENCY_RESET_HOLD_MS
  });
})();
