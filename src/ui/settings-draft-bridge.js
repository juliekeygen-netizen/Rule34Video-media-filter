(() => {
  "use strict";

  const app = globalThis.R34MF;
  const settings = app?.modules.settings;
  if (!app || !settings) throw new Error("R34MF settings must load before Settings draft bridge.");

  const baseNormalize = settings.normalize;
  let currentDraft = null;

  settings.normalize = function normalizeWithDraftCapture(raw = {}) {
    if (raw && typeof raw === "object" && raw !== settings.value) currentDraft = raw;
    return baseNormalize(raw);
  };

  app.modules.settingsDraftBridge = Object.freeze({ current: () => currentDraft });
})();
