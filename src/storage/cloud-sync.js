(() => {
  "use strict";

  const app = globalThis.R34MF;
  const browserApi = app?.modules.browserApi;
  const data = app?.modules.settingsData;
  const db = app?.modules.db;
  const seenStore = app?.modules.seenStore;
  const favoriteStore = app?.modules.favoriteStore;
  if (!app || !browserApi || !data || !db || !seenStore || !favoriteStore) {
    throw new Error("R34MF browser API, database, Seen/Favorite stores and hardened Settings data must load before Cloud sync.");
  }

  const CONFIG_KEY = "r34mf.cloudSyncCredentials.v1";
  const STATE_KEY = "r34mf.cloudSyncState.v1";
  const BACKUP_PATH = "rule34video-media-filter-backup.r34mfbackup";
  const ENCODING_JSON = "json";
  const ENCODING_GZIP = "gzip";

  function normalizeRepository(value) {
    let repository = String(value ?? "").trim();
    if (!repository) return "";

    try {
      const url = /^https?:\/\//i.test(repository)
        ? new URL(repository)
        : /^github\.com\//i.test(repository)
          ? new URL(`https://${repository}`)
          : null;
      if (url) {
        if (url.hostname.toLocaleLowerCase() !== "github.com") return repository;
        repository = url.pathname.replace(/^\/+|\/+$/g, "");
      }
    } catch {
      return repository;
    }

    return repository.replace(/\.git$/i, "").replace(/\/+$/g, "");
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const repository = normalizeRepository(source.repository);
    const token = String(source.token ?? "").trim();
    const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    return {
      repository: match ? `${match[1]}/${match[2]}` : repository,
      token,
      valid: Boolean(match && token),
      savedAt: Math.max(0, Number(source.savedAt) || 0)
    };
  }

  async function loadConfig() {
    const stored = await browserApi.storageLocal.get(CONFIG_KEY);
    return normalizeConfig(stored?.[CONFIG_KEY]);
  }

  async function saveConfig(raw) {
    const config = normalizeConfig(raw);
    if (!config.repository && !config.token) {
      await browserApi.storageLocal.remove(CONFIG_KEY);
      return normalizeConfig(null);
    }
    if (!config.valid) throw Object.assign(new Error("Enter a private GitHub repository as owner/repository or a github.com repository URL, plus a fine-grained access token."), { code: "cloud-config-invalid" });
    const stored = { repository: config.repository, token: config.token, savedAt: Date.now() };
    await browserApi.storageLocal.set({ [CONFIG_KEY]: stored });
    return normalizeConfig(stored);
  }

  async function clearConfig() {
    await browserApi.storageLocal.remove(CONFIG_KEY);
    return normalizeConfig(null);
  }

  async function loadState() {
    const stored = await browserApi.storageLocal.get(STATE_KEY);
    const state = stored?.[STATE_KEY];
    return state && typeof state === "object" ? { ...state } : {};
  }

  async function saveState(changes) {
    const previous = await loadState();
    const next = { ...previous, ...changes };
    await browserApi.storageLocal.set({ [STATE_KEY]: next });
    return next;
  }

  function remoteError(response) {
    const error = new Error(response?.error?.message ?? "Cloud sync failed.");
    error.code = response?.error?.code ?? "cloud-sync-failed";
    error.httpStatus = Number(response?.error?.httpStatus) || 0;
    return error;
  }

  async function message(type, payload = {}) {
    const response = await browserApi.runtimeSendMessage({ type, ...payload });
    if (!response?.ok) throw remoteError(response);
    return response;
  }

  async function status({ includeBackupMeta = false } = {}) {
    const result = await message("r34mf-cloud-status", { includeBackupMeta });
    await saveState({
      checkedAt: Date.now(),
      checkedRemoteSha: result.remote?.sha ?? null,
      checkedRemoteCommit: result.remote?.commit ?? null,
      repository: result.repository?.fullName ?? null,
      lastError: null
    });
    return result;
  }

  async function testConfig(raw) {
    const config = normalizeConfig(raw);
    if (!config.valid) throw Object.assign(new Error("Enter a private GitHub repository as owner/repository or a github.com repository URL, plus a fine-grained access token."), { code: "cloud-config-invalid" });
    return message("r34mf-cloud-test", {
      config: { repository: config.repository, token: config.token },
      includeBackupMeta: false
    });
  }

  function backupMeta(backup) {
    const summary = data.summaryFromBackup(backup);
    const seen = new Set((backup?.storage?.seenVideos?.ids ?? []).map(String)).size;
    const favorites = new Set((backup?.storage?.favoriteVideos?.ids ?? []).map(String)).size;
    return {
      exportedAt: backup?.exportedAt ?? null,
      appVersion: String(backup?.appVersion ?? "Unknown"),
      indexed: summary.indexed,
      detailed: summary.detailed,
      seen,
      favorites,
      bytes: summary.approximateBytes,
      storage: summary.approximateStorage
    };
  }

  async function quickLocalMeta() {
    const [catalogue, seen, favorites] = await Promise.all([
      db.getCatalogueState(),
      seenStore.load(),
      favoriteStore.load()
    ]);
    return {
      current: true,
      exportedAt: null,
      appVersion: String(app.version ?? "0.1.0"),
      indexed: Math.max(0, Number(catalogue?.indexedCount) || 0),
      detailed: Math.max(0, Number(catalogue?.detailedCount) || 0),
      seen: new Set((seen?.ids ?? []).map(String)).size,
      favorites: new Set((favorites?.ids ?? []).map(String)).size,
      bytes: null
    };
  }

  async function preview() {
    // Confirmation should be cheap. Do not build the multi-megabyte local backup or
    // download the entire remote backup merely to open the preview. The real transfer
    // happens once, after confirmation; import still validates before replacing data.
    const [remote, local] = await Promise.all([
      status({ includeBackupMeta: false }),
      quickLocalMeta()
    ]);
    return { remote, local };
  }

  function progress(callback, stage, detail = {}) {
    try { callback?.({ stage, ...detail }); } catch { /* UI progress must not break the operation */ }
  }

  function bytesToBase64(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? 0);
    let binary = "";
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value ?? ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function gzipBytes(bytes) {
    if (typeof globalThis.CompressionStream !== "function" || typeof Blob !== "function" || typeof Response !== "function") return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new globalThis.CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzipBytes(bytes) {
    if (typeof globalThis.DecompressionStream !== "function" || typeof Blob !== "function" || typeof Response !== "function") {
      throw Object.assign(new Error("This browser cannot decompress the optimized cloud backup. Update the browser or use a current Chrome/Firefox build."), { code: "cloud-compression-unsupported" });
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new globalThis.DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function encodeTransfer(text) {
    const rawBytes = new TextEncoder().encode(String(text));
    try {
      const compressed = await gzipBytes(rawBytes);
      // Feature-detect and fall back to the original JSON path. Also avoid gzip if a
      // pathological payload becomes larger after compression.
      if (compressed && compressed.byteLength < rawBytes.byteLength) {
        return {
          encoding: ENCODING_GZIP,
          encodedContent: bytesToBase64(compressed),
          bytes: compressed.byteLength,
          originalBytes: rawBytes.byteLength
        };
      }
    } catch {
      // Compression is an optimization, never a reason to make Cloud sync unusable.
    }
    return { encoding: ENCODING_JSON, text: String(text), bytes: rawBytes.byteLength, originalBytes: rawBytes.byteLength };
  }

  async function decodeTransfer(result) {
    if (result?.encoding !== ENCODING_GZIP) {
      if (typeof result?.text !== "string") throw Object.assign(new Error("The downloaded cloud backup payload is missing."), { code: "cloud-backup-invalid" });
      return result.text;
    }
    if (typeof result?.encodedContent !== "string" || !result.encodedContent) {
      throw Object.assign(new Error("The downloaded compressed cloud backup payload is missing."), { code: "cloud-backup-invalid" });
    }
    const compressed = base64ToBytes(result.encodedContent);
    const raw = await gunzipBytes(compressed);
    return new TextDecoder().decode(raw);
  }

  async function push({ expectedSha = null, onProgress = null } = {}) {
    return data.withIdleDataLock("cloud-push", async () => {
      progress(onProgress, "preparing");
      const backup = await data.buildBackup();
      const text = JSON.stringify(backup);
      progress(onProgress, "compressing");
      const payload = await encodeTransfer(text);
      progress(onProgress, "uploading", { bytes: payload.bytes, originalBytes: payload.originalBytes, encoding: payload.encoding });
      const result = await message("r34mf-cloud-push", { ...payload, expectedSha });
      progress(onProgress, "finalizing");
      await saveState({
        checkedAt: Date.now(),
        checkedRemoteSha: result.remote?.sha ?? null,
        lastPushedSha: result.remote?.sha ?? null,
        lastPushedAt: Date.now(),
        repository: result.repository?.fullName ?? null,
        lastError: null
      });
      progress(onProgress, "complete");
      return { ...result, local: backupMeta(backup), transfer: { encoding: payload.encoding, bytes: payload.bytes, originalBytes: payload.originalBytes } };
    });
  }

  async function pull({ expectedSha = null, onProgress = null } = {}) {
    progress(onProgress, "downloading");
    const result = await message("r34mf-cloud-pull", { expectedSha });
    if (result.encoding === ENCODING_GZIP) progress(onProgress, "decompressing", { bytes: Number(result.bytes) || null });
    const text = await decodeTransfer(result);
    progress(onProgress, "validating");
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw Object.assign(new Error("The downloaded cloud backup is not valid JSON."), { code: "cloud-backup-invalid" }); }

    progress(onProgress, "replacing");
    const imported = await data.importBackup(parsed, "replace");
    await saveState({
      checkedAt: Date.now(),
      checkedRemoteSha: result.remote?.sha ?? null,
      lastPulledSha: result.remote?.sha ?? null,
      lastPulledAt: Date.now(),
      repository: result.repository?.fullName ?? null,
      lastError: null
    });
    progress(onProgress, "complete");
    return { ...result, text: undefined, encodedContent: undefined, imported };
  }

  async function checkForRemoteUpdate({ maxAgeMs = 15 * 60 * 1000 } = {}) {
    const config = await loadConfig();
    if (!config.valid) return null;
    const state = await loadState();
    if (Number(state.checkedAt) > 0 && Date.now() - Number(state.checkedAt) < maxAgeMs) return state;
    try {
      const result = await status({ includeBackupMeta: false });
      const newest = result.remote?.sha ?? null;
      const synced = state.lastPulledSha ?? state.lastPushedSha ?? null;
      return saveState({ remoteChanged: Boolean(newest && synced && newest !== synced), lastError: null });
    } catch (error) {
      return saveState({ checkedAt: Date.now(), lastError: { code: error?.code ?? "cloud-check-failed", message: String(error?.message ?? error).slice(0, 300) } });
    }
  }

  app.modules.cloudSync = Object.freeze({
    CONFIG_KEY,
    STATE_KEY,
    BACKUP_PATH,
    ENCODING_JSON,
    ENCODING_GZIP,
    normalizeRepository,
    normalizeConfig,
    loadConfig,
    saveConfig,
    clearConfig,
    loadState,
    status,
    testConfig,
    backupMeta,
    quickLocalMeta,
    preview,
    encodeTransfer,
    decodeTransfer,
    push,
    pull,
    checkForRemoteUpdate
  });
})();