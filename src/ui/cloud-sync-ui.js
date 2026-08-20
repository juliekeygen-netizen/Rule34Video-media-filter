(() => {
  "use strict";

  const app = globalThis.R34MF;
  const cloud = app?.modules.cloudSync;
  if (!app || !cloud) throw new Error("R34MF Cloud sync must load before Cloud sync UI.");

  let active = null;
  let toastTimer = null;

  function el(tag, cls = "", text = undefined) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / (1024 ** 2)).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  }

  function when(value) {
    if (!value) return "Unknown";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
  }

  function toast(message, kind = "success") {
    document.querySelector(".r34mf-cloud-toast")?.remove();
    if (toastTimer) clearTimeout(toastTimer);
    const node = el("div", `r34mf-cloud-toast is-${kind}`, message);
    node.dataset.r34mfOwned = "true";
    document.body.append(node);
    toastTimer = setTimeout(() => {
      node.remove();
      if (toastTimer) toastTimer = null;
    }, 5200);
  }

  function metadataCard(title, meta, extra = {}) {
    const card = el("div", "r34mf-cloud-meta-card");
    card.append(el("strong", "r34mf-cloud-meta-title", title));
    const grid = el("div", "r34mf-cloud-meta-grid");
    const items = [
      ["Backup", meta?.current === true ? "Current state" : when(meta?.exportedAt)],
      ["Extension", meta?.appVersion ?? "Unknown"],
      ["Indexed", Number(meta?.indexed ?? 0).toLocaleString()],
      ["Detailed", Number(meta?.detailed ?? 0).toLocaleString()],
      ["Seen", Number(meta?.seen ?? 0).toLocaleString()],
      ["Favorites", Number(meta?.favorites ?? 0).toLocaleString()],
      ["Size", meta?.bytes == null ? "Calculated when needed" : formatBytes(meta.bytes ?? extra.size ?? 0)]
    ];
    if (extra.commit) items.push(["Commit", `${extra.commit.shortSha || String(extra.commit.sha ?? "").slice(0, 7)} · ${when(extra.commit.date)}`]);
    for (const [label, value] of items) {
      const item = el("div");
      item.append(el("span", "", label), el("b", "", value));
      grid.append(item);
    }
    card.append(grid);
    if (extra.commit?.message) card.append(el("small", "r34mf-cloud-commit-message", extra.commit.message));
    return card;
  }

  function remoteFileCard(remote) {
    const card = el("div", "r34mf-cloud-meta-card");
    card.append(el("strong", "r34mf-cloud-meta-title", "Cloud backup"));
    const grid = el("div", "r34mf-cloud-meta-grid");
    const commit = remote?.commit;
    const items = [
      ["Latest commit", commit?.shortSha || String(commit?.sha ?? "").slice(0, 7) || "Unknown"],
      ["Updated", when(commit?.date)],
      ["File size", formatBytes(remote?.size ?? 0)]
    ];
    for (const [label, value] of items) {
      const item = el("div");
      item.append(el("span", "", label), el("b", "", value));
      grid.append(item);
    }
    card.append(grid);
    if (commit?.message) card.append(el("small", "r34mf-cloud-commit-message", commit.message));
    card.append(el("small", "r34mf-cloud-commit-message", "Backup contents are downloaded and validated only after you confirm, which keeps this preview fast."));
    return card;
  }

  function setProgress(stage, info = {}) {
    if (!active?.box) return;
    const label = active.box.querySelector(".r34mf-cloud-progress-label");
    const note = active.box.querySelector(".r34mf-cloud-progress-note");
    const bar = active.box.querySelector(".r34mf-cloud-progress-bar");
    const stages = {
      preparing: ["Preparing local backup…", "Reading the local catalogue and serializing the backup once."],
      compressing: ["Optimizing backup for transfer…", "Compressing the JSON before it crosses extension messaging and GitHub. This usually makes catalogue backups much smaller."],
      uploading: ["Uploading backup to GitHub…", "The browser does not expose reliable byte-by-byte GitHub upload progress here, so this indicator shows the current stage."],
      finalizing: ["Finalizing GitHub commit…", "GitHub is saving the uploaded backup and returning the new commit information."],
      downloading: ["Downloading cloud backup…", "Cloud backups created by current versions are compressed to reduce transfer time. Older uncompressed backups remain supported."],
      decompressing: ["Decompressing cloud backup…", "Expanding the downloaded backup locally before validation. No local catalogue data has been replaced yet."],
      validating: ["Validating cloud backup…", "The downloaded file is checked before any local extension data is replaced."],
      replacing: ["Replacing local extension data…", "Applying the validated cloud snapshot and refreshing Local state."],
      complete: ["Complete", "Cloud sync finished successfully."]
    };
    const [text, defaultDetail] = stages[stage] ?? ["Working…", "This operation may take a little while for a large catalogue."];
    let detail = defaultDetail;
    if (stage === "uploading" && Number(info.originalBytes) > 0 && Number(info.bytes) > 0) {
      detail = info.encoding === "gzip"
        ? `Uploading ${formatBytes(info.bytes)} after compressing the ${formatBytes(info.originalBytes)} JSON backup.`
        : `Uploading ${formatBytes(info.bytes)}. Compression was unavailable, so this transfer is using the legacy JSON path.`;
    }
    if (label) label.textContent = text;
    if (note) note.textContent = detail;
    if (bar) {
      bar.dataset.stage = stage;
      bar.classList.toggle("is-complete", stage === "complete");
      bar.classList.toggle("is-indeterminate", stage !== "complete");
    }
  }

  function close({ returnFocus = true } = {}) {
    if (!active || active.busy) return;
    const focus = active.returnFocus;
    document.removeEventListener("keydown", onKeyDown, true);
    active.layer.remove();
    active = null;
    if (returnFocus && focus?.isConnected) queueMicrotask(() => focus.focus({ preventScroll: true }));
  }

  function onKeyDown(event) {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...active.box.querySelectorAll("button:not(:disabled), [tabindex]:not([tabindex='-1'])")];
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

  function loading(action) {
    const box = el("section", "r34mf-cloud-dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const title = action === "pull" ? "Pull cloud backup" : "Push cloud backup";
    box.append(
      el("h3", "", title),
      el("p", "r34mf-cloud-lead", "Checking GitHub repository and local counts…"),
      el("p", "r34mf-cloud-progress-note", "This preview is lightweight. The larger backup build or download happens only after you confirm.")
    );
    const progress = el("div", "r34mf-cloud-progress-bar is-indeterminate");
    progress.append(el("span"));
    box.append(progress);
    return box;
  }

  function errorView(error) {
    if (!active) return;
    active.box.replaceChildren(
      el("h3", "", active.action === "pull" ? "Pull cloud backup" : "Push cloud backup"),
      el("div", "r34mf-cloud-error", error?.message ?? "Cloud sync failed.")
    );
    const actions = el("div", "r34mf-cloud-actions");
    const closeButton = el("button", "r34mf-cloud-button is-primary", "Close");
    closeButton.type = "button";
    closeButton.addEventListener("click", () => close());
    actions.append(closeButton);
    active.box.append(actions);
    queueMicrotask(() => closeButton.focus({ preventScroll: true }));
  }

  function confirmation(preview) {
    if (!active) return;
    const action = active.action;
    const remote = preview.remote?.remote ?? null;
    const remoteMeta = remote?.backupMeta ?? null;
    const remoteInspected = remoteMeta !== null;
    const remoteValid = remoteMeta?.valid === true;
    active.preview = preview;
    active.box.replaceChildren();
    active.box.append(el("h3", "", action === "pull" ? "Replace local data from cloud?" : "Push local backup to GitHub?"));

    const note = action === "pull"
      ? "Pull always uses Replace. Your local catalogue, filters, presets, Seen and Favorites will be replaced by this cloud backup. The backup is downloaded, decompressed if needed, and validated before replacement. Rule34Video sign-in credentials and the GitHub token are not changed."
      : remote
        ? "This will replace the existing cloud backup with a fresh compressed backup from this device. The remote SHA is checked again before upload so a newer cloud copy cannot be overwritten silently."
        : "No cloud backup exists yet. This will create the first compressed backup file in the configured private repository.";
    active.box.append(el("p", "r34mf-cloud-lead", note));

    const compare = el("div", "r34mf-cloud-compare");
    compare.append(metadataCard("This device", preview.local));
    if (remote) {
      compare.append(remoteMeta
        ? metadataCard("Cloud backup", remoteMeta, { size: remote.size, commit: remote.commit })
        : remoteFileCard(remote));
    } else {
      const empty = el("div", "r34mf-cloud-meta-card is-empty");
      empty.append(el("strong", "r34mf-cloud-meta-title", "Cloud backup"), el("p", "", "No remote backup file yet."));
      compare.append(empty);
    }
    active.box.append(compare);

    if (action === "pull" && remote && remoteInspected && remoteMeta?.valid === false) {
      active.box.append(el(
        "div",
        "r34mf-cloud-error",
        remoteMeta?.error
          ? `Pull is blocked: ${remoteMeta.error}`
          : "Pull is blocked because the remote file is not a valid Rule34Video Media Filter backup."
      ));
    }

    if (preview.remote?.repository?.fullName) {
      active.box.append(el("div", "r34mf-cloud-repo-note", `Private repository: ${preview.remote.repository.fullName} · ${preview.remote.backupPath}`));
    }

    const progressWrap = el("div", "r34mf-cloud-progress is-hidden");
    progressWrap.append(
      el("div", "r34mf-cloud-progress-label", "Preparing…"),
      el("div", "r34mf-cloud-progress-note", "Large backups can still take a little while. This indicator reports the real current stage rather than a made-up percentage.")
    );
    const bar = el("div", "r34mf-cloud-progress-bar is-indeterminate");
    bar.append(el("span"));
    progressWrap.append(bar);
    active.box.append(progressWrap);

    const actions = el("div", "r34mf-cloud-actions");
    const cancel = el("button", "r34mf-cloud-button", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => close());
    const confirm = el("button", `r34mf-cloud-button ${action === "pull" ? "is-danger" : "is-primary"}`, action === "pull" ? "Replace from cloud" : "Push backup");
    confirm.type = "button";
    confirm.disabled = action === "pull" && !remote;
    confirm.addEventListener("click", async () => {
      if (!active || active.busy) return;
      active.busy = true;
      cancel.disabled = true;
      confirm.disabled = true;
      progressWrap.classList.remove("is-hidden");
      const expectedSha = remote?.sha ?? null;
      try {
        const result = action === "pull"
          ? await cloud.pull({ expectedSha, onProgress: (info) => setProgress(info.stage, info) })
          : await cloud.push({ expectedSha, onProgress: (info) => setProgress(info.stage, info) });
        setProgress("complete");
        const callback = active?.onComplete;
        const focus = active?.returnFocus;
        active.busy = false;
        close({ returnFocus: false });
        toast(action === "pull" ? "Cloud backup pulled and local data replaced." : "Cloud backup pushed successfully.");
        await callback?.({ action, result });
        if (focus?.isConnected) queueMicrotask(() => focus.focus({ preventScroll: true }));
      } catch (error) {
        if (!active) return;
        active.busy = false;
        errorView(error);
        toast(error?.message ?? "Cloud sync failed.", "error");
      }
    });
    actions.append(cancel, confirm);
    active.box.append(actions);
    queueMicrotask(() => cancel.focus({ preventScroll: true }));
  }

  async function open(action, { returnFocus = null, onComplete = null } = {}) {
    if (!new Set(["push", "pull"]).has(action)) throw new Error("Cloud sync action must be push or pull.");
    if (active) return active.layer;
    const config = await cloud.loadConfig();
    if (!config.valid) {
      toast("Configure GitHub Cloud sync in Settings → Data & storage first.", "error");
      return null;
    }

    const layer = el("div", "r34mf-cloud-layer");
    layer.dataset.r34mfOwned = "true";
    const scrim = el("div", "r34mf-cloud-scrim");
    const box = loading(action);
    layer.append(scrim, box);
    active = { layer, box, action, busy: false, returnFocus, onComplete, preview: null };
    scrim.addEventListener("click", () => close());
    document.body.append(layer);
    document.addEventListener("keydown", onKeyDown, true);

    try {
      const preview = await cloud.preview();
      if (!active || active.layer !== layer) return layer;
      confirmation(preview);
    } catch (error) {
      if (active?.layer === layer) errorView(error);
    }
    return layer;
  }

  app.modules.cloudSyncUi = Object.freeze({ open, close, toast, formatBytes, metadataCard });
})();