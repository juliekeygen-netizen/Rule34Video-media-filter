(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.advancedFilterEditor;
  const engine = app?.modules.filterEngine;
  if (!app || !base || !engine) throw new Error("R34MF Advanced Filter editor must load before field additions.");

  const DUPLICATE_LAYOUT = Object.freeze([
    Object.freeze(["matchingDuration", "matchingCategory", "matchingTag"]),
    Object.freeze(["matchingTitleWords", "matchingQuality"])
  ]);

  const DUPLICATE_HELP = Object.freeze({
    matchingDuration: "Second difference for flag",
    matchingTag: "Amount of tags to flag",
    matchingTitleWords: "Amount of words to flag"
  });

  let activeDuplicateHelp = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
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
    control.addEventListener("change", () => onChange(control.value));
    return control;
  }

  function toggle(checked, text, onChange) {
    const label = el("label", "r34mf-check-label r34mf-duplicate-toggle");
    const input = el("input", "r34mf-check");
    input.type = "checkbox";
    input.checked = checked === true;
    input.addEventListener("change", () => onChange(input.checked));
    label.append(input, el("span", "", text));
    return label;
  }

  function hideDuplicateHelp() {
    activeDuplicateHelp?.node?.remove?.();
    activeDuplicateHelp = null;
  }

  function showDuplicateHelp(anchor, text) {
    if (!anchor?.isConnected || !text) return;
    hideDuplicateHelp();
    const tooltip = el("div", "r34mf-duplicate-help", text);
    tooltip.setAttribute("role", "tooltip");
    document.body.append(tooltip);

    const anchorBox = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const remainingWidth = Math.max(52, viewportWidth - anchorBox.left - 8);
    tooltip.style.maxWidth = `${Math.min(190, remainingWidth)}px`;
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.round(anchorBox.left))}px`;
    tooltip.style.top = `${Math.max(8, Math.round(anchorBox.top - box.height - 6))}px`;
    activeDuplicateHelp = { node: tooltip, anchor };
  }

  globalThis.addEventListener?.("resize", hideDuplicateHelp);
  globalThis.addEventListener?.("scroll", hideDuplicateHelp, true);

  function duplicateAmount(rule, debug, { optionKey, defaultValue, ariaLabel, helpText }) {
    const wrapper = el("span", "r34mf-duplicate-amount-wrap");
    const control = el("input", "r34mf-filter-input r34mf-duplicate-amount");
    control.type = "text";
    control.inputMode = "numeric";
    control.pattern = "[0-9]*";
    control.autocomplete = "off";
    const normalized = engine.duplicateOptions(rule.options);
    const amount = Number(normalized?.[optionKey]);
    control.value = amount === defaultValue ? "" : String(amount);
    control.setAttribute("aria-label", ariaLabel);
    control.addEventListener("input", () => {
      const clean = control.value.replace(/\D/g, "");
      if (clean !== control.value) control.value = clean;
      const current = debug.findItem(rule.id);
      if (!current) return;
      const raw = clean === "" ? defaultValue : Number.parseInt(clean, 10);
      const nextAmount = optionKey === "matchingDurationSecDifference"
        ? (engine.nonNegativeInteger?.(raw) ?? Math.max(0, raw || 0))
        : (engine.positiveWordCount?.(raw) ?? Math.max(1, raw || 1));
      current.options = { ...engine.duplicateOptions(current.options), [optionKey]: nextAmount };
    });
    const show = () => showDuplicateHelp(control, helpText);
    wrapper.addEventListener("pointerenter", show);
    wrapper.addEventListener("pointerleave", hideDuplicateHelp);
    wrapper.addEventListener("focusin", show);
    wrapper.addEventListener("focusout", hideDuplicateHelp);
    wrapper.append(control);
    return wrapper;
  }

  function amountForDuplicateOption(key, rule, debug) {
    if (key === "matchingDuration") {
      return duplicateAmount(rule, debug, {
        optionKey: "matchingDurationSecDifference",
        defaultValue: 0,
        ariaLabel: "Allowed seconds difference",
        helpText: DUPLICATE_HELP.matchingDuration
      });
    }
    if (key === "matchingTag") {
      return duplicateAmount(rule, debug, {
        optionKey: "matchingTagCount",
        defaultValue: 1,
        ariaLabel: "Amount of matching tags",
        helpText: DUPLICATE_HELP.matchingTag
      });
    }
    if (key === "matchingTitleWords") {
      return duplicateAmount(rule, debug, {
        optionKey: "matchingTitleWordCount",
        defaultValue: 1,
        ariaLabel: "Amount of matching words",
        helpText: DUPLICATE_HELP.matchingTitleWords
      });
    }
    return null;
  }

  function duplicateOption(key, label, rule, debug) {
    const item = el("div", "r34mf-duplicate-option");
    item.dataset.duplicateOption = key;
    item.append(toggle(rule.options?.[key], label, (checked) => {
      const current = debug.findItem(rule.id);
      if (!current) return;
      current.options = { ...engine.duplicateOptions(current.options), [key]: checked };
      debug.redraw({ focusId: rule.id });
    }));
    const amount = amountForDuplicateOption(key, rule, debug);
    if (amount) item.append(amount);
    return item;
  }

  function duplicateRows(rule, debug) {
    const labels = new Map(engine.DUPLICATE_OPTIONS);
    const options = el("div", "r34mf-duplicate-options");
    DUPLICATE_LAYOUT.forEach((keys, index) => {
      const row = el("div", "r34mf-duplicate-row");
      row.dataset.duplicateRow = String(index + 1);
      for (const key of keys) row.append(duplicateOption(key, labels.get(key) ?? key, rule, debug));
      options.append(row);
    });
    return options;
  }

  function shortenAnyWord(root) {
    root?.querySelectorAll?.(".r34mf-check-label span").forEach((node) => {
      if (node.textContent.trim() === "Match any word") node.textContent = "Any word";
    });
  }

  function enhanceSpecialRows(content) {
    const debug = content?.__r34mfAdvancedDebug;
    if (!debug) return;
    shortenAnyWord(content);

    for (const row of content.querySelectorAll(".r34mf-advanced-rule[data-advanced-id]")) {
      const rule = debug.findItem(row.dataset.advancedId);
      if (!rule || !["quality", "duplicates"].includes(rule.field)) continue;
      const conditionCell = row.querySelector(":scope > .r34mf-rule-primary > .r34mf-advanced-condition");
      const valueCell = row.querySelector(":scope > .r34mf-rule-primary > .r34mf-advanced-value");
      if (!conditionCell || !valueCell) continue;

      const alreadyEnhanced = rule.field === "quality"
        ? Boolean(conditionCell.querySelector("select[aria-label='Quality condition']") && valueCell.querySelector("select[aria-label='Quality']"))
        : Boolean(valueCell.querySelector(".r34mf-duplicate-options"));
      if (alreadyEnhanced) continue;

      row.classList.remove("is-boolean-only", "is-quality", "is-duplicates", "has-wide-value");
      conditionCell.replaceChildren();
      valueCell.replaceChildren();

      if (rule.field === "quality") {
        row.classList.add("is-quality");
        conditionCell.append(select(rule.operator ?? "equals", engine.QUALITY_OPERATORS, "Quality condition", (operator) => {
          const current = debug.findItem(rule.id);
          if (!current) return;
          current.operator = operator;
          debug.redraw({ focusId: rule.id });
        }));
        valueCell.append(select(rule.value ?? "1080p", engine.QUALITY_OPTIONS, "Quality", (value) => {
          const current = debug.findItem(rule.id);
          if (!current) return;
          current.value = value;
          debug.redraw({ focusId: rule.id });
        }));
      } else {
        row.classList.add("is-duplicates", "has-wide-value");
        valueCell.append(duplicateRows(rule, debug));
      }
    }
  }

  function create(args) {
    const result = base.create(args);
    const content = result?.content;
    if (!content) return result;
    let queued = false;
    const run = () => { queued = false; enhanceSpecialRows(content); };
    const schedule = () => {
      if (!queued) {
        queued = true;
        queueMicrotask(run);
      }
    };
    const observer = new MutationObserver(schedule);
    observer.observe(content, { childList: true, subtree: true });
    content.addEventListener("change", schedule, true);
    content.__r34mfAdvancedFieldObserver = observer;
    run();
    return result;
  }

  app.modules.advancedFilterEditor = Object.freeze({
    ...base,
    create,
    shortenAnyWord,
    enhanceSpecialRows,
    amountForDuplicateOption,
    duplicateRows,
    DUPLICATE_LAYOUT,
    DUPLICATE_HELP,
    hideDuplicateHelp,
    showDuplicateHelp
  });
})();
