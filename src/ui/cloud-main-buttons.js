(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.shell;
  const settings = app?.modules.settings;
  if (!app || !base || !settings) throw new Error("R34MF shell and settings must load before Cloud main-card buttons.");

  function button(label, action) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "r34mf-control r34mf-cloud-main-control";
    node.dataset.r34mfAction = action;
    node.textContent = label;
    node.setAttribute("aria-label", `${label} GitHub cloud backup`);
    node.title = `${label} GitHub cloud backup`;
    return node;
  }

  function decorate(scope) {
    const shell = scope?.matches?.(".r34mf-shell") ? scope : scope?.querySelector?.(".r34mf-shell");
    if (!shell) return shell;
    const modeGroup = shell.querySelector(".r34mf-mode-group");
    shell.querySelector(".r34mf-cloud-main-actions")?.remove();
    modeGroup?.classList.remove("has-cloud-actions");
    if (settings.value?.showCloudSyncMainButtons !== true || !modeGroup) return shell;

    const actions = document.createElement("div");
    actions.className = "r34mf-cloud-main-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Cloud backup actions");
    actions.append(button("Pull", "cloud-pull"), button("Push", "cloud-push"));
    modeGroup.classList.add("has-cloud-actions");
    modeGroup.append(actions);
    return shell;
  }

  function render(state) {
    return decorate(base.render(state));
  }

  function update(root, state) {
    const result = base.update(root, state);
    decorate(root);
    return result;
  }

  function mount(root, state, onIntent) {
    const result = base.mount(root, state, onIntent);
    decorate(root);
    return result;
  }

  app.modules.shell = Object.freeze({ ...base, render, update, mount, decorateCloudButtons: decorate });
})();