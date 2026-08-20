(() => {
  "use strict";

  const app = globalThis.R34MF;
  const defaultDb = app?.modules.db;
  const defaultParser = app?.modules.detailParser;
  const defaultScheduler = app?.modules.requestScheduler;
  const identity = app?.modules.rule34VideoIdentity;
  if (!app || !defaultDb || !defaultParser || !defaultScheduler || !identity) throw new Error("R34MF detail dependencies must load before detail scanner.");

  const SYSTEMIC_THRESHOLD = 3;
  const SYSTEMIC_CODES = new Set(["authentication-required", "unexpected-detail-structure", "video-id-mismatch", "detail-parse-failed", "invalid-video-url"]);
  const PREFLIGHT_SAMPLE_LIMIT = 10;
  const CANARY_MAX_ATTEMPTS = 10;

  function abortError() { return new DOMException("Detailed metadata was stopped.", "AbortError"); }
  function isAbort(error) { return error?.name === "AbortError"; }
  function sessionId() { return globalThis.crypto?.randomUUID?.() ?? `details-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
  function safeError(error, fallback = "detail-request-failed") { return { code: String(error?.code ?? fallback).slice(0, 80), message: String(error?.message ?? "Detailed metadata could not be fetched.").slice(0, 240), ...(Number.isFinite(Number(error?.httpStatus)) ? { httpStatus: Number(error.httpStatus) } : {}) }; }
  function detailError(code, message, httpStatus = null) { const error = new Error(message); error.code = code; if (httpStatus !== null) error.httpStatus = Number(httpStatus); return error; }
  function detailUrl(video, origin = globalThis.location?.origin, preferredShape = null) {
    const parsed = identity.validateRecord(video); if (!parsed.ok) return null;
    const url = new URL(parsed.url); let current;
    try { current = new URL(origin ?? url.origin); } catch { current = url; }
    if (identity.HOSTS.has(current.hostname.toLocaleLowerCase()) && ["http:", "https:"].includes(current.protocol)) { url.protocol = current.protocol; url.host = current.host; }
    if (["/video/", "/videos/"].includes(preferredShape)) url.pathname = url.pathname.replace(/^\/videos?\//i, preferredShape);
    url.hash = ""; return url.href;
  }
  function alternateDetailUrl(url) { const value = new URL(url); value.pathname = /^\/videos\//i.test(value.pathname) ? value.pathname.replace(/^\/videos\//i, "/video/") : value.pathname.replace(/^\/video\//i, "/videos/"); return value.href; }
  function systemicGroup(code) { return code === "authentication-required" ? "authentication" : SYSTEMIC_CODES.has(code) ? "structure" : null; }
  function systemicPreflight(invalidCount, targetCount) { return invalidCount >= 25 || (invalidCount >= 3 && invalidCount / Math.max(1, targetCount) >= 0.05); }
  function localPreflight(targets) {
    const valid = []; const invalid = [];
    for (const video of targets ?? []) {
      const parsed = identity.validateRecord(video);
      if (parsed.ok) valid.push({ video, url: parsed.url, pathShape: parsed.pathShape });
      else if (invalid.length < PREFLIGHT_SAMPLE_LIMIT) invalid.push({ videoId: String(video?.videoId ?? "").slice(0, 40) || null, reason: parsed.reason });
    }
    const invalidCount = Math.max(0, (targets?.length ?? 0) - valid.length);
    return { targetCount: targets?.length ?? 0, validCount: valid.length, invalidCount, invalidSamples: invalid, systemic: systemicPreflight(invalidCount, targets?.length ?? 0), checkedAt: Date.now() };
  }
  function parserEvidence(diagnostics) {
    return {
      identityCandidates: [...(diagnostics?.identityCandidates ?? [])].slice(0, 3),
      identityEvidence: [...(diagnostics?.identityEvidence ?? [])].slice(0, 6).map((item) => ({ source: String(item?.source ?? "").slice(0, 24), valid: item?.valid === true, videoId: item?.videoId ? String(item.videoId).slice(0, 40) : null })),
      detailRoot: diagnostics?.expectedDetailRootFound === true,
      jsonLdVideoObject: diagnostics?.jsonLdVideoObjectFound === true,
      rule34ColumnCount: Math.max(0, Number(diagnostics?.rule34ColumnCount) || 0),
      artistCandidates: Math.max(0, Number(diagnostics?.artistCandidates) || 0),
      uploaderCandidates: Math.max(0, Number(diagnostics?.uploaderCandidates) || 0),
      tagCandidates: Math.max(0, Number(diagnostics?.tagCandidates) || 0),
      categoryCandidates: Math.max(0, Number(diagnostics?.categoryCandidates) || 0),
      descriptionEvidence: diagnostics?.descriptionEvidence ?? null,
      uploadDateCandidate: diagnostics?.uploadDateCandidateFound === true,
      commentsCandidate: diagnostics?.commentsCandidateFound === true
    };
  }
  function responseEvidence(response, requestUrl, responseLength = null, requestVariant = "stored") {
    const final = identity.parse(response?.url || requestUrl);
    const rawContentLength = response?.headers?.get?.("Content-Length");
    const contentLength = rawContentLength === null || rawContentLength === undefined || String(rawContentLength).trim() === "" ? NaN : Number(rawContentLength);
    return {
      requestPathShape: identity.shape(requestUrl), requestVariant,
      finalHostname: final.ok ? final.hostname : null, finalPathShape: final.ok ? final.pathShape : "invalid/other",
      httpStatus: Number(response?.status) || null, ok: response?.ok === true,
      contentType: String(response?.headers?.get?.("Content-Type") ?? "").slice(0, 100) || null,
      redirected: response?.redirected === true,
      responseLength: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : Number.isFinite(responseLength) ? Math.min(Number(responseLength), 10_000_000) : null
    };
  }
  function histogram(samples) {
    const failureCodes = {}; const httpStatuses = {};
    for (const sample of samples ?? []) if (!sample.ok) { const code = String(sample.code ?? "unknown"); failureCodes[code] = (failureCodes[code] ?? 0) + 1; const status = Number(sample.httpStatus); if (status) httpStatuses[status] = (httpStatuses[status] ?? 0) + 1; }
    return { failureCodes, httpStatuses };
  }
  function classifyCanary(samples, successes, attempts) {
    const failed = (samples ?? []).filter((sample) => !sample.ok); const count = failed.length; const majority = (predicate) => failed.filter(predicate).length >= Math.max(1, Math.ceil(count / 2));
    if (majority((sample) => sample.code === "request-scheduler-error")) return detailError("request-scheduler-error", "The extension request scheduler failed before Detailed Metadata could safely start bulk requests.");
    if (majority((sample) => sample.code === "authentication-required")) return detailError("detail-canary-authentication", "Rule34Video repeatedly returned authentication or challenge responses. Bulk enrichment was not started.");
    if (majority((sample) => sample.code === "network-error" || Number(sample.httpStatus) >= 500)) { const statusCounts = histogram(failed).httpStatuses; const dominant = Object.entries(statusCounts).sort((a, b) => b[1] - a[1])[0]?.[0]; return detailError("detail-canary-transient-network", dominant ? `Rule34Video detail pages are repeatedly returning HTTP ${dominant}. Completed data was preserved; retry later.` : "Rule34Video detail pages are repeatedly failing at the network layer. Completed data was preserved; retry later."); }
    if (majority((sample) => [404, 410].includes(Number(sample.httpStatus)))) return detailError("detail-canary-http-failure", "Most canary detail URLs returned HTTP 404/410. The catalogue was preserved and bulk enrichment was not started.");
    if (majority((sample) => SYSTEMIC_CODES.has(sample.code))) return detailError("detail-canary-parser-failure", "Rule34Video video identity or page structure repeatedly could not be verified. Bulk enrichment was not started.");
    return detailError("detail-canary-mixed-failure", `Detail canary verified ${successes} of ${attempts} attempted pages; mixed failures prevented bulk enrichment.`);
  }
  function exhaustedGoneOnlyCanary(samples, targets, attempted) {
    const failed = (samples ?? []).filter((sample) => sample?.ok !== true);
    if (!failed.length || failed.length >= SYSTEMIC_THRESHOLD || !failed.every((sample) => [404, 410].includes(Number(sample.httpStatus)))) return false;
    const validTargets = (targets ?? []).filter((video) => identity.validateRecord(video).ok);
    return validTargets.length > 0 && validTargets.every((video) => attempted?.has?.(String(video.videoId)) === true);
  }

  function createDetailScanner(options = {}) {
    const db = options.db ?? defaultDb; const parser = options.parser ?? defaultParser; const scheduler = options.scheduler ?? defaultScheduler;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis); const parseHtml = options.parseHtml ?? ((html) => new DOMParser().parseFromString(html, "text/html"));
    const settings = options.getSettings ?? (() => app.modules.settings?.value ?? {}); const logger = options.logger ?? app.modules.logger; const getCurrentOrigin = options.getCurrentOrigin ?? (() => globalThis.location?.origin);
    let activeController = null;

    async function run({ signal: suppliedSignal, onProgress, limit = null } = {}) {
      if (activeController) throw detailError("detail-run-active", "Detailed metadata is already running.");
      if (typeof fetchImpl !== "function") throw detailError("fetch-unavailable", "Detailed metadata fetch is unavailable.");
      const catalogue = await db.getCatalogueState();
      if (catalogue.catalogueReady !== true) throw detailError("catalogue-unavailable", "A completed catalogue is required before fetching detailed metadata.");

      const controller = new AbortController(); const stopFromCaller = () => controller.abort(); if (suppliedSignal?.aborted) controller.abort();
      const signal = controller.signal; const id = sessionId(); const startedAt = Date.now(); const attempted = new Set();
      let targets = await db.getMissingDetailTargets({ limit }); let targetCount = targets.length; let processedCount = 0; let completedCount = 0; let failedCount = 0;
      let detailedCount = await db.countDetailedVideos(); let phase = "preflight"; let fatal = null; let systemicKind = null; let systemicCount = 0; let checkpointChain = Promise.resolve(); let historyWritten = false;
      let lastPreflight = localPreflight(targets); let lastCanary = null; let canaryAttempted = 0; let canaryVerified = 0; let canaryRequired = 0; let preferredPathShape = null;
      activeController = controller; if (!suppliedSignal?.aborted) suppliedSignal?.addEventListener?.("abort", stopFromCaller, { once: true });

      const detailsState = (changes = {}) => ({ status: "running", phase, sessionId: id, mode: "missing", targetCount, processedCount, completedCount, failedCount, startedAt, activeRunStartedAt: startedAt, lastProgressAt: Date.now(), completedAt: null, lastError: null, systemicReason: null, lastPreflight, lastCanary, ...changes });
      const checkpoint = (changes = {}) => { const value = detailsState(changes); checkpointChain = checkpointChain.then(() => db.updateDetailsState(value)); return checkpointChain; };
      const progress = (videoId = null) => { const value = { phase, completed: phase === "canary" ? canaryAttempted : processedCount, total: phase === "canary" ? CANARY_MAX_ATTEMPTS : phase === "preflight" ? null : targetCount, processed: processedCount, runCompleted: completedCount, detailedCount, failedCount, canaryAttempted, canaryVerified, canaryRequired, canaryMaximum: CANARY_MAX_ATTEMPTS, ...(videoId ? { currentVideoId: videoId } : {}) }; onProgress?.(value); return value; };
      const recordHistory = async (status) => { if (historyWritten) return; historyWritten = true; await db.appendHistory({ kind: "detailed-metadata", status, startedAt, finishedAt: Date.now(), summary: { target: targetCount, processed: processedCount, completed: completedCount, failed: failedCount, detailedTotal: detailedCount, phase } }); };
      const setFatal = (error, status = "failed") => { if (fatal) return; fatal = { error, status }; controller.abort(); };
      const observeSystemic = (code) => {
        const group = systemicGroup(code); if (!group) { systemicKind = null; systemicCount = 0; return; }
        if (systemicKind === group) systemicCount += 1; else { systemicKind = group; systemicCount = 1; }
        if (systemicCount >= SYSTEMIC_THRESHOLD) setFatal(detailError(group === "authentication" ? "authentication-required" : "unexpected-detail-structure", group === "authentication" ? "Rule34Video repeatedly returned an authentication or challenge response." : "Rule34Video detail identity or page structure repeatedly could not be verified."));
      };
      const failTarget = async (video, error, evidence = {}) => { const value = safeError(error); await db.recordDetailFailure(video.videoId, value); failedCount += 1; processedCount += 1; observeSystemic(value.code); logger?.debug?.("detail-record-failed", { videoId: video.videoId, code: value.code, httpStatus: value.httpStatus ?? null }); await checkpoint(); progress(video.videoId); return { ok: false, code: value.code, httpStatus: value.httpStatus ?? null, ...evidence }; };

      async function processTarget(video, { allowAlternate = false } = {}) {
        if (signal.aborted) throw abortError(); attempted.add(String(video.videoId));
        const primary = detailUrl(video, getCurrentOrigin(), preferredPathShape); if (!primary) return failTarget(video, detailError("invalid-video-url", "The catalogue record has no usable Rule34Video detail URL."));
        const requests = [{ url: primary, variant: preferredPathShape ? `preferred-${preferredPathShape.replace(/\W/g, "")}` : "stored-shape" }];
        if (allowAlternate && !preferredPathShape) requests.push({ url: alternateDetailUrl(primary), variant: "alternate-path" });
        const responses = [];
        for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
          const requestInfo = requests[requestIndex]; logger?.debug?.("detail-request-start", { videoId: video.videoId, phase, variant: requestInfo.variant }); let response;
          try {
            response = await scheduler.runWithPolicy({ signal, maximumRetries: settings().retryTemporaryDetailFailures === false ? 0 : undefined, request: ({ signal: requestSignal }) => fetchImpl(requestInfo.url, { credentials: "include", cache: "no-store", signal: requestSignal }) });
          } catch (error) {
            if (isAbort(error)) throw error;
            const evidence = { responses: [{ requestPathShape: identity.shape(requestInfo.url), requestVariant: requestInfo.variant, finalHostname: null, finalPathShape: null, httpStatus: null, ok: false, contentType: null, redirected: false, responseLength: null }] };
            if (error?.code === "request-scheduler-error") {
              const internal = detailError("request-scheduler-error", `The extension request scheduler failed: ${String(error?.message ?? "unknown scheduler error").slice(0, 160)}`);
              setFatal(internal);
              logger?.warn?.("detail-request-scheduler-failed", { videoId: video.videoId, message: internal.message });
              return { ok: false, code: internal.code, ...evidence };
            }
            return failTarget(video, detailError("network-error", error?.message ?? "The detail request failed."), evidence);
          }
          let responseInfo = responseEvidence(response, requestInfo.url, null, requestInfo.variant); responses.push(responseInfo);
          if (response.status === 429) { const outcome = await failTarget(video, detailError("http-429", "Rule34Video is still rate-limiting detail requests. Resume later.", 429), { response: responseInfo, responses }); setFatal(detailError("http-429", "Rule34Video is still rate-limiting detail requests. Completed details were preserved.", 429), "paused"); return outcome; }
          if ([404, 410].includes(Number(response.status)) && requestIndex + 1 < requests.length) continue;
          if ([401, 403].includes(Number(response.status))) return failTarget(video, detailError("authentication-required", `Rule34Video denied the detail request (HTTP ${response.status}).`, response.status), { response: responseInfo, responses });
          if (!response.ok) { const status = Number(response.status); const code = status === 404 ? "http-404" : status === 410 ? "http-410" : status >= 500 ? "http-5xx" : `http-${status}`; return failTarget(video, detailError(code, `Could not read video ${video.videoId} (HTTP ${status}).`, status), { response: responseInfo, responses }); }
          let html; let result;
          try { html = await response.text(); responseInfo = responseEvidence(response, requestInfo.url, html.length, requestInfo.variant); responses[responses.length - 1] = responseInfo; result = parser.parseDocument(parseHtml(html), { expectedVideoId: String(video.videoId), url: response.url || requestInfo.url }); }
          catch (error) { return failTarget(video, detailError("detail-parse-failed", error?.message ?? "The detail response could not be parsed."), { response: responseInfo, responses }); }
          if (!result?.ok) {
            const code = result?.reason ?? "detail-parse-failed"; const evidence = parserEvidence(result?.diagnostics); logger?.warn?.("detail-parse-failed", { videoId: video.videoId, code, diagnostics: result?.diagnostics ?? null });
            if (code === "video-id-mismatch" && requestIndex + 1 < requests.length) continue;
            return failTarget(video, detailError(code, code === "video-id-mismatch" ? "The returned video identity did not match the catalogue record." : code === "authentication-required" ? "Rule34Video returned a login or challenge page." : "The Rule34Video detail page could not be verified."), { evidence, response: responseInfo, responses });
          }
          const committed = await db.writeCompleteDetail({ ...result.record, videoId: String(video.videoId), fetchedAt: Date.now() }); if (committed.newlyComplete !== false) detailedCount += 1; completedCount += 1; processedCount += 1; systemicKind = null; systemicCount = 0;
          const evidence = parserEvidence(result.diagnostics); logger?.debug?.("detail-parse-success", { videoId: video.videoId, phase, evidence, variant: requestInfo.variant }); await checkpoint(); progress(video.videoId);
          return { ok: true, evidence, response: responseInfo, responses, requestVariant: requestInfo.variant, successfulPathShape: identity.shape(requestInfo.url) };
        }
        return failTarget(video, detailError("http-404", `Could not read video ${video.videoId} through either verified path form.`, 404), { responses });
      }

      async function runBatch(batch, concurrency) {
        let index = 0;
        async function worker() { while (!signal.aborted && !fatal) { const current = index++; if (current >= batch.length) return; try { await processTarget(batch[current]); } catch (error) { if (isAbort(error)) return; setFatal(detailError(error?.code ?? "detail-system-failure", error?.message ?? "Detailed metadata stopped unexpectedly.")); return; } } }
        await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, batch.length)) }, () => worker()));
      }

      try {
        logger?.debug?.("detail-run-start", { sessionId: id, targetCount, concurrency: settings().concurrentDetailRequests }); await db.updateDetailsState(detailsState()); progress();
        if (lastPreflight.systemic) {
          const error = detailError("detail-url-preflight-failed", `${lastPreflight.invalidCount.toLocaleString()} of ${targetCount.toLocaleString()} detail targets failed the local Rule34Video URL contract.`);
          fatal = { error, status: "failed" };
        } else {
          for (const video of targets.filter((item) => !identity.validateRecord(item).ok)) { attempted.add(String(video.videoId)); await failTarget(video, detailError("invalid-video-url", "The catalogue record has no usable Rule34Video detail URL.")); }
        }

        if (!fatal && !signal.aborted && lastPreflight.validCount) {
          phase = "canary"; await checkpoint(); progress();
          const candidates = targets.filter((video) => identity.validateRecord(video).ok).slice(0, CANARY_MAX_ATTEMPTS);
          const requiredSuccesses = Math.min(3, Math.max(1, Math.ceil(candidates.length * 0.6))); const samples = []; const alternateShapes = {}; let successes = 0; let attempts = 0;
          canaryRequired = requiredSuccesses; progress();
          for (const video of candidates) {
            if (fatal || signal.aborted || successes >= requiredSuccesses) break;
            const outcome = await processTarget(video, { allowAlternate: true }); attempts += 1; canaryAttempted = attempts; if (outcome?.ok) { successes += 1; canaryVerified = successes; if (outcome.requestVariant === "alternate-path") alternateShapes[outcome.successfulPathShape] = (alternateShapes[outcome.successfulPathShape] ?? 0) + 1; }
            samples.push({ videoId: String(video.videoId), ok: outcome?.ok === true, ...(outcome?.code ? { code: outcome.code } : {}), ...(outcome?.httpStatus ? { httpStatus: outcome.httpStatus } : {}), ...(outcome?.evidence ? { evidence: outcome.evidence } : {}), ...(outcome?.response ? { response: outcome.response } : {}), ...(outcome?.responses ? { responses: outcome.responses.slice(0, 2) } : {}), ...(outcome?.requestVariant ? { requestVariant: outcome.requestVariant } : {}) });
            await checkpoint(); progress(video.videoId);
          }
          const distributions = histogram(samples); const provenAlternate = Object.entries(alternateShapes).find(([, count]) => count >= 2)?.[0] ?? null; if (provenAlternate) preferredPathShape = provenAlternate;
          const isolatedGoneOnly = !fatal && successes < requiredSuccesses && exhaustedGoneOnlyCanary(samples, targets, attempted);
          lastCanary = { attemptedCount: attempts, maximumAttempts: CANARY_MAX_ATTEMPTS, successCount: successes, failedCount: attempts - successes, requiredSuccesses, passed: successes >= requiredSuccesses, isolatedGoneOnly, failureCodes: distributions.failureCodes, httpStatuses: distributions.httpStatuses, preferredPathShape, checkedAt: Date.now(), samples: samples.slice(0, CANARY_MAX_ATTEMPTS) };
          await checkpoint();
          if (isolatedGoneOnly) logger?.debug?.("detail-canary-isolated-gone", { attemptedCount: attempts, failedCount: attempts - successes });
          else if (!lastCanary.passed && fatal?.error?.code && !["http-429", "request-scheduler-error"].includes(fatal.error.code)) { const classified = classifyCanary(samples, successes, attempts); fatal = { error: classified, status: "failed" }; controller.abort(); }
          else if (!fatal && !lastCanary.passed) setFatal(classifyCanary(samples, successes, attempts));
        }
        if (!fatal && !signal.aborted && targetCount > 0 && !lastPreflight.validCount) setFatal(detailError("detail-url-preflight-failed", "No valid Rule34Video detail URLs remained after local preflight."));

        if (!fatal && !signal.aborted) {
          phase = "bulk"; await checkpoint(); progress();
          const concurrency = Math.max(1, Math.min(3, Number(settings().concurrentDetailRequests) || 2));
          await runBatch(targets.filter((video) => !attempted.has(String(video.videoId))), concurrency);
          let reconciliationPasses = 0;
          while (!signal.aborted && !fatal && limit === null && reconciliationPasses < 20) {
            const missing = await db.getMissingDetailTargets(); const fresh = missing.filter((video) => !attempted.has(String(video.videoId))); if (!fresh.length) break;
            const preflight = localPreflight(fresh); if (preflight.systemic) { lastPreflight = preflight; setFatal(detailError("detail-url-preflight-failed", "Newly reconciled detail targets failed the local Rule34Video URL contract.")); break; }
            targets = fresh; targetCount += fresh.length; reconciliationPasses += 1; await checkpoint(); progress();
            for (const video of fresh.filter((item) => !identity.validateRecord(item).ok)) { attempted.add(String(video.videoId)); await failTarget(video, detailError("invalid-video-url", "The catalogue record has no usable Rule34Video detail URL.")); }
            await runBatch(fresh.filter((video) => identity.validateRecord(video).ok), concurrency);
          }
          if (!signal.aborted && !fatal && limit === null && reconciliationPasses >= 20) { const remaining = (await db.getMissingDetailTargets()).filter((video) => !attempted.has(String(video.videoId))); if (remaining.length) setFatal(detailError("detail-targets-changing", "The catalogue kept changing during final detail reconciliation. Resume to include the newest videos."), "paused"); }
        }
        await checkpointChain; detailedCount = await db.synchronizeDetailedCount();
        if (fatal) { const error = safeError(fatal.error); const systemicReason = systemicGroup(error.code) || error.code.startsWith("detail-canary-") || error.code === "detail-url-preflight-failed" || error.code === "request-scheduler-error" ? error : null; const state = detailsState({ status: fatal.status, activeRunStartedAt: null, lastError: error, systemicReason }); await db.updateDetailsState(state); await recordHistory(fatal.status === "paused" ? "stopped" : "failed"); logger?.warn?.(fatal.status === "paused" ? "detail-run-paused" : "detail-systemic-failure", error); return { detailsState: state, detailedCount, lastError: error }; }
        if (signal.aborted) { const state = detailsState({ status: "paused", activeRunStartedAt: null }); await db.updateDetailsState(state); await recordHistory("stopped"); return { detailsState: state, detailedCount }; }
        const completedAt = Date.now(); phase = "complete"; const state = detailsState({ status: "complete", activeRunStartedAt: null, completedAt }); await db.updateDetailsState(state); await recordHistory("complete"); return { detailsState: state, detailedCount };
      } catch (error) {
        detailedCount = await db.synchronizeDetailedCount().catch(() => detailedCount); const stopped = isAbort(error) || suppliedSignal?.aborted; const failure = stopped ? null : safeError(error, "detail-system-failure"); const status = stopped ? "paused" : "failed";
        const state = detailsState({ status, activeRunStartedAt: null, lastError: failure, ...(failure?.code === "request-scheduler-error" ? { systemicReason: failure } : {}) }); await db.updateDetailsState(state); await recordHistory(stopped ? "stopped" : "failed"); return { detailsState: state, detailedCount, lastError: failure };
      } finally { suppliedSignal?.removeEventListener?.("abort", stopFromCaller); if (activeController === controller) activeController = null; }
    }

    function stop() { activeController?.abort(); }
    return { run, stop, detailUrl, safeError, systemicGroup, localPreflight, systemicPreflight, parserEvidence, responseEvidence, histogram, classifyCanary, exhaustedGoneOnlyCanary };
  }

  app.modules.createDetailScanner = createDetailScanner;
  app.modules.detailScanner = Object.freeze(createDetailScanner());
})();