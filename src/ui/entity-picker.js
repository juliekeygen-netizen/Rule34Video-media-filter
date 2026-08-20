(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before entity picker.");

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function normalizedValues(selected, multiple) {
    if (multiple) {
      const seen = new Set();
      return Array.isArray(selected) ? selected.map((value) => String(value ?? "").trim()).filter((value) => {
        const key = value.toLocaleLowerCase();
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
      }) : [];
    }
    return selected ? [selected] : [];
  }

  function pointerScrollable(rail) {
    const threshold = 6;
    let pressed = false, dragging = false, suppressClick = false, pointerId = null, startX = 0, startScroll = 0;
    rail.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pressed = true;
      dragging = false;
      suppressClick = false;
      pointerId = event.pointerId;
      startX = event.clientX;
      startScroll = rail.scrollLeft;
    });
    rail.addEventListener("pointermove", (event) => {
      if (!pressed || event.pointerId !== pointerId) return;
      const delta = event.clientX - startX;
      if (!dragging && Math.abs(delta) >= threshold) {
        dragging = true;
        suppressClick = true;
        rail.setPointerCapture?.(pointerId);
        rail.classList.add("is-dragging");
      }
      if (dragging) {
        rail.scrollLeft = startScroll - delta;
        event.preventDefault();
      }
    });
    const end = (event) => {
      if (!pressed || (event.pointerId != null && event.pointerId !== pointerId)) return;
      const wasDragging = dragging;
      pressed = false;
      dragging = false;
      rail.classList.remove("is-dragging");
      if (wasDragging && pointerId != null && rail.hasPointerCapture?.(pointerId)) rail.releasePointerCapture?.(pointerId);
      pointerId = null;
    };
    rail.addEventListener("pointerup", end);
    rail.addEventListener("pointercancel", end);
    rail.addEventListener("lostpointercapture", end);
    rail.addEventListener("click", (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    rail.__r34mfConsumeDragClick = () => {
      if (!suppressClick) return false;
      suppressClick = false;
      return true;
    };
    rail.addEventListener("wheel", (event) => {
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta) return;
      rail.scrollLeft += delta;
      event.preventDefault();
    }, { passive: false });
    rail.tabIndex = 0;
    rail.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") rail.scrollLeft = 0;
      else if (event.key === "End") rail.scrollLeft = rail.scrollWidth;
      else rail.scrollLeft += event.key === "ArrowLeft" ? -80 : 80;
    });
  }

  function create({
    field,
    selected = null,
    vocabulary = { covered: 0, total: 0, values: [] },
    multiple = false,
    collapseOnSelect = false,
    placeholder = null,
    emptyMessage = null,
    resultLimit = 60,
    onChange
  }) {
    const root = el("div", `r34mf-entity-picker${collapseOnSelect ? " is-single is-compact-single" : ""}`);
    root.dataset.entityField = field;
    let values = normalizedValues(selected, multiple);
    let query = "";
    let searchOpen = !collapseOnSelect || !values.length;

    const notify = () => onChange?.(multiple ? [...values] : values[0] ?? null);

    function renderSelected(container) {
      container.replaceChildren();
      if (collapseOnSelect && values.length) {
        const value = values[0];
        const count = vocabulary.values?.find((item) => item.value === value)?.count ?? 0;
        const selectedRow = el("div", "r34mf-entity-selected-compact");
        selectedRow.append(
          el("span", "r34mf-entity-selected-name", value),
          el("small", "r34mf-entity-selected-count", `${count.toLocaleString()} ${count === 1 ? "video" : "videos"}`)
        );
        const change = el("button", "r34mf-entity-change", "Change");
        change.type = "button";
        change.addEventListener("click", () => {
          searchOpen = true;
          render();
          queueMicrotask(() => root.focusSearch());
        });
        selectedRow.append(change);
        container.append(selectedRow);
        return;
      }

      const header = el("div", "r34mf-entity-subhead");
      header.append(el("span", "", "SELECTED"), el("small", "", `${values.length} selected`));
      container.append(header);
      if (!values.length) { container.append(el("p", "r34mf-entity-empty", "Nothing selected.")); return; }
      const chips = el("div", "r34mf-entity-selected-list");
      chips.setAttribute("role", "list");
      pointerScrollable(chips);
      for (const value of values) {
        const count = vocabulary.values?.find((item) => String(item.value).toLocaleLowerCase() === String(value).toLocaleLowerCase())?.count ?? 0;
        const chip = el("span", "r34mf-entity-chip");
        chip.append(el("span", "", value), el("small", "", `[${count.toLocaleString()}]`));
        const remove = el("button", "", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${value}`);
        remove.addEventListener("click", () => {
          if (chips.__r34mfConsumeDragClick?.()) return;
          values = values.filter((item) => item !== value); notify(); render();
        });
        chip.append(remove);
        chips.append(chip);
      }
      container.append(chips);
    }

    function renderResults(container) {
      container.replaceChildren();
      const header = el("div", "r34mf-entity-subhead");
      header.append(el("span", "", "RESULTS"), el("small", "", `${(vocabulary.covered ?? 0).toLocaleString()} / ${(vocabulary.total ?? 0).toLocaleString()} detailed`));
      container.append(header);
      if (!(vocabulary.covered > 0)) {
        container.append(el("p", "r34mf-entity-empty", emptyMessage ?? `No detailed ${field} metadata yet.`));
        return;
      }
      const needle = query.trim().toLocaleLowerCase();
      const results = (vocabulary.values ?? [])
        .filter((item) => !needle || String(item.value).toLocaleLowerCase().includes(needle))
        .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
        .slice(0, resultLimit);
      if (!results.length) { container.append(el("p", "r34mf-entity-empty", needle ? "No matching local values." : "No local values.")); return; }

      const rail = el("div", "r34mf-entity-results");
      rail.setAttribute("role", "listbox");
      rail.setAttribute("aria-label", `${field} results`);
      pointerScrollable(rail);
      const updateOverflow = () => rail.classList.toggle("has-more", rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2);
      rail.addEventListener("scroll", updateOverflow, { passive: true });
      for (const item of results) {
        const result = el("button", "r34mf-entity-result");
        result.type = "button";
        result.setAttribute("role", "option");
        const selectedIndex = () => values.findIndex((value) => value.toLocaleLowerCase() === String(item.value).toLocaleLowerCase());
        result.setAttribute("aria-selected", selectedIndex() >= 0 ? "true" : "false");
        result.append(el("span", "", item.value), el("small", "", `[${item.count.toLocaleString()}]`));
        result.addEventListener("click", () => {
          if (rail.__r34mfConsumeDragClick?.()) return;
          if (multiple) {
            const index = selectedIndex();
            values = index >= 0 ? values.filter((_value, valueIndex) => valueIndex !== index) : [...values, item.value];
          }
          else { values = [item.value]; if (collapseOnSelect) searchOpen = false; }
          notify();
          render();
        });
        rail.append(result);
      }
      container.append(rail);
      queueMicrotask(updateOverflow);
    }

    function render() {
      root.replaceChildren();
      if (searchOpen) {
        const searchGroup = el("label", "r34mf-entity-search");
        if (!collapseOnSelect) searchGroup.append(el("span", "r34mf-entity-subhead-label", "SEARCH"));
        const search = el("input", "r34mf-filter-input");
        search.type = "search";
        search.autocomplete = "off";
        search.placeholder = placeholder ?? `Search local ${field}…`;
        search.value = query;
        search.addEventListener("input", () => {
          query = search.value;
          const results = root.querySelector(".r34mf-entity-results-wrap");
          if (results) renderResults(results);
        });
        searchGroup.append(search);
        root.append(searchGroup);
      }
      if (searchOpen) {
        const resultsWrap = el("section", "r34mf-entity-results-wrap");
        renderResults(resultsWrap);
        root.append(resultsWrap);
      }
      if (multiple || (values.length && !searchOpen)) {
        const selectedWrap = el("section", "r34mf-entity-selected-wrap");
        renderSelected(selectedWrap);
        root.append(selectedWrap);
      }
    }

    render();
    root.value = () => multiple ? [...values] : values[0] ?? null;
    root.focusSearch = () => root.querySelector("input[type='search']")?.focus();
    return root;
  }

  app.modules.entityPicker = Object.freeze({ create, normalizedValues, pointerScrollable });
})();
