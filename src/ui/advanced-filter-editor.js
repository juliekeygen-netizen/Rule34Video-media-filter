(() => {
  "use strict";

  const app = globalThis.R34MF;
  const engine = app?.modules.filterEngine;
  const drafts = app?.modules.filterDraft;
  const dates = app?.modules.dateControl;
  const entities = app?.modules.entityPicker;
  if (!app || !engine || !drafts || !dates || !entities) throw new Error("Advanced Filter editor dependencies must load first.");

  const fieldOptions = engine.ALL_FIELDS.map((field) => [field, engine.FIELD_DEFINITIONS[field].label]);
  const polarityOptions = [["match", "Match"], ["exclude", "Exclude"]];
  const logicOptions = [["and", "AND"], ["or", "OR"]];
  function sanitizeNumeric(value, mode = "integer") {
    const text = String(value ?? "");
    if (mode === "integer") return text.replace(/\D/g, "");
    if (mode === "decimal") { const clean = text.replace(/[^\d.,]/g, "").replace(",", "."); const parts = clean.split("."); return parts.shift() + (parts.length ? `.${parts.join("")}` : ""); }
    if (mode === "compact") { const clean = text.replace(/[^\d.kmb]/gi, ""); const match = clean.match(/^(\d*(?:\.\d*)?)([kmbKMB]?).*$/); return `${match?.[1] ?? ""}${match?.[2] ?? ""}`; }
    return text;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, cls = "") {
    const node = el("button", `r34mf-filter-button ${cls}`.trim(), text);
    node.type = "button";
    return node;
  }

  function select(value, options, label, onChange) {
    const control = el("select", "r34mf-filter-select");
    control.setAttribute("aria-label", label);
    for (const [key, text] of options) {
      const option = el("option", "", text);
      option.value = key;
      option.selected = key === value;
      control.append(option);
    }
    control.addEventListener("change", () => onChange([...control.querySelectorAll("option")].find((option) => option.selected)?.value));
    return control;
  }

  function input(value, placeholder, label, onInput, inputMode = "text") {
    const control = el("input", "r34mf-filter-input");
    control.type = "text";
    control.inputMode = inputMode;
    control.autocomplete = "off";
    control.value = value ?? "";
    control.placeholder = placeholder;
    control.setAttribute("aria-label", label);
    control.addEventListener("input", () => { const clean = inputMode === "text" ? control.value : sanitizeNumeric(control.value, inputMode); if (clean !== control.value) control.value = clean; onInput(clean); });
    return control;
  }

  function checkbox(checked, label, onChange) {
    const wrapper = el("label", "r34mf-advanced-check");
    const control = el("input", "r34mf-check");
    control.type = "checkbox";
    control.checked = checked === true;
    control.setAttribute("aria-label", label);
    control.addEventListener("change", () => onChange(control.checked));
    wrapper.append(control);
    return wrapper;
  }

  function updateRuleIn(items, id, update) {
    for (const item of items ?? []) {
      if (item.id === id && item.kind === "rule") { update(item); return item; }
      if (item.kind === "group") {
        const found = updateRuleIn(item.items, id, update);
        if (found) return found;
      }
    }
    return null;
  }

  function findItem(items, id) {
    for (const item of items ?? []) {
      if (item.id === id) return item;
      if (item.kind === "group") {
        const found = findItem(item.items, id);
        if (found) return found;
      }
    }
    return null;
  }

  function entityVocabulary(state, field) {
    return state.vocabulary?.[field] ?? { covered: 0, total: state.coverage?.total ?? 0, values: [] };
  }

  function create({ modal, state, send, overlayHost }) {
    let draft = engine.clone(modal.draft ?? { enabled: false, items: [] });
    if (!Array.isArray(draft.items)) draft.items = [];
    if (modal.enableOnApply && !draft.items.length) draft.items.push(drafts.defaultRule());
    const collapsedGroups = new Set();
    const validationErrors = new Map();
    const content = el("div", "r34mf-advanced-editor");
    const body = el("div", "r34mf-advanced-modal-body");
    const headerMeta = el("div", "r34mf-advanced-header-meta");
    const headerCounts = el("p", "r34mf-advanced-header-counts");
    const headerCoverage = el("p", "r34mf-advanced-header-coverage");
    headerMeta.append(headerCounts, headerCoverage);
    content.append(body);

    let menuState = null;
    let dragState = null;
    let previewOpen = false;
    let previewText = null;
    let previewSummary = null;
    let suppressOutsideClick = false;

    const updateLive = () => {
      const count = drafts.counts(draft.items);
      headerCounts.textContent = `${count.rules} ${count.rules === 1 ? "rule" : "rules"} · ${count.enabled} enabled`;
      const globalActive = state.filters?.advanced?.enabled === true;
      const detailed = drafts.detailedCount(draft.items, globalActive);
      headerCoverage.textContent = detailed
        ? `Detailed metadata ${(state.coverage?.detailed ?? 0).toLocaleString()} / ${(state.coverage?.total ?? 0).toLocaleString()} · used by ${detailed} active ${detailed === 1 ? "rule" : "rules"}`
        : "";
      headerCoverage.hidden = !detailed;
      if (previewText) previewText.textContent = drafts.preview(draft.items).join("\n");
      if (previewSummary) {
        const connectors = new Set();
        const inspect = (items) => (items ?? []).forEach((item) => {
          if (item.enabled === false) return;
          if (item.connector) connectors.add(item.connector);
          if (item.kind === "group") inspect(item.items);
        });
        inspect(draft.items);
        const logic = connectors.size > 1 ? "Mixed AND/OR" : connectors.has("or") ? "OR logic" : "AND logic";
        previewSummary.textContent = `Logic preview · ${logic} · ${count.groups} ${count.groups === 1 ? "group" : "groups"}`;
      }
    };

    const closeMenu = ({ restoreFocus = false } = {}) => {
      const trigger = menuState?.trigger;
      menuState?.node.remove();
      menuState = null;
      if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    };

    const clearDropIndicators = () => {
      body.querySelectorAll(".is-drop-before, .is-drop-after").forEach((node) => node.classList.remove("is-drop-before", "is-drop-after"));
    };

    const redraw = ({ focusId = null } = {}) => {
      const scrollTop = body.scrollTop;
      closeMenu();
      clearDropIndicators();
      body.replaceChildren();

      const headings = el("div", "r34mf-advanced-columns");
      for (const [cls, text] of [["logic", "LOGIC"], ["field", "FIELD"], ["polarity", "MATCH / EXCLUDE"], ["condition", "OPTIONS"]]) headings.append(el("span", `is-${cls}`, text));
      body.append(headings);

      draft.items.forEach((item, index) => body.append(item.kind === "group" ? renderGroup(item, index, draft.items) : renderRule(item, index, "root", draft.items)));

      const addActions = el("div", "r34mf-advanced-actions");
      const addRule = button("+ Add rule", "r34mf-advanced-add-rule");
      addRule.dataset.advancedAction = "add-root-rule";
      const addGroup = button("+ Add group", "r34mf-filter-quiet r34mf-advanced-add-group");
      addGroup.dataset.advancedAction = "add-root-group";
      addActions.append(addRule, addGroup);
      body.append(addActions);

      const preview = el("details", "r34mf-logic-preview");
      preview.open = previewOpen;
      preview.addEventListener("toggle", () => { previewOpen = preview.open; });
      previewSummary = el("summary", "");
      previewText = el("pre", "");
      preview.append(previewSummary, previewText);
      body.append(preview);
      updateLive();
      body.scrollTop = scrollTop;
      if (focusId) queueMicrotask(() => body.querySelector(`[data-advanced-id='${focusId}'] select, [data-advanced-id='${focusId}'] input, [data-advanced-id='${focusId}'] button`)?.focus());
    };

    function isEffective(item) { return item?.enabled !== false && (item.kind !== "group" || engine.hasEffectiveExpression(item.items)); }
    function logicCell(item, index, label, siblings = []) {
      const cell = el("div", "r34mf-advanced-logic");
      if (!(siblings ?? []).slice(0, index).some(isEffective)) cell.append(el("span", "r34mf-rule-logic-spacer"));
      else cell.append(select(item.connector ?? "and", logicOptions, label, (connector) => { item.connector = connector; updateLive(); }));
      return cell;
    }

    function dragHandle(item, parentId) {
      const handle = button("⠿", "r34mf-drag");
      handle.draggable = true;
      handle.setAttribute("aria-label", `Drag ${item.kind === "group" ? "group" : "rule"} to reorder`);
      handle.title = "Drag to reorder";
      handle.addEventListener("dragstart", (event) => {
        dragState = { id: item.id, parentId };
        event.dataTransfer?.setData("text/plain", item.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        handle.classList.add("is-dragging");
      });
      handle.addEventListener("dragend", () => { handle.classList.remove("is-dragging"); dragState = null; clearDropIndicators(); });
      return handle;
    }

    function bindDropTarget(node, item, parentId) {
      node.dataset.dragParent = parentId;
      node.addEventListener("dragover", (event) => {
        if (!dragState || dragState.parentId !== parentId || dragState.id === item.id) return;
        event.preventDefault();
        clearDropIndicators();
        const box = node.getBoundingClientRect();
        node.classList.add(event.clientY > box.top + box.height / 2 ? "is-drop-after" : "is-drop-before");
      });
      node.addEventListener("drop", (event) => {
        if (!dragState || dragState.parentId !== parentId || dragState.id === item.id) return;
        event.preventDefault();
        const items = drafts.listFor(draft, parentId);
        const targetIndex = items.findIndex((candidate) => candidate.id === item.id);
        const after = node.classList.contains("is-drop-after");
        const beforeId = after ? items[targetIndex + 1]?.id ?? null : item.id;
        draft = drafts.reorder(draft, { parentId, id: dragState.id, beforeId });
        dragState = null;
        redraw();
      });
    }

    function menuButton(item, parentId, index, length) {
      const trigger = button("...", "r34mf-filter-quiet r34mf-advanced-menu-toggle");
      trigger.setAttribute("aria-label", `${item.kind === "group" ? "Group" : "Rule"} actions`);
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.addEventListener("click", () => openMenu(item, parentId, index, length, trigger));
      return trigger;
    }

    function openMenu(item, parentId, index, length, trigger) {
      if (menuState?.id === item.id) { closeMenu({ restoreFocus: true }); return; }
      closeMenu();
      const menu = el("div", "r34mf-advanced-menu");
      menu.setAttribute("role", "menu");
      const actions = [];
      if (item.kind === "group") actions.push(["add-child", "Add rule", false]);
      actions.push(["move-up", "Move up", index === 0], ["move-down", "Move down", index === length - 1]);
      actions.push(["duplicate", item.kind === "group" ? "Duplicate group" : "Duplicate rule", false]);
      if (item.kind === "group") actions.push(["toggle", item.enabled === false ? "Enable group" : "Disable group", false]);
      actions.push(["delete", item.kind === "group" ? "Delete group" : "Delete rule", false]);

      for (const [action, label, disabled] of actions) {
        const control = button(label, `r34mf-filter-quiet${action === "delete" ? " is-danger" : ""}`);
        control.disabled = disabled;
        control.setAttribute("role", "menuitem");
        control.addEventListener("click", () => {
          if (action === "add-child") draft = drafts.mutate(draft, { type: "addRule", parentId: item.id });
          else if (action === "move-up" || action === "move-down") draft = drafts.move(draft, { parentId, id: item.id, direction: action === "move-up" ? "up" : "down" });
          else draft = drafts.mutate(draft, { type: action, parentId, id: item.id });
          closeMenu();
          redraw({ focusId: item.id });
        });
        menu.append(control);
      }
      overlayHost.append(menu);
      const box = trigger.getBoundingClientRect();
      const menuBox = menu.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const left = Math.max(8, Math.min(box.right - menuBox.width, viewportWidth - menuBox.width - 8));
      const top = box.bottom + 5 + menuBox.height <= viewportHeight - 8 ? box.bottom + 5 : Math.max(8, box.top - menuBox.height - 5);
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
      menuState = { id: item.id, node: menu, trigger };
      queueMicrotask(() => menu.querySelector("button:not(:disabled)")?.focus());
    }

    function textOptions(rule) {
      const keys = engine.textOptionKeys(rule.operator);
      if (!keys.length) return null;
      const secondary = el("div", "r34mf-rule-secondary r34mf-text-options-secondary");
      const options = el("div", "r34mf-text-options");
      const labels = { caseSensitive: "Case sensitive", wholeWord: "Exact word / phrase", matchAnyWord: "Match any word", separateByCommas: "Separate by commas" };
      for (const key of keys) {
        const label = el("label", "r34mf-check-label");
        const control = el("input", "r34mf-check");
        control.type = "checkbox";
        control.checked = rule.options?.[key] === true;
        control.addEventListener("change", () => { rule.options = { ...rule.options, [key]: control.checked }; updateLive(); });
        label.append(control, el("span", "", labels[key]));
        options.append(label);
      }
      secondary.append(options);
      return secondary;
    }

    function renderTextEditor(rule, definition, valueCell, conditionCell) {
      conditionCell.append(select(rule.operator, definition.operators, `${definition.label} condition`, (operator) => {
        Object.assign(rule, drafts.changeRuleOperator(rule, operator));
        redraw({ focusId: rule.id });
      }));
      valueCell.append(input(rule.value, definition.editor === "text" && rule.field === "description" ? "Description text" : "Text", `${definition.label} value`, (value) => { rule.value = value; updateLive(); }));
      return textOptions(rule);
    }

    function renderNumericEditor(rule, definition, valueCell, conditionCell) {
      conditionCell.append(select(rule.operator, definition.operators, `${definition.label} condition`, (operator) => {
        Object.assign(rule, drafts.changeRuleOperator(rule, operator));
        redraw({ focusId: rule.id });
      }));
      const range = el("div", "r34mf-advanced-range");
      const placeholder = rule.field === "rating" ? "0–100" : ["views", "ratingVotes"].includes(rule.field) ? "e.g. 100K" : "Value";
      const mode = definition.editor === "compactNumeric" ? "compact" : "decimal";
      range.append(input(rule.value, placeholder, `${definition.label} value`, (value) => { rule.value = value; updateLive(); }, mode));
      if (rule.operator === "between") {
        range.append(el("span", "r34mf-range-separator", "to"));
        range.append(input(rule.valueTo, placeholder, `${definition.label} upper value`, (value) => { rule.valueTo = value; updateLive(); }, mode));
      }
      if (rule.field === "rating") range.append(el("span", "r34mf-input-suffix r34mf-rating-suffix", "%"));
      valueCell.append(range);
      if (definition.units) valueCell.append(select(rule.unit, definition.units, `${definition.label} unit`, (unit) => { rule.unit = unit; updateLive(); }));
      return null;
    }

    function renderDateEditor(rule, definition, valueCell, conditionCell) {
      conditionCell.append(select(rule.operator, definition.operators, "Upload date condition", (operator) => {
        Object.assign(rule, drafts.changeRuleOperator(rule, operator));
        redraw({ focusId: rule.id });
      }));
      if (rule.operator === "within") {
        const relative = el("div", "r34mf-advanced-relative");
        relative.append(
          input(rule.value, "Amount", "Relative date amount", (value) => { rule.value = value; updateLive(); }, "integer"),
          select(rule.unit, definition.units, "Relative date unit", (unit) => { rule.unit = unit; updateLive(); })
        );
        valueCell.append(relative);
      } else {
        const range = el("div", "r34mf-advanced-date-range");
        const start = dates.create(rule.value, rule.operator === "between" ? "Start date" : "Date");
        start.addEventListener("change", () => { rule.value = start.dataset.dateValue; updateLive(); });
        range.append(start);
        if (rule.operator === "between") {
          range.append(el("span", "r34mf-range-separator", "to"));
          const end = dates.create(rule.valueTo, "End date");
          end.addEventListener("change", () => { rule.valueTo = end.dataset.dateValue; updateLive(); });
          range.append(end);
        }
        valueCell.append(range);
      }
      return null;
    }

    function renderEntityPicker(rule, valueCell) {
      const field = rule.field;
      const singular = ({ tags: "tag", categories: "category", artist: "artist", uploader: "uploader" })[field] ?? field;
      valueCell.append(entities.create({
        field,
        selected: rule.value,
        vocabulary: entityVocabulary(state, field),
        multiple: false,
        collapseOnSelect: true,
        placeholder: `Search local ${field}…`,
        emptyMessage: `No detailed ${singular} metadata yet.`,
        onChange: (value) => { rule.value = value ?? ""; redraw({ focusId: rule.id }); }
      }));
    }

    function renderRule(rule, index, parentId, siblings = []) {
      const definition = engine.FIELD_DEFINITIONS[rule.field] ?? engine.FIELD_DEFINITIONS.title;
      const row = el("article", `r34mf-advanced-rule is-${definition.editor}${validationErrors.has(rule.id) ? " is-invalid" : ""}`);
      row.dataset.advancedId = rule.id;
      row.dataset.advancedParent = parentId;
      const primary = el("div", "r34mf-rule-primary");
      primary.append(dragHandle(rule, parentId));
      primary.append(checkbox(rule.enabled, `Enable ${definition.label} rule`, (enabled) => { rule.enabled = enabled; validationErrors.delete(rule.id); updateLive(); row.classList.remove("is-invalid"); }));
      primary.append(logicCell(rule, index, "Rule logic", siblings));
      const fieldCell = el("div", "r34mf-advanced-field");
      fieldCell.append(select(rule.field, fieldOptions, "Rule field", (field) => {
        const replacement = drafts.resetRuleField(rule, field);
        Object.keys(rule).forEach((key) => { delete rule[key]; });
        Object.assign(rule, replacement);
        validationErrors.delete(rule.id);
        redraw({ focusId: rule.id });
      }));
      primary.append(fieldCell);
      const polarityCell = el("div", "r34mf-advanced-polarity");
      polarityCell.append(select(rule.polarity ?? "match", polarityOptions, "Match or exclude", (polarity) => { rule.polarity = polarity; updateLive(); }));
      primary.append(polarityCell);
      const conditionCell = el("div", "r34mf-advanced-condition");
      const valueCell = el("div", "r34mf-advanced-value");
      let secondary = null;

      if (definition.editor === "text") secondary = renderTextEditor(rule, definition, valueCell, conditionCell);
      else if (["numeric", "compactNumeric", "rating"].includes(definition.editor)) secondary = renderNumericEditor(rule, definition, valueCell, conditionCell);
      else if (definition.editor === "date") secondary = renderDateEditor(rule, definition, valueCell, conditionCell);
      else if (definition.editor === "entity") { row.classList.add("has-wide-value"); renderEntityPicker(rule, valueCell); }
      else if (definition.editor === "entityOrText") {
        conditionCell.append(select(rule.operator, definition.operators, `${definition.label} condition`, (operator) => {
          Object.assign(rule, drafts.changeRuleOperator(rule, operator));
          redraw({ focusId: rule.id });
        }));
        if (rule.operator === "is") renderEntityPicker(rule, valueCell);
        else if (rule.field === "artist" && rule.operator === "amountOf") {
          valueCell.append(input(rule.value, "Value", "Artist amount", (value) => { rule.value = value; updateLive(); }, "integer"));
          valueCell.append(select(rule.countComparator ?? "gt", [["gt", ">"], ["gte", "≥"], ["lte", "≤"], ["lt", "<"]], "Artist amount comparator", (value) => { rule.countComparator = value; updateLive(); }));
        } else {
          valueCell.append(input(rule.value, "Text", `${definition.label} value`, (value) => { rule.value = value; updateLive(); }));
          secondary = textOptions(rule);
        }
      } else if (definition.editor === "membership") {
        row.classList.add("is-membership");
        const membershipOption = el("label", "r34mf-check-label");
        const membershipControl = el("input", "r34mf-check");
        membershipControl.type = "checkbox";
        membershipControl.checked = rule.options?.includeWithoutDetails === true;
        membershipControl.addEventListener("change", () => { rule.options = { includeWithoutDetails: membershipControl.checked }; updateLive(); });
        membershipOption.append(membershipControl, el("span", "", "Include videos without details"));
        valueCell.append(membershipOption);
      } else row.classList.add("is-boolean-only");

      primary.append(conditionCell, valueCell, menuButton(rule, parentId, index, drafts.listFor(draft, parentId)?.length ?? 1));
      row.append(primary);
      if (secondary) row.append(secondary);
      if (validationErrors.has(rule.id)) row.append(el("p", "r34mf-rule-error", validationErrors.get(rule.id)));
      bindDropTarget(row, rule, parentId);
      return row;
    }

    function renderGroup(group, index, siblings = []) {
      const section = el("section", `r34mf-advanced-group${group.enabled === false ? " is-disabled" : ""}`);
      section.dataset.advancedId = group.id;
      section.dataset.advancedParent = "root";
      const header = el("header", "r34mf-group-header");
      header.tabIndex = 0;
      header.setAttribute("role", "button");
      header.setAttribute("aria-label", "Toggle group collapse");
      header.setAttribute("aria-expanded", collapsedGroups.has(group.id) ? "false" : "true");
      const toggleCollapse = () => { if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id); else collapsedGroups.add(group.id); redraw({ focusId: group.id }); };
      header.addEventListener("click", (event) => { if (!event.target.closest("button, input, select, a, label")) toggleCollapse(); });
      header.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !event.target.closest("button, input, select, a, label")) { event.preventDefault(); toggleCollapse(); } });
      header.append(dragHandle(group, "root"));
      header.append(checkbox(group.enabled, "Enable group", (enabled) => { group.enabled = enabled; redraw({ focusId: group.id }); }));
      header.append(logicCell(group, index, "Group logic", siblings));
      header.append(el("strong", "r34mf-group-title", `GROUP · ${group.items.length} ${group.items.length === 1 ? "rule" : "rules"}`));
      header.append(menuButton(group, "root", index, draft.items.length));
      section.append(header);
      if (!collapsedGroups.has(group.id)) {
        const children = el("div", "r34mf-group-children");
        group.items.forEach((child, childIndex) => children.append(renderRule(child, childIndex, group.id, group.items)));
        const add = button("+ Add rule to group", "r34mf-filter-quiet r34mf-group-add");
        add.dataset.advancedAction = `add-group-rule:${group.id}`;
        children.append(add);
        section.append(children);
      }
      bindDropTarget(section, group, "root");
      return section;
    }

    body.addEventListener("click", (event) => {
      const action = event.target.closest("[data-advanced-action]")?.dataset.advancedAction;
      if (action === "add-root-rule") draft = drafts.mutate(draft, { type: "addRule", parentId: "root" });
      else if (action === "add-root-group") draft = drafts.mutate(draft, { type: "addGroup", parentId: "root" });
      else if (action?.startsWith("add-group-rule:")) draft = drafts.mutate(draft, { type: "addRule", parentId: action.slice("add-group-rule:".length) });
      else return;
      redraw();
    });

    overlayHost.addEventListener("pointerdown", (event) => {
      if (!menuState || menuState.node.contains(event.target) || menuState.trigger.contains(event.target)) return;
      closeMenu();
      suppressOutsideClick = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    overlayHost.addEventListener("click", (event) => {
      if (!suppressOutsideClick) return;
      suppressOutsideClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    const handleEscape = () => {
      if (menuState) { closeMenu({ restoreFocus: true }); return true; }
      if (dates.handleEscape(overlayHost)) return true;
      return false;
    };

    const apply = () => {
      validationErrors.clear();
      const errors = drafts.validate(draft.items);
      if (errors.length) {
        errors.forEach((error) => validationErrors.set(error.id, error.message));
        redraw({ focusId: errors[0].id });
        queueMicrotask(() => body.querySelector(`[data-advanced-id='${errors[0].id}']`)?.scrollIntoView?.({ block: "center" }));
        return false;
      }
      const advanced = drafts.serialize(draft);
      if (!advanced.items.length) advanced.enabled = false;
      send("advanced-apply", { advanced, enableOnApply: modal.enableOnApply === true });
      return true;
    };

    redraw();
    content.__r34mfAdvancedDebug = Object.freeze({ getDraft: () => engine.clone(draft), apply, redraw, findItem: (id) => findItem(draft.items, id) });
    return { content, headerMeta, apply, handleEscape, getDraft: () => engine.clone(draft) };
  }

  app.modules.advancedFilterEditor = Object.freeze({ create, updateRuleIn, findItem, sanitizeNumeric });
})();
