(() => {
  "use strict";
  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before job manager.");

  function createJobManager({ getConcurrency = () => app.modules.settings?.value?.concurrentQueueJobs ?? 1 } = {}) {
    const waiting = [];
    const active = new Map();
    const recent = [];
    const handlers = new Map();
    const listeners = new Set();
    let serial = 0;
    let executionEnabled = true;
    let acceptingEnabled = true;
    const concurrency = () => Number(getConcurrency()) === 2 ? 2 : 1;
    const clone = (job) => ({ ...job, controller: undefined, _handler: undefined, resourceKeys: [...(job.resourceKeys ?? [])], coverage: [...(job.coverage ?? [])], progress: { ...(job.progress ?? {}) } });
    function snapshot() {
      return {
        concurrency: concurrency(),
        slots: concurrency(),
        executionEnabled,
        acceptingEnabled,
        active: [...active.values()].map(clone),
        waiting: waiting.map(clone),
        recent: recent.map(clone)
      };
    }
    function emit() { const value = snapshot(); listeners.forEach((listener) => listener(value)); return value; }
    function conflicts(job) { return [...active.values()].some((other) => (job.resourceKeys ?? []).some((key) => other.resourceKeys?.includes(key))); }
    function covers(existing, job) { return existing.kind === job.kind && existing.scopeKey === job.scopeKey || (existing.coverage ?? []).includes(job.kind); }
    function findExisting(job) { return [...active.values(), ...waiting].find((existing) => covers(existing, job)) ?? null; }
    function registerHandler(kind, handler) { handlers.set(kind, handler); }
    function enqueue(input) {
      if (!acceptingEnabled) {
        app.modules.logger?.debug?.("job-enqueue-skipped", { kind: input?.kind ?? null, scopeKey: input?.scopeKey ?? input?.kind ?? null, reason: "executor-unavailable" });
        return { accepted: false, reason: "executor-unavailable", job: null };
      }
      const existing = findExisting(input);
      if (existing) {
        const reason = (existing.coverage ?? []).includes(input.kind) ? "covered" : "duplicate";
        app.modules.logger?.debug?.("job-enqueue-skipped", { kind: input.kind, scopeKey: input.scopeKey ?? input.kind, reason, existingId: existing.id });
        return { accepted: false, reason, job: clone(existing) };
      }
      const requestedAt = Number(input.requestedAt);
      const job = {
        id: input.id ?? `job-${Date.now()}-${++serial}`,
        kind: input.kind,
        scopeKey: input.scopeKey ?? input.kind,
        state: "queued",
        requestedAt: Number.isFinite(requestedAt) && requestedAt > 0 ? requestedAt : Date.now(),
        startedAt: null,
        resourceKeys: [...new Set(input.resourceKeys ?? [])], coverage: [...new Set(input.coverage ?? [])],
        progress: { ...(input.progress ?? {}) }, result: null, error: null, controller: null, _handler: input.handler
      };
      waiting.push(job); app.modules.logger?.debug?.("job-enqueued", { id: job.id, kind: job.kind, scopeKey: job.scopeKey, resourceKeys: job.resourceKeys }); emit(); pump(); return { accepted: true, job: clone(job) };
    }
    function updateProgress(id, progress) { const job = active.get(id); if (job) { job.progress = { ...job.progress, ...progress }; emit(); } }
    function start(job) {
      waiting.splice(waiting.indexOf(job), 1); job.state = "running"; job.startedAt = Date.now(); job.controller = new AbortController(); active.set(job.id, job); emit();
      app.modules.logger?.debug?.("job-started", { id: job.id, kind: job.kind, scopeKey: job.scopeKey });
      const handler = job._handler ?? handlers.get(job.kind);
      if (typeof handler !== "function") {
        const error = Object.assign(new Error(`No handler is available for ${job.kind}.`), { code: "missing-job-handler" });
        app.modules.logger?.warn("job-handler-missing", { kind: job.kind, id: job.id });
        finish(job, "failed", null, error);
        return;
      }
      Promise.resolve().then(() => handler(clone(job), { signal: job.controller.signal, updateProgress: (value) => updateProgress(job.id, value) }))
        .then((result) => {
          const smartStatus = result?.smartUpdate?.status;
          const detailsStatus = result?.detailsState?.status;
          const stopped = job.controller.signal.aborted || result?.scanStatus === "paused" || smartStatus === "paused" || detailsStatus === "paused";
          const failed = result?.scanStatus === "failed" || smartStatus === "failed" || detailsStatus === "failed";
          finish(job, stopped ? "stopped" : failed ? "failed" : "complete", result, (failed || stopped) ? (result?.lastError ?? result?.smartUpdate?.lastError ?? result?.detailsState?.lastError) : null);
        })
        .catch((error) => finish(job, error?.name === "AbortError" || job.controller.signal.aborted ? "stopped" : "failed", null, error));
    }
    function finish(job, state, result = null, error = null) { if (!active.has(job.id)) return; active.delete(job.id); job.state = state; job.result = result; job.error = error ? { message: String(error.message ?? error), code: error.code ?? null } : null; job.finishedAt = Date.now(); job.controller = null; recent.unshift(job); recent.splice(12); app.modules.logger?.debug?.("job-finished", { id: job.id, kind: job.kind, state, durationMs: job.finishedAt - job.startedAt, errorCode: job.error?.code ?? null }); emit(); pump(); }
    function pump() {
      if (!executionEnabled) return;
      while (active.size < concurrency()) { const next = waiting.find((job) => !conflicts(job)); if (!next) break; start(next); }
    }
    function stop(id) { const job = active.get(id); if (job) { job.controller.abort(); return true; } return false; }
    function remove(id) { const index = waiting.findIndex((job) => job.id === id); if (index < 0) return false; waiting.splice(index, 1); emit(); pump(); return true; }
    function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    function setExecutionEnabled(value) {
      const next = value !== false;
      if (executionEnabled === next) return snapshot();
      executionEnabled = next;
      const valueSnapshot = emit();
      if (executionEnabled) pump();
      return valueSnapshot;
    }
    function setAcceptingEnabled(value) {
      const next = value !== false;
      if (acceptingEnabled === next) return snapshot();
      acceptingEnabled = next;
      return emit();
    }
    return { enqueue, stop, remove, pump, snapshot, subscribe, registerHandler, updateProgress, setExecutionEnabled, setAcceptingEnabled };
  }
  app.modules.jobManager = Object.freeze(createJobManager());
  app.modules.createJobManager = createJobManager;
})();
