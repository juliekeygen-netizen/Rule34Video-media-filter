(() => {
  "use strict";

  const app = globalThis.R34MF;
  const data = app?.modules.settingsData;
  const schema = app?.modules.backupSchema;
  const settings = app?.modules.settings;
  const constants = app?.modules.constants;
  const browserApi = app?.modules.browserApi;
  if (!app || !data || !schema || !settings || !constants || !browserApi) {
    throw new Error("R34MF Settings data/schema must load before portable Settings preference sync.");
  }

  const SETTINGS_KEY = constants.storageKeys.settings;
  const DEVICE_LOCAL_PRESENTATION_KEYS = Object.freeze([
    "videosPerPage",
    "videoColumns",
    "thumbnailAspectRatio",
    "artistThumbnailLabels",
    "artistThumbnailLabelSize"
  ]);

  function stripDeviceLocalPresentationSettings(raw) {
    const portable = { ...settings.normalize(raw ?? {}) };
    for (const key of DEVICE_LOCAL_PRESENTATION_KEYS) delete portable[key];
    return portable;
  }

  function pickDeviceLocalPresentationSettings(raw) {
    const normalized = settings.normalize(raw ?? settings.value);
    return Object.fromEntries(DEVICE_LOCAL_PRESENTATION_KEYS.map((key) => [key, normalized[key]]));
  }

  async function currentStoredSettings() {
    const stored = await browserApi.storageLocal.get(SETTINGS_KEY);
    return settings.normalize(stored?.[SETTINGS_KEY] ?? settings.value);
  }

  async function currentPortableSettings() {
    return stripDeviceLocalPresentationSettings(await currentStoredSettings());
  }

  async function settingsForImport(rawSettings, { replace = false } = {}) {
    const current = await currentStoredSettings();
    const deviceLocal = pickDeviceLocalPresentationSettings(current);
    if (rawSettings === null || rawSettings === undefined) {
      if (!replace) return null;
      return settings.normalize({ ...settings.normalize({}), ...deviceLocal });
    }
    const portable = stripDeviceLocalPresentationSettings(rawSettings);
    return settings.normalize({ ...portable, ...deviceLocal });
  }

  async function storagePayload() {
    const payload = await data.storagePayload();
    return { ...payload, settings: await currentPortableSettings() };
  }

  async function buildBackup() {
    const backup = await data.buildBackup();
    return {
      ...backup,
      storage: {
        ...(backup?.storage ?? {}),
        settings: await currentPortableSettings()
      }
    };
  }

  async function applyBackupStorage(storagePayload = {}, options = {}) {
    const nextSettings = await settingsForImport(storagePayload?.settings, options);
    const prepared = { ...storagePayload };
    if (nextSettings) prepared.settings = nextSettings;

    const result = await data.applyBackupStorage(prepared, options);
    // Credentials stay device-local, while portable Settings (including the user's
    // Automatic sign-in enable/disable preference) still survive backup/Cloud.
    // Local grid density/shape/artist-label presentation stays specific to this device.
    if (nextSettings) {
      await browserApi.storageLocal.set({ [SETTINGS_KEY]: nextSettings });
      await settings.load();
    }
    return result;
  }

  function normalizePortableSettings(rawSettings) {
    const portable = stripDeviceLocalPresentationSettings(rawSettings);
    portable.automaticSignIn = rawSettings?.automaticSignIn === true;
    return portable;
  }

  function normalizeStorage(raw) {
    const normalized = schema.normalizeStorage(raw);
    if (normalized?.settings && raw?.settings !== null && raw?.settings !== undefined) {
      normalized.settings = normalizePortableSettings({
        ...normalized.settings,
        automaticSignIn: raw.settings?.automaticSignIn === true
      });
    }
    return normalized;
  }

  function normalizeBackup(backup) {
    const normalized = schema.normalizeBackup(backup);
    const rawSettings = backup?.storage?.settings;
    if (normalized?.storage?.settings && rawSettings !== null && rawSettings !== undefined) {
      normalized.storage.settings = normalizePortableSettings({
        ...normalized.storage.settings,
        automaticSignIn: rawSettings?.automaticSignIn === true
      });
    }
    return normalized;
  }

  app.modules.settingsData = Object.freeze({
    ...data,
    DEVICE_LOCAL_PRESENTATION_KEYS,
    stripDeviceLocalPresentationSettings,
    pickDeviceLocalPresentationSettings,
    settingsForImport,
    storagePayload,
    buildBackup,
    applyBackupStorage
  });

  app.modules.backupSchema = Object.freeze({
    ...schema,
    normalizeStorage,
    normalizeBackup
  });
})();
