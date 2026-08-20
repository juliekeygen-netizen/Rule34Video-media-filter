(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const phase10 = app?.modules.phase10HardeningController;
  if (!app || !controller || !phase10) {
    throw new Error("R34MF Phase 10 controller must load before filter vocabulary performance hardening.");
  }

  const ENTITY_FIELDS = Object.freeze(["artist", "uploader", "categories", "tags"]);
  const ENTITY_SET = new Set(ENTITY_FIELDS);
  // Entity picker search is client-side. The picker itself only renders a bounded
  // result rail, but it must receive the complete local vocabulary so searches
  // and selected-value counts are not limited to the globally most-common 60.
  const MODAL_VOCABULARY_LIMIT = Number.MAX_SAFE_INTEGER;

  function collectEntityFields(items, result = new Set()) {
    for (const item of items ?? []) {
      if (item?.kind === "group") collectEntityFields(item.items, result);
      else if (ENTITY_SET.has(item?.field)) result.add(item.field);
    }
    return result;
  }

  function requiredVocabularyFields(modal) {
    if (modal?.type === "normal" && ENTITY_SET.has(modal.field)) return [modal.field];
    if (modal?.type === "advanced") return [...collectEntityFields(modal.draft?.items)];
    return [];
  }

  function current(instance, snapshot, epoch) {
    return phase10.current(instance, snapshot)
      && epoch === instance.phase10FilterOpenEpoch
      && instance.phase10PageHidden !== true;
  }

  function preserveLiveAdvancedDraft(instance = controller) {
    if (instance.filterModal?.type !== "advanced" || !instance.root?.isConnected) return null;
    const editor = instance.root.querySelector?.(":scope > .r34mf-modal-layer .r34mf-advanced-editor")
      ?? instance.root.querySelector?.(".r34mf-advanced-editor");
    const liveDraft = editor?.__r34mfAdvancedDebug?.getDraft?.();
    if (!liveDraft) return null;
    instance.filterModal = { ...instance.filterModal, draft: liveDraft };
    return liveDraft;
  }

  controller.openFilters = async function openFiltersWithoutEagerVocabulary() {
    if (!this.root?.isConnected || this.phase10PageHidden) return;
    const epoch = ++this.phase10FilterOpenEpoch;
    const snapshot = { generation: this.phase10Generation, revision: this.revision, root: this.root };
    const catalogue = this.state.catalogue ?? {};
    const coverage = { detailed: catalogue.detailedCount ?? 0, total: catalogue.indexedCount ?? 0 };
    const fields = requiredVocabularyFields(this.filterModal);
    let vocabulary = {};

    // The parent Filters popover, Presets, and non-entity editors do not consume
    // entity vocabulary. Avoiding four full faceted scans here keeps normal UI
    // interactions independent from catalogue size.
    if (fields.length) {
      try {
        const source = await app.modules.db.getAllLocalRecords();
        if (!current(this, snapshot, epoch)) return;
        for (const field of fields) {
          vocabulary[field] = {
            ...app.modules.filterEngine.vocabulary(
              source.records,
              source.detailsById,
              field,
              "",
              MODAL_VOCABULARY_LIMIT
            ),
            total: source.records.length
          };
        }
      } catch {
        if (!current(this, snapshot, epoch)) return;
        vocabulary = {};
      }
    }

    if (!current(this, snapshot, epoch)) return;
    const root = snapshot.root;
    const preset = app.modules.filterState.active();
    const membership = app.modules.subscriptionMembership?.publicState?.() ?? null;
    const host = app.modules.filtersUi.render({
      root,
      filters: this.state.filters ?? preset.filters,
      preset,
      presets: app.modules.filterState.value.presets,
      coverage,
      vocabulary,
      membership,
      modal: this.filterModal
    }, (action, trigger) => this.handleIntent(action, trigger), this.filterView ?? { view: "parent" });
    this.placeTool(host, this.resolveToolAnchor("filters"));
    app.modules.filterModals?.render({
      root,
      filters: this.state.filters ?? preset.filters,
      coverage,
      vocabulary,
      membership,
      modal: this.filterModal,
      preset,
      presets: app.modules.filterState.value.presets
    }, (action, payload) => this.handleIntent(action, payload));
    app.modules.accessibilityHardening?.decorateRoot(root);
  };

  // Advanced can switch a rule into an entity field without closing the modal.
  // Load that vocabulary lazily after the field becomes active. The Advanced
  // editor owns its draft until Apply, so snapshot that live draft before the
  // modal is reconstructed for the newly-required vocabulary.
  document.addEventListener("change", (event) => {
    if (controller.filterModal?.type !== "advanced") return;
    const select = event.target?.closest?.(".r34mf-advanced-field .r34mf-filter-select");
    if (!select || !controller.root?.contains?.(select) || !ENTITY_SET.has(select.value)) return;
    queueMicrotask(() => {
      if (controller.filterModal?.type !== "advanced" || !controller.root?.isConnected) return;
      preserveLiveAdvancedDraft(controller);
      controller.openFilters();
    });
  }, true);

  app.modules.filterVocabularyPerformance = Object.freeze({
    ENTITY_FIELDS,
    MODAL_VOCABULARY_LIMIT,
    collectEntityFields,
    requiredVocabularyFields,
    preserveLiveAdvancedDraft
  });
})();
