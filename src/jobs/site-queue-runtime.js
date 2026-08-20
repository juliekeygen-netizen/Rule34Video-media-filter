(() => {
  "use strict";

  const app = globalThis.R34MF;
  const browserApi = app?.modules.browserApi;
  const manager = app?.modules.jobManager;
  if (!app || !browserApi || !manager) {
    throw new Error("R34MF browser API and Job Manager must load before site-wide queue runtime.");
  }

  const CLAIM_RETRY_MS = 2000;
  const HEARTBEAT_MS = 2000;
  const token = globalThis.crypto?.randomUUID?.()
    ?? `queue-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const listeners = new Set();
  let started = false;
  let owner = false;
  let executionReady = false;
  let retryTimer = null;
  let heartbeatTimer = null;
  let claimPromise = null;

  // A fresh content runtime must never start restored work until it has proven
  // that this tab is the single queue executor and all job handlers are bound.
  manager.setExecutionEnabled(false);
  manager.setAcceptingEnabled(false);

  function emit() {
    const snapshot = publicState();
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  function publicState() {
    return Object.freeze({ started, owner, executionReady, token });
  }

  function clearRetry() {
    if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function clearHeartbeat() {
    if (heartbeatTimer !== null) globalThis.clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }

  function scheduleRetry() {
    clearRetry();
    if (!started || owner) return;
    retryTimer = globalThis.setTimeout(() => {
      retryTimer = null;
      claim().catch((error) => {
        app.modules.logger?.debug?.("queue-runtime-claim-retry-failed", { message: error?.message ?? String(error) });
        scheduleRetry();
      });
    }, CLAIM_RETRY_MS);
  }

  function scheduleHeartbeat() {
    clearHeartbeat();
    if (!started || !owner) return;
    heartbeatTimer = globalThis.setTimeout(() => {
      heartbeatTimer = null;
      heartbeat().catch((error) => {
        app.modules.logger?.debug?.("queue-runtime-heartbeat-failed", { message: error?.message ?? String(error) });
        loseOwnership("heartbeat-error");
      });
    }, HEARTBEAT_MS);
  }

  function applyGates() {
    manager.setAcceptingEnabled(owner);
    manager.setExecutionEnabled(owner && executionReady);
  }

  function loseOwnership(reason = "lost") {
    if (!owner) {
      applyGates();
      scheduleRetry();
      return;
    }
    // Save the active descriptors before aborting. Queue persistence deliberately
    // ignores the stop echoes after ownership has changed, so the successor can
    // reconstruct the same logical work rather than treating navigation as Cancel.
    app.modules.queuePersistence?.flush?.(manager.snapshot()).catch?.(() => {});
    owner = false;
    applyGates();
    for (const job of manager.snapshot().active ?? []) manager.stop(job.id);
    app.modules.logger?.debug?.("queue-runtime-ownership-lost", { reason });
    emit();
    scheduleRetry();
  }

  function gainOwnership() {
    if (owner) {
      scheduleHeartbeat();
      return;
    }
    owner = true;
    clearRetry();
    applyGates();
    app.modules.logger?.debug?.("queue-runtime-ownership-acquired", { path: globalThis.location?.pathname ?? null });
    emit();
    scheduleHeartbeat();
  }

  async function claim() {
    if (!started) return publicState();
    if (claimPromise) return claimPromise;
    claimPromise = browserApi.runtimeSendMessage({ type: "r34mf:queue-runtime-claim", token })
      .then((response) => {
        if (response?.claimed === true) gainOwnership();
        else {
          if (owner) loseOwnership("claim-denied");
          else scheduleRetry();
        }
        return publicState();
      })
      .finally(() => { claimPromise = null; });
    return claimPromise;
  }

  async function heartbeat() {
    if (!started || !owner) return publicState();
    const response = await browserApi.runtimeSendMessage({ type: "r34mf:queue-runtime-heartbeat", token });
    if (response?.owned !== true) {
      loseOwnership("heartbeat-denied");
      return publicState();
    }
    scheduleHeartbeat();
    return publicState();
  }

  async function start() {
    if (started) return publicState();
    started = true;
    emit();
    try {
      await claim();
    } catch (error) {
      app.modules.logger?.debug?.("queue-runtime-initial-claim-failed", { message: error?.message ?? String(error) });
      scheduleRetry();
    }
    return publicState();
  }

  function setExecutionReady(value = true) {
    executionReady = value === true;
    applyGates();
    emit();
    return publicState();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // pagehide intentionally does not release the lease. A same-tab navigation is
  // allowed to replace its own lease immediately in the background, while another
  // tab must wait for the short stale timeout. This prevents a different tab from
  // stealing the queue during the tiny gap between two documents of one navigation.
  globalThis.addEventListener?.("pagehide", () => {
    if (owner) app.modules.queuePersistence?.flush?.(manager.snapshot()).catch?.(() => {});
    clearRetry();
    clearHeartbeat();
  });
  globalThis.addEventListener?.("pageshow", () => {
    if (!started) return;
    if (owner) scheduleHeartbeat();
    else claim().catch(() => scheduleRetry());
  });

  app.modules.siteQueueRuntime = Object.freeze({
    CLAIM_RETRY_MS,
    HEARTBEAT_MS,
    token,
    start,
    claim,
    heartbeat,
    isOwner: () => owner,
    setExecutionReady,
    subscribe,
    snapshot: publicState
  });
})();
