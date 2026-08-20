(() => {
  "use strict";

  const app = globalThis.R34MF;
  const db = app?.modules.db;
  const settings = app?.modules.settings;
  const uiState = app?.modules.uiState;
  const filterEngine = app?.modules.filterEngine;
  const identity = app?.modules.rule34VideoIdentity;
  if (!app || !db || !settings || !uiState || !filterEngine || !identity) {
    throw new Error("R34MF backup-schema dependencies must load first.");
  }

  const MAX_DEPTH = 32;
  const MAX_ARRAY = 25_000;
  const MAX_STRING = 1_000_000;
  const TERMINAL_HISTORY = new Set(["complete", "completed", "failed", "stopped", "cancelled", "canceled"]);
  const DETAIL_STATUSES = new Set(["missing", "queued", "complete", "failed", "stale"]);
  const SCAN_STATUSES = new Set(["not-scanned", "idle", "running", "paused", "failed", "complete"]);
  const SMART_STATUSES = new Set(["idle", "running", "paused", "failed", "complete"]);
  const DETAILS_STATE_STATUSES = new Set(["idle", "running", "paused", "failed", "complete"]);
  const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

  function backupError(message, code = "backup-schema-invalid", path = null) {
    const error = new Error(path ? `${message} (${path})` : message);
    error.code = code;
    if (path) error.path = path;
    return error;
  }

  function plainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function cloneJsonValue(value, path = "backup", depth = 0, seen = new WeakSet()) {
    if (depth > MAX_DEPTH) throw backupError("Backup data is nested too deeply.", "backup-schema-depth", path);
    if (value === undefined) return null;
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "object") {
      const tag = Object.prototype.toString.call(value);
      if (tag === "[object Date]") {
        const time = Number(value.getTime?.());
        if (!Number.isFinite(time)) throw backupError("Backup contains an invalid date.", "backup-schema-type", path);
        return new Date(time).toISOString();
      }
      if (tag === "[object Error]" || tag === "[object DOMException]") {
        const code = value.code;
        return {
name: String(value.name ?? "Error").slice(0, 80),
message: String(value.message ?? "").slice(0, 500),
...((typeof code === "string" || typeof code === "number") && String(code) ? { code: String(code).slice(0, 80) } : {})
        };
      }
    }
    if (typeof value === "string") {
      if (value.length > MAX_STRING) throw backupError("Backup text field is unreasonably large.", "backup-schema-size", path);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw backupError("Backup contains a non-finite number.", "backup-schema-number", path);
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY) throw backupError("Backup array is unreasonably large.", "backup-schema-size", path);
      return value.map((item, index) => cloneJsonValue(item, `${path}[${index}]`, depth + 1, seen));
    }
    if (!plainObject(value)) throw backupError("Backup contains an unsupported value type.", "backup-schema-type", path);
    if (seen.has(value)) throw backupError("Backup contains a circular object graph.", "backup-schema-cycle", path);
    seen.add(value);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw backupError("Backup contains a forbidden object key.", "backup-schema-key", `${path}.${key}`);
      result[key] = cloneJsonValue(item, `${path}.${key}`, depth + 1, seen);
    }
    seen.delete(value);
    return result;
  }

  function requiredId(value, path, { numeric = false } = {}) {
    const id = String(value ?? "").trim();
    if (!id || id.length > 160 || (numeric && !/^\d+$/.test(id))) {
      throw backupError("Backup record has an invalid primary key.", "backup-primary-key-invalid", path);
    }
    return id;
  }

  function finiteOrNull(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
      throw backupError("Backup numeric field is invalid.", "backup-record-invalid", path);
    }
    return number;
  }

  function boundedString(value, path, max = 20_000, { nullable = true } = {}) {
    if (value === null || value === undefined) {
      if (nullable) return null;
      throw backupError("Backup text field is missing.", "backup-record-invalid", path);
    }
    const text = String(value);
    if (text.length > max) throw backupError("Backup text field is too large.", "backup-schema-size", path);
    return text;
  }

  function httpUrlOrNull(value, path) {
    if (value === null || value === undefined || value === "") return null;
    let url;
    try { url = new URL(String(value)); }
    catch { throw backupError("Backup contains a malformed URL.", "backup-record-invalid", path); }
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    return url.href;
  }

  function normalizeError(value, path) {
    if (value === null || value === undefined) return null;
    if (!plainObject(value)) throw backupError("Backup error metadata is invalid.", "backup-record-invalid", path);
    return {
      code: boundedString(value.code ?? "unknown", `${path}.code`, 80, { nullable: false }).slice(0, 80),
      message: boundedString(value.message ?? "Operation failed.", `${path}.message`, 500, { nullable: false }).slice(0, 500),
      ...(value.httpStatus === null || value.httpStatus === undefined ? {} : {
        httpStatus: finiteOrNull(value.httpStatus, `${path}.httpStatus`, { min: 100, max: 599, integer: true })
      })
    };
  }

  function normalizeVideo(raw, path = "database.videos") {
    if (!plainObject(raw)) throw backupError("Video record must be an object.", "backup-record-invalid", path);
    const record = cloneJsonValue(raw, path);
    record.videoId = requiredId(record.videoId, `${path}.videoId`, { numeric: true });
    const checked = identity.validateRecord(record);
    if (!checked.ok) throw backupError(`Video record URL does not match its video ID: ${checked.reason}.`, "backup-video-identity-invalid", `${path}.url`);
    record.url = checked.url;

    for (const field of ["thumbnailUrl", "thumbnailPreferredUrl", "thumbnailFallbackUrl", "previewUrl"]) {
      if (record[field] !== undefined) record[field] = httpUrlOrNull(record[field], `${path}.${field}`);
    }
    for (const field of ["durationSec", "views", "ratingVotes", "nativePage", "nativeOrder", "firstSeenAt", "lastSeenAt", "listingUpdatedAt", "relativeUploadObservedAt", "listingUploadEarliestAt", "listingUploadLatestAt", "thumbnailRepairedAt"]) {
      if (record[field] !== undefined && record[field] !== null) {
        record[field] = finiteOrNull(record[field], `${path}.${field}`, { min: 0, integer: ["durationSec", "views", "ratingVotes", "nativePage", "nativeOrder"].includes(field) });
      }
    }
    if (record.nativePage !== null && record.nativePage !== undefined && record.nativePage < 1) throw backupError("Native page must be positive.", "backup-record-invalid", `${path}.nativePage`);
    if (record.nativeOrder !== null && record.nativeOrder !== undefined && record.nativeOrder < 1) throw backupError("Native order must be positive.", "backup-record-invalid", `${path}.nativeOrder`);
    if (record.ratingPercent !== undefined && record.ratingPercent !== null) {
      record.ratingPercent = finiteOrNull(record.ratingPercent, `${path}.ratingPercent`, { min: 0, max: 100 });
    }
    if (record.listingUploadEarliestAt !== null && record.listingUploadEarliestAt !== undefined
      && record.listingUploadLatestAt !== null && record.listingUploadLatestAt !== undefined
      && record.listingUploadEarliestAt > record.listingUploadLatestAt) {
      throw backupError("Listing upload-date range is reversed.", "backup-record-invalid", path);
    }
    if (record.title !== undefined) record.title = boundedString(record.title, `${path}.title`, 20_000, { nullable: false });
    if (record.relativeUploadText !== undefined && record.relativeUploadText !== null) record.relativeUploadText = boundedString(record.relativeUploadText, `${path}.relativeUploadText`, 500);
    record.hdAvailable = record.hdAvailable === true;
    return record;
  }

  function normalizeStringList(value, path, limit = 10_000) {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value) || value.length > limit) throw backupError("Backup list field is invalid.", "backup-record-invalid", path);
    const seen = new Set();
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = boundedString(value[index], `${path}[${index}]`, 2_000, { nullable: false }).trim();
      if (!item) continue;
      const key = item.toLocaleLowerCase();
      if (!seen.has(key)) { seen.add(key); result.push(item); }
    }
    return result;
  }

  function validExactDate(value, path) {
    if (value === null || value === undefined || value === "") return null;
    const text = boundedString(value, path, 80, { nullable: false }).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const time = Date.parse(`${text}T00:00:00.000Z`);
      if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== text) throw backupError("Exact upload date is invalid.", "backup-record-invalid", path);
      return text;
    }
    const time = Date.parse(text);
    if (!Number.isFinite(time)) throw backupError("Exact upload date is invalid.", "backup-record-invalid", path);
    return new Date(time).toISOString();
  }

  function normalizeFormats(value, path) {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value) || value.length > 128) throw backupError("Detail formats list is invalid.", "backup-record-invalid", path);
    return value.map((raw, index) => {
      if (!plainObject(raw)) throw backupError("Detail format must be an object.", "backup-record-invalid", `${path}[${index}]`);
      const result = {};
      for (const key of ["name", "format", "quality", "resolution"]) {
        if (raw[key] !== null && raw[key] !== undefined && String(raw[key]).trim()) result[key] = boundedString(raw[key], `${path}[${index}].${key}`, 500, { nullable: false }).trim();
      }
      return result;
    }).filter((item) => Object.keys(item).length);
  }

  function normalizeDetail(raw, path = "database.videoDetails") {
    if (!plainObject(raw)) throw backupError("Detail record must be an object.", "backup-record-invalid", path);
    const record = cloneJsonValue(raw, path);
    record.videoId = requiredId(record.videoId, `${path}.videoId`, { numeric: true });
    const status = String(record.status ?? "missing").toLocaleLowerCase();
    if (!DETAIL_STATUSES.has(status)) throw backupError("Detail status is invalid.", "backup-record-invalid", `${path}.status`);
    // `queued` is page-runtime state, not durable work. Import it as missing.
    record.status = status === "queued" ? "missing" : status;
    for (const field of ["fetchedAt", "attemptedAt", "lastAttemptAt", "failureCount", "schemaVersion", "commentsCount"]) {
      if (record[field] !== undefined && record[field] !== null) {
        record[field] = finiteOrNull(record[field], `${path}.${field}`, { min: 0, integer: ["failureCount", "schemaVersion", "commentsCount"].includes(field) });
      }
    }
    record.failureCount = Math.max(0, Number(record.failureCount) || 0);
    if (record.status === "complete") {
      record.artist = record.artist === null || record.artist === undefined ? null : boundedString(record.artist, `${path}.artist`, 4_000).trim() || null;
      record.uploader = record.uploader === null || record.uploader === undefined ? null : boundedString(record.uploader, `${path}.uploader`, 4_000).trim() || null;
      record.artists = normalizeStringList(Array.isArray(record.artists) && record.artists.length ? record.artists : (record.artist ? [record.artist] : []), `${path}.artists`);
      record.artistRefs = (Array.isArray(record.artistRefs) ? record.artistRefs : []).map((ref, index) => {
        if (!plainObject(ref)) throw backupError("Artist reference is invalid.", "backup-record-invalid", `${path}.artistRefs[${index}]`);
        const url = httpUrlOrNull(ref.url, `${path}.artistRefs[${index}].url`);
        const parsed = url ? new URL(url) : null;
        const match = parsed?.pathname.match(/^\/models\/([^/]+)\/?$/i);
        if (!parsed || !new Set(["rule34video.com", "www.rule34video.com"]).has(parsed.hostname.toLocaleLowerCase()) || !match) throw backupError("Artist reference URL is invalid.", "backup-record-invalid", `${path}.artistRefs[${index}].url`);
        let slug;
        try { slug = decodeURIComponent(match[1]).toLocaleLowerCase(); }
        catch { throw backupError("Artist reference URL is invalid.", "backup-record-invalid", `${path}.artistRefs[${index}].url`); }
        return { key: slug, name: boundedString(ref.name, `${path}.artistRefs[${index}].name`, 4_000, { nullable: false }).trim(), url: `${parsed.origin}/models/${encodeURIComponent(slug)}/` };
      }).filter((ref, index, all) => ref.key && ref.name && all.findIndex((item) => item.key === ref.key) === index);
      record.uploaders = normalizeStringList(Array.isArray(record.uploaders) && record.uploaders.length ? record.uploaders : (record.uploader ? [record.uploader] : []), `${path}.uploaders`);
      record.artist = record.artists[0] ?? record.artist;
      record.uploader = record.uploaders[0] ?? record.uploader;
      record.tags = normalizeStringList(record.tags, `${path}.tags`);
      record.categories = normalizeStringList(record.categories, `${path}.categories`);
      if (record.entityTrust !== undefined && !plainObject(record.entityTrust)) throw backupError("Detail entity trust is invalid.", "backup-record-invalid", `${path}.entityTrust`);
      record.entityTrust = Object.fromEntries(["artist", "uploader", "tags", "categories"].map((field) => [field, record.entityTrust?.[field] === true]));
      record.description = boundedString(record.description ?? "", `${path}.description`, 250_000, { nullable: false });
      record.exactUploadDate = validExactDate(record.exactUploadDate, `${path}.exactUploadDate`);
      record.formats = normalizeFormats(record.formats, `${path}.formats`);
      record.lastError = null;
    } else if (record.lastError !== undefined) {
      record.lastError = normalizeError(record.lastError, `${path}.lastError`);
    }
    if (record.lastAttemptError !== undefined) record.lastAttemptError = normalizeError(record.lastAttemptError, `${path}.lastAttemptError`);
    return record;
  }

  function normalizePage(raw, path) {
    if (!plainObject(raw)) throw backupError("Catalogue page must be an object.", "backup-record-invalid", path);
    const record = cloneJsonValue(raw, path);
    record.pageNumber = finiteOrNull(record.pageNumber, `${path}.pageNumber`, { min: 1, integer: true });
    if (!Array.isArray(record.videoIds)) throw backupError("Catalogue page videoIds is invalid.", "backup-record-invalid", `${path}.videoIds`);
    const seen = new Set();
    record.videoIds = record.videoIds.map((id, index) => requiredId(id, `${path}.videoIds[${index}]`, { numeric: true })).filter((id) => !seen.has(id) && seen.add(id));
    record.status = String(record.status ?? "complete");
    if (!new Set(["complete", "failed"]).has(record.status)) throw backupError("Catalogue page status is invalid.", "backup-record-invalid", `${path}.status`);
    if (record.scannedAt !== undefined && record.scannedAt !== null) record.scannedAt = finiteOrNull(record.scannedAt, `${path}.scannedAt`, { min: 0 });
    if (record.sessionId !== undefined && record.sessionId !== null) record.sessionId = boundedString(record.sessionId, `${path}.sessionId`, 200).trim() || null;
    if (record.lastError !== undefined) record.lastError = normalizeError(record.lastError, `${path}.lastError`);
    if (record.lastAttemptError !== undefined) record.lastAttemptError = normalizeError(record.lastAttemptError, `${path}.lastAttemptError`);
    return record;
  }

  function normalizeSmartPage(raw, path) {
    if (!plainObject(raw)) throw backupError("Smart Update stage row must be an object.", "backup-record-invalid", path);
    const record = cloneJsonValue(raw, path);
    record.sessionId = requiredId(record.sessionId, `${path}.sessionId`);
    record.pageNumber = finiteOrNull(record.pageNumber, `${path}.pageNumber`, { min: 1, integer: true });
    record.key = requiredId(record.key ?? `${record.sessionId}:${record.pageNumber}`, `${path}.key`);
    const expectedKey = `${record.sessionId}:${record.pageNumber}`;
    if (record.key !== expectedKey) throw backupError("Smart Update stage key does not match its session/page.", "backup-primary-key-invalid", `${path}.key`);
    if (!Array.isArray(record.records)) throw backupError("Smart Update stage records are invalid.", "backup-record-invalid", `${path}.records`);
    record.records = record.records.map((item, index) => normalizeVideo(item, `${path}.records[${index}]`));
    if (record.stagedAt !== undefined && record.stagedAt !== null) record.stagedAt = finiteOrNull(record.stagedAt, `${path}.stagedAt`, { min: 0 });
    return record;
  }

  function normalizeRuntimeStateObject(value, path, defaults, allowedStatus) {
    if (value === null || value === undefined) return { ...defaults };
    if (!plainObject(value)) throw backupError("Operation state is invalid.", "backup-record-invalid", path);
    const result = { ...defaults, ...cloneJsonValue(value, path) };
    const status = String(result.status ?? defaults.status);
    if (!allowedStatus.has(status)) throw backupError("Operation status is invalid.", "backup-record-invalid", `${path}.status`);
    result.status = status === "running" ? "paused" : status;
    if (status === "running") {
      result.activeRunStartedAt = null;
      result.currentPage = null;
      result.lastError = { code: "runtime-interrupted", message: "Operation was active when the backup was created and was imported as paused." };
    }
    return result;
  }

  function normalizeCatalogueState(raw, path) {
    if (!plainObject(raw)) throw backupError("Catalogue state must be an object.", "backup-record-invalid", path);
    const record = cloneJsonValue(raw, path);
    if (record.key !== undefined && record.key !== db.STATE_KEY) throw backupError("Catalogue state has an unexpected key.", "backup-primary-key-invalid", `${path}.key`);
    record.key = db.STATE_KEY;
    const status = String(record.scanStatus ?? "not-scanned");
    if (!SCAN_STATUSES.has(status)) throw backupError("Catalogue scan status is invalid.", "backup-record-invalid", `${path}.scanStatus`);
    record.scanStatus = status === "running" ? "paused" : status;
    if (status === "running") {
      record.currentPage = null;
      record.activeRunStartedAt = null;
      record.lastError = { code: "runtime-interrupted", message: "Catalogue scan was active when the backup was created and was imported as paused." };
    }
    record.catalogueReady = record.catalogueReady === true;
    for (const field of ["indexedCount", "detailedCount", "discoveredPageCount", "discoveredNativeTotal", "discoveredPageSize", "pagesCompleted", "currentPage", "nextPage", "startedAt", "activeRunStartedAt", "lastProgressAt", "completedAt", "lastFullScanAt", "lastSmartUpdateAt", "lastCatalogueUpdateAt", "schemaVersion"]) {
      if (record[field] !== undefined && record[field] !== null) record[field] = finiteOrNull(record[field], `${path}.${field}`, { min: 0, integer: ["indexedCount", "detailedCount", "discoveredPageCount", "discoveredNativeTotal", "discoveredPageSize", "pagesCompleted", "currentPage", "nextPage", "schemaVersion"].includes(field) });
    }
    record.detailsState = normalizeRuntimeStateObject(record.detailsState, `${path}.detailsState`, db.defaultDetailsState(), DETAILS_STATE_STATUSES);
    record.smartUpdate = normalizeRuntimeStateObject(record.smartUpdate, `${path}.smartUpdate`, db.defaultCatalogueState().smartUpdate, SMART_STATUSES);
    if (record.lastError !== undefined) record.lastError = normalizeError(record.lastError, `${path}.lastError`);
    return db.deriveCatalogueState(record);
  }

  function normalizeHistory(raw, path) {
    if (!plainObject(raw)) throw backupError("History record must be an object.", "backup-record-invalid", path);
    const record = cloneJsonValue(raw, path);
    record.id = requiredId(record.id, `${path}.id`);
    const status = String(record.status ?? record.state ?? "").toLocaleLowerCase();
    if (!TERMINAL_HISTORY.has(status)) return null;
    record.status = status === "completed" ? "complete" : status === "canceled" ? "cancelled" : status;
    if (record.state !== undefined) record.state = record.status;
    for (const field of ["startedAt", "finishedAt", "requestedAt"]) {
      if (record[field] !== undefined && record[field] !== null) record[field] = finiteOrNull(record[field], `${path}.${field}`, { min: 0 });
    }
    if (!Number(record.finishedAt)) return null;
    if (record.error !== undefined && record.error !== null) record.error = normalizeError(record.error, `${path}.error`);
    return record;
  }

  function dedupe(records, keyOf, merge) {
    const map = new Map();
    for (const record of records) {
      const key = String(keyOf(record));
      map.set(key, map.has(key) ? merge(map.get(key), record) : record);
    }
    return [...map.values()];
  }

  function newer(existing, incoming, fields) {
    const score = (item) => Math.max(0, ...fields.map((field) => Number(item?.[field]) || 0));
    return score(incoming) >= score(existing) ? incoming : existing;
  }

  function mergeDetail(existing, incoming) {
    if (existing.status === "complete" && incoming.status !== "complete") return existing;
    if (incoming.status === "complete" && existing.status !== "complete") return incoming;
    return newer(existing, incoming, ["fetchedAt", "lastAttemptAt", "attemptedAt"]);
  }

  function normalizeStorage(raw) {
    const source = raw === null || raw === undefined ? {} : raw;
    if (!plainObject(source)) throw backupError("Backup storage payload is invalid.", "backup-storage-invalid", "storage");
    const safeSettings = source.settings === null || source.settings === undefined ? null : settings.normalize(cloneJsonValue(source.settings, "storage.settings"));
    if (safeSettings) safeSettings.automaticSignIn = false;
    const safeUi = source.uiState === null || source.uiState === undefined ? null : uiState.normalize(cloneJsonValue(source.uiState, "storage.uiState"));
    let safeFilters = null;
    if (source.filterState !== null && source.filterState !== undefined) {
      const rawFilters = cloneJsonValue(source.filterState, "storage.filterState");
      if (!plainObject(rawFilters)) throw backupError("Filter-state payload is invalid.", "backup-storage-invalid", "storage.filterState");
      const version = Number(rawFilters.version ?? 1);
      if (!Number.isInteger(version) || version < 1 || version > 1) throw backupError("Filter-state version is not supported.", "backup-storage-version", "storage.filterState.version");
      if (!Array.isArray(rawFilters.presets) || !rawFilters.presets.length || rawFilters.presets.length > 500) throw backupError("Filter-state presets are invalid.", "backup-storage-invalid", "storage.filterState.presets");
      const usedIds = new Set();
      const presets = rawFilters.presets.map((preset, index) => {
        if (!plainObject(preset)) throw backupError("Filter preset is invalid.", "backup-storage-invalid", `storage.filterState.presets[${index}]`);
        const id = requiredId(preset.id, `storage.filterState.presets[${index}].id`);
        if (usedIds.has(id)) throw backupError("Filter preset IDs must be unique.", "backup-primary-key-invalid", `storage.filterState.presets[${index}].id`);
        usedIds.add(id);
        const name = boundedString(preset.name, `storage.filterState.presets[${index}].name`, 200, { nullable: false }).trim();
        if (!name) throw backupError("Filter preset name is empty.", "backup-storage-invalid", `storage.filterState.presets[${index}].name`);
        return {
          id,
          name,
          createdAt: Math.max(0, Number(preset.createdAt) || 0),
          updatedAt: Math.max(0, Number(preset.updatedAt) || 0),
          filters: filterEngine.normalize(preset.filters)
        };
      });
      const activePresetId = usedIds.has(String(rawFilters.activePresetId ?? "")) ? String(rawFilters.activePresetId) : presets[0].id;
      safeFilters = { version: 1, activePresetId, presets };
    }
    return { settings: safeSettings, uiState: safeUi, filterState: safeFilters };
  }

  function normalizeDatabase(raw) {
    if (!plainObject(raw)) throw backupError("Backup database payload is invalid.", "backup-database-invalid", "database");
    const knownStores = new Set(Object.values(db.STORES));
    for (const key of Object.keys(raw)) {
      if (!knownStores.has(key) && raw[key] !== null && raw[key] !== undefined) throw backupError(`Backup contains unsupported database store ${key}.`, "backup-unknown-store", `database.${key}`);
    }
    for (const name of knownStores) {
      if (raw[name] !== undefined && !Array.isArray(raw[name])) throw backupError(`Backup store ${name} is invalid.`, "backup-database-invalid", `database.${name}`);
    }

    const videos = dedupe((raw[db.STORES.videos] ?? []).map((item, index) => normalizeVideo(item, `database.${db.STORES.videos}[${index}]`)), (item) => item.videoId, (a, b) => newer(a, b, ["listingUpdatedAt", "lastSeenAt", "firstSeenAt"]));
    const membership = new Set(videos.map((video) => video.videoId));
    const details = dedupe((raw[db.STORES.videoDetails] ?? []).map((item, index) => normalizeDetail(item, `database.${db.STORES.videoDetails}[${index}]`)).filter((detail) => membership.has(detail.videoId)), (item) => item.videoId, mergeDetail);

    const pageMap = new Map();
    for (const [index, item] of (raw[db.STORES.cataloguePages] ?? []).entries()) {
      const page = normalizePage(item, `database.${db.STORES.cataloguePages}[${index}]`);
      page.videoIds = page.videoIds.filter((id) => membership.has(id));
      if (pageMap.has(page.pageNumber)) throw backupError("Catalogue page primary keys must be unique.", "backup-primary-key-invalid", `database.${db.STORES.cataloguePages}[${index}].pageNumber`);
      pageMap.set(page.pageNumber, page);
    }

    const smartPages = dedupe((raw[db.STORES.smartUpdatePages] ?? []).map((item, index) => normalizeSmartPage(item, `database.${db.STORES.smartUpdatePages}[${index}]`)), (item) => item.key, (a, b) => newer(a, b, ["stagedAt"]));

    const states = (raw[db.STORES.catalogueState] ?? []).map((item, index) => normalizeCatalogueState(item, `database.${db.STORES.catalogueState}[${index}]`));
    if (states.length > 1) throw backupError("Backup contains multiple catalogue-state records.", "backup-primary-key-invalid", `database.${db.STORES.catalogueState}`);
    const completeCount = details.filter((detail) => detail.status === "complete").length;
    const state = db.deriveCatalogueState(states[0] ?? db.defaultCatalogueState(), { indexedCount: videos.length, detailedCount: completeCount });

    const history = dedupe((raw[db.STORES.jobHistory] ?? []).map((item, index) => normalizeHistory(item, `database.${db.STORES.jobHistory}[${index}]`)).filter(Boolean), (item) => item.id, (a, b) => newer(a, b, ["finishedAt", "startedAt"]))
      .sort((a, b) => Number(b.finishedAt) - Number(a.finishedAt))
      .slice(0, db.HISTORY_LIMIT ?? 12);

    return {
      [db.STORES.videos]: videos,
      [db.STORES.videoDetails]: details,
      [db.STORES.cataloguePages]: [...pageMap.values()].sort((a, b) => a.pageNumber - b.pageNumber),
      [db.STORES.smartUpdatePages]: smartPages,
      [db.STORES.catalogueState]: [state],
      [db.STORES.jobHistory]: history
    };
  }

  function normalizeBackup(backup) {
    if (!plainObject(backup)) throw backupError("Backup payload must be an object.", "backup-schema-invalid", "backup");
    return {
      ...cloneJsonValue(backup, "backup"),
      storage: normalizeStorage(backup.storage ?? {}),
      database: normalizeDatabase(backup.database)
    };
  }

  app.modules.backupSchema = Object.freeze({
    backupError,
    plainObject,
    cloneJsonValue,
    normalizeVideo,
    normalizeDetail,
    normalizePage,
    normalizeSmartPage,
    normalizeCatalogueState,
    normalizeHistory,
    normalizeStorage,
    normalizeDatabase,
    normalizeBackup
  });
})();
