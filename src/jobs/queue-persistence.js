(() => {
  "use strict";

  const app = globalThis.R34MF;
  const constants = app?.modules.constants;
  const browserApi = app?.modules.browserApi;
  const manager = app?.modules.jobManager;
  const runtime = app?.modules.siteQueueRuntime;
  if (!app || !constants || !browserApi || !manager || !runtime) {
    throw new Error("R34MF queue runtime dependencies must load before queue persistence.");
  }

  const STORAGE_KEY = constants.storageKeys.queueState;
  const VERSION = 1;
  const MAX_PENDING_JOBS = 24;
  const PROGRESS_FLUSH_MS = 1000;
  let unsubscribe = null;
  let progressTimer = null;
  let lastTopology = "";
  let writeChain = Promise.resolve();

  function serializableJob(job, bucket = "waiting") {
    if (!job?.id || !job?.kind) return null;
    return {
      id: String(job.id),
      kind: String(job.kind),
      scopeKey: String(job.scopeKey ?? job.kind),
      requestedAt: Math.max(0, Number(job.requestedAt) || Date.now()),
      resourceKeys: [...new Set([...(job.resourceKeys ?? [])].map(String).filter(Boolean))].slice(0, 12),
      coverage: [...new Set([...(job.coverage ?? [])].map(String).filter(Boolean))].slice(0, 12),
      progress: job.progress && typeof job.progress === "object" ? { ...job.progress } : {},
      bucket: bucket === "active" ? "active" : "waiting"
    };
  }

  function pendingFromSnapshot(snapshot = manager.snapshot()) {
    const jobs = [
      ...(snapshot.active ?? []).map((job) => serializableJob(job, "active")),
      ...(snapshot.waiting ?? []).map((job) => serializableJob(job, "waiting"))
    ].filter(Boolean).slice(0, MAX_PENDING_JOBS);
    return jobs;
  }

  function topology(snapshot = manager.snapshot()) {
    return JSON.stringify({
      active: (snapshot.active ?? []).map((job) => [job.id, job.kind]),
      waiting: (snapshot.waiting ?? []).map((job) => [job.id, job.kind])
    });
  }

  function queueWrite(operation) {
    const next = writeChain.then(operation, operation);
    writeChain = next.catch(() => {});
    return next;
  }

  function flush(snapshot = manager.snapshot()) {
    if (!runtime.isOwner()) return Promise.resolve({ saved: false, reason: "not-owner" });
    const jobs = pendingFromSnapshot(snapshot);
    if (progressTimer !== null) {
      globalThis.clearTimeout(progressTimer);
      progressTimer = null;
    }
    return queueWrite(async () => {
      if (!jobs.length) {
        await browserApi.storageLocal.remove(STORAGE_KEY);
        return { saved: true, cleared: true, jobs: 0 };
      }
      const record = { version: VERSION, updatedAt: Date.now(), jobs };
      await browserApi.storageLocal.set({ [STORAGE_KEY]: record });
      return { saved: true, cleared: false, jobs: jobs.length };
    });
  }

  function schedule(snapshot) {
    if (!runtime.isOwner()) return;
    const nextTopology = topology(snapshot);
    if (nextTopology !== lastTopology) {
      lastTopology = nextTopology;
      flush(snapshot).catch((error) => app.modules.logger?.debug?.("queue-persistence-write-failed", { message: error?.message ?? String(error) }));
      return;
    }
    if (progressTimer !== null) return;
    progressTimer = globalThis.setTimeout(() => {
      progressTimer = null;
      flush(manager.snapshot()).catch((error) => app.modules.logger?.debug?.("queue-persistence-progress-write-failed", { message: error?.message ?? String(error) }));
    }, PROGRESS_FLUSH_MS);
  }

  async function read() {
    const stored = await browserApi.storageLocal.get(STORAGE_KEY);
    const record = stored?.[STORAGE_KEY];
    if (!record || Number(record.version) !== VERSION || !Array.isArray(record.jobs)) {
      return { version: VERSION, updatedAt: null, jobs: [] };
    }
    const seen = new Set();
    const jobs = [];
    for (const item of record.jobs.slice(0, MAX_PENDING_JOBS)) {
      const normalized = serializableJob(item, item?.bucket);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      jobs.push(normalized);
    }
    return { version: VERSION, updatedAt: Number(record.updatedAt) || null, jobs };
  }

  async function clear() {
    if (progressTimer !== null) {
      globalThis.clearTimeout(progressTimer);
      progressTimer = null;
    }
    await queueWrite(() => browserApi.storageLocal.remove(STORAGE_KEY));
  }

  function start() {
    if (unsubscribe) return;
    lastTopology = topology(manager.snapshot());
    unsubscribe = manager.subscribe(schedule);
    if (runtime.isOwner()) schedule(manager.snapshot());
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = null;
    if (progressTimer !== null) globalThis.clearTimeout(progressTimer);
    progressTimer = null;
  }

  globalThis.addEventListener?.("pagehide", () => {
    if (runtime.isOwner()) flush(manager.snapshot()).catch(() => {});
  });

  app.modules.queuePersistence = Object.freeze({
    STORAGE_KEY,
    VERSION,
    MAX_PENDING_JOBS,
    PROGRESS_FLUSH_MS,
    serializableJob,
    pendingFromSnapshot,
    topology,
    read,
    flush,
    clear,
    start,
    stop
  });
})();
