(() => {
  "use strict";

  const app = globalThis.R34MF;
  const settings = app?.modules.settings;
  const data = app?.modules.settingsData;
  const browserApi = app?.modules.browserApi;
  const constants = app?.modules.constants;
  if (!app || !settings || !data || !browserApi || !constants) {
    throw new Error("R34MF Settings UI dependencies must load first.");
  }

  const TABS = Object.freeze([
    ["scanning", "Scanning & queue"],
    ["display", "Local display"],
    ["data", "Data & storage"],
    ["advanced", "Advanced"]
  ]);

  let active = null;
  let opening = null;
  let openGeneration = 0;
  let scrollLock = null;

  function el(tag, cls = "", text = undefined) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function keyed(node, key) { if (node && key) node.dataset.settingsFocusKey = key; return node; }
  function btn(text, cls = "", key = "") {
    const node = keyed(el("button", `r34mf-settings-button ${cls}`.trim(), text), key);
    node.type = "button";
    return node;
  }
  function closeIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const d of ["M4.5 4.5 15.5 15.5", "M15.5 4.5 4.5 15.5"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  function percent(value) { return `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`; }
  function normalized() { return settings.normalize(active?.draft ?? settings.value); }
  function credentialsDirty(session = active) {
    if (!session) return false;
    const savedIdentifier = String(session.credentials?.identifier ?? "").trim();
    const savedPassword = String(session.credentials?.password ?? "");
    if (session.auth.remove === true) return Boolean(savedIdentifier || savedPassword);
    return session.auth.identifier.trim() !== savedIdentifier || session.auth.password !== savedPassword;
  }
  function dirty() {
    return Boolean(active) && (JSON.stringify(normalized()) !== JSON.stringify(active.original) || credentialsDirty(active));
  }
  function credentialValues(session = active) {
    if (!session) return { identifier: "", password: "" };
    return {
      identifier: session.auth.identifier.trim(),
      password: session.auth.remove ? "" : (session.auth.password || String(session.credentials?.password ?? ""))
    };
  }

  function lockScroll() {
    if (scrollLock) return;
    const html = document.documentElement;
    const body = document.body;
    const scrollX = window.scrollX ?? window.pageXOffset ?? 0;
    const scrollY = window.scrollY ?? window.pageYOffset ?? 0;
    const viewportWidth = window.innerWidth || html.clientWidth;
    const clientWidth = html.clientWidth || viewportWidth;
    const scrollbarWidth = Math.max(0, viewportWidth - clientWidth);
    const currentPaddingRight = Number.parseFloat(globalThis.getComputedStyle?.(body)?.paddingRight) || 0;
    scrollLock = {
      scrollX,
      scrollY,
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
      bodyPaddingRight: body.style.paddingRight
    };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `${-scrollY}px`;
    body.style.left = `${-scrollX}px`;
    body.style.right = "0";
    body.style.width = "auto";
    if (scrollbarWidth) body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
    body.dataset.r34mfSettingsScrollLock = "true";
  }

  function unlockScroll() {
    if (!scrollLock) return;
    const saved = scrollLock;
    scrollLock = null;
    const html = document.documentElement;
    const body = document.body;
    html.style.overflow = saved.htmlOverflow;
    body.style.overflow = saved.bodyOverflow;
    body.style.position = saved.bodyPosition;
    body.style.top = saved.bodyTop;
    body.style.left = saved.bodyLeft;
    body.style.right = saved.bodyRight;
    body.style.width = saved.bodyWidth;
    body.style.paddingRight = saved.bodyPaddingRight;
    delete body.dataset.r34mfSettingsScrollLock;
    window.scrollTo?.(saved.scrollX, saved.scrollY);
  }

  function clearFormError() {
    if (!active?.formError) return;
    active.formError = null;
    active.dialog?.querySelector(".r34mf-settings-form-error")?.remove();
  }
  function setDraft(changes) { clearFormError(); active.draft = { ...active.draft, ...changes }; redraw(); }
  function setAdvanced(changes) {
    clearFormError();
    active.draft = settings.normalize({
      ...active.draft,
      advanced: { ...active.draft.advanced, ...changes }
    });
    redraw();
  }

  function sw(value, label, onChange) {
    const node = keyed(el("button", "r34mf-settings-switch"), `control:${label}`);
    node.type = "button";
    node.setAttribute("role", "switch");
    node.setAttribute("aria-checked", String(value === true));
    node.setAttribute("aria-label", label);
    node.addEventListener("click", () => onChange(value !== true));
    return node;
  }

  function select(value, choices, label, onChange) {
    const node = keyed(el("select", "r34mf-settings-select"), `control:${label}`);
    node.setAttribute("aria-label", label);
    for (const [key, text, disabled = false] of choices) {
      const option = el("option", "", text);
      option.value = String(key);
      option.selected = String(key) === String(value);
      option.disabled = disabled;
      node.append(option);
    }
    node.addEventListener("change", () => onChange(node.value));
    return node;
  }

  function number(value, options, onChange) {
    const input = keyed(el("input", "r34mf-settings-input"), `control:${options.label}`);
    input.type = "number";
    input.value = String(value ?? "");
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step ?? 1);
    input.disabled = options.disabled === true;
    input.setAttribute("aria-label", options.label);
    if (options.title) input.title = options.title;
    input.addEventListener("change", () => onChange(Number(input.value)));
    return input;
  }

  function copy(title, description, warning = false) {
    const node = el("div", "r34mf-settings-copy");
    node.append(el("strong", "", title));
    if (description) node.append(el("small", warning ? "is-warning" : "", description));
    return node;
  }
  function row(title, description, control, warning = false) {
    const node = el("div", "r34mf-settings-row");
    node.append(copy(title, description, warning), control);
    return node;
  }
  function section(title) {
    const node = el("section", "r34mf-settings-section");
    const list = el("div", "r34mf-settings-list");
    node.append(el("h4", "r34mf-settings-section-title", title), list);
    return { node, list };
  }
  function page(title, description) {
    const node = el("div", "r34mf-settings-page");
    node.append(el("h3", "", title), el("p", "", description));
    return node;
  }

  function scanningPage() {
    const node = page("Scanning & queue", "Control how catalogue and detailed-metadata work is scheduled. Saved changes affect new request starts without rebuilding your catalogue.");
    const queue = section("Queue");
    queue.list.append(
      row("Concurrent Queue jobs", "Run one operation at a time, or allow two non-conflicting jobs to share the global scheduler.", select(active.draft.concurrentQueueJobs, [[1, "1 — Recommended"], [2, "2"]], "Concurrent Queue jobs", (v) => setDraft({ concurrentQueueJobs: Number(v) }))),
      row("Concurrent detail requests", "Parallel workers inside one Detailed metadata job. All workers still share request spacing and the global 429 cooldown.", select(active.draft.concurrentDetailRequests, [[1, "1"], [2, "2 — Recommended"], [3, "3"]], "Concurrent detail requests", (v) => setDraft({ concurrentDetailRequests: Number(v) })))
    );
    node.append(queue.node);

    const requests = section("Request behavior");
    const paceChoices = [["conservative", "Conservative"], ["recommended", "Recommended"], ["faster", "Faster"]];
    if (active.draft.requestPace === "custom") paceChoices.push(["custom", "Custom — Advanced timing", true]);
    requests.list.append(
      row("Request pace", active.draft.requestPace === "custom" ? "Advanced raw timing does not match a preset. Pick a preset here to restore its spacing." : "Sets the global minimum gap between request starts.", select(active.draft.requestPace, paceChoices, "Request pace", (v) => {
        if (v !== "custom") {
          clearFormError();
          active.draft = settings.applyRequestPace(active.draft, v);
          redraw();
        }
      })),
      row("Retry temporary detail failures", "Retry transient network/server failures through the shared scheduler.", sw(active.draft.retryTemporaryDetailFailures, "Retry temporary detail failures", (v) => setDraft({ retryTemporaryDetailFailures: v }))),
      row("Fetch missing details automatically", "After a successful Scan/Update, enqueue Detailed metadata only when missing records remain.", sw(active.draft.autoFetchMissingDetails, "Fetch missing details automatically", (v) => setDraft({ autoFetchMissingDetails: v }))),
      row("Auto-update recent videos", "Once per browser session, check only the newest subscription pages until the newest Local video is found.", sw(active.draft.autoUpdateRecentVideos, "Auto-update recent videos", (v) => setDraft({ autoUpdateRecentVideos: v })))
    );
    node.append(requests.node);
    return node;
  }

  function displayPage() {
    const node = page("Local display", "Choose how the extension-owned Local catalogue is presented.");
    const grid = section("Video grid");
    grid.list.append(
      row("Videos per page", "24 matches Rule34Video's native subscription-page density.", select(active.draft.videosPerPage, [[24, "24 — Match Rule34Video"], [48, "48"], [72, "72"]], "Videos per page", (v) => setDraft({ videosPerPage: Number(v) }))),
      row("Video column amount", "Choose how many Local videos appear in each row.", select(active.draft.videoColumns, [[1, "1"], [2, "2"], [3, "3 — Default"], [4, "4"], [5, "5"], [6, "6"]], "Video column amount", (v) => setDraft({ videoColumns: Number(v) }))),
      row("Thumbnail aspect ratio", "Change the shape used by Local thumbnails and animated previews.", select(active.draft.thumbnailAspectRatio, settings.THUMBNAIL_ASPECT_RATIOS.map((value) => [value, value]), "Thumbnail aspect ratio", (v) => setDraft({ thumbnailAspectRatio: v }))),
      row("Animated hover previews", "Play stored preview media on Local thumbnails when Rule34Video supplied a preview URL.", sw(active.draft.animatedHoverPreviews, "Animated hover previews", (v) => setDraft({ animatedHoverPreviews: v })))
    );
    node.append(grid.node);
    return node;
  }

  function stat(label, value, note = "") {
    const node = el("div", "r34mf-settings-stat");
    node.append(el("span", "", label), el("strong", "", value));
    if (note) node.append(el("small", "", note));
    return node;
  }

  function actionCard(title, description, label, handler, cls = "") {
    const card = el("div", "r34mf-settings-action-card");
    const action = btn(label, cls, `data:${label}`);
    action.disabled = active.busy;
    action.addEventListener("click", handler);
    card.append(el("strong", "", title), el("p", "", description), action);
    return card;
  }

  async function runData(work, message, notify = true) {
    const session = active;
    if (!session || session.busy) return;
    let committed = false;
    session.busy = true;
    session.dataError = null;
    session.dataMessage = null;
    redraw();
    try {
      await work();
      committed = true;
      if (active !== session) return;
      session.summary = await data.summary();
      session.dataMessage = message;
      if (notify) await session.onDataChanged?.();
    } catch (error) {
      if (active === session) {
        const detail = error?.message ?? "The page could not refresh.";
        session.dataError = committed
          ? `${message} The change completed, but Settings could not refresh the page state: ${detail}`
          : detail;
      }
    } finally {
      if (active === session) {
        session.busy = false;
        redraw();
      }
    }
  }

  async function refreshSummary() {
    const session = active;
    if (!session) return;
    try {
      const value = await data.summary();
      if (active === session) {
        session.summary = value;
        session.dataError = null;
        redraw();
      }
    } catch (error) {
      if (active === session) {
        session.dataError = error?.message ?? "Could not inspect local storage.";
        redraw();
      }
    }
  }

  function confirmAction({ title, message, label, danger = false, action }) {
    if (active?.busy) return;
    showConfirm(title, message, label, danger, action);
  }

  function openFilePicker() {
    if (!active?.fileInput || active.busy) return;
    active.fileInput.value = "";
    active.fileInput.click();
  }

  function importPreview(node) {
    if (!active.importPreview) return;
    const preview = active.importPreview;
    const box = el("div", "r34mf-settings-import");
    const meta = el("div", "r34mf-settings-import-meta");
    for (const [label, value] of [
      ["Backup", preview.meta.exportedAt ? new Date(preview.meta.exportedAt).toLocaleString() : "Unknown"],
      ["Extension", preview.meta.appVersion],
      ["Indexed", preview.meta.indexed.toLocaleString()],
      ["Detailed", preview.meta.detailed.toLocaleString()]
    ]) {
      const item = el("div");
      item.append(el("span", "", label), el("strong", "", value));
      meta.append(item);
    }

    const modes = el("div", "r34mf-settings-import-modes");
    for (const [mode, label] of [["merge", "Merge"], ["replace", "Replace"]]) {
      const control = btn(label, "", `import-mode:${mode}`);
      control.setAttribute("aria-pressed", String(active.importMode === mode));
      control.addEventListener("click", () => { active.importMode = mode; redraw(); });
      modes.append(control);
    }
    box.append(
      meta,
      modes,
      el("div", "r34mf-settings-inline-note", active.importMode === "replace"
        ? "Replace clears current extension catalogue data before restoring this backup. It also restores backed-up Settings/UI/filter state; sign-in credentials are never changed."
        : "Merge preserves a complete current catalogue membership/order while enriching compatible records. It also restores backed-up Settings/UI/filter state; sign-in credentials are never imported.")
    );

    const actions = el("div", "r34mf-settings-import-actions");
    const choose = btn("Choose another file", "is-quiet", "data:Choose another file");
    choose.addEventListener("click", openFilePicker);
    const apply = btn(active.importMode === "replace" ? "Replace & import" : "Merge backup", active.importMode === "replace" ? "is-danger" : "is-primary", "data:Apply backup");
    apply.disabled = active.busy;
    apply.addEventListener("click", () => {
      const session = active;
      if (!session || session.busy) return;
      const mode = session.importMode;
      const execute = () => runData(async () => {
        await data.importBackup(preview.backup, mode);
        if (active !== session) return;
        session.original = clone(settings.normalize(settings.value));
        session.draft = clone(session.original);
        session.importPreview = null;
        session.formError = null;
      }, "Backup imported.");

      if (mode === "replace") {
        confirmAction({
          title: "Replace current extension data?",
          message: "Current local catalogue data, details and checkpoints will be cleared first. Backed-up Settings/UI/filter state will replace the current saved state, and any unsaved Settings edits in this window will be discarded. Rule34Video itself and sign-in credentials are not changed.",
          label: "Replace & import",
          danger: true,
          action: execute
        });
      } else if (dirty()) {
        confirmAction({
          title: "Merge backup and replace unsaved Settings edits?",
          message: "Merge restores the backup's saved Settings/UI/filter state as part of the import. Unsaved edits in this Settings window will be replaced; sign-in credentials are not changed.",
          label: "Merge backup",
          action: execute
        });
      } else {
        execute();
      }
    });
    actions.append(choose, apply);
    box.append(actions);
    node.append(box);
  }

  function dataPage() {
    const node = page("Data & storage", "Inspect local catalogue size, make portable backups, or clear extension-owned data without changing your Rule34Video subscriptions.");
    const summary = el("div", "r34mf-settings-summary");
    if (active.summary) {
      summary.append(
        stat("Indexed", active.summary.indexed.toLocaleString(), "subscription videos"),
        stat("Detailed", active.summary.detailed.toLocaleString(), `${percent(active.summary.coverage)} coverage`),
        stat("Approx. storage", active.summary.approximateStorage, "portable-backup estimate")
      );
    } else {
      summary.append(stat("Indexed", "…"), stat("Detailed", "…"), stat("Approx. storage", "…"));
    }
    node.append(summary);

    const actions = el("div", "r34mf-settings-action-grid");
    actions.append(
      actionCard("Export backup", "Download settings, presets, catalogue, details, manifests/checkpoints and terminal history. Queue runtime and sign-in credentials are excluded.", "Export backup", () => runData(() => data.exportBackup(), "Backup exported.", false)),
      actionCard("Import backup", "Choose a .r34mfbackup file, review its metadata, then Merge or Replace.", "Import backup", openFilePicker)
    );
    node.append(actions);

    const file = el("input", "r34mf-settings-file-input");
    file.type = "file";
    file.accept = ".r34mfbackup,.json,application/json";
    file.addEventListener("change", async () => {
      const session = active;
      const picked = file.files?.[0];
      if (!session || !picked || session.busy) return;
      try {
        const preview = await data.readBackupFile(picked);
        if (active !== session) return;
        session.importPreview = preview;
        session.importMode = "merge";
        session.dataError = null;
      } catch (error) {
        if (active !== session) return;
        session.importPreview = null;
        session.dataError = error?.message ?? "The backup could not be read.";
      }
      redraw();
    });
    active.fileInput = file;
    node.append(file);
    importPreview(node);

    const danger = el("section", "r34mf-settings-danger");
    danger.append(el("h4", "r34mf-settings-section-title", "Danger zone"));
    const dangerList = el("div", "r34mf-settings-list");

    const clearDetails = btn("Clear detailed metadata", "is-danger", "data:Clear detailed metadata");
    clearDetails.disabled = active.busy;
    clearDetails.addEventListener("click", () => confirmAction({
      title: "Clear detailed metadata?",
      message: "Artist, uploader, tags, categories, description and exact upload dates will be removed. Listing catalogue data remains available.",
      label: "Clear details",
      danger: true,
      action: () => runData(() => data.clearDetailedMetadata(), "Detailed metadata cleared.")
    }));

    const clearAll = btn("Clear entire local catalogue", "is-danger", "data:Clear entire local catalogue");
    clearAll.disabled = active.busy;
    clearAll.addEventListener("click", () => confirmAction({
      title: "Clear entire local catalogue?",
      message: "All indexed videos, details, manifests, resumable scan state and Recent history stored by this extension will be deleted. Your Rule34Video subscriptions are not changed.",
      label: "Clear catalogue",
      danger: true,
      action: () => runData(() => data.clearEntireCatalogue(), "Local catalogue cleared.")
    }));

    dangerList.append(
      row("Clear detailed metadata", "Keep the indexed catalogue, but return detail coverage to zero.", clearDetails, true),
      row("Clear entire local catalogue", "This cannot be undone unless you exported a backup first.", clearAll, true)
    );
    danger.append(dangerList);
    node.append(danger);

    if (active.dataError) node.append(el("div", "r34mf-settings-inline-note is-error", active.dataError));
    else if (active.dataMessage) node.append(el("div", "r34mf-settings-inline-note is-success", active.dataMessage));
    return node;
  }

  function authCard() {
    const card = el("div", "r34mf-settings-auth-card");
    const values = credentialValues();
    const summary = el("div", "r34mf-settings-auth-summary");
    const account = el("div");
    account.append(el("span", "", "Account"), el("strong", "", active.auth.remove ? "Not saved" : (active.auth.identifier || "Not saved")));
    const edit = btn(active.auth.editing ? "Hide editor" : (values.password ? "Change credentials" : "Add credentials"), "", "auth:edit");
    edit.addEventListener("click", () => { active.auth.editing = !active.auth.editing; redraw(); });
    const password = el("div");
    password.append(el("span", "", "Password"), el("strong", "", active.auth.remove ? "Not saved" : (values.password ? "Saved" : "Not saved")));
    summary.append(account, edit, password);
    card.append(summary);

    if (active.auth.editing) {
      const form = el("div", "r34mf-settings-auth-form");
      const userField = el("div", "r34mf-settings-field");
      const user = keyed(el("input", "r34mf-settings-text-input"), "auth:identifier");
      user.type = "text";
      user.id = "r34mf-settings-auth-identifier";
      user.autocomplete = "username";
      user.value = active.auth.identifier;
      user.placeholder = "Username or email";
      user.addEventListener("input", () => {
        active.auth.identifier = user.value;
        active.auth.remove = false;
        clearFormError();
        updateFooter();
      });
      const userLabel = el("label", "", "Username or email");
      userLabel.htmlFor = user.id;
      userField.append(userLabel, user);

      const passField = el("div", "r34mf-settings-field");
      const pass = keyed(el("input", "r34mf-settings-text-input"), "auth:password");
      pass.type = "password";
      pass.id = "r34mf-settings-auth-password";
      pass.autocomplete = "current-password";
      pass.value = active.auth.password;
      pass.placeholder = "Password";
      pass.addEventListener("input", () => {
        active.auth.password = pass.value;
        active.auth.remove = false;
        clearFormError();
        updateFooter();
      });
      const passLabel = el("label", "", "Password");
      passLabel.htmlFor = pass.id;
      passField.append(passLabel, pass);
      form.append(userField, passField);
      card.append(form);

      if (active.credentials?.password || active.auth.password) {
        const remove = btn("Remove saved credentials", "is-quiet", "auth:remove");
        remove.addEventListener("click", () => {
          active.auth = { identifier: "", password: "", remove: true, editing: false };
          active.draft.automaticSignIn = false;
          clearFormError();
          redraw();
          queueMicrotask(() => active?.dialog.querySelector("[data-settings-focus-key='control:Automatically sign in']")?.focus({ preventScroll: true }));
        });
        const buttons = el("div", "r34mf-settings-auth-actions");
        buttons.append(remove);
        card.append(buttons);
      }
    }

    return card;
  }

  function advancedPage() {
    const node = page("Advanced", "Raw scheduler/retry controls and optional account recovery live here. Recommended defaults remain intentionally conservative.");
    const network = section("Network & recovery");
    const retryDisabled = active.draft.retryTemporaryDetailFailures !== true;
    network.list.append(
      row("Minimum request spacing", "Global minimum gap between request starts. Direct edits derive Request pace: Custom unless they exactly match a preset. (ms)", number(active.draft.advanced.minimumRequestSpacingMs, { min: 0, max: 10_000, step: 25, title: "Milliseconds (ms)", label: "Minimum request spacing" }, (v) => setAdvanced({ minimumRequestSpacingMs: v }))),
      row("Maximum automatic retries", retryDisabled ? "Disabled because Retry temporary detail failures is off in Scanning & queue." : "Retry attempts after the initial request; every retry reacquires the global gate.", number(active.draft.advanced.maximumAutomaticRetries, { min: 0, max: 10, disabled: retryDisabled, label: "Maximum automatic retries" }, (v) => setAdvanced({ maximumAutomaticRetries: v })), retryDisabled),
      row("Known-content stop threshold", "Consecutive known pages Smart Update uses as ordered-overlap evidence. (pages)", number(active.draft.advanced.smartUpdateKnownPageThreshold, { min: 1, max: 20, title: "Pages", label: "Known-content stop threshold" }, (v) => setAdvanced({ smartUpdateKnownPageThreshold: v }))),
      row("Debug logging", "Write extension diagnostic events to DevTools. Passwords and sign-in credentials are never logged.", sw(active.draft.advanced.debugLogging, "Debug logging", (v) => setAdvanced({ debugLogging: v })))
    );
    node.append(network.node);

    const auth = section("Automatic sign-in");
    auth.list.append(row("Automatically sign in", "Keep this account signed in whenever Rule34Video can safely verify a logged-out state and its native sign-in form.", sw(active.draft.automaticSignIn, "Automatically sign in", (v) => {
      clearFormError();
      active.draft.automaticSignIn = v;
      if (v && !credentialValues().password) active.auth.editing = true;
      redraw();
    })));
    node.append(auth.node, authCard());
    if (active.formError) node.append(el("div", "r34mf-settings-inline-note is-error r34mf-settings-form-error", active.formError));

    const restore = section("Recommended defaults");
    const restoreButton = btn("Restore recommended settings", "", "advanced:restore");
    restoreButton.addEventListener("click", () => {
      clearFormError();
      active.draft = settings.resetPreview();
      redraw();
    });
    restore.list.append(row("Restore recommended settings", "Load recommended values into the draft. Nothing changes until Save changes is pressed.", restoreButton));
    node.append(restore.node);
    return node;
  }

  function renderPage() {
    return active.tab === "display" ? displayPage()
      : active.tab === "data" ? dataPage()
        : active.tab === "advanced" ? advancedPage()
          : scanningPage();
  }

  function nav() {
    const node = el("nav", "r34mf-settings-nav");
    node.setAttribute("aria-label", "Settings sections");
    for (const [key, label] of TABS) {
      const item = keyed(el("button", key === active.tab ? "is-active" : "", label), `nav:${key}`);
      item.type = "button";
      item.setAttribute("aria-current", key === active.tab ? "page" : "false");
      item.addEventListener("click", () => {
        active.tab = key;
        active.dataMessage = null;
        redraw(false);
        if (key === "data" && !active.summary) refreshSummary();
      });
      node.append(item);
    }
    return node;
  }

  function footer() {
    const node = el("footer", "r34mf-settings-footer");
    const isDirty = dirty();
    node.append(el("span", `r34mf-settings-footer-status${isDirty ? " is-dirty" : ""}`, isDirty ? "Unsaved changes" : "All changes saved"));
    const actions = el("div", "r34mf-settings-footer-actions");
    const cancel = btn("Cancel", "is-quiet", "footer:cancel");
    cancel.disabled = active.busy;
    cancel.addEventListener("click", requestClose);
    const save = btn("Save changes", "is-primary", "footer:save");
    save.disabled = !isDirty || active.busy;
    save.addEventListener("click", saveChanges);
    actions.append(cancel, save);
    node.append(actions);
    return node;
  }

  function dialog() {
    const node = el("section", "r34mf-settings-dialog");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    node.setAttribute("aria-labelledby", "r34mf-settings-title");

    const header = el("header", "r34mf-settings-header");
    const heading = el("div", "r34mf-settings-heading");
    const title = el("h2", "", "Settings");
    title.id = "r34mf-settings-title";
    heading.append(title, el("p", "", "Rule34Video Media Filter"));
    const closeButton = keyed(el("button", "r34mf-settings-close"), "header:close");
    closeButton.type = "button";
    closeButton.disabled = active.busy;
    closeButton.setAttribute("aria-label", "Close settings");
    closeButton.append(closeIcon());
    closeButton.addEventListener("click", requestClose);
    header.append(heading, closeButton);

    const body = el("div", "r34mf-settings-body");
    const content = el("main", "r34mf-settings-content");
    content.append(renderPage());
    body.append(nav(), content);
    node.append(header, body, footer());
    return node;
  }

  function focusedKey() {
    const focused = document.activeElement;
    return active?.dialog?.contains(focused) ? focused?.dataset?.settingsFocusKey ?? null : null;
  }

  function restoreFocus(dialogNode, key) {
    if (!key) return;
    const target = [...dialogNode.querySelectorAll("[data-settings-focus-key]")]
      .find((node) => node.dataset.settingsFocusKey === key && !node.disabled);
    if (target) queueMicrotask(() => target.isConnected && target.focus({ preventScroll: true }));
  }

  function resolveReturnFocus(node) {
    if (node?.isConnected) return node;
    const action = String(node?.dataset?.r34mfAction ?? "");
    if (!action) return null;
    return [...document.querySelectorAll("[data-r34mf-action]")]
      .find((candidate) => candidate.dataset.r34mfAction === action && !candidate.disabled) ?? null;
  }

  function redraw(preserve = true) {
    if (!active?.layer) return;
    const oldContent = active.layer.querySelector(".r34mf-settings-content");
    const top = preserve ? oldContent?.scrollTop ?? 0 : 0;
    const focusKey = focusedKey();
    const confirmLayer = active.dialog?.querySelector(".r34mf-settings-confirm-layer") ?? null;
    const next = dialog();
    active.dialog.replaceWith(next);
    active.dialog = next;
    if (confirmLayer) next.append(confirmLayer);
    const content = next.querySelector(".r34mf-settings-content");
    if (content) content.scrollTop = top;
    restoreFocus(next, focusKey);
  }

  function updateFooter() {
    if (!active?.dialog) return;
    const old = active.dialog.querySelector(".r34mf-settings-footer");
    old?.replaceWith(footer());
  }

  function dismissConfirm(layer, { returnFocus = true } = {}) {
    const originalTarget = layer?._returnFocus ?? null;
    const returnKey = layer?._returnFocusKey ?? null;
    layer?.remove();
    if (!returnFocus) return;
    const target = originalTarget?.isConnected
      ? originalTarget
      : [...(active?.dialog?.querySelectorAll?.("[data-settings-focus-key]") ?? [])]
        .find((node) => node.dataset.settingsFocusKey === returnKey && !node.disabled);
    if (target?.isConnected) queueMicrotask(() => target.focus({ preventScroll: true }));
  }

  function showConfirm(title, message, confirmLabel, danger, action) {
    if (!active?.dialog || active.busy) return;
    dismissConfirm(active.dialog.querySelector(".r34mf-settings-confirm-layer"), { returnFocus: false });
    const layer = el("div", "r34mf-settings-confirm-layer");
    layer._returnFocus = document.activeElement;
    layer._returnFocusKey = focusedKey();
    const box = el("section", "r34mf-settings-confirm");
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "r34mf-settings-confirm-title");
    box.setAttribute("aria-describedby", "r34mf-settings-confirm-description");
    const heading = el("h4", "", title);
    heading.id = "r34mf-settings-confirm-title";
    const description = el("p", "", message);
    description.id = "r34mf-settings-confirm-description";
    box.append(heading, description);
    const actions = el("div", "r34mf-settings-confirm-actions");
    const keep = btn("Keep editing", "is-primary", "confirm:keep");
    const confirm = btn(confirmLabel, danger ? "is-danger" : "", "confirm:accept");
    keep.addEventListener("click", () => dismissConfirm(layer));
    confirm.addEventListener("click", async () => {
      dismissConfirm(layer, { returnFocus: false });
      await action?.();
    });
    actions.append(keep, confirm);
    box.append(actions);
    layer.append(box);
    active.dialog.append(layer);
    queueMicrotask(() => keep.focus({ preventScroll: true }));
  }

  function requestClose() {
    if (!active || active.busy) return;
    if (!dirty()) {
      close({ returnFocus: true });
      return;
    }
    showConfirm(
      "Discard unsaved changes?",
      "Settings changes have not been saved. Immediate data actions that already completed are not undone.",
      "Discard changes",
      true,
      () => close({ returnFocus: true })
    );
  }

  function validateSave() {
    const values = credentialValues();
    const partialCredentials = credentialsDirty(active)
      && active.auth.remove !== true
      && Boolean(values.identifier) !== Boolean(values.password);
    if (partialCredentials || (active.draft.automaticSignIn && (!values.identifier || !values.password))) {
      active.tab = "advanced";
      active.auth.editing = true;
      active.formError = partialCredentials
        ? "Saved sign-in credentials need both a username/email and password. Complete both fields or remove the saved credentials."
        : "Automatic sign-in needs both a username/email and password before it can be enabled.";
      const missingKey = values.identifier ? "auth:password" : "auth:identifier";
      redraw(false);
      queueMicrotask(() => active?.dialog.querySelector(`[data-settings-focus-key='${missingKey}']`)?.focus({ preventScroll: true }));
      return false;
    }
    active.formError = null;
    return true;
  }

  function credentialStorageUpdate(session) {
    if (!credentialsDirty(session)) return { changed: false, value: session.credentials ?? null };
    const values = credentialValues(session);
    if (session.auth.remove || (!values.identifier && !values.password)) return { changed: true, value: null };
    if (!values.identifier || !values.password) throw new Error("Sign-in credentials must include both an identifier and password.");
    return {
      changed: true,
      value: {
        identifier: values.identifier,
        password: values.password,
        savedAt: Date.now(),
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        blockedUntil: 0
      }
    };
  }

  async function saveChanges() {
    if (!active || active.busy || !validateSave()) return;
    const session = active;
    const credentialUpdate = credentialStorageUpdate(session);
    let persisted = false;
    session.busy = true;
    redraw();
    try {
      const extraStorage = credentialUpdate.changed ? { [constants.storageKeys.authCredentials]: credentialUpdate.value } : {};
      const saved = await settings.save(session.draft, extraStorage);
      persisted = true;
      if (active !== session) return;
      if (credentialUpdate.changed) session.credentials = credentialUpdate.value;
      session.original = clone(saved);
      session.draft = clone(saved);
      await session.onSaved?.(saved);
      if (active === session) {
        session.busy = false;
        close({ returnFocus: true });
      }
    } catch (error) {
      if (active === session) {
        session.busy = false;
        redraw();
        const detail = error?.message ?? "Unknown refresh error.";
        const message = persisted
          ? `Settings were saved, but the page could not refresh them immediately: ${detail} Reload the page if the visible state looks stale.`
          : (error?.message ?? "Settings could not be saved.");
        session.dialog.querySelector(".r34mf-settings-page")?.append(el("div", "r34mf-settings-inline-note is-error", message));
      }
    }
  }

  function onKeyDown(event) {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      const confirm = active.dialog.querySelector(".r34mf-settings-confirm-layer");
      if (confirm) {
        dismissConfirm(confirm);
      } else {
        requestClose();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const scope = active.dialog.querySelector(".r34mf-settings-confirm-layer") ?? active.dialog;
    const focusable = [...scope.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")]
      .filter((node) => node.offsetParent !== null || node === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function close({ returnFocus = false, force = false } = {}) {
    openGeneration += 1;
    opening = null;
    if (!active) return;
    if (active.busy && !force) return;
    const focus = active.returnFocus;
    document.removeEventListener("keydown", onKeyDown, true);
    active.layer.remove();
    active = null;
    unlockScroll();
    if (returnFocus) {
      const target = resolveReturnFocus(focus);
      if (target) queueMicrotask(() => target.isConnected && target.focus({ preventScroll: true }));
    }
  }

  async function open({ returnFocus = null, onSaved = null, onDataChanged = null } = {}) {
    if (active) {
      active.dialog.querySelector(".r34mf-settings-close")?.focus({ preventScroll: true });
      return active.layer;
    }
    if (opening) return opening;

    const generation = ++openGeneration;
    const promise = (async () => {
      const result = await browserApi.storageLocal.get(constants.storageKeys.authCredentials);
      if (generation !== openGeneration) return null;
      const credentials = result?.[constants.storageKeys.authCredentials] ?? null;
      const original = settings.normalize(settings.value);
      const layer = el("div", "r34mf-settings-layer");
      layer.dataset.r34mfOwned = "true";
      const scrim = el("div", "r34mf-settings-scrim");
      layer.append(scrim);
      active = {
        layer,
        dialog: null,
        tab: "scanning",
        original: clone(original),
        draft: clone(original),
        credentials,
        auth: { identifier: String(credentials?.identifier ?? ""), password: String(credentials?.password ?? ""), remove: false, editing: false },
        summary: null,
        dataError: null,
        dataMessage: null,
        formError: null,
        importPreview: null,
        importMode: "merge",
        fileInput: null,
        busy: false,
        returnFocus,
        onSaved,
        onDataChanged
      };
      scrim.addEventListener("click", requestClose);
      active.dialog = dialog();
      layer.append(active.dialog);
      if (generation !== openGeneration) {
        active = null;
        return null;
      }
      document.body.append(layer);
      lockScroll();
      document.addEventListener("keydown", onKeyDown, true);
      queueMicrotask(() => active?.dialog.querySelector(".r34mf-settings-nav .is-active")?.focus({ preventScroll: true }));
      return layer;
    })();
    opening = promise;
    try {
      return await promise;
    } finally {
      if (opening === promise) opening = null;
    }
  }

  app.modules.settingsUi = Object.freeze({
    open,
    close,
    isOpen: () => Boolean(active),
    isDirty: () => dirty(),
    normalizedDraft: normalized,
    TABS
  });
})();
