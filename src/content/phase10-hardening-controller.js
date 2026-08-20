(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  if (!app || !controller) throw new Error("R34MF subscriptions controller must load before Phase 10 lifecycle hardening.");

  controller.phase10Generation = 0;
  controller.phase10LocalRenderEpoch = 0;
  controller.phase10FilterOpenEpoch = 0;
  controller.phase10PageHidden = false;
  controller.phase10BfCache = false;

  function current(instance, snapshot) {
    return instance.started === true
      && instance.phase10Generation === snapshot.generation
      && instance.revision === snapshot.revision
      && instance.root === snapshot.root
      && snapshot.root?.isConnected === true;
  }

  const baseBindLifecycle = controller.bindLifecycle;
  controller.bindLifecycle = function bindLifecycle(...args) {
    const result = baseBindLifecycle.apply(this, args);
    // Phase 1 intentionally used zero-argument handlers. Phase 10 needs the
    // PageTransitionEvent.persisted bit so BFCache can be handled deliberately.
    if (this.boundPageHide) window.removeEventListener("pagehide", this.boundPageHide);
    if (this.boundPageShow) window.removeEventListener("pageshow", this.boundPageShow);
    this.boundPageHide = (event) => this.pauseForPageHide(event);
    this.boundPageShow = (event) => this.resumeFromPageShow(event);
    window.addEventListener("pagehide", this.boundPageHide);
    window.addEventListener("pageshow", this.boundPageShow);
    return result;
  };

  const basePauseForPageHide = controller.pauseForPageHide;
  controller.pauseForPageHide = function pauseForPageHide(event) {
    this.phase10PageHidden = true;
    this.phase10BfCache = event?.persisted === true;
    this.phase10Generation += 1;
    this.phase10LocalRenderEpoch += 1;
    this.phase10FilterOpenEpoch += 1;
    // Invalidate queued microtask work without destroying durable JobManager/DB
    // state. A non-BFCache unload will be recovered from IndexedDB on next load;
    // a BFCache restore keeps the same page runtime and reconciles below.
    this.revision += 1;
    this.reconcileQueued = false;
    return basePauseForPageHide.call(this, event);
  };

  const baseResumeFromPageShow = controller.resumeFromPageShow;
  controller.resumeFromPageShow = function resumeFromPageShow(event) {
    this.phase10PageHidden = false;
    this.phase10BfCache = event?.persisted === true;
    this.phase10Generation += 1;
    const result = baseResumeFromPageShow.call(this, event);
    // Native/KVS DOM may have been restored from BFCache with a different
    // insertion block. Running reconciliation a second time is coalesced by the
    // controller and is intentionally cheaper than trusting stale geometry.
    if (event?.persisted === true) this.scheduleReconcile();
    return result;
  };

  controller.openFilters = async function openFilters() {
    if (!this.root?.isConnected || this.phase10PageHidden) return;
    const epoch = ++this.phase10FilterOpenEpoch;
    const snapshot = { generation: this.phase10Generation, revision: this.revision, root: this.root };
    const activePreset = app.modules.filterState.active();
    const catalogue = this.state.catalogue ?? {};
    const coverage = { detailed: catalogue.detailedCount ?? 0, total: catalogue.indexedCount ?? 0 };
    let vocabulary = {};
    try {
      const source = await app.modules.db.getAllLocalRecords();
      if (!current(this, snapshot) || epoch !== this.phase10FilterOpenEpoch) return;
      for (const field of ["tags", "categories", "artist", "uploader"]) {
        vocabulary[field] = {
          ...app.modules.filterEngine.vocabulary(source.records, source.detailsById, field),
          total: source.records.length
        };
      }
    } catch {
      if (!current(this, snapshot) || epoch !== this.phase10FilterOpenEpoch) return;
      vocabulary = {};
    }
    if (!current(this, snapshot) || epoch !== this.phase10FilterOpenEpoch) return;
    const root = snapshot.root;
    const preset = app.modules.filterState.active();
    const host = app.modules.filtersUi.render({
      root,
      filters: this.state.filters ?? preset.filters,
      preset,
      presets: app.modules.filterState.value.presets,
      coverage,
      vocabulary,
      modal: this.filterModal
    }, (action, trigger) => this.handleIntent(action, trigger), this.filterView ?? { view: "parent" });
    this.placeTool(host, this.resolveToolAnchor("filters"));
    app.modules.filterModals?.render({
      root,
      filters: this.state.filters ?? preset.filters,
      coverage,
      vocabulary,
      modal: this.filterModal,
      preset,
      presets: app.modules.filterState.value.presets
    }, (action, payload) => this.handleIntent(action, payload));
    app.modules.accessibilityHardening?.decorateRoot(root);
  };

  controller.renderLocal = async function renderLocal() {
    if (!this.root?.isConnected || this.state.mode !== "local" || this.phase10PageHidden) return;
    const epoch = ++this.phase10LocalRenderEpoch;
    const snapshot = { generation: this.phase10Generation, revision: this.revision, root: this.root };
    try {
      const source = await app.modules.db.getAllLocalRecords();
      if (!current(this, snapshot) || epoch !== this.phase10LocalRenderEpoch || this.state.mode !== "local") return;

      const filters = this.state.filters ?? app.modules.filterEngine.createEmpty();
      const now = Date.now();
      const matches = [];
      let unknownCount = 0;
      for (const record of source.records) {
        const result = app.modules.filterEngine.evaluate(record, source.detailsById.get(record.videoId), filters, now);
        if (result === app.modules.filterEngine.TRUE) matches.push(record);
        else if (result === app.modules.filterEngine.UNKNOWN) unknownCount += 1;
      }
      const sortedMatches = app.modules.sorter.sort(matches, source.detailsById, this.state.sort);
      if (!current(this, snapshot) || epoch !== this.phase10LocalRenderEpoch) return;

      const result = await app.modules.localGrid.render(snapshot.root, {
        page: this.state.localPage,
        pageSize: app.modules.settings.value.videosPerPage,
        previews: app.modules.settings.value.animatedHoverPreviews,
        columns: app.modules.settings.value.videoColumns,
        aspectRatio: app.modules.settings.value.thumbnailAspectRatio,
        onPage: (localPage) => this.setUiState({ localPage }),
        records: sortedMatches,
        guard: () => current(this, snapshot) && epoch === this.phase10LocalRenderEpoch && this.state.mode === "local"
      });
      if (!current(this, snapshot) || epoch !== this.phase10LocalRenderEpoch || this.state.mode !== "local") return;
      if (result.page !== this.state.localPage) {
        await this.setUiState({ localPage: result.page });
        return;
      }
      this.state = {
        ...this.state,
        showingCount: result.total,
        unknownCount,
        localRendererActive: true,
        filterCount: app.modules.filterEngine.countApplied(filters)
      };
      this.updateShell();
    } catch (error) {
      if (!current(this, snapshot) || epoch !== this.phase10LocalRenderEpoch) return;
      this.state = { ...this.state, localRendererActive: false };
      this.updateShell();
      app.modules.logger?.warn("local-render-failed", { message: error?.message ?? String(error) });
    }
  };

  const baseOpenSort = controller.openSort;
  controller.openSort = function openSort(...args) {
    const result = baseOpenSort.apply(this, args);
    app.modules.accessibilityHardening?.decorateRoot(this.root);
    return result;
  };

  const baseCleanup = controller.cleanup;
  controller.cleanup = function cleanup(...args) {
    this.phase10Generation += 1;
    this.phase10LocalRenderEpoch += 1;
    this.phase10FilterOpenEpoch += 1;
    this.phase10PageHidden = false;
    this.phase10BfCache = false;
    this.reconcileQueued = false;
    this.queueUiState = null;
    this.filterView = null;
    this.filterModal = null;
    this.queueTrigger = null;
    return baseCleanup.apply(this, args);
  };

  app.modules.phase10HardeningController = Object.freeze({
    current,
    snapshot: () => ({
      generation: controller.phase10Generation,
      localRenderEpoch: controller.phase10LocalRenderEpoch,
      filterOpenEpoch: controller.phase10FilterOpenEpoch,
      pageHidden: controller.phase10PageHidden,
      bfCache: controller.phase10BfCache,
      revision: controller.revision,
      started: controller.started,
      mounted: controller.mounted
    })
  });
})();
