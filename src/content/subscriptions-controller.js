(() => {
  "use strict";

  const app = globalThis.R34MF;
  const constants = app?.modules.constants;
  if (!app || !constants) {
    throw new Error("R34MF constants must load before subscriptions controller.");
  }

  function toUrl(locationLike) {
    if (locationLike instanceof URL) {
      return locationLike;
    }
    if (typeof locationLike === "string") {
      return new URL(locationLike, "https://rule34video.com");
    }
    return new URL(locationLike.href);
  }

  function isTargetPage(locationLike = window.location) {
    const url = toUrl(locationLike);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return ["rule34video.com", "www.rule34video.com"].includes(url.hostname) && path === "/my/subscriptions";
  }

  function isOwnedNode(node) {
    if (node?.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    return node.dataset?.r34mfOwned === "true" || Boolean(node.closest?.("[data-r34mf-owned='true']"));
  }

  function nodeAffectsInsertion(node) {
    if (node?.nodeType !== Node.ELEMENT_NODE || isOwnedNode(node)) {
      return false;
    }
    const selectors = [
      constants.selectors.subscriptionsBlock,
      constants.selectors.subscriptionsItems
    ].join(", ");
    return node.matches?.(selectors) === true || Boolean(node.querySelector?.(selectors));
  }

  function mutationIsRelevant(records) {
    return records.some((record) => {
      if (record.type !== "childList" || isOwnedNode(record.target)) {
        return false;
      }
      return [...record.addedNodes, ...record.removedNodes].some(nodeAffectsInsertion);
    });
  }

  function findNativeParts(documentLike = document) {
    const block = documentLike.querySelector(constants.selectors.subscriptionsBlock);
    if (!block) {
      return null;
    }
    const grid = block.querySelector(constants.selectors.subscriptionsItems)
      ?? documentLike.querySelector(constants.selectors.subscriptionsItems);
    if (!grid) {
      return null;
    }
    const heading = [...block.querySelectorAll(constants.selectors.subscriptionsHeading)]
      .find((candidate) => /videos\s+from\s+my\s+subscriptions/i.test(candidate.textContent ?? ""))
      ?? null;
    const pagination = block.querySelector(constants.selectors.subscriptionsPagination)
      ?? documentLike.querySelector(constants.selectors.subscriptionsPagination);
    return { block, grid, heading, pagination };
  }

  function rootIsAtInsertionPoint(root, grid) {
    return root?.isConnected === true && root.nextElementSibling === grid;
  }
  function rootBelongsToRuntime(root, token) { return Boolean(root?.dataset?.r34mfRuntime && root.dataset.r34mfRuntime === token); }

  function queueUiTransition(current, action) {
    const state = {
      queueOpen: current?.queueOpen === true,
      queuePage: current?.queuePage ?? "root",
      collapsed: current?.collapsed === true
    };
    if (action === "queue") return { ...state, queueOpen: !state.queueOpen, queuePage: "root" };
    if (action === "queue-close") return { ...state, queueOpen: false, queuePage: "root" };
    if (action === "queue-back") return { ...state, queueOpen: true, queuePage: "root" };
    if (action === "queue-catalogue") return { ...state, queueOpen: true, queuePage: "catalogue" };
    if (action === "queue-details") return { ...state, queueOpen: true, queuePage: "details" };
    if (action === "queue-maintenance") return { ...state, queueOpen: true, queuePage: "maintenance" };
    if (action === "queue-full-rescan") return { ...state, queueOpen: true, queuePage: "rescan" };
    if (action === "toggle-collapse") {
      const collapsed = !state.collapsed;
      return { queueOpen: collapsed ? false : state.queueOpen, queuePage: collapsed ? "root" : state.queuePage, collapsed };
    }
    return null;
  }

  function filtersNeedMembership(filters) {
    if (filters?.detailed?.subscriptionsOnly?.enabled === true) return true;
    const inspect = (items) => (items ?? []).some((item) => item?.enabled !== false && (item.kind === "group" ? inspect(item.items) : item.field === "subscriptionsOnly"));
    return filters?.advanced?.enabled === true && inspect(filters.advanced.items);
  }

  const controller = {
    started: false,
    mounted: false,
    revision: 0,
    root: null,
    observer: null,
    observerTarget: null,
    reconcileQueued: false,
    routeTimer: null,
    lastUrl: null,
    state: { mode: "native", collapsed: false, localPage: 1, sort: { field: "uploadDate", direction: "desc" }, filters: null, canFilter: false, canSort: false, catalogue: { hasCatalogue: false }, membership: null },
    filterView: null,
    filterModal: null,
    queueOpen: false,
    queuePage: "root",
    queueTrigger: null,
    queueUiState: null,
    recentHistory: [],
    detailRefreshTimer: null,
    runtimeToken: null,
    runtimeUnsubscribers: [],

    isTargetPage,
    findNativeParts,
    mutationIsRelevant,
    rootIsAtInsertionPoint,
    rootBelongsToRuntime,
    queueUiTransition,

    async start() {
      if (this.started) {
        this.onRouteMaybeChanged();
        return;
      }
      this.started = true;
      app.modules.logger?.debug?.("controller-starting", { route: globalThis.location?.pathname ?? null });
      this.runtimeToken = globalThis.crypto?.randomUUID?.() ?? `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      this.bindLifecycle();
      await this.restoreState();
      this.runtimeUnsubscribers = [
        app.modules.catalogueScanner.subscribe((catalogue) => this.onCatalogueState(catalogue)),
        app.modules.jobManager.subscribe(() => { this.renderQueue(); this.updateShell(); }),
        app.modules.db.subscribeCatalogueChanges(() => { if (this.state.mode === "local") this.renderLocal(); }),
        app.modules.db.subscribeDetailChanges?.(() => this.scheduleDetailRefresh()),
        app.modules.subscriptionMembership?.subscribe?.((membership) => {
          this.state = { ...this.state, membership };
          if (this.state.mode === "local" && (membership.status === "complete" || membership.status === "failed")) this.renderLocal();
          const status = this.root?.querySelector?.("[data-membership-status]");
          if (status && this.filterModal?.field === "subscriptionsOnly") {
            status.classList.toggle("is-error", membership.status === "failed");
            status.textContent = membership.status === "refreshing" ? "Refreshing current subscriptions…"
              : membership.status === "failed" ? "Could not refresh subscriptions."
                : membership.snapshot ? `${membership.snapshot.total.toLocaleString()} current subscriptions` : "Current subscriptions unavailable.";
          }
        }),
        app.modules.settings.subscribe?.((current, previous, source) => {
          const changed = Object.keys(current).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(previous?.[key]));
          app.modules.logger?.debug?.("settings-applied", { source, changed });
          app.modules.jobManager.pump();
        })
      ].filter((unsubscribe) => typeof unsubscribe === "function");
      app.modules.jobManager.registerHandler("initial-scan", (_job, context) => this.runCatalogueJob("initial-scan", context));
      app.modules.jobManager.registerHandler("full-rescan", (_job, context) => this.runCatalogueJob("full-rescan", context));
      app.modules.jobManager.registerHandler("smart-update", (job, context) => this.runCatalogueJob("smart-update", context, {
        updateMode: job.progress?.updateMode === "recent" ? "recent" : "smart"
      }));
      app.modules.jobManager.registerHandler("detail-enrichment", async (_job, context) => {
        const result = await app.modules.detailScanner.run({ signal: context.signal, onProgress: context.updateProgress });
        await this.refreshDetailData();
        return result;
      });
      await this.refreshCatalogueState();
      this.onRouteMaybeChanged();
    },

    async mount() {
      return this.start();
    },

    async restoreState() {
      const stored = await app.modules.uiState.load();
      const filterState = await app.modules.filterState.load();
      this.state = {
        ...this.state,
        ...stored,
        filters: app.modules.filterState.active().filters,
        activePresetId: filterState.activePresetId
      };
    },

    bindLifecycle() {
      this.boundRouteChange = () => this.onRouteMaybeChanged();
      this.boundPageHide = () => this.pauseForPageHide();
      this.boundPageShow = () => this.resumeFromPageShow();
      this.boundKeyDown = (event) => this.onKeyDown(event);
      this.boundDocumentPointerDown = (event) => this.onDocumentPointerDown(event);
      this.boundWindowResize = () => this.repositionOpenTool();
      window.addEventListener("popstate", this.boundRouteChange);
      window.addEventListener("hashchange", this.boundRouteChange);
      window.addEventListener("pagehide", this.boundPageHide);
      window.addEventListener("pageshow", this.boundPageShow);
      document.addEventListener("keydown", this.boundKeyDown);
      document.addEventListener("pointerdown", this.boundDocumentPointerDown);
      window.addEventListener("resize", this.boundWindowResize);
      this.routeTimer = window.setInterval(() => this.onRouteMaybeChanged(), 750);
    },

    unbindLifecycle() {
      window.removeEventListener("popstate", this.boundRouteChange);
      window.removeEventListener("hashchange", this.boundRouteChange);
      window.removeEventListener("pagehide", this.boundPageHide);
      window.removeEventListener("pageshow", this.boundPageShow);
      document.removeEventListener("keydown", this.boundKeyDown);
      document.removeEventListener("pointerdown", this.boundDocumentPointerDown);
      window.removeEventListener("resize", this.boundWindowResize);
      if (this.routeTimer !== null) {
        window.clearInterval(this.routeTimer);
        this.routeTimer = null;
      }
    },

    onRouteMaybeChanged() {
      const currentUrl = window.location.href;
      const target = isTargetPage();
      if (!target) {
        this.lastUrl = currentUrl;
        this.unmount();
        return;
      }
      if (this.lastUrl !== currentUrl || !this.mounted || this.needsReconcile()) {
        this.lastUrl = currentUrl;
        this.scheduleReconcile();
      }
    },

    needsReconcile() {
      const parts = findNativeParts();
      return !parts || !rootIsAtInsertionPoint(this.root, parts.grid);
    },

    pauseForPageHide() {
      this.disconnectObserver();
    },

    resumeFromPageShow() {
      this.onRouteMaybeChanged();
      this.scheduleReconcile();
    },

    scheduleReconcile() {
      if (this.reconcileQueued || !this.started) {
        return;
      }
      this.reconcileQueued = true;
      const revision = this.revision;
      queueMicrotask(() => {
        this.reconcileQueued = false;
        if (revision !== this.revision || !this.started) {
          return;
        }
        this.reconcile();
      });
    },

    reconcile() {
      if (!isTargetPage()) {
        this.unmount();
        return;
      }
      const parts = findNativeParts();
      if (!parts) {
        this.mounted = false;
        this.disconnectObserver();
        return;
      }

      const roots = [...document.querySelectorAll(constants.selectors.extensionRoot)];
      let root = roots.find((candidate) => rootIsAtInsertionPoint(candidate, parts.grid)) ?? roots[0] ?? null;
      for (const duplicate of roots) {
        if (duplicate !== root) {
          duplicate.remove();
        }
      }

      if (!root) {
        root = document.createElement("div");
        root.dataset.r34mfRoot = "subscriptions";
        root.dataset.r34mfOwned = "true";
        parts.grid.parentNode.insertBefore(root, parts.grid);
      } else if (!rootIsAtInsertionPoint(root, parts.grid)) {
        parts.grid.parentNode.insertBefore(root, parts.grid);
      }
      // DOM survives extension reloads, but closures/listeners from the old runtime do
      // not become current merely because a historical boolean remains on the root.
      if (root.dataset.r34mfRuntime && root.dataset.r34mfRuntime !== this.runtimeToken) {
        const replacement = root.cloneNode(false);
        replacement.dataset.r34mfRoot = "subscriptions";
        replacement.dataset.r34mfOwned = "true";
        root.parentNode.replaceChild(replacement, root);
        root = replacement;
      }
      root.dataset.r34mfRuntime = this.runtimeToken;
      root.dataset.r34mfBuild = app.build?.id ?? "dev";
      if (root.dataset.r34mfShellBound !== this.runtimeToken) {
        app.modules.shell.mount(root, this.state, (action, trigger) => this.handleIntent(action, trigger));
        root.dataset.r34mfShellBound = this.runtimeToken;
      }

      this.root = root;
      this.mounted = true;
      app.modules.subscriptionMembership?.attach?.(document);
      app.modules.subscriptionMembership?.ensureFresh?.({ documentLike: document })?.catch((error) => {
        if (error?.name !== "AbortError") app.modules.logger?.warn?.("subscription-membership-mount-refresh-failed", { message: error?.message });
      });
      this.updateShell();
      this.applyModeVisibility(parts);
      this.attachObserver(parts.block);
    },

    attachObserver(block) {
      const target = block.parentElement ?? block;
      if (this.observerTarget === target && this.observer) {
        return;
      }
      this.disconnectObserver();
      this.observer = new MutationObserver((records) => {
        if (mutationIsRelevant(records)) {
          this.scheduleReconcile();
        }
      });
      this.observer.observe(target, { childList: true, subtree: true });
      this.observerTarget = target;
    },

    disconnectObserver() {
      this.observer?.disconnect();
      this.observer = null;
      this.observerTarget = null;
    },

    async runCatalogueJob(kind, context, options = {}) {
      const requestedMode = options.updateMode === "recent" ? "recent" : "smart";
      const runner = requestedMode === "recent" ? app.modules.catalogueScanner.runRecentUpdate : app.modules.catalogueScanner.runSmartUpdate;
      const result = kind === "smart-update"
        ? await runner({ documentLike: document, signal: context.signal, onProgress: context.updateProgress })
        : await app.modules.catalogueScanner.run({ documentLike: document, fullRescan: kind === "full-rescan", signal: context.signal, onProgress: context.updateProgress });
      const successful = kind === "smart-update" ? result?.smartUpdate?.status === "complete" : result?.scanStatus === "complete";
      app.modules.logger?.debug?.("catalogue-job-result", { kind, updateMode: kind === "smart-update" ? requestedMode : null, successful });
      if (successful) await this.afterSuccessfulCatalogueMutation({ kind, updateMode: requestedMode });
      return result;
    },

    async afterSuccessfulCatalogueMutation({ kind, updateMode = null } = {}) {
      const catalogue = await app.modules.catalogueScanner.refresh();
      this.onCatalogueState(catalogue);
      return this.maybeAutoFetchDetails({ catalogue, source: updateMode === "recent" ? "recent-update" : kind });
    },

    enqueueDetails({ automatic = false } = {}) {
      const catalogue = this.state.catalogue ?? {};
      if (catalogue.catalogueReady !== true) return { accepted: false, reason: "catalogue-unavailable" };
      const outcome = app.modules.jobManager.enqueue({
        kind: "detail-enrichment",
        scopeKey: "details-missing",
        resourceKeys: ["detail-write", "catalogue-reconcile"],
        progress: { completed: 0, processed: 0, total: Math.max(0, Number(catalogue.indexedCount ?? 0) - Number(catalogue.detailedCount ?? 0)), detailedCount: Number(catalogue.detailedCount) || 0, failedCount: 0 }
      });
      if (!outcome.accepted && !automatic) app.modules.logger?.warn("detail-job-not-enqueued", { outcome });
      return outcome;
    },

    async maybeAutoFetchDetails({ catalogue = this.state.catalogue, source = "catalogue-update" } = {}) {
      if (app.modules.settings?.value?.autoFetchMissingDetails !== true) {
        app.modules.logger?.debug?.("automatic-detail-fetch-decision", { source, decision: "disabled" });
        return false;
      }
      const missing = await app.modules.db.getMissingDetailTargets({ limit: 1 });
      if (!missing.length) {
        app.modules.logger?.debug?.("automatic-detail-fetch-decision", { source, decision: "no-missing-details" });
        return false;
      }
      const previousCatalogue = this.state.catalogue;
      this.state = { ...this.state, catalogue: catalogue ?? previousCatalogue };
      const outcome = this.enqueueDetails({ automatic: true });
      app.modules.logger?.debug?.("automatic-detail-fetch-decision", { source, decision: outcome.accepted ? "enqueued" : "skipped", reason: outcome.reason ?? null, missingVideoId: missing[0]?.videoId ?? null });
      return outcome.accepted === true;
    },

    scheduleDetailRefresh() {
      if (this.detailRefreshTimer !== null) return;
      this.detailRefreshTimer = window.setTimeout(() => {
        this.detailRefreshTimer = null;
        this.refreshDetailData().catch((error) => app.modules.logger?.warn("detail-ui-refresh-failed", { message: error?.message }));
      }, 1000);
    },

    async refreshDetailData() {
      if (this.detailRefreshTimer !== null) {
        window.clearTimeout(this.detailRefreshTimer);
        this.detailRefreshTimer = null;
      }
      const catalogue = await app.modules.catalogueScanner.refresh();
      this.recentHistory = await app.modules.db.readRecentHistory();
      this.renderQueue();
      return catalogue;
    },

    async handleIntent(action, trigger) {
      const queueTransition = queueUiTransition({
        queueOpen: this.queueOpen,
        queuePage: this.queuePage,
        collapsed: this.state.collapsed
      }, action);
      if (queueTransition) {
        if (action === "toggle-collapse") {
          if (this.queueOpen && !queueTransition.queueOpen) this.closeQueue({ returnFocus: false, updateShell: false });
          await this.setUiState({ collapsed: queueTransition.collapsed });
          return;
        }
        if (action === "queue") {
          if (!queueTransition.queueOpen) {
            this.closeQueue();
            return;
          }
          this.queueOpen = true;
          this.queuePage = "root";
          this.state = { ...this.state, queueOpen: true };
          this.updateShell();
          this.queueTrigger = this.root?.querySelector("[data-r34mf-action='queue']") ?? trigger;
          this.queueTrigger?.focus({ preventScroll: true });
          return;
        }
        if (!queueTransition.queueOpen) {
          this.closeQueue();
          return;
        }
        this.queueOpen = true;
        this.queuePage = queueTransition.queuePage;
        this.renderQueue();
        return;
      }
      if (action === "set-native") {
        await this.setUiState({ mode: "native" });
        return;
      }
      if (action === "set-local") {
        await this.setUiState({ mode: "local" });
        return;
      }
      if (action === "filters") { if (this.root?.querySelector(":scope > .r34mf-tool-layer")) { this.closeFilters(); return; } this.closeSort(); this.filterView = null; this.openFilters(); return; }
      if (action === "sort") { if (this.root?.querySelector(":scope > .r34mf-sort-surface")) { this.closeSort(); return; } this.closeFilters(); this.openSort(); return; }
      if (action === "disable-all") { await this.commitFilters(app.modules.filterEngine.disableAll(this.state.filters)); this.openFilters(); return; }
      if (action.startsWith("filter-chip-remove:")) { const [, source, field] = action.split(":"); const next = app.modules.filterEngine.clone(this.state.filters); if (source === "advanced") next.advanced.enabled = false; else next[source][field].enabled = false; await this.commitFilters(next); return; }
      if (action === "parent" || action === "modal-cancel") {
        const returnToAdvanced = this.filterModal?.type === "advanced";
        this.filterView = null;
        this.filterModal = null;
        await this.openFilters();
        if (returnToAdvanced) queueMicrotask(() => this.root?.querySelector("[data-filter-source='advanced'] .r34mf-filter-row-main")?.focus({ preventScroll: true }));
        return;
      }
      if (action === "presets") { this.filterModal = { type: "presets" }; this.openFilters(); return; }
      if (action === "preset-create") { try { await app.modules.filterState.create(trigger?.name); await this.useActivePreset(); } catch (error) { this.filterView = { view: "presets", name: trigger?.name ?? "", error: error.message }; this.openFilters(); } return; }
      if (action.startsWith("preset-select:")) { await app.modules.filterState.select(action.slice("preset-select:".length)); await this.useActivePreset(); return; }
      if (action.startsWith("preset-menu:")) { this.filterView = { view: "presets", menuId: action.slice("preset-menu:".length) }; this.openFilters(); return; }
      if (action.startsWith("preset-rename-open:")) { const id = action.slice("preset-rename-open:".length); const preset = app.modules.filterState.value.presets.find((item) => item.id === id); this.filterView = { view: "presets", renameId: id, name: preset?.name ?? "" }; this.openFilters(); return; }
      if (action === "preset-rename-submit") { try { await app.modules.filterState.rename(trigger?.id, trigger?.name); this.filterView = { view: "presets" }; this.openFilters(); } catch (error) { this.filterView = { view: "presets", renameId: trigger?.id, name: trigger?.name ?? "", error: error.message }; this.openFilters(); } return; }
      if (action.startsWith("preset-duplicate:")) { await app.modules.filterState.duplicate(action.slice("preset-duplicate:".length)); await this.useActivePreset(); return; }
      if (action.startsWith("preset-delete:")) { await app.modules.filterState.remove(action.slice("preset-delete:".length)); await this.useActivePreset(); return; }
      if (action.startsWith("filter-toggle:")) { const [, source, field] = action.split(":"); const next = app.modules.filterEngine.clone(this.state.filters), entry = next[source][field]; if (field === "hdAvailable" || entry.enabled || app.modules.filterEngine.configured(field, entry)) { entry.enabled = !entry.enabled; await this.commitFilters(next); this.openFilters(); return; } this.filterModal = { type: "normal", source, field, draft: app.modules.filterDraft.normalDraft(entry, field), enableOnApply: true }; this.openFilters(); return; }
      if (action === "advanced-toggle") { const next = app.modules.filterEngine.clone(this.state.filters); if (next.advanced.enabled || app.modules.filterEngine.hasEffectiveExpression(next.advanced.items)) { next.advanced.enabled = !next.advanced.enabled; await this.commitFilters(next); this.openFilters(); return; } this.filterModal = { type: "advanced", draft: app.modules.filterEngine.clone(next.advanced), enableOnApply: true }; this.openFilters(); return; }
      if (action.startsWith("edit:")) { const [, source, field] = action.split(":"); this.filterModal = { type: "normal", source, field, draft: app.modules.filterDraft.normalDraft(this.state.filters[source][field], field), enableOnApply: false }; this.openFilters(); return; }
      if (action === "filter-apply") { const next = app.modules.filterEngine.clone(this.state.filters), entry = next[trigger.source][trigger.field]; const entity = ["artist", "uploader", "tags", "categories"].includes(trigger.field); entry.value = entity ? trigger.value.value : trigger.value; if (entity) entry.matchMode = trigger.value.matchMode === "all" ? "all" : "any"; if (trigger.enableOnApply) entry.enabled = true; await this.commitFilters(next); this.filterModal = null; this.filterView = null; this.openFilters(); return; }
      if (action === "advanced-apply") {
        const next = app.modules.filterEngine.clone(this.state.filters);
        const hasExpression = app.modules.filterEngine.hasEffectiveExpression(trigger.advanced?.items);
        next.advanced = { ...trigger.advanced, enabled: hasExpression && (this.state.filters.advanced.enabled || trigger.enableOnApply === true) };
        await this.commitFilters(next);
        this.filterModal = null;
        this.filterView = null;
        await this.openFilters();
        queueMicrotask(() => this.root?.querySelector("[data-filter-source='advanced'] .r34mf-filter-row-main")?.focus({ preventScroll: true }));
        return;
      }
      if (action === "advanced") { this.filterModal = { type: "advanced", draft: app.modules.filterEngine.clone(this.state.filters.advanced), enableOnApply: false }; this.openFilters(); return; }
      if (action === "noop") return;
      if (action === "scan-stop") {
        const active = app.modules.jobManager.snapshot().active.find((job) => ["initial-scan", "full-rescan", "smart-update"].includes(job.kind));
        if (active) app.modules.jobManager.stop(active.id);
        return;
      }
      if (action === "details-stop") {
        const active = app.modules.jobManager.snapshot().active.find((job) => job.kind === "detail-enrichment");
        if (active) app.modules.jobManager.stop(active.id);
        return;
      }
      if (action === "details-remove") {
        const waiting = app.modules.jobManager.snapshot().waiting.find((job) => job.kind === "detail-enrichment");
        if (waiting) app.modules.jobManager.remove(waiting.id);
        return;
      }
      if (action === "details-export-diagnostic") {
        try { await app.modules.detailDiagnosticExport.download(); }
        catch (error) { app.modules.logger?.warn("detail-diagnostic-export-failed", { message: error?.message }); }
        return;
      }
      if (["details-fetch", "details-resume"].includes(action)) {
        this.queueOpen = true;
        this.queuePage = "details";
        const outcome = this.enqueueDetails();
        this.state = { ...this.state, queueOpen: true, queueNotice: outcome.accepted ? null : "Detailed metadata is already queued or running." };
        this.updateShell();
        this.renderQueue();
        return;
      }
      if (["scan-start", "scan-resume", "full-rescan-start", "smart-update"].includes(action)) {
        const kind = action === "full-rescan-start" ? "full-rescan" : action === "smart-update" ? "smart-update" : "initial-scan";
        this.queuePage = "catalogue";
        this.renderQueue();
        const outcome = app.modules.jobManager.enqueue({
          kind,
          scopeKey: kind === "initial-scan" ? "catalogue-initial" : kind,
          resourceKeys: kind === "smart-update" ? ["catalogue-write"] : ["catalogue-write", "catalogue-reconcile"],
          coverage: kind === "full-rescan" ? ["smart-update"] : []
        });
        if (!outcome?.accepted) {
          this.queueOpen = true;
          this.queuePage = "catalogue";
          this.state = { ...this.state, queueOpen: true, queueNotice: outcome?.reason === "covered" ? "This operation is covered by existing queued work." : "This operation is already queued or running." };
          this.updateShell(); this.renderQueue();
          app.modules.logger?.warn("catalogue-job-not-enqueued", { action, outcome });
        } else {
          this.queueOpen = true;
          this.queuePage = "catalogue";
          this.state = { ...this.state, queueOpen: true, queueNotice: null };
          this.updateShell(); this.renderQueue();
        }
        return;
      }
      if (action.startsWith("job-remove:")) {
        app.modules.jobManager.remove(action.slice("job-remove:".length));
        return;
      }
      app.modules.logger?.debug("phase-1-shell-intent", { action });
    },

    async setUiState(changes) {
      const next = await app.modules.uiState.save({ ...this.state, ...changes });
      this.state = { ...this.state, ...next };
      if (this.root?.isConnected) {
        this.updateShell();
        this.applyModeVisibility();
      }
    },

    async commitFilters(filters) {
      const normalized = app.modules.filterEngine.normalize(filters);
      await app.modules.filterState.commitFilters(normalized);
      this.state = { ...this.state, filters: normalized, activePresetId: app.modules.filterState.value.activePresetId };
      if (filtersNeedMembership(normalized)) app.modules.subscriptionMembership?.ensureFresh?.({ documentLike: document })?.catch(() => {});
      await this.setUiState({ localPage: 1 });
    },

    async useActivePreset() {
      const active = app.modules.filterState.active();
      this.state = { ...this.state, filters: active.filters, activePresetId: active.id };
      await this.setUiState({ localPage: 1 });
      this.filterView = null;
      this.filterModal = null;
      this.openFilters();
    },

    async openFilters() {
      if (!this.root?.isConnected) return;
      const active = app.modules.filterState.active();
      const catalogue = this.state.catalogue ?? {}; const coverage = { detailed: catalogue.detailedCount ?? 0, total: catalogue.indexedCount ?? 0 };
      let vocabulary = {};
      try { const source = await app.modules.db.getAllLocalRecords(); ["tags", "categories", "artist", "uploader"].forEach((field) => { vocabulary[field] = { ...app.modules.filterEngine.vocabulary(source.records, source.detailsById, field), total: source.records.length }; }); } catch { /* the picker correctly remains empty without details */ }
      const membership = app.modules.subscriptionMembership?.publicState?.() ?? null;
      const host = app.modules.filtersUi.render({ root: this.root, filters: this.state.filters ?? active.filters, preset: active, presets: app.modules.filterState.value.presets, coverage, vocabulary, membership, modal: this.filterModal }, (action, trigger) => this.handleIntent(action, trigger), this.filterView ?? { view: "parent" });
      this.placeTool(host, this.resolveToolAnchor("filters"));
      app.modules.filterModals?.render({ root: this.root, filters: this.state.filters ?? active.filters, coverage, vocabulary, membership, modal: this.filterModal, preset: active, presets: app.modules.filterState.value.presets }, (action, payload) => this.handleIntent(action, payload));
    },

    openSort() {
      if (!this.root?.isConnected) return;
      this.closeFilters();
      let host = this.root.querySelector(".r34mf-sort-surface"); if (!host) { host = document.createElement("section"); host.className = "r34mf-sort-surface"; host.dataset.r34mfOwned = "true"; this.root.append(host); }
      this.placeTool(host, this.resolveToolAnchor("sort"));
      host.replaceChildren(); const title = document.createElement("strong"); title.textContent = "SORT"; host.append(title);
      for (const field of app.modules.sorter.FIELDS) { const button = document.createElement("button"); button.type = "button"; const current = this.state.sort ?? {}; button.textContent = `${field === "ratingVotes" ? "Rating votes" : field === "uploadDate" ? "Upload date" : field[0].toUpperCase() + field.slice(1)}${current.field === field ? current.direction === "asc" ? " ↑" : " ↓" : ""}`; button.addEventListener("click", async () => { const sort = app.modules.sorter.select(this.state.sort, field); await this.setUiState({ sort, localPage: 1 }); host.remove(); }); host.append(button); }
    },

    closeSort() {
      this.root?.querySelector(":scope > .r34mf-sort-surface")?.remove();
    },

    closeFilters() { app.modules.filtersUi.close(this.root); this.filterView = null; },

    resolveToolAnchor(action, preferredNode = null) {
      if (!this.root?.isConnected) return null;
      const selector = `[data-r34mf-action='${action}']`;
      if (preferredNode?.isConnected === true && this.root.contains(preferredNode) && preferredNode.matches?.(selector)) return preferredNode;
      return this.root.querySelector(selector);
    },

    repositionOpenTool() {
      if (!this.root?.isConnected) return;
      const filters = this.root.querySelector(":scope > .r34mf-tool-layer");
      if (filters) this.placeTool(filters, this.resolveToolAnchor("filters"));
      const sort = this.root.querySelector(":scope > .r34mf-sort-surface");
      if (sort) this.placeTool(sort, this.resolveToolAnchor("sort"));
    },

    placeTool(host, anchor, wide = false) {
      if (!host || !this.root?.isConnected) return;
      const rootBox = this.root.getBoundingClientRect(), viewport = window.innerWidth || document.documentElement.clientWidth;
      const anchorBox = anchor?.getBoundingClientRect?.(), width = wide ? Math.min(1080, rootBox.width, viewport - 16) : Math.min(390, rootBox.width, viewport - 16);
      const wanted = wide ? (rootBox.width - width) / 2 : (anchorBox?.left ?? rootBox.left) - rootBox.left;
      host.style.width = `${width}px`; host.style.left = `${Math.min(Math.max(0, wanted), Math.max(0, rootBox.width - width))}px`; host.style.top = `${Math.max(0, (anchorBox?.bottom ?? rootBox.top) - rootBox.top + 7)}px`;
    },

    async refreshCatalogueState() {
      const catalogue = await app.modules.catalogueScanner.initialize();
      this.recentHistory = await app.modules.db.readRecentHistory();
      this.onCatalogueState(catalogue);
    },

    onCatalogueState(catalogue) {
      this.state = {
        ...this.state,
        catalogue: {
          ...catalogue,
          hasCatalogue: catalogue.catalogueReady === true,
          usable: catalogue.usable === true
        },
        canFilter: catalogue.usable === true,
        canSort: catalogue.usable === true
      };
      if (this.root?.isConnected) {
        this.updateShell();
        this.applyModeVisibility();
      }
      if (["complete", "paused", "failed"].includes(catalogue.scanStatus)) {
        app.modules.db.readRecentHistory().then((history) => {
          this.recentHistory = history;
          this.renderQueue();
        }).catch(() => {});
      }
    },

    renderQueue() {
      if (!this.queueOpen || !this.root?.isConnected) return;
      const currentQueueUiState = app.modules.queue.capture(this.root);
      this.queueUiState = app.modules.queue.render(this.root, {
        catalogue: this.state.catalogue,
        recent: this.recentHistory,
        runtime: app.modules.jobManager.snapshot(),
        capabilities: { smartUpdate: this.state.catalogue.hasCatalogue === true, fetchDetails: true },
        notice: this.state.queueNotice
      }, this.queuePage, currentQueueUiState ?? this.queueUiState, (action, trigger) => this.handleIntent(action, trigger));
    },

    updateShell() {
      if (!this.root?.isConnected) return;
      this.queueUiState = this.queueOpen ? app.modules.queue.capture(this.root) : null;
      app.modules.shell.update(this.root, this.state);
      this.renderQueue();
      this.repositionOpenTool();
    },

    nativeVisibilityNodes(parts = null) {
      const resolvedParts = parts ?? (typeof document.querySelector === "function" ? findNativeParts() : null);
      if (!resolvedParts) return [];
      const paginationFamily = [...new Set([resolvedParts.pagination, ...resolvedParts.block.querySelectorAll("#list_videos_videos_from_my_subscriptions_pagination, .pagination:has(#list_videos_videos_from_my_subscriptions_pagination), .pagination")])]
        .filter((node) => node && (node === resolvedParts.pagination || resolvedParts.block.contains(node)));
      return [...new Set([resolvedParts.grid, ...paginationFamily])].filter(Boolean);
    },

    restoreNativeVisibility(parts = null) {
      for (const node of this.nativeVisibilityNodes(parts)) {
        if (!node.dataset.r34mfNativeHidden) continue;
        node.hidden = node.dataset.r34mfNativeHidden === "was-hidden";
        node.classList.remove("r34mf-native-video-pagination-hidden");
        delete node.dataset.r34mfNativeHidden;
      }
    },

    applyModeVisibility(parts = findNativeParts()) {
      if (!this.root?.isConnected || !parts) return;
      const local = this.state.mode === "local";
      if (!local) {
        this.restoreNativeVisibility(parts);
        app.modules.localGrid.hide(this.root);
        return;
      }
      for (const node of this.nativeVisibilityNodes(parts)) {
        if (!node.dataset.r34mfNativeHidden) node.dataset.r34mfNativeHidden = node.hidden ? "was-hidden" : "was-visible";
        node.hidden = true;
        node.classList.add("r34mf-native-video-pagination-hidden");
      }
      this.renderLocal();
    },

    async renderLocal() {
      if (!this.root?.isConnected || this.state.mode !== "local") return;
      this.state = { ...this.state, localRendererActive: true };
      try {
        const source = await app.modules.db.getAllLocalRecords();
        const membership = app.modules.subscriptionMembership?.evaluationContext?.() ?? { status: "unavailable", keys: new Set(), names: new Set() };
        const now = Date.now();
        const evaluated = source.records.map((record) => ({ record, result: app.modules.filterEngine.evaluate(record, source.detailsById.get(record.videoId), this.state.filters ?? app.modules.filterEngine.createEmpty(), now, { membership }) }));
        const matches = app.modules.sorter.sort(evaluated.filter((item) => item.result === app.modules.filterEngine.TRUE).map((item) => item.record), source.detailsById, this.state.sort);
        const unknownCount = evaluated.filter((item) => item.result === app.modules.filterEngine.UNKNOWN).length;
        const result = await app.modules.localGrid.render(this.root, {
          page: this.state.localPage, pageSize: app.modules.settings.value.videosPerPage,
          previews: app.modules.settings.value.animatedHoverPreviews,
          columns: app.modules.settings.value.videoColumns,
          aspectRatio: app.modules.settings.value.thumbnailAspectRatio,
          onPage: (localPage) => this.setUiState({ localPage }), records: matches
        });
        if (result.page !== this.state.localPage) await this.setUiState({ localPage: result.page });
        this.state = { ...this.state, showingCount: result.total, unknownCount, localRendererActive: true, filterCount: app.modules.filterEngine.countApplied(this.state.filters) };
        this.updateShell();
      } catch { this.state = { ...this.state, localRendererActive: false }; this.updateShell(); }
    },

    closeQueue({ returnFocus = true, updateShell = true } = {}) {
      const host = this.root?.querySelector(":scope > .r34mf-queue-host");
      if (!this.queueOpen && !host) return;
      this.queueOpen = false;
      this.queuePage = "root";
      this.state = { ...this.state, queueOpen: false };
      // Shell replacement does not own the sibling Queue host.  Remove it before any
      // rerender so close cannot leave an orphaned disclosure in the page.
      host?.remove();
      if (updateShell && this.root?.isConnected) this.updateShell();
      const trigger = this.root?.querySelector("[data-r34mf-action='queue']") ?? this.queueTrigger;
      if (returnFocus) trigger?.focus({ preventScroll: true });
      this.queueTrigger = null;
      this.queueUiState = null;
    },

    onKeyDown(event) {
      if (event.key === "Escape" && this.filterModal) { event.preventDefault(); this.filterModal = null; this.openFilters(); return; }
      if (event.key === "Escape" && this.root?.querySelector(":scope > .r34mf-tool-layer, :scope > .r34mf-sort-surface")) {
        event.preventDefault();
        if (this.filterView?.view && this.filterView.view !== "parent") { this.filterView = null; this.openFilters(); } else { this.closeFilters(); this.closeSort(); }
        return;
      }
      if (!this.queueOpen) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (this.queuePage === "root") this.closeQueue();
      else {
        this.queuePage = "root";
        this.renderQueue();
      }
    },

    onDocumentPointerDown(event) {
      if (!this.root?.isConnected || this.filterView?.view && this.filterView.view !== "parent") return;
      const insideTool = event.target.closest?.(".r34mf-tool-layer, .r34mf-sort-surface");
      const trigger = event.target.closest?.("[data-r34mf-action='filters'], [data-r34mf-action='sort']");
      if (!insideTool && !trigger) { this.closeFilters(); this.closeSort(); }
    },

    unmount() {
      this.revision += 1;
      app.modules.dateControl?.closeOpenPicker();
      app.modules.filterModals?.unlockPageScroll?.();
      this.restoreNativeVisibility();
      this.closeQueue({ returnFocus: false, updateShell: false });
      app.modules.subscriptionMembership?.detach?.();
      this.disconnectObserver();
      for (const root of document.querySelectorAll(constants.selectors.extensionRoot)) {
        root.remove();
      }
      this.root = null;
      this.mounted = false;
    },

    cleanup() {
      app.modules.logger?.debug?.("controller-teardown", { mounted: this.mounted, activeJobs: app.modules.jobManager?.snapshot?.().active.length ?? 0 });
      this.unmount();
      this.unbindLifecycle();
      for (const unsubscribe of this.runtimeUnsubscribers.splice(0)) {
        try { unsubscribe(); }
        catch (error) { app.modules.logger?.warn("runtime-unsubscribe-failed", { message: error?.message }); }
      }
      if (this.detailRefreshTimer !== null) window.clearTimeout(this.detailRefreshTimer);
      this.detailRefreshTimer = null;
      this.started = false;
      this.lastUrl = null;
      this.runtimeToken = null;
    }
  };

  app.modules.subscriptionsController = controller;
})();
