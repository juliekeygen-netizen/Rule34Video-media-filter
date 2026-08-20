(() => {
  "use strict";

  const app = globalThis.R34MF;
  const engine = app?.modules.filterEngine;
  const drafts = app?.modules.filterDraft;
  const dates = app?.modules.dateControl;
  const entities = app?.modules.entityPicker;
  const advanced = app?.modules.advancedFilterEditor;
  if (!app || !engine || !drafts || !dates || !entities || !advanced) {
    throw new Error("R34MF filter modal dependencies must load first.");
  }

  const labels = Object.freeze({
    title: "Title",
    duration: "Duration",
    views: "Views",
    rating: "Rating",
    ratingVotes: "Rating votes",
    hdAvailable: "HD available",
    uploadDate: "Upload date",
    artist: "Artist",
    uploader: "Uploader",
    tags: "Tags",
    categories: "Categories",
    description: "Description",
    subscriptionsOnly: "Subscriptions only"
  });

  const numericOperators = Object.freeze([
    ["gte", "Greater than or equal to"],
    ["gt", "Greater than"],
    ["lte", "Less than or equal to"],
    ["lt", "Less than"],
    ["equals", "Equals"],
    ["between", "Between"]
  ]);

  const textOperators = Object.freeze([
    ["contains", "Contains"],
    ["equals", "Equals"],
    ["startsWith", "Starts with"],
    ["endsWith", "Ends with"],
    ["wildcard", "Wildcard"],
    ["regex", "Regular expression"]
  ]);

  let scrollLock = null;

  function lockPageScroll() {
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
    body.dataset.r34mfModalScrollLock = "true";
  }

  function unlockPageScroll() {
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
    delete body.dataset.r34mfModalScrollLock;
    window.scrollTo?.(saved.scrollX, saved.scrollY);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, action, cls = "") {
    const node = el("button", `r34mf-filter-button ${cls}`.trim(), text);
    node.type = "button";
    if (action) node.dataset.modalAction = action;
    return node;
  }

  function select(value, items, onChange, ariaLabel = "") {
    const node = el("select", "r34mf-filter-select");
    if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
    for (const [key, text] of items) {
      const option = el("option", "", text);
      option.value = key;
      option.selected = key === value;
      node.append(option);
    }
    node.addEventListener("change", () => onChange(node.value));
    return node;
  }

  function input(value, placeholder, onChange, mode = "text") {
    const node = el("input", "r34mf-filter-input");
    node.type = "text";
    node.inputMode = mode === "compact" ? "text" : mode === "text" ? "text" : "decimal";
    node.value = value ?? "";
    node.placeholder = placeholder;
    node.autocomplete = "off";
    node.addEventListener("input", () => { const clean = mode === "text" ? node.value : advanced.sanitizeNumeric(node.value, mode); if (clean !== node.value) node.value = clean; onChange(clean); });
    return node;
  }

  function checkbox(text, checked, onChange) {
    const label = el("label", "r34mf-check-label");
    const control = el("input", "r34mf-check");
    control.type = "checkbox";
    control.checked = checked === true;
    control.addEventListener("change", () => onChange(control.checked));
    label.append(control, el("span", "", text));
    return label;
  }

  function normalEditor(modal, state, send) {
    let draft = drafts.normalDraft({ value: modal.draft }, modal.field);
    const currentEntry = app.modules.filterState?.active?.().filters?.[modal.source]?.[modal.field];
    let matchMode = modal.matchMode ?? currentEntry?.matchMode ?? currentEntry?.tagMatch ?? "any";
    const content = el("div", "r34mf-modal-content");

    const redraw = () => {
      content.replaceChildren();
      const field = modal.field;
      const config = draft && typeof draft === "object" && !Array.isArray(draft)
        ? draft
        : { value: draft };

      if (["title", "description"].includes(field)) {
        content.append(
          select(config.operator ?? "contains", textOperators, (operator) => {
            draft = { ...config, operator };
            redraw();
          }, `${labels[field]} condition`),
          input(config.value, "Text", (value) => { draft = { ...config, value }; })
        );
        const options = el("div", "r34mf-text-options");
        for (const [key, text] of [
          ["caseSensitive", "Case sensitive"],
          ["wholeWord", "Exact word / phrase"],
          ["matchAnyWord", "Match any word"]
        ]) {
          options.append(checkbox(text, config.options?.[key], (checked) => {
            draft = { ...config, options: { ...config.options, [key]: checked } };
          }));
        }
        content.append(options);
        return;
      }

      if (["duration", "views", "rating", "ratingVotes"].includes(field)) {
        const operator = config.operator ?? "gte";
        content.append(select(operator, numericOperators, (next) => {
          draft = { ...config, operator: next };
          redraw();
        }, `${labels[field]} condition`));

        const range = el("div", "r34mf-range-inputs");
        const numericMode = ["views", "ratingVotes"].includes(field) ? "compact" : "decimal";
        range.append(input(config.value, field === "rating" ? "0–100" : field === "views" ? "e.g. 10K" : "Value", (value) => {
          draft = { ...config, value };
        }, numericMode));
        if (operator === "between") {
          range.append(el("span", "r34mf-range-separator", "to"));
          range.append(input(config.valueTo, "To", (valueTo) => { draft = { ...config, valueTo }; }, numericMode));
        }
        if (field === "duration") {
          range.append(select(config.unit ?? "minutes", [["seconds", "Seconds"], ["minutes", "Minutes"], ["hours", "Hours"]], (unit) => {
            draft = { ...config, unit };
          }, "Duration unit"));
        }
        if (field === "rating") range.append(el("span", "r34mf-input-suffix r34mf-rating-suffix", "%"));
        content.append(range);
        return;
      }

      if (field === "uploadDate") {
        const operator = config.operator ?? "on";
        content.append(select(operator, [["on", "On"], ["after", "After"], ["before", "Before"], ["between", "Between"], ["within", "Within"]], (next) => {
          draft = { ...config, operator: next };
          redraw();
        }, "Upload date condition"));

        if (operator === "within") {
          const relative = el("div", "r34mf-range-inputs");
          relative.append(
            input(config.value, "Amount", (value) => { draft = { ...config, value }; }, "integer"),
            select(config.unit ?? "days", engine.DATE_WITHIN_UNITS, (unit) => {
              draft = { ...config, unit };
            }, "Relative date unit")
          );
          content.append(relative);
        } else {
          const date = dates.create(config.value, "Date");
          date.addEventListener("change", () => { draft = { ...config, value: date.dataset.dateValue }; });
          content.append(date);
          if (operator === "between") {
            const end = dates.create(config.valueTo, "End date");
            end.addEventListener("change", () => { draft = { ...config, valueTo: end.dataset.dateValue }; });
            content.append(end);
          }
        }
        return;
      }

      if (["artist", "uploader", "tags", "categories"].includes(field)) {
        const picker = entities.create({
          field,
          selected: Array.isArray(draft) ? draft : [],
          vocabulary: state.vocabulary?.[field] ?? { covered: 0, total: state.coverage?.total ?? 0, values: [] },
          multiple: true,
          onChange: (value) => { draft = value; }
        });
        content.append(picker);
        const match = el("div", "r34mf-entity-match");
        match.append(el("span", "r34mf-entity-subhead-label", "MATCH"));
        match.append(select(matchMode, [["any", "Any selected"], ["all", "All selected"]], (next) => { matchMode = next; }, `${labels[field]} match mode`));
        content.append(match);
        return;
      }

      if (field === "subscriptionsOnly") {
        content.append(checkbox("Include videos without details", config.options?.includeWithoutDetails, (checked) => {
          draft = { ...config, options: { ...config.options, includeWithoutDetails: checked } };
        }));
      }
    };

    redraw();

    return {
      content,
      apply: () => send("filter-apply", {
        source: modal.source,
        field: modal.field,
        value: ["artist", "uploader", "tags", "categories"].includes(modal.field)
          ? { value: Array.isArray(draft) ? draft : [], matchMode }
          : draft,
        enableOnApply: modal.enableOnApply === true
      })
    };
  }

  function presetEditor(state, send, overlayHost) {
    const content = el("div", "r34mf-modal-content r34mf-presets-content");
    let openMenu = null;
    let renameId = null;
    let creating = false;

    const closeMenu = () => {
      openMenu?.node.remove();
      openMenu = null;
    };

    const openMenuFor = (preset, trigger) => {
      if (openMenu?.id === preset.id) {
        closeMenu();
        return;
      }
      closeMenu();
      const menu = el("div", "r34mf-preset-menu");
      menu.setAttribute("role", "menu");
      const rename = button("Rename", null, "r34mf-filter-quiet");
      rename.addEventListener("click", () => { closeMenu(); renameId = preset.id; redraw(); });
      const duplicate = button("Duplicate", null, "r34mf-filter-quiet");
      duplicate.addEventListener("click", () => { closeMenu(); send(`preset-duplicate:${preset.id}`); });
      const remove = button("Delete", null, "r34mf-filter-quiet");
      remove.disabled = (state.presets?.length ?? 0) <= 1;
      remove.addEventListener("click", () => { closeMenu(); send(`preset-delete:${preset.id}`); });
      menu.append(rename, duplicate, remove);
      overlayHost.append(menu);
      const box = trigger.getBoundingClientRect();
      const gap = 5;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const menuBox = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(box.right - menuBox.width, viewportWidth - menuBox.width - 8));
      const top = box.bottom + gap + menuBox.height <= viewportHeight - 8
        ? box.bottom + gap
        : Math.max(8, box.top - menuBox.height - gap);
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
      openMenu = { id: preset.id, node: menu, trigger };
      rename.focus({ preventScroll: true });
    };

    overlayHost.addEventListener("pointerdown", (event) => {
      if (openMenu && !openMenu.node.contains(event.target) && !openMenu.trigger.contains(event.target)) {
        closeMenu();
        event.stopPropagation();
      }
    }, true);
    overlayHost.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && openMenu) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenu();
      }
    }, true);

    const redraw = () => {
      content.replaceChildren();
      for (const preset of state.presets ?? []) {
        const row = el("div", `r34mf-preset-row${preset.id === state.preset?.id ? " is-active" : ""}`);
        const selectPreset = button("", `preset-select:${preset.id}`, "r34mf-preset-select");
        selectPreset.append(el("span", "", preset.name));
        const menu = button("...", null, "r34mf-filter-quiet r34mf-preset-menu-toggle");
        menu.setAttribute("aria-label", `Actions for ${preset.name}`);
        menu.setAttribute("aria-haspopup", "menu");
        menu.addEventListener("click", () => { renameId = null; openMenuFor(preset, menu); });
        row.append(selectPreset, menu);

        if (renameId === preset.id) {
          const form = el("div", "r34mf-preset-inline-form");
          let nextName = preset.name;
          const name = input(preset.name, "Preset name", (value) => { nextName = value; });
          const save = button("Save", null, "r34mf-filter-primary");
          save.addEventListener("click", () => {
            if (nextName.trim()) send("preset-rename-submit", { id: preset.id, name: nextName.trim() });
          });
          form.append(name, save);
          row.append(form);
          queueMicrotask(() => name.select());
        }
        content.append(row);
      }

      const newPreset = button(creating ? "Cancel new preset" : "+ New preset", null, "r34mf-preset-new");
      newPreset.addEventListener("click", () => { creating = !creating; redraw(); });
      content.append(newPreset);
      if (creating) {
        const form = el("div", "r34mf-preset-inline-form");
        let nameValue = "";
        const name = input("", "Preset name", (value) => { nameValue = value; });
        const create = button("Create preset", null, "r34mf-filter-primary");
        create.addEventListener("click", () => {
          if (nameValue.trim()) send("preset-create", { name: nameValue.trim() });
        });
        form.append(name, create);
        content.append(form);
        queueMicrotask(() => name.focus());
      }
    };

    redraw();
    return { content };
  }

  function focusable(dialog) {
    return [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")]
      .filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
  }

  function render(state, send) {
    const existing = state.root.querySelector(":scope > .r34mf-modal-layer");
    if (!state.modal) {
      dates.closeOpenPicker(existing);
      existing?.remove();
      unlockPageScroll();
      return null;
    }
    dates.closeOpenPicker(existing);
    existing?.remove();
    lockPageScroll();

    const layer = el("div", "r34mf-modal-layer");
    layer.dataset.r34mfOwned = "true";
    const type = state.modal.type;
    const dialog = el("section", `r34mf-modal${type === "advanced" ? " r34mf-modal-advanced" : type === "presets" ? " r34mf-modal-presets" : state.modal.field === "subscriptionsOnly" ? " r34mf-modal-subscriptions" : ""}`);
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const header = el("header", "r34mf-modal-header");
    const title = el("h2", "r34mf-modal-title", type === "presets" ? "PRESETS" : type === "advanced" ? "ADVANCED FILTER" : labels[state.modal.field]);
    title.id = `r34mf-${type}-modal-title`;
    dialog.setAttribute("aria-labelledby", title.id);
    header.append(title);
    if (type === "presets") {
      const close = button("×", "cancel", "r34mf-filter-quiet r34mf-modal-close");
      close.setAttribute("aria-label", "Close");
      header.append(close);
    }

    const editor = type === "presets"
      ? presetEditor(state, send, layer)
      : type === "advanced"
        ? advanced.create({ modal: state.modal, state, send, overlayHost: layer })
        : normalEditor(state.modal, state, send);

    if (editor.headerMeta) header.append(editor.headerMeta);
    dialog.append(header, editor.content);
    if (type !== "presets") {
      const footer = el("footer", "r34mf-modal-footer");
      if (type === "advanced") footer.append(el("small", "r34mf-advanced-draft-note", "Draft changes are not applied until Apply."));
      footer.append(button("Cancel", "cancel"), button("Apply", "apply", "r34mf-filter-primary"));
      dialog.append(footer);
    }

    layer.append(dialog);
    state.root.append(layer);

    layer.addEventListener("click", (event) => {
      if (event.target === layer) {
        if (type === "presets") send("modal-cancel");
        return;
      }
      const action = event.target.closest("[data-modal-action]")?.dataset.modalAction;
      if (action === "cancel") send("modal-cancel");
      if (action === "apply") editor.apply?.();
      if (action?.startsWith("preset-select:") || action?.startsWith("preset-duplicate:") || action?.startsWith("preset-delete:")) send(action);
    });

    layer.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (editor.handleEscape?.()) return;
        if (dates.handleEscape(layer)) return;
        send("modal-cancel");
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(dialog);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    queueMicrotask(() => focusable(dialog)[0]?.focus());
    return layer;
  }

  app.modules.filterModals = Object.freeze({ render, labels, numericOperators, textOperators, lockPageScroll, unlockPageScroll });
})();
