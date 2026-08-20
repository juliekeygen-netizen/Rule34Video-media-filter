(() => {
  "use strict";
  const app = globalThis.R34MF;
  const constants = app?.modules.constants, browserApi = app?.modules.browserApi, engine = app?.modules.filterEngine;
  if (!app || !constants || !browserApi || !engine) throw new Error("R34MF filter dependencies must load before filter state.");
  const KEY = constants.storageKeys.filterState;
  const copy = engine.clone;
  const defaultPreset = () => ({ id: "preset-default", name: "Default", createdAt: 0, updatedAt: 0, filters: engine.createEmpty() });
  function uniqueName(name, presets, exceptId = null) { const used = new Set(presets.filter((preset) => preset.id !== exceptId).map((preset) => preset.name.toLocaleLowerCase())); let candidate = String(name ?? "").trim(); if (!candidate) return null; if (!used.has(candidate.toLocaleLowerCase())) return candidate; let number = 2; while (used.has(`${candidate} (${number})`.toLocaleLowerCase())) number += 1; return `${candidate} (${number})`; }
  function normalize(raw = {}) { const presets = Array.isArray(raw.presets) && raw.presets.length ? raw.presets.map((preset, index) => ({ id: String(preset.id || (index ? engine.id("preset") : "preset-default")), name: String(preset.name || `Preset ${index + 1}`).trim() || `Preset ${index + 1}`, createdAt: Number(preset.createdAt) || 0, updatedAt: Number(preset.updatedAt) || 0, filters: engine.normalize(preset.filters) })) : [defaultPreset()]; const activePresetId = presets.some((preset) => preset.id === raw.activePresetId) ? raw.activePresetId : presets[0].id; return { version: 1, activePresetId, presets }; }
  // Keep configuration behind a frozen public API.  Freezing a state object whose
  // methods assign its own `value` property makes the first restore throw in strict
  // mode, which previously stopped controller startup after settings had loaded.
  let currentValue = normalize();
  const api = {
    get value() { return currentValue; },
    async load() { const stored = await browserApi.storageLocal.get(KEY); currentValue = normalize(stored[KEY]); return currentValue; },
    async save(next) { currentValue = normalize(next); await browserApi.storageLocal.set({ [KEY]: currentValue }); return currentValue; },
    active() { return currentValue.presets.find((preset) => preset.id === currentValue.activePresetId) ?? currentValue.presets[0]; },
    async commitFilters(filters) { const now = Date.now(), active = api.active(); return api.save({ ...currentValue, presets: currentValue.presets.map((preset) => preset.id === active.id ? { ...preset, filters: engine.normalize(filters), updatedAt: now } : preset) }); },
    async select(id) { return api.save({ ...currentValue, activePresetId: currentValue.presets.some((preset) => preset.id === id) ? id : api.active().id }); },
    async create(name) { const resolved = uniqueName(name, currentValue.presets); if (!resolved) throw new Error("Preset name is required."); const preset = { id: engine.id("preset"), name: resolved, createdAt: Date.now(), updatedAt: Date.now(), filters: copy(api.active().filters) }; return api.save({ ...currentValue, activePresetId: preset.id, presets: [...currentValue.presets, preset] }); },
    async rename(id, name) { const resolved = uniqueName(name, currentValue.presets, id); if (!resolved) throw new Error("Preset name is required."); return api.save({ ...currentValue, presets: currentValue.presets.map((preset) => preset.id === id ? { ...preset, name: resolved, updatedAt: Date.now() } : preset) }); },
    async duplicate(id) { const original = currentValue.presets.find((preset) => preset.id === id) ?? api.active(); const preset = { ...copy(original), id: engine.id("preset"), name: uniqueName(`${original.name} copy`, currentValue.presets), createdAt: Date.now(), updatedAt: Date.now() }; return api.save({ ...currentValue, activePresetId: preset.id, presets: [...currentValue.presets, preset] }); },
    async remove(id) { if (currentValue.presets.length < 2) return currentValue; const index = currentValue.presets.findIndex((preset) => preset.id === id); const presets = currentValue.presets.filter((preset) => preset.id !== id); return api.save({ ...currentValue, presets, activePresetId: currentValue.activePresetId === id ? presets[Math.max(0, index - 1)].id : currentValue.activePresetId }); }
  };
  app.modules.filterState = Object.freeze(api);
})();
