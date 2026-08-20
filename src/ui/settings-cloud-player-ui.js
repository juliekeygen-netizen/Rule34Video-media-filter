(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.settingsUi;
  const bridge = app?.modules.settingsDraftBridge;
  const cloud = app?.modules.cloudSync;
  const cloudUi = app?.modules.cloudSyncUi;
  if (!app || !base || !bridge || !cloud || !cloudUi) {
    throw new Error("R34MF Settings UI, draft bridge and Cloud sync UI must load before Cloud/player Settings additions.");
  }

  let observer = null;
  let cloudSession = null;
  let decorateQueued = false;

  function el(tag, cls = "", text = undefined) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function setTextIfChanged(node, value) {
    if (!node) return false;
    const wanted = String(value);
    if (node.textContent === wanted) return false;
    node.textContent = wanted;
    return true;
  }

  function scheduleDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    queueMicrotask(() => {
      decorateQueued = false;
      decorate();
    });
  }

  function findPage(dialog, title) {
    return [...dialog?.querySelectorAll?.(".r34mf-settings-page") ?? []]
      .find((node) => node.querySelector(":scope > h3")?.textContent.trim() === title) ?? null;
  }

  function findSection(dialog, pageTitle, sectionTitle) {
    const page = findPage(dialog, pageTitle);
    return [...page?.querySelectorAll?.(".r34mf-settings-section") ?? []]
      .find((node) => node.querySelector(":scope > .r34mf-settings-section-title")?.textContent.trim() === sectionTitle) ?? null;
  }

  function findRow(section, title) {
    return [...section?.querySelectorAll?.(".r34mf-settings-row") ?? []]
      .find((node) => node.querySelector(".r34mf-settings-copy > strong")?.textContent.trim() === title) ?? null;
  }

  function refreshFooter() {
    const dialog = document.querySelector(".r34mf-settings-dialog");
    if (!dialog) return;
    const dirty = base.isDirty();
    const status = dialog.querySelector(".r34mf-settings-footer-status");
    if (status) {
      setTextIfChanged(status, dirty ? "Unsaved changes" : "All changes saved");
      status.classList.toggle("is-dirty", dirty);
    }
    const save = [...dialog.querySelectorAll("button")].find((node) => node.textContent.trim() === "Save changes");
    if (save && !dialog.querySelector(".r34mf-settings-confirm-layer")) save.disabled = !dirty;
  }

  function switchControl(key, label) {
    base.normalizedDraft();
    const draft = bridge.current();
    const button = el("button", "r34mf-settings-switch");
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-checked", String(draft?.[key] === true));
    button.addEventListener("click", () => {
      base.normalizedDraft();
      const live = bridge.current();
      if (!live) return;
      live[key] = live[key] !== true;
      button.setAttribute("aria-checked", String(live[key] === true));
      refreshFooter();
    });
    return button;
  }

  function settingRow(key, title, description) {
    const row = el("div", "r34mf-settings-row r34mf-settings-followup-row");
    row.dataset.r34mfSettingsFollowup = key;
    const copy = el("div", "r34mf-settings-copy");
    copy.append(el("strong", "", title), el("small", "", description));
    row.append(copy, switchControl(key, title));
    return row;
  }

  function decoratePlayerSetting(dialog) {
    const display = findSection(dialog, "Local display", "Video grid");
    if (!display || display.querySelector("[data-r34mf-settings-followup='improvedPlayerPlaybackControls']")) return;
    const row = settingRow(
      "improvedPlayerPlaybackControls",
      "Improved video player controls",
      "Add compact 10-second back and forward controls between the native Play/Pause and Volume controls, including fullscreen playback."
    );
    const hover = findRow(display, "Animated hover previews");
    hover?.after(row);
    if (!hover) display.querySelector(".r34mf-settings-list")?.prepend(row);
  }

  function polishBackupCopy(dialog) {
    const page = findPage(dialog, "Data & storage");
    if (!page) return;
    for (const card of page.querySelectorAll(".r34mf-settings-action-card")) {
      const title = card.querySelector("strong")?.textContent.trim();
      const description = card.querySelector("p");
      if (!description) continue;
      if (title === "Export backup") {
        setTextIfChanged(description, "Download settings, presets, catalogue, details, Seen, Favorites, manifests/checkpoints and terminal history. Queue runtime, sign-in credentials and Cloud credentials are excluded.");
      } else if (title === "Import backup") {
        setTextIfChanged(description, "Choose a .r34mfbackup file, review it, then Merge or Replace. Current backups include Seen and Favorites.");
      }
    }

    const importNote = page.querySelector(".r34mf-settings-import .r34mf-settings-inline-note");
    if (importNote) {
      if (importNote.textContent.trim().startsWith("Replace")) {
        setTextIfChanged(importNote, "Replace restores the backup exactly for extension catalogue data, Settings/UI/filter state, Seen and Favorites. Rule34Video sign-in credentials and Cloud credentials are never imported.");
      } else {
        setTextIfChanged(importNote, "Merge preserves the current catalogue membership/order while enriching compatible records. Backed-up Settings/UI/filter state is restored; Seen and Favorites are unioned with this device so existing local marks are not lost. Sign-in and Cloud credentials are never imported.");
      }
    }
  }

  function cloudDirty() {
    if (!cloudSession) return false;
    return cloudSession.repository.trim() !== String(cloudSession.saved?.repository ?? "").trim()
      || cloudSession.token !== String(cloudSession.saved?.token ?? "");
  }

  function cloudConfigDraft() {
    return { repository: cloudSession?.repository ?? "", token: cloudSession?.token ?? "" };
  }

  function cloudStatusText() {
    if (!cloudSession) return "Not checked";
    if (cloudSession.checking) return "Checking…";
    if (cloudSession.error) return cloudSession.error;
    const remote = cloudSession.status?.remote;
    if (remote?.commit) {
      const date = remote.commit.date ? new Date(remote.commit.date) : null;
      const stamp = date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "unknown time";
      return `${remote.commit.shortSha || String(remote.commit.sha ?? "").slice(0, 7)} · ${stamp}`;
    }
    if (cloudSession.status && !remote) return "Connected · no cloud backup yet";
    return "Not checked";
  }

  function replaceCloudSection(dialog) {
    if (!dialog || !base.isOpen()) return;
    dialog.querySelector("[data-r34mf-settings-followup='cloudSync']")?.remove();
    decorateCloud(dialog);
  }

  async function checkConnection({ useDraft = false } = {}) {
    const session = cloudSession;
    if (!session || session.checking) return;
    session.checking = true;
    session.error = null;
    replaceCloudSection(document.querySelector(".r34mf-settings-dialog"));
    try {
      const result = useDraft
        ? await cloud.testConfig({ repository: session.repository, token: session.token })
        : await cloud.status({ includeBackupMeta: false });
      if (cloudSession !== session) return;
      session.status = result;
    } catch (error) {
      if (cloudSession !== session) return;
      session.status = null;
      session.error = error?.message ?? "Could not connect to GitHub.";
    } finally {
      session.checking = false;
      if (cloudSession === session) replaceCloudSection(document.querySelector(".r34mf-settings-dialog"));
    }
  }

  async function saveConnection() {
    const session = cloudSession;
    if (!session) return false;
    try {
      const saved = await cloud.saveConfig({ repository: session.repository, token: session.token });
      if (cloudSession !== session) return saved.valid;
      session.saved = saved;
      session.repository = saved.repository;
      session.token = saved.token;
      session.error = null;
      session.message = saved.valid ? "Cloud connection saved." : "Cloud connection removed.";
      session.removeArmed = false;
      replaceCloudSection(document.querySelector(".r34mf-settings-dialog"));
      return saved.valid;
    } catch (error) {
      if (cloudSession === session) {
        session.error = error?.message ?? "Cloud connection could not be saved.";
        replaceCloudSection(document.querySelector(".r34mf-settings-dialog"));
      }
      return false;
    }
  }

  async function removeConnection() {
    const session = cloudSession;
    if (!session) return;
    if (!session.removeArmed) {
      session.removeArmed = true;
      session.message = "Press Remove connection again to confirm.";
      replaceCloudSection(document.querySelector(".r34mf-settings-dialog"));
      return;
    }
    const cleared = await cloud.clearConfig();
    if (cloudSession !== session) return;
    session.saved = cleared;
    session.repository = "";
    session.token = "";
    session.status = null;
    session.error = null;
    session.message = "Cloud connection removed. GitHub itself was not changed.";
    session.removeArmed = false;
    replaceCloudSection(document.querySelector(".r34mf-settings-dialog"));
  }

  async function openCloudAction(action, trigger) {
    if (!cloudSession) return;
    if (cloudDirty()) {
      const saved = await saveConnection();
      if (!saved) return;
    }
    if (!cloudSession?.saved?.valid) {
      if (cloudSession) {
        cloudSession.error = "Configure and save a private GitHub repository before using Push or Pull.";
        replaceCloudSection(document.querySelector(".r34mf-settings-dialog"));
      }
      return;
    }
    await cloudUi.open(action, {
      returnFocus: trigger,
      onComplete: async ({ action: completed }) => {
        if (completed === "pull") {
          base.close({ returnFocus: false, force: true });
          document.dispatchEvent(new CustomEvent("r34mf:cloud-pulled"));
          return;
        }
        await checkConnection({ useDraft: false });
      }
    });
  }

  function cloudField(label, value, type, onInput, { placeholder = "" } = {}) {
    const field = el("div", "r34mf-settings-field");
    const id = `r34mf-cloud-${label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const control = el("input", "r34mf-settings-text-input");
    control.id = id;
    control.type = type;
    control.value = value;
    control.placeholder = placeholder;
    control.autocomplete = type === "password" ? "new-password" : "off";
    control.spellcheck = false;
    control.addEventListener("input", () => {
      onInput(control.value);
      if (cloudSession) {
        cloudSession.error = null;
        cloudSession.message = null;
        cloudSession.removeArmed = false;
      }
    });
    const name = el("label", "", label);
    name.htmlFor = id;
    field.append(name, control);
    return field;
  }

  function cloudCard() {
    const card = el("div", "r34mf-settings-auth-card r34mf-settings-cloud-card");
    card.dataset.r34mfSettingsFollowup = "cloudSync";
    const summary = el("div", "r34mf-settings-auth-summary");
    const provider = el("div");
    provider.append(el("span", "", "Provider"), el("strong", "", "GitHub private repository"));
    const edit = el("button", "r34mf-settings-button", cloudSession?.editing ? "Hide editor" : (cloudSession?.saved?.valid ? "Edit cloud sync" : "Configure cloud sync"));
    edit.type = "button";
    edit.addEventListener("click", () => {
      if (!cloudSession) return;
      cloudSession.editing = !cloudSession.editing;
      cloudSession.removeArmed = false;
      replaceCloudSection(document.querySelector(".r34mf-settings-dialog"));
    });
    const repository = el("div");
    repository.append(el("span", "", "Repository"), el("strong", "", cloudSession?.saved?.valid ? cloudSession.saved.repository : "Not configured"));
    const remote = el("div");
    remote.append(el("span", "", "Remote backup"), el("strong", "", cloudStatusText()));
    summary.append(provider, edit, repository, remote);
    card.append(summary);

    if (cloudSession?.editing) {
      const form = el("div", "r34mf-settings-auth-form r34mf-settings-cloud-form");
      form.append(
        cloudField("Private repository", cloudSession.repository, "text", (value) => { cloudSession.repository = value; }, { placeholder: "username/private-repo" }),
        cloudField("Fine-grained access token", cloudSession.token, "password", (value) => { cloudSession.token = value; }, { placeholder: "github_pat_..." })
      );
      card.append(form);

      const pathNote = el("p", "r34mf-settings-security", `Repository accepts owner/repo or a full github.com URL. Backup file: ${cloud.BACKUP_PATH}. The token is stored only in this extension profile and is never included in exported or cloud backups. Public repositories are rejected.`);
      card.append(pathNote);

      const toggle = el("div", "r34mf-settings-row r34mf-settings-cloud-toggle-row");
      const toggleCopy = el("div", "r34mf-settings-copy");
      toggleCopy.append(
        el("strong", "", "Show Push and Pull buttons in main card"),
        el("small", "", "Show same-height Pull and Push controls on the MODE row: Native/Local stay left, Cloud actions stay right. Save Settings to apply.")
      );
      toggle.append(toggleCopy, switchControl("showCloudSyncMainButtons", "Show Push and Pull buttons in main card"));
      card.append(toggle);

      if (cloudSession.error) card.append(el("div", "r34mf-settings-inline-note is-error", cloudSession.error));
      else if (cloudSession.message) card.append(el("div", "r34mf-settings-inline-note is-success", cloudSession.message));

      const actions = el("div", "r34mf-settings-auth-actions r34mf-settings-cloud-actions");
      const test = el("button", "r34mf-settings-button", cloudSession.checking ? "Checking…" : "Check connection");
      test.type = "button";
      test.disabled = cloudSession.checking;
      test.addEventListener("click", () => checkConnection({ useDraft: cloudDirty() || !cloudSession.saved?.valid }));
      const save = el("button", "r34mf-settings-button is-primary", "Save connection");
      save.type = "button";
      save.disabled = !cloudDirty() && cloudSession.saved?.valid;
      save.addEventListener("click", saveConnection);
      const pull = el("button", "r34mf-settings-button", "Pull");
      pull.type = "button";
      pull.addEventListener("click", () => openCloudAction("pull", pull));
      const push = el("button", "r34mf-settings-button", "Push");
      push.type = "button";
      push.addEventListener("click", () => openCloudAction("push", push));
      actions.append(test, save, pull, push);
      card.append(actions);

      if (cloudSession.saved?.valid) {
        const remove = el("button", "r34mf-settings-button is-quiet r34mf-settings-cloud-remove", cloudSession.removeArmed ? "Confirm remove connection" : "Remove cloud connection");
        remove.type = "button";
        remove.addEventListener("click", removeConnection);
        card.append(remove);
      }
    }
    return card;
  }

  function decorateCloud(dialog) {
    const page = findPage(dialog, "Data & storage");
    if (!page || page.querySelector("[data-r34mf-settings-followup='cloudSync']")) return;
    const section = el("section", "r34mf-settings-section r34mf-settings-cloud-section");
    section.dataset.r34mfSettingsFollowup = "cloudSync";
    section.append(el("h4", "r34mf-settings-section-title", "Cloud sync"), cloudCard());
    const danger = page.querySelector(".r34mf-settings-danger");
    if (danger) danger.before(section);
    else page.append(section);
  }

  function decorate() {
    if (!base.isOpen()) return;
    const dialog = document.querySelector(".r34mf-settings-dialog");
    if (!dialog) return;
    decoratePlayerSetting(dialog);
    polishBackupCopy(dialog);
    decorateCloud(dialog);
    refreshFooter();
  }

  const originalOpen = base.open;
  const originalClose = base.close;

  async function open(args) {
    // If Settings is already mounted, preserve its current in-progress drawer draft.
    // Otherwise always start a fresh session from storage. Base Settings can close
    // itself through lexical Save/Cancel paths that do not call this wrapper's close().
    if (base.isOpen()) {
      const existing = await originalOpen(args);
      scheduleDecorate();
      return existing;
    }

    observer?.disconnect();
    observer = null;
    decorateQueued = false;
    cloudSession = null;
    const saved = await cloud.loadConfig();
    const state = await cloud.loadState();
    cloudSession = {
      saved,
      repository: saved.repository,
      token: saved.token,
      editing: false,
      checking: false,
      status: state.checkedRemoteSha ? {
        remote: {
          sha: state.checkedRemoteSha,
          commit: state.checkedRemoteCommit ?? null
        }
      } : null,
      error: state.lastError?.message ?? null,
      message: null,
      removeArmed: false
    };

    const layer = await originalOpen(args);
    observer?.disconnect();
    if (layer) {
      observer = new MutationObserver(scheduleDecorate);
      observer.observe(layer, { childList: true, subtree: true });
      scheduleDecorate();
    }
    return layer;
  }

  function close(args) {
    observer?.disconnect();
    observer = null;
    decorateQueued = false;
    cloudSession = null;
    return originalClose(args);
  }

  app.modules.settingsUi = Object.freeze({ ...base, open, close, decorateCloudPlayer: decorate });
})();