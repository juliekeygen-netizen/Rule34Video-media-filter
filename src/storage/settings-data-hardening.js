(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.settingsData;
  const schema = app?.modules.backupSchema;
  const lock = app?.modules.dataOperationLock;
  const db = app?.modules.db;
  if (!app || !base || !schema || !lock || !db) {
    throw new Error("R34MF Settings data, backup schema, data lock and DB must load before Phase 10 data hardening.");
  }

  function normalizedValidation(input) {
    // Envelope/version validation runs first so a newer backup is rejected before
    // any record normalization can accidentally make it look compatible.
    const shallow = base.validateBackup(input);
    const backup = schema.normalizeBackup(shallow.backup);
    const validated = base.validateBackup(backup);
    return { backup: validated.backup, meta: validated.meta };
  }

  async function readBackupFile(file) {
    if (!file || typeof file.text !== "function") throw new Error("Choose a backup file first.");
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch { throw new Error("The selected backup is not valid JSON."); }
    return normalizedValidation(parsed);
  }

  async function withIdleDataLock(label, work) {
    return lock.runExclusive(label, async () => {
      // Acquire the lock before checking JobManager. The Phase 10 JobManager guard
      // refuses new enqueue attempts while this lock is held, closing the old
      // check-then-await race around destructive data operations.
      base.ensureQueueIdle();
      return work();
    });
  }

  async function safeBuildBackup() {
    const backup = await base.buildBackup();
    return schema.normalizeBackup(backup);
  }

  async function importBackup(input, mode = "merge") {
    const { backup, meta } = normalizedValidation(input);
    if (!["merge", "replace"].includes(mode)) throw new Error("Choose Merge or Replace before importing.");

    return withIdleDataLock(`backup-${mode}`, async () => {
      // Capture rollback data only after the operation owns the data lock and has
      // proven Queue idle. This gives the import one stable local baseline. Merge
      // reuses this exact snapshot instead of immediately reading the same large
      // video/detail/history stores for a second time.
      const [previousDatabase, previousStorage] = await Promise.all([
        base.readStores(),
        base.storagePayload()
      ]);
      let databaseCommitted = false;
      try {
        if (mode === "replace") await base.replaceDatabase(backup.database);
        else await base.mergeDatabase(backup.database, { currentDatabase: previousDatabase });
        databaseCommitted = true;
        await base.applyBackupStorage(backup.storage ?? {}, { replace: mode === "replace" });
        db.invalidateCatalogueOrder?.();
        return { mode, meta, summary: await base.summary() };
      } catch (error) {
        if (!databaseCommitted) throw error;
        try {
          await base.replaceDatabase(previousDatabase);
          await base.applyBackupStorage(previousStorage, { replace: true });
          db.invalidateCatalogueOrder?.();
        } catch (rollbackError) {
          const fatal = new Error(`Backup import failed and the previous extension data could not be fully restored: ${rollbackError?.message ?? rollbackError}`);
          fatal.code = "backup-import-rollback-failed";
          fatal.cause = error;
          throw fatal;
        }
        const rolledBack = new Error(`Backup import did not complete. Previous extension data was restored. ${error?.message ?? error}`);
        rolledBack.code = error?.code ?? "backup-import-rolled-back";
        rolledBack.cause = error;
        throw rolledBack;
      }
    });
  }

  async function clearDetailedMetadata() {
    return withIdleDataLock("clear-detailed-metadata", () => base.clearDetailedMetadata());
  }

  async function clearEntireCatalogue() {
    return withIdleDataLock("clear-entire-catalogue", () => base.clearEntireCatalogue());
  }

  async function exportBackup() {
    return withIdleDataLock("export-backup", async () => {
      const backup = await safeBuildBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      anchor.href = url;
      anchor.download = `rule34video-media-filter-${stamp}.r34mfbackup`;
      anchor.hidden = true;
      document.body.append(anchor);
      try { anchor.click(); }
      finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      return backup;
    });
  }

  async function replaceDatabase(payload) {
    const normalized = schema.normalizeDatabase(payload);
    return withIdleDataLock("replace-database", () => base.replaceDatabase(normalized));
  }

  async function mergeDatabase(payload) {
    const normalized = schema.normalizeDatabase(payload);
    return withIdleDataLock("merge-database", () => base.mergeDatabase(normalized));
  }

  app.modules.settingsData = Object.freeze({
    ...base,
    validateBackup: normalizedValidation,
    readBackupFile,
    buildBackup: safeBuildBackup,
    importBackup,
    replaceDatabase,
    mergeDatabase,
    clearDetailedMetadata,
    clearEntireCatalogue,
    exportBackup,
    withIdleDataLock
  });
})();
