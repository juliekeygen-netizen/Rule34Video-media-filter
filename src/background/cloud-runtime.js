(() => {
  "use strict";

  if (globalThis.R34MFCloudRuntime) return;
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime || !api?.storage?.local) return;

  const CONFIG_KEY = "r34mf.cloudSyncCredentials.v1";
  const BACKUP_PATH = "rule34video-media-filter-backup.r34mfbackup";
  const API_ROOT = "https://api.github.com";
  const API_VERSION = "2022-11-28";
  const MAX_BACKUP_BYTES = 80_000_000;
  const MAX_BASE64_CHARS = Math.ceil(MAX_BACKUP_BYTES / 3) * 4 + 8;
  const ENCODING_JSON = "json";
  const ENCODING_GZIP = "gzip";

  function localGet(key) {
    if (globalThis.browser?.storage?.local) return globalThis.browser.storage.local.get(key);
    return new Promise((resolve, reject) => api.storage.local.get(key, (value) => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    }));
  }

  function cloudError(message, code = "cloud-sync-failed", status = 0) {
    const error = new Error(String(message || "Cloud sync failed."));
    error.code = code;
    error.httpStatus = Number(status) || 0;
    return error;
  }

  function safeError(error) {
    return {
      code: String(error?.code ?? "cloud-sync-failed").slice(0, 100),
      message: String(error?.message ?? error ?? "Cloud sync failed.").slice(0, 500),
      httpStatus: Number(error?.httpStatus) || 0
    };
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const repository = String(source.repository ?? "").trim();
    const token = String(source.token ?? "").trim();
    const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match || !token) return null;
    return {
      repository: `${match[1]}/${match[2]}`,
      owner: match[1],
      repo: match[2],
      token
    };
  }

  async function savedConfig() {
    const stored = await localGet(CONFIG_KEY);
    return normalizeConfig(stored?.[CONFIG_KEY]);
  }

  function headers(config, accept = "application/vnd.github+json") {
    return {
      Accept: accept,
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "Content-Type": "application/json"
    };
  }

  async function responseMessage(response) {
    try {
      const payload = await response.clone().json();
      return String(payload?.message ?? "").slice(0, 300);
    } catch {
      try { return String(await response.clone().text()).slice(0, 300); }
      catch { return ""; }
    }
  }

  async function githubFetch(config, path, options = {}) {
    let response;
    try {
      response = await fetch(`${API_ROOT}${path}`, {
        method: options.method ?? "GET",
        headers: headers(config, options.accept),
        cache: "no-store",
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch (error) {
      throw cloudError(error?.message || "GitHub could not be reached.", "cloud-network-failed");
    }
    if (options.allow404 && response.status === 404) return response;
    if (!response.ok) {
      const detail = await responseMessage(response);
      const code = response.status === 401 ? "cloud-auth-failed"
        : response.status === 403 ? "cloud-access-denied"
          : response.status === 404 ? "cloud-repository-not-found"
            : response.status === 409 ? "cloud-conflict"
              : "cloud-github-error";
      throw cloudError(detail || `GitHub returned HTTP ${response.status}.`, code, response.status);
    }
    return response;
  }

  function repoPath(config, suffix = "") {
    return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}${suffix}`;
  }

  function contentPath(config, branch) {
    const ref = branch ? `?ref=${encodeURIComponent(branch)}` : "";
    return `${repoPath(config)}/contents/${encodeURIComponent(BACKUP_PATH)}${ref}`;
  }

  function boundedBackupMeta(text, bytes = null) {
    let backup;
    try { backup = JSON.parse(text); }
    catch { return { valid: false, error: "Remote file is not valid JSON." }; }
    const storage = backup?.storage && typeof backup.storage === "object" ? backup.storage : {};
    const database = backup?.database && typeof backup.database === "object" ? backup.database : {};
    const videos = Array.isArray(database.videos) ? database.videos : [];
    const details = Array.isArray(database.videoDetails) ? database.videoDetails : [];
    const seenIds = Array.isArray(storage?.seenVideos?.ids) ? storage.seenVideos.ids : [];
    const favoriteIds = Array.isArray(storage?.favoriteVideos?.ids) ? storage.favoriteVideos.ids : [];
    return {
      valid: backup?.format === "r34mf-backup",
      format: String(backup?.format ?? "").slice(0, 80),
      version: Number(backup?.version) || 0,
      exportedAt: typeof backup?.exportedAt === "string" ? backup.exportedAt.slice(0, 80) : null,
      appVersion: String(backup?.appVersion ?? "Unknown").slice(0, 80),
      indexed: videos.length,
      detailed: details.filter((item) => item?.status === "complete").length,
      seen: new Set(seenIds.map(String)).size,
      favorites: new Set(favoriteIds.map(String)).size,
      bytes: Number(bytes) || new TextEncoder().encode(text).length
    };
  }

  async function repositoryInfo(config) {
    const response = await githubFetch(config, repoPath(config));
    const repo = await response.json();
    if (repo?.private !== true) {
      throw cloudError("Cloud sync only supports private GitHub repositories so backup data is not published accidentally.", "cloud-repository-public");
    }
    return {
      fullName: String(repo.full_name ?? config.repository),
      private: true,
      defaultBranch: String(repo.default_branch ?? "main"),
      htmlUrl: typeof repo.html_url === "string" ? repo.html_url : null
    };
  }

  async function remoteFileInfo(config, repository) {
    const response = await githubFetch(config, contentPath(config, repository.defaultBranch), { allow404: true });
    if (response.status === 404) return null;
    const file = await response.json();
    if (!file || file.type !== "file" || !file.sha) {
      throw cloudError("The configured cloud-backup path is not a normal GitHub file.", "cloud-backup-path-invalid");
    }
    return {
      sha: String(file.sha),
      size: Math.max(0, Number(file.size) || 0),
      path: String(file.path ?? BACKUP_PATH),
      htmlUrl: typeof file.html_url === "string" ? file.html_url : null
    };
  }

  async function latestFileCommit(config, repository) {
    const path = `${repoPath(config)}/commits?path=${encodeURIComponent(BACKUP_PATH)}&sha=${encodeURIComponent(repository.defaultBranch)}&per_page=1`;
    const response = await githubFetch(config, path);
    const commits = await response.json();
    const commit = Array.isArray(commits) ? commits[0] : null;
    if (!commit) return null;
    return {
      sha: String(commit.sha ?? ""),
      shortSha: String(commit.sha ?? "").slice(0, 7),
      message: String(commit.commit?.message ?? "Cloud backup update").split("\n")[0].slice(0, 180),
      date: commit.commit?.committer?.date ?? commit.commit?.author?.date ?? null,
      htmlUrl: typeof commit.html_url === "string" ? commit.html_url : null
    };
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

  function base64ByteLength(value) {
    const text = String(value ?? "").trim();
    if (!text || text.length > MAX_BASE64_CHARS || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return -1;
    const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
    return Math.floor(text.length * 3 / 4) - padding;
  }

  function isGzip(bytes) {
    return bytes?.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  }

  function base64HasGzipMagic(value) {
    try {
      const prefix = atob(String(value ?? "").slice(0, 4));
      return prefix.length >= 2 && prefix.charCodeAt(0) === 0x1f && prefix.charCodeAt(1) === 0x8b;
    } catch {
      return false;
    }
  }

  async function downloadPayload(config, repository) {
    const response = await githubFetch(config, contentPath(config, repository.defaultBranch), {
      accept: "application/vnd.github.raw+json"
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BACKUP_BYTES) {
      throw cloudError("The cloud backup is too large to import safely in one operation.", "cloud-backup-too-large");
    }
    if (isGzip(bytes)) {
      return { encoding: ENCODING_GZIP, encodedContent: bytesToBase64(bytes), bytes: bytes.byteLength };
    }
    return { encoding: ENCODING_JSON, text: new TextDecoder().decode(bytes), bytes: bytes.byteLength };
  }

  async function decodePayloadText(payload) {
    if (payload?.encoding === ENCODING_JSON) return payload.text;
    if (payload?.encoding !== ENCODING_GZIP || typeof globalThis.DecompressionStream !== "function" || typeof Blob !== "function" || typeof Response !== "function") return null;
    const binary = atob(payload.encodedContent);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const stream = new Blob([bytes]).stream().pipeThrough(new globalThis.DecompressionStream("gzip"));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }

  async function inspect(config, { includeBackupMeta = false } = {}) {
    const repository = await repositoryInfo(config);
    const file = await remoteFileInfo(config, repository);
    if (!file) return { repository, remote: null, backupPath: BACKUP_PATH };
    const [commit, payload] = await Promise.all([
      latestFileCommit(config, repository),
      includeBackupMeta ? downloadPayload(config, repository) : Promise.resolve(null)
    ]);
    let backupMeta = null;
    if (payload) {
      const text = await decodePayloadText(payload);
      backupMeta = text === null
        ? { valid: null, compressed: true, bytes: payload.bytes, error: "Compressed backup contents are validated during Pull." }
        : boundedBackupMeta(text, payload.bytes);
    }
    return {
      repository,
      backupPath: BACKUP_PATH,
      remote: {
        ...file,
        commit,
        backupMeta
      }
    };
  }

  // Transfer-time checks deliberately skip the latest-commit lookup. The file SHA is
  // the concurrency guard; fetching commit presentation metadata again adds latency
  // without strengthening Push/Pull conflict safety.
  async function transferSnapshot(config) {
    const repository = await repositoryInfo(config);
    const remote = await remoteFileInfo(config, repository);
    return { repository, remote, backupPath: BACKUP_PATH };
  }

  function normalizeUpload(message) {
    if (message?.encoding === ENCODING_GZIP) {
      const encodedContent = String(message.encodedContent ?? "").trim();
      const bytes = base64ByteLength(encodedContent);
      if (bytes < 1 || bytes > MAX_BACKUP_BYTES) {
        throw cloudError("The prepared compressed backup payload is missing or too large.", "cloud-backup-too-large");
      }
      if (!base64HasGzipMagic(encodedContent)) {
        throw cloudError("The prepared compressed backup is not a valid gzip stream.", "cloud-backup-invalid");
      }
      return { encoding: ENCODING_GZIP, content: encodedContent, bytes, backupMeta: null };
    }

    const text = typeof message?.text === "string" ? message.text : "";
    const bytes = new TextEncoder().encode(text).length;
    if (!text || bytes > MAX_BACKUP_BYTES) {
      throw cloudError("The prepared backup payload is missing or too large.", "cloud-backup-too-large");
    }
    return { encoding: ENCODING_JSON, content: bytesToBase64(new TextEncoder().encode(text)), bytes, backupMeta: boundedBackupMeta(text, bytes) };
  }

  async function push(config, message, expectedSha) {
    const before = await transferSnapshot(config);
    const currentSha = before.remote?.sha ?? null;
    const expected = expectedSha ? String(expectedSha) : null;
    if (currentSha !== expected) {
      throw cloudError("The cloud backup changed after the confirmation screen opened. Check it again before pushing so a newer backup is not overwritten.", "cloud-remote-changed", 409);
    }

    const upload = normalizeUpload(message);
    const body = {
      message: `Update Rule34Video Media Filter cloud backup (${new Date().toISOString()})`,
      content: upload.content,
      branch: before.repository.defaultBranch,
      ...(currentSha ? { sha: currentSha } : {})
    };
    const response = await githubFetch(config, `${repoPath(config)}/contents/${encodeURIComponent(BACKUP_PATH)}`, {
      method: "PUT",
      body
    });
    const result = await response.json();
    return {
      repository: before.repository,
      backupPath: BACKUP_PATH,
      encoding: upload.encoding,
      remote: {
        sha: String(result.content?.sha ?? ""),
        size: upload.bytes,
        path: String(result.content?.path ?? BACKUP_PATH),
        htmlUrl: typeof result.content?.html_url === "string" ? result.content.html_url : null,
        commit: {
          sha: String(result.commit?.sha ?? ""),
          shortSha: String(result.commit?.sha ?? "").slice(0, 7),
          message: String(result.commit?.message ?? body.message).split("\n")[0].slice(0, 180),
          date: result.commit?.committer?.date ?? result.commit?.author?.date ?? new Date().toISOString(),
          htmlUrl: typeof result.commit?.html_url === "string" ? result.commit.html_url : null
        },
        backupMeta: upload.backupMeta
      }
    };
  }

  async function pull(config, expectedSha) {
    const before = await transferSnapshot(config);
    if (!before.remote) throw cloudError("No cloud backup exists in this repository yet.", "cloud-backup-missing", 404);
    const expected = expectedSha ? String(expectedSha) : null;
    if (expected && before.remote.sha !== expected) {
      throw cloudError("The cloud backup changed after the confirmation screen opened. Check it again before pulling.", "cloud-remote-changed", 409);
    }
    const payload = await downloadPayload(config, before.repository);
    return {
      ...before,
      ...payload,
      remote: {
        ...before.remote,
        backupMeta: payload.encoding === ENCODING_JSON ? boundedBackupMeta(payload.text, payload.bytes) : null
      }
    };
  }

  async function resolveConfig(message) {
    if (message?.config) {
      const config = normalizeConfig(message.config);
      if (!config) throw cloudError("Enter a GitHub repository as owner/repository and a fine-grained access token.", "cloud-config-invalid");
      return config;
    }
    const config = await savedConfig();
    if (!config) throw cloudError("GitHub cloud sync is not configured yet.", "cloud-not-configured");
    return config;
  }

  async function handle(message) {
    const config = await resolveConfig(message);
    if (message.type === "r34mf-cloud-status" || message.type === "r34mf-cloud-test") {
      return { ok: true, ...(await inspect(config, { includeBackupMeta: message.includeBackupMeta === true })) };
    }
    if (message.type === "r34mf-cloud-push") {
      return { ok: true, ...(await push(config, message, message.expectedSha ?? null)) };
    }
    if (message.type === "r34mf-cloud-pull") {
      return { ok: true, ...(await pull(config, message.expectedSha ?? null)) };
    }
    throw cloudError("Unknown cloud-sync request.", "cloud-request-invalid");
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!String(message?.type ?? "").startsWith("r34mf-cloud-")) return undefined;
    handle(message).then(
      sendResponse,
      (error) => sendResponse({ ok: false, error: safeError(error) })
    );
    return true;
  });

  globalThis.R34MFCloudRuntime = Object.freeze({
    CONFIG_KEY,
    BACKUP_PATH,
    ENCODING_JSON,
    ENCODING_GZIP,
    normalizeConfig,
    boundedBackupMeta,
    repositoryInfo,
    inspect,
    transferSnapshot,
    normalizeUpload,
    push,
    pull
  });
})();