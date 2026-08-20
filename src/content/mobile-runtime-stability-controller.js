(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const constants = app?.modules.constants;
  if (!app || !controller || !constants) {
    throw new Error("R34MF subscriptions controller and constants must load before runtime stability support.");
  }

  function fastInsertionPointIsCurrent(instance = controller) {
    const root = instance?.root;
    const sibling = root?.nextElementSibling;
    return Boolean(
      root?.isConnected === true
      && sibling?.matches?.(constants.selectors.subscriptionsItems) === true
    );
  }

  controller.needsReconcile = function needsReconcileWithoutRepeatedDocumentScan() {
    // The route timer runs frequently for SPA safety. On the steady-state page,
    // avoid repeatedly querying the complete native subscriptions block merely to
    // prove that the already-connected root still precedes the native grid.
    if (fastInsertionPointIsCurrent(this)) return false;
    const parts = this.findNativeParts?.();
    return !parts || !this.rootIsAtInsertionPoint?.(this.root, parts.grid);
  };

  controller.onRouteMaybeChanged = function onRouteMaybeChangedWithoutRepeatedOffPageUnmount() {
    const currentUrl = window.location.href;
    const target = this.isTargetPage?.() === true;
    if (!target) {
      this.lastUrl = currentUrl;
      // The site-wide Queue runtime intentionally stays alive on every Rule34Video
      // page. Only tear down the subscriptions UI when there is something mounted
      // to tear down; the old 750ms route check called unmount() forever on video,
      // home and playlist pages, causing needless revision/root/membership churn.
      if (this.mounted || this.root?.isConnected) this.unmount?.();
      return;
    }
    if (this.lastUrl !== currentUrl || !this.mounted || this.needsReconcile?.()) {
      this.lastUrl = currentUrl;
      this.scheduleReconcile?.();
    }
  };

  controller.applyModeVisibility = function applyModeVisibilityWithoutUnnecessaryLocalReset(parts = this.findNativeParts?.(), { refreshLocal = true } = {}) {
    if (!this.root?.isConnected || !parts) return;
    const local = this.state.mode === "local";
    if (!local) {
      this.restoreNativeVisibility?.(parts);
      app.modules.localGrid.hide(this.root);
      return;
    }

    for (const node of this.nativeVisibilityNodes?.(parts) ?? []) {
      if (!node.dataset.r34mfNativeHidden) node.dataset.r34mfNativeHidden = node.hidden ? "was-hidden" : "was-visible";
      node.hidden = true;
      node.classList.add("r34mf-native-video-pagination-hidden");
    }

    const existingLocal = this.root.querySelector?.(":scope > .r34mf-local-host") ?? null;
    if (existingLocal) existingLocal.hidden = false;
    if (refreshLocal || !existingLocal) this.renderLocal?.();
  };

  controller.reconcile = function reconcilePreservingRuntimeRoot() {
    if (!this.isTargetPage?.()) {
      if (this.mounted || this.root?.isConnected) this.unmount?.();
      return;
    }

    const parts = this.findNativeParts?.();
    if (!parts) {
      this.mounted = false;
      this.disconnectObserver?.();
      return;
    }

    const connectedRoots = [...document.querySelectorAll(constants.selectors.extensionRoot)];
    const rememberedRoot = this.rootBelongsToRuntime?.(this.root, this.runtimeToken) ? this.root : null;
    let root = connectedRoots.find((candidate) => this.rootIsAtInsertionPoint?.(candidate, parts.grid))
      ?? connectedRoots.find((candidate) => this.rootBelongsToRuntime?.(candidate, this.runtimeToken))
      ?? rememberedRoot
      ?? connectedRoots[0]
      ?? null;

    const recoveringRememberedRoot = Boolean(root && root === rememberedRoot && root.isConnected !== true);
    const hadLocalHost = Boolean(root?.querySelector?.(":scope > .r34mf-local-host"));

    for (const duplicate of connectedRoots) {
      if (duplicate !== root) duplicate.remove();
    }

    if (!root) {
      root = document.createElement("div");
      root.dataset.r34mfRoot = "subscriptions";
      root.dataset.r34mfOwned = "true";
      parts.grid.parentNode.insertBefore(root, parts.grid);
    } else if (!this.rootIsAtInsertionPoint?.(root, parts.grid)) {
      // A KVS/mobile host refresh can replace the whole native subscriptions
      // container. Reinsert the SAME extension root instead of creating a fresh
      // one; open Filters/modals, Local cards and their interaction state survive.
      parts.grid.parentNode.insertBefore(root, parts.grid);
    }

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

    this.updateShell?.();
    this.applyModeVisibility(parts, {
      // If the native site only replaced its own host container, the Local result
      // DOM is still valid inside the remembered root. Do not rebuild it and reset
      // open extension UI merely because the host page churned underneath us.
      refreshLocal: !(recoveringRememberedRoot && hadLocalHost)
    });
    this.attachObserver?.(parts.block);
  };

  app.modules.mobileRuntimeStabilityController = Object.freeze({
    fastInsertionPointIsCurrent
  });
})();