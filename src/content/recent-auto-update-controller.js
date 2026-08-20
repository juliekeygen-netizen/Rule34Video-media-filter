(() => {
  "use strict";
  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const browserApi = app?.modules.browserApi;
  const manager = app?.modules.jobManager;
  const settings = app?.modules.settings;
  const dataLock = app?.modules.dataOperationLock;
  if (!app || !controller || !browserApi || !manager || !settings || !dataLock) throw new Error("R34MF recent-update dependencies must load first.");

  const AUTO_REENTRY_RETRY_MS = 30_000;
  const AUTO_START_DELAY_MS = 1400;
  const AUTO_IDLE_TIMEOUT_MS = 3000;
  const AUTO_RUNTIME_RETRY_MS = 900;
  const AUTO_COOLDOWN_GRACE_MS = 350;
  let automaticAttemptedThisPage = false;
  let hiddenAt = null;
  let automaticTimer = null;
  let automaticIdleHandle = null;

  function automaticFrequency() {
    return String(settings.value.autoUpdateRecentVideosFrequency ?? "session");
  }

  function automaticIntervalMs() {
    return Math.max(0, Number(settings.autoUpdateRecentIntervalMs?.(automaticFrequency())) || 0);
  }

  async function claim() {
    try {
      return await browserApi.runtimeSendMessage({
        type: "r34mf:auto-recent-claim",
        frequency: automaticFrequency()
      });
    } catch {
      return { claimed: false };
    }
  }

  async function complete() {
    try {
      return await browserApi.runtimeSendMessage({
        type: "r34mf:auto-recent-complete",
        frequency: automaticFrequency()
      });
    } catch {
      return { completed: false };
    }
  }

  async function release() {
    try { await browserApi.runtimeSendMessage({ type: "r34mf:auto-recent-release" }); }
    catch { /* stale in-progress claims expire in the background runtime */ }
  }

  function matchingUpdateJob() {
    const runtime = manager.snapshot();
    return [...runtime.active, ...runtime.waiting].find((job) => job.kind === "smart-update") ?? null;
  }

  function queueRuntimeReady() {
    const runtime = app.modules.siteQueueRuntime;
    if (!runtime) return true;
    const snapshot = runtime.snapshot?.();
    return runtime.isOwner?.() === true && snapshot?.executionReady === true;
  }

  function clearAutomaticSchedule() {
    if (automaticTimer !== null) globalThis.clearTimeout?.(automaticTimer);
    automaticTimer = null;
    if (automaticIdleHandle !== null && typeof globalThis.cancelIdleCallback === "function") {
      globalThis.cancelIdleCallback(automaticIdleHandle);
    }
    automaticIdleHandle = null;
  }

  function scheduleAutomaticAttempt(instance = controller, { delay = AUTO_START_DELAY_MS } = {}) {
    if (automaticAttemptedThisPage || settings.value.autoUpdateRecentVideos !== true) return;
    clearAutomaticSchedule();
    automaticTimer = globalThis.setTimeout?.(() => {
      automaticTimer = null;
      if (automaticAttemptedThisPage || settings.value.autoUpdateRecentVideos !== true) return;
      if (!instance?.isTargetPage?.() || document.visibilityState === "hidden") return;
      if (!queueRuntimeReady()) {
        scheduleAutomaticAttempt(instance, { delay: AUTO_RUNTIME_RETRY_MS });
        return;
      }
      const run = () => {
        automaticIdleHandle = null;
        if (automaticAttemptedThisPage || settings.value.autoUpdateRecentVideos !== true) return;
        instance.maybeAutoUpdateRecentVideos?.().catch(() => {});
      };
      if (typeof globalThis.requestIdleCallback === "function") {
        automaticIdleHandle = globalThis.requestIdleCallback(run, { timeout: AUTO_IDLE_TIMEOUT_MS });
      } else {
        queueMicrotask(run);
      }
    }, Math.max(0, Number(delay) || 0)) ?? null;
  }

  function scheduleFromCooldown(instance, retryAfterMs) {
    const delay = Math.max(1000, Number(retryAfterMs) || 0) + AUTO_COOLDOWN_GRACE_MS;
    scheduleAutomaticAttempt(instance, { delay });
  }

  async function runRecentJob(instance, context, automatic) {
    try {
      const result = await instance.runCatalogueJob("smart-update", context, { updateMode: "recent" });
      if (automatic) {
        if (result?.smartUpdate?.status === "complete") {
          const completion = await complete();
          const intervalMs = automaticIntervalMs();
          if (intervalMs > 0) {
            // Hour-based modes are repeatable while the page stays open. The
            // background owns the durable timestamp; this timer is only the next
            // opportunity to ask it again.
            automaticAttemptedThisPage = false;
            scheduleFromCooldown(instance, Number(completion?.retryAfterMs) || intervalMs);
          }
        } else {
          await release();
        }
      }
      return result;
    } catch (error) {
      if (automatic) await release();
      throw error;
    }
  }

  async function enqueueRecentUpdate(instance, { automatic = false } = {}) {
    if (!instance?.isTargetPage?.() || instance.state.catalogue?.catalogueReady !== true) {
      app.modules.logger?.debug?.("recent-update-decision", { automatic, decision: "catalogue-unavailable" });
      return { accepted: false, reason: "catalogue-unavailable" };
    }
    if (automatic && !queueRuntimeReady()) {
      app.modules.logger?.debug?.("recent-update-decision", { automatic, decision: "queue-runtime-not-ready" });
      return { accepted: false, reason: "queue-runtime-not-ready" };
    }
    if (dataLock.isBusy()) {
      app.modules.logger?.debug?.("recent-update-decision", { automatic, decision: "data-operation-busy" });
      return { accepted: false, reason: "data-operation-busy" };
    }
    const existing = matchingUpdateJob();
    if (existing) {
      app.modules.logger?.debug?.("recent-update-decision", { automatic, decision: "duplicate", existingId: existing.id });
      return { accepted: false, reason: "duplicate", job: existing };
    }
    if (automatic && automaticAttemptedThisPage) {
      app.modules.logger?.debug?.("recent-update-decision", { automatic, decision: "page-already-attempted" });
      return { accepted: false, reason: "page-already-attempted" };
    }

    let claimed = false;
    if (automatic) {
      const session = await claim();
      if (!session?.claimed) {
        const cooldown = session?.status === "cooldown" && Number(session?.retryAfterMs) > 0;
        if (cooldown) scheduleFromCooldown(instance, session.retryAfterMs);
        const reason = cooldown ? "frequency-not-due" : "session-already-checked";
        app.modules.logger?.debug?.("recent-update-decision", {
          automatic,
          decision: reason,
          status: session?.status ?? null,
          frequency: automaticFrequency(),
          retryAfterMs: Number(session?.retryAfterMs) || null
        });
        return { accepted: false, reason, retryAfterMs: Number(session?.retryAfterMs) || 0 };
      }
      claimed = true;
      automaticAttemptedThisPage = true;
    }

    const outcome = manager.enqueue({
      kind: "smart-update",
      scopeKey: "smart-update",
      resourceKeys: ["catalogue-write"],
      progress: { updateMode: "recent", completed: 0, pagesChecked: 0 },
      handler: (_job, context) => runRecentJob(instance, context, automatic)
    });

    if (claimed && !outcome?.accepted) await release();
    app.modules.logger?.debug?.("recent-update-decision", { automatic, decision: outcome?.accepted ? "enqueued" : "skipped", reason: outcome?.reason ?? null });
    return outcome ?? { accepted: false, reason: "enqueue-failed" };
  }

  controller.maybeAutoUpdateRecentVideos = async function () {
    if (settings.value.autoUpdateRecentVideos !== true) return false;
    const outcome = await enqueueRecentUpdate(this, { automatic: true });
    return outcome?.accepted === true || ["duplicate", "covered", "session-already-checked", "page-already-attempted", "frequency-not-due"].includes(outcome?.reason);
  };

  controller.startRecentUpdateTest = async function () {
    this.queueOpen = true;
    this.queuePage = "catalogue";
    this.state = { ...this.state, queueOpen: true, queueNotice: null };
    this.updateShell?.();
    this.renderQueue?.();
    const outcome = await enqueueRecentUpdate(this, { automatic: false });
    const notice = outcome?.accepted
      ? "Recent Update test started."
      : outcome?.reason === "data-operation-busy"
        ? "A Settings data operation is currently running."
        : outcome?.reason === "catalogue-unavailable"
          ? "A completed Local catalogue is required before Recent Update."
          : "An update is already queued or running.";
    this.state = { ...this.state, queueOpen: true, queueNotice: outcome?.accepted ? null : notice };
    this.updateShell?.();
    this.renderQueue?.();
    return outcome;
  };

  const baseHandleIntent = controller.handleIntent;
  controller.handleIntent = async function (action, trigger) {
    if (action === "smart-update-recent-test") return this.startRecentUpdateTest(trigger);
    return baseHandleIntent.call(this, action, trigger);
  };

  const baseOnCatalogueState = controller.onCatalogueState;
  controller.onCatalogueState = function (catalogue) {
    const result = baseOnCatalogueState.call(this, catalogue);
    if (catalogue?.catalogueReady === true && settings.value.autoUpdateRecentVideos === true && !automaticAttemptedThisPage) {
      scheduleAutomaticAttempt(this);
    }
    return result;
  };

  const baseRenderQueue = controller.renderQueue;
  controller.renderQueue = function (...args) {
    const result = baseRenderQueue.apply(this, args);
    this.root?.querySelectorAll?.("[data-r34mf-action='smart-update']").forEach((button) => {
      button.title = "Right-click to test Recent Update";
    });
    return result;
  };

  function retryAutomaticAfterReentry() {
    automaticAttemptedThisPage = false;
    scheduleAutomaticAttempt(controller, { delay: 450 });
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      clearAutomaticSchedule();
      return;
    }
    const awayFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (awayFor >= AUTO_REENTRY_RETRY_MS) retryAutomaticAfterReentry();
    else if (!automaticAttemptedThisPage) scheduleAutomaticAttempt(controller, { delay: 450 });
  }

  function onPageShow(event) {
    if (event?.persisted === true) retryAutomaticAfterReentry();
  }

  function onContextMenu(event) {
    const button = event.target?.closest?.("[data-r34mf-action='smart-update']");
    if (!button || button.disabled || !controller.root?.contains?.(button)) return;
    event.preventDefault();
    controller.handleIntent("smart-update-recent-test", button).catch((error) => {
      app.modules.logger?.warn("recent-update-test-start-failed", { message: error?.message ?? String(error) });
    });
  }

  settings.subscribe((current, previous) => {
    const enabledChanged = current?.autoUpdateRecentVideos !== previous?.autoUpdateRecentVideos;
    const frequencyChanged = current?.autoUpdateRecentVideosFrequency !== previous?.autoUpdateRecentVideosFrequency;
    if (!enabledChanged && !frequencyChanged) return;

    clearAutomaticSchedule();
    automaticAttemptedThisPage = false;
    if (current?.autoUpdateRecentVideos === true) {
      scheduleAutomaticAttempt(controller, { delay: 450 });
    }
  });

  const baseStart = controller.start;
  controller.start = async function (...args) {
    const result = await baseStart.apply(this, args);
    if (!this.__r34mfRecentContextBound) {
      document.addEventListener("contextmenu", onContextMenu, true);
      document.addEventListener("visibilitychange", onVisibilityChange, { passive: true });
      globalThis.addEventListener?.("pageshow", onPageShow, { passive: true });
      this.__r34mfRecentContextBound = true;
    }
    scheduleAutomaticAttempt(this);
    return result;
  };

  const baseCleanup = controller.cleanup;
  controller.cleanup = function (...args) {
    if (this.__r34mfRecentContextBound) {
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      globalThis.removeEventListener?.("pageshow", onPageShow);
      this.__r34mfRecentContextBound = false;
    }
    clearAutomaticSchedule();
    automaticAttemptedThisPage = false;
    hiddenAt = null;
    return baseCleanup.apply(this, args);
  };

  app.modules.recentAutoUpdateController = Object.freeze({
    claim,
    complete,
    release,
    runRecentJob,
    enqueueRecentUpdate,
    matchingUpdateJob,
    queueRuntimeReady,
    automaticFrequency,
    automaticIntervalMs,
    scheduleAutomaticAttempt,
    scheduleFromCooldown,
    clearAutomaticSchedule,
    onContextMenu,
    onVisibilityChange,
    onPageShow,
    retryAutomaticAfterReentry,
    AUTO_REENTRY_RETRY_MS,
    AUTO_START_DELAY_MS,
    AUTO_IDLE_TIMEOUT_MS,
    AUTO_COOLDOWN_GRACE_MS,
    attemptedThisPage: () => automaticAttemptedThisPage
  });
})();