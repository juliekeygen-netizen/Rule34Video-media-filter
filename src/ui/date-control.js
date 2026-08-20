(() => {
  "use strict";

  const app = globalThis.R34MF;
  const engine = app?.modules.filterEngine;
  if (!app || !engine) throw new Error("R34MF date control dependencies must load first.");

  let openPicker = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function dateParts(value) {
    const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match
      ? { year: match[1], month: match[2], day: match[3] }
      : { year: "", month: "", day: "" };
  }

  function valueFrom(root) {
    return engine.dateFromSegments(
      root.querySelector("[data-date-part='day']")?.value,
      root.querySelector("[data-date-part='month']")?.value,
      root.querySelector("[data-date-part='year']")?.value
    );
  }

  function chevronIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("r34mf-date-chevron");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 6l4 4 4-4");
    svg.append(path);
    return svg;
  }

  function overlayFor(root) {
    return root.closest?.(".r34mf-modal-layer") ?? null;
  }

  function positionPicker(active) {
    if (!active?.root.isConnected || !active?.picker.isConnected) {
      closeOpenPicker();
      return;
    }
    const anchor = active.root.getBoundingClientRect();
    const box = active.picker.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const gap = 6;
    const gutter = 8;
    if (anchor.bottom < gutter || anchor.top > viewportHeight - gutter || anchor.right < gutter || anchor.left > viewportWidth - gutter) {
      closeOpenPicker(active.overlay);
      return;
    }
    const left = Math.max(gutter, Math.min(anchor.left, viewportWidth - box.width - gutter));
    const below = anchor.bottom + gap;
    const top = below + box.height <= viewportHeight - gutter
      ? below
      : Math.max(gutter, anchor.top - box.height - gap);
    active.picker.style.left = `${Math.round(left)}px`;
    active.picker.style.top = `${Math.round(top)}px`;
  }

  function closeOpenPicker(scope = null, { restoreFocus = false } = {}) {
    if (!openPicker || (scope && !scope.contains(openPicker.root) && !scope.contains(openPicker.picker))) return false;
    const active = openPicker;
    openPicker = null;
    active.picker.remove();
    active.toggle.setAttribute("aria-expanded", "false");
    window.removeEventListener("resize", active.reposition);
    active.overlay.removeEventListener("scroll", active.reposition, true);
    active.overlay.removeEventListener("pointerdown", active.outsidePointerDown, true);
    if (restoreFocus && active.toggle.isConnected) active.toggle.focus({ preventScroll: true });
    return true;
  }

  function hasOpenPicker(scope = null) {
    return Boolean(openPicker && (!scope || scope.contains(openPicker.root) || scope.contains(openPicker.picker)));
  }

  function handleEscape(scope = null) {
    return closeOpenPicker(scope, { restoreFocus: true });
  }

  function create(value = "", label = "Date") {
    const parts = dateParts(value);
    const root = el("div", "r34mf-date-control");
    root.dataset.dateValue = value || "";
    root.setAttribute("aria-label", label);

    const updateTypedValue = () => {
      const next = valueFrom(root) ?? "";
      const hasInput = [...root.querySelectorAll("[data-date-part]")].some((part) => part.value);
      const changed = next !== root.dataset.dateValue;
      root.dataset.dateValue = next;
      root.toggleAttribute("data-invalid", hasInput && !next);
      if (changed || !hasInput) root.dispatchEvent(new Event("change", { bubbles: true }));
    };

    [["day", "DD", 2], ["month", "MM", 2], ["year", "YYYY", 4]].forEach(([key, placeholder, maxLength]) => {
      const input = el("input", "r34mf-date-segment");
      input.type = "text";
      input.inputMode = "numeric";
      input.maxLength = maxLength;
      input.placeholder = placeholder;
      input.value = parts[key];
      input.dataset.datePart = key;
      input.setAttribute("aria-label", `${label} ${key}`);
      input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(0, maxLength);
        updateTypedValue();
      });
      root.append(input);
      if (key !== "year") root.append(" / ");
    });

    const toggle = el("button", "r34mf-date-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-label", `Choose ${label.toLowerCase()}`);
    toggle.append(chevronIcon());
    root.append(toggle);

    const picker = el("div", "r34mf-date-picker");

    let displayed = value ? new Date(`${value}T00:00:00`) : new Date();

    const selectDate = (date) => {
      root.dataset.dateValue = date.toISOString().slice(0, 10);
      const next = dateParts(root.dataset.dateValue);
      Object.entries(next).forEach(([key, part]) => {
        const input = root.querySelector(`[data-date-part='${key}']`);
        if (input) input.value = part;
      });
      root.removeAttribute("data-invalid");
      closeOpenPicker(null, { restoreFocus: true });
      root.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const draw = (monthView = false) => {
      picker.replaceChildren();
      const header = el("div", "r34mf-date-picker-header");
      const prev = el("button", "", "‹");
      const title = el(
        "button",
        "r34mf-date-picker-title",
        monthView
          ? String(displayed.getFullYear())
          : displayed.toLocaleString(undefined, { month: "long", year: "numeric" })
      );
      const next = el("button", "", "›");
      prev.type = title.type = next.type = "button";
      prev.onclick = () => {
        displayed = new Date(
          displayed.getFullYear() + (monthView ? -1 : 0),
          displayed.getMonth() + (monthView ? 0 : -1),
          1
        );
        draw(monthView);
      };
      next.onclick = () => {
        displayed = new Date(
          displayed.getFullYear() + (monthView ? 1 : 0),
          displayed.getMonth() + (monthView ? 0 : 1),
          1
        );
        draw(monthView);
      };
      title.onclick = () => draw(true);
      header.append(prev, title, next);
      picker.append(header);

      const body = el("div", monthView ? "r34mf-month-grid" : "r34mf-day-grid");
      if (monthView) {
        for (let month = 0; month < 12; month += 1) {
          const button = el("button", "", new Date(2000, month, 1).toLocaleString(undefined, { month: "short" }));
          button.type = "button";
          button.onclick = () => {
            displayed = new Date(displayed.getFullYear(), month, 1);
            draw(false);
          };
          body.append(button);
        }
      } else {
        ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach((name) => body.append(el("span", "r34mf-date-weekday", name)));
        const first = new Date(displayed.getFullYear(), displayed.getMonth(), 1);
        const offset = (first.getDay() + 6) % 7;
        for (let blank = 0; blank < offset; blank += 1) body.append(el("span"));
        const days = new Date(displayed.getFullYear(), displayed.getMonth() + 1, 0).getDate();
        for (let day = 1; day <= days; day += 1) {
          const button = el("button", "", day);
          button.type = "button";
          const date = new Date(displayed.getFullYear(), displayed.getMonth(), day);
          if (date.toISOString().slice(0, 10) === root.dataset.dateValue) button.classList.add("is-selected");
          button.onclick = () => selectDate(date);
          body.append(button);
        }
      }
      picker.append(body);

      const today = el("button", "r34mf-date-today", "Today");
      today.type = "button";
      today.onclick = () => selectDate(new Date());
      picker.append(today);
    };

    toggle.setAttribute("aria-expanded", "false");
    toggle.onclick = () => {
      if (openPicker?.root === root) {
        closeOpenPicker(null, { restoreFocus: true });
        return;
      }
      const overlay = overlayFor(root);
      if (!overlay) return;
      closeOpenPicker();
      draw(false);
      overlay.append(picker);
      toggle.setAttribute("aria-expanded", "true");
      const reposition = () => positionPicker(openPicker);
      const outsidePointerDown = (event) => {
        if (picker.contains(event.target) || root.contains(event.target)) return;
        closeOpenPicker(overlay);
      };
      openPicker = { root, picker, toggle, overlay, reposition, outsidePointerDown };
      positionPicker(openPicker);
      window.addEventListener("resize", reposition);
      overlay.addEventListener("scroll", reposition, true);
      overlay.addEventListener("pointerdown", outsidePointerDown, true);
    };

    return root;
  }

  app.modules.dateControl = Object.freeze({ create, valueFrom, dateParts, hasOpenPicker, closeOpenPicker, handleEscape });
})();
