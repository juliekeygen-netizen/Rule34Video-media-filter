(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const manager = app?.modules.jobManager;
  const db = app?.modules.db;
  const maintenanceController = app?.modules.maintenanceController;
  if (!app || !controller || !manager || !db || !maintenanceController) {
    throw new Error("R34MF detail runtime must load before rate-limit auto-resume support.");
  }

  const DETAIL_KINDS = maintenanceController.DETAIL_KINDS;
  const AUTO_RESUME_DELAYS_MS = Object.freeze([60_000, 120_000, 180_000]);
  const MODE_BY_KIND = Object.freeze({
    "detail-enrichment": "missing",
    "detail-retry-failed": "failed",
    "detail-retry-failed-refreshes": "refreshFailed",
    "detail-refresh": "refresh",
    "detail-repair-outdated": "outdated"
  });
  const DETAIL_START_ACTIONS = new Set([
    "details-fetch",
    "maintenance-retry-failed-details",
    "maintenance-retry-failed-refreshes",
    "maintenance-refresh-details",
    "maintenance-repair-outdated-details"
  ]);

  let timer = null;
  let scheduled = null;
  let rateLimitStreak = 0;
  let lastTerminalJobId = null;
  let unsubscribe = null;

  function delayForStreak(streak) {
    const index = Math.min(AUTO_RESUME_DELAYS_MS.length - 1, Math.max(0, Number(streak) - 1));
    return AUTO_RESUME_DELAYS_MS[index];
  }

  function modeForJob(job) {
    const mode = job?.result?.detailsState?.mode ?? job?.progress?.detailMode ?? MODE_BY_KIND[job?.kind];
    return ["missing", "failed", "refreshFailed", "refresh", "outdated"].includes(mode) ? mode : "missing";
  }

  function isRateLimitPause(job) {
    if (!DETAIL_KINDS?.has?.(job?.kind) || job?.state !== "stopped") return false;
    const detailsState = job?.result?.detailsState;
    const code = job?.error?.code ?? detailsState?.lastError?.code ?? job?.result?.lastError?.code;
    return detailsState?.status === "paused" && code === "http-429";
  }

  function canAutoResumeHere() {
    if (!controller.started) return false;
    const siteRuntime = app.modules.siteQueueRuntime;
    if (siteRuntime?.isOwner) return siteRuntime.isOwner() === true;
    // Preserve the pre-site-wide behavior for isolated/test runtimes that do not
    // load the executor module. Production pages always use the elected owner.
    return controller.mounted === true && controller.phase10PageHidden !== true && controller.root?.isConnected === true;
  }

  function clearTimerOnly() {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    scheduled = null;
  }

  function clearNotice(instance = controller) {
    const notice = String(instance?.state?.queueNotice ?? "");
    if (!notice.startsWith("Rule34Video rate limit hit.") && !notice.startsWith("Rate-limit cooldown elapsed.")) return;
    instance.state = { ...instance.state, queueNotice: null };
    instance.updateShell?.();
  }

  function clearScheduled({ resetStreak = false, clearQueueNotice = false } = {}) {
    clearTimerOnly();
    if (resetStreak) rateLimitStreak = 0;
    if (clearQueueNotice) clearNotice();
  }

  function schedule(job, { remainingMs = null } = {}) {
    if (!isRateLimitPause(job)) return false;
    clearTimerOnly();
    rateLimitStreak += 1;
    const defaultDelay = delayForStreak(rateLimitStreak);
    const hasRemaining = remainingMs !== null && remainingMs !== undefined && Number.isFinite(Number(remainingMs));
    const delayMs = hasRemaining
      ? Math.max(0, Math.min(defaultDelay, Number(remainingMs)))
      : defaultDelay;
    const minutes = Math.max(1, Math.round(delayMs / 60_000));
    const plan = {
      jobId: job.id,
      mode: modeForJob(job),
      delayMs,
      resumeAt: Date.now() + delayMs
    };
    scheduled = plan;
    controller.state = {
      ...controller.state,
      queueNotice: `Rule34Video rate limit hit. Detailed metadata will auto-resume in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`
    };
    controller.updateShell?.();
    app.modules.logger?.debug?.("detail-rate-limit-auto-resume-scheduled", {
      mode: plan.mode,
      delayMs,
      streak: rateLimitStreak,
      jobId: plan.jobId,
      siteWide: app.modules.siteQueueRuntime?.isOwner?.() === true
    });
    timer = globalThis.setTimeout(() => {
      timer = null;
      attemptAutoResume(plan).catch((error) => {
        app.modules.logger?.warn?.("detail-rate-limit-auto-resume-failed", { message: error?.message ?? String(error) });
      });
    }, delayMs);
    return true;
  }

  async function attemptAutoResume(plan = scheduled) {
    if (!plan || !scheduled || plan.jobId !== scheduled.jobId) return false;
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    scheduled = null;

    if (!canAutoResumeHere()) return false;

    const catalogue = await db.getCatalogueState();
    const detailsState = catalogue?.detailsState ?? {};
    if (detailsState.status !== "paused" || detailsState.lastError?.code !== "http-429") {
      return false;
    }

    const runtime = manager.snapshot();
    if ([...(runtime.active ?? []), ...(runtime.waiting ?? [])].some((job) => DETAIL_KINDS.has(job.kind))) {
      return false;
    }

    const mode = ["missing", "failed", "refreshFailed", "refresh", "outdated"].includes(detailsState.mode)
      ? detailsState.mode
      : plan.mode;
    const outcome = controller.enqueueDetails({ automatic: true, mode });
    if (outcome?.accepted !== true) {
      app.modules.logger?.debug?.("detail-rate-limit-auto-resume-skipped", { mode, reason: outcome?.reason ?? "unknown" });
      return false;
    }

    controller.state = {
      ...controller.state,
      queueNotice: "Rate-limit cooldown elapsed. Detailed metadata resumed automatically."
    };
    controller.updateShell?.();
    app.modules.logger?.debug?.("detail-rate-limit-auto-resumed", { mode, previousJobId: plan.jobId, siteWide: Boolean(app.modules.siteQueueRuntime) });
    return true;
  }

  async function restorePaused() {
    if (scheduled || !canAutoResumeHere()) return false;
    const catalogue = await db.getCatalogueState();
    const detailsState = catalogue?.detailsState ?? {};
    if (detailsState.status !== "paused" || detailsState.lastError?.code !== "http-429") return false;
    if (allDetailWorkPresent()) return false;
    const mode = ["missing", "failed", "refreshFailed", "refresh", "outdated"].includes(detailsState.mode)
      ? detailsState.mode
      : "missing";
    const kind = Object.entries(MODE_BY_KIND).find(([, value]) => value === mode)?.[0] ?? "detail-enrichment";
    const synthetic = {
      id: `rate-limit-recovery-${Number(detailsState.lastProgressAt) || Number(detailsState.startedAt) || Date.now()}`,
      kind,
      state: "stopped",
      progress: { detailMode: mode },
      result: { detailsState }
    };
    return schedule(synthetic);
  }

  function allDetailWorkPresent() {
    const runtime = manager.snapshot();
    return [...(runtime.active ?? []), ...(runtime.waiting ?? [])].some((job) => DETAIL_KINDS.has(job.kind));
  }

  function handleSnapshot(snapshot) {
    const latest = (snapshot?.recent ?? []).find((job) => DETAIL_KINDS.has(job.kind));
    if (!latest || latest.id === lastTerminalJobId) return;
    lastTerminalJobId = latest.id;

    if (isRateLimitPause(latest)) {
      schedule(latest);
      return;
    }

    if (["complete", "failed", "stopped"].includes(latest.state)) {
      clearScheduled({ resetStreak: true, clearQueueNotice: true });
    }
  }

  const baseStart = controller.start;
  controller.start = async function start(...args) {
    const result = await baseStart.apply(this, args);
    if (!unsubscribe) {
      unsubscribe = manager.subscribe(handleSnapshot);
      handleSnapshot(manager.snapshot());
    }
    if (app.modules.siteQueueRuntime?.isOwner?.() === true) restorePaused().catch(() => {});
    return result;
  };

  const baseHandleIntent = controller.handleIntent;
  controller.handleIntent = async function handleIntent(action, trigger) {
    if (action === "details-resume") {
      clearScheduled({ clearQueueNotice: true });
    } else if (action === "details-cancel") {
      clearScheduled({ resetStreak: true, clearQueueNotice: true });
    } else if (DETAIL_START_ACTIONS.has(action)) {
      clearScheduled({ resetStreak: true, clearQueueNotice: true });
    }
    return baseHandleIntent.call(this, action, trigger);
  };

  const baseCleanup = controller.cleanup;
  controller.cleanup = function cleanup(...args) {
    clearScheduled({ resetStreak: true, clearQueueNotice: false });
    unsubscribe?.();
    unsubscribe = null;
    lastTerminalJobId = null;
    return baseCleanup.apply(this, args);
  };

  app.modules.detailRateLimitRecovery = Object.freeze({
    AUTO_RESUME_DELAYS_MS,
    delayForStreak,
    modeForJob,
    isRateLimitPause,
    canAutoResumeHere,
    schedule,
    attemptAutoResume,
    restorePaused,
    clearScheduled,
    snapshot: () => ({
      rateLimitStreak,
      lastTerminalJobId,
      scheduled: scheduled ? { ...scheduled } : null
    })
  });
})();
