(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.filterModals;
  if (!app || !base) throw new Error("R34MF filter modals must load before wording polish.");

  function shortenAnyWord(root) {
    root?.querySelectorAll?.(".r34mf-check-label span").forEach((node) => {
      if (node.textContent.trim() === "Match any word") node.textContent = "Any word";
    });
  }

  function render(state, send) {
    const normalText = state?.modal?.type === "normal" && ["title", "description"].includes(state.modal.field);
    let separateByCommas = state?.modal?.draft?.options?.separateByCommas === true;
    let currentOperator = state?.modal?.draft?.operator ?? "contains";
    const wrappedSend = (action, payload) => {
      if (normalText && action === "filter-apply" && payload?.value && typeof payload.value === "object") {
        payload = {
          ...payload,
          value: {
            ...payload.value,
            options: {
              ...(payload.value.options ?? {}),
              separateByCommas: currentOperator === "contains" && separateByCommas
            }
          }
        };
      }
      return send(action, payload);
    };

    const layer = base.render(state, wrappedSend);
    if (!layer) return layer;

    const enhance = () => {
      shortenAnyWord(layer);
      if (!normalText) return;
      const condition = layer.querySelector(`select[aria-label='${state.modal.field === "title" ? "Title" : "Description"} condition']`);
      if (condition) currentOperator = condition.value;
      const options = layer.querySelector(".r34mf-modal-content .r34mf-text-options");
      if (!options || currentOperator !== "contains" || options.querySelector("[data-r34mf-separate-by-commas='true']")) return;

      const label = document.createElement("label");
      label.className = "r34mf-check-label";
      label.dataset.r34mfSeparateByCommas = "true";
      const control = document.createElement("input");
      control.className = "r34mf-check";
      control.type = "checkbox";
      control.checked = separateByCommas;
      control.addEventListener("change", () => { separateByCommas = control.checked; });
      const text = document.createElement("span");
      text.textContent = "Separate by commas";
      label.append(control, text);
      options.append(label);
    };

    enhance();
    if (normalText) {
      layer.__r34mfTextOptionObserver?.disconnect?.();
      const observer = new MutationObserver(() => queueMicrotask(enhance));
      observer.observe(layer, { childList: true, subtree: true });
      layer.__r34mfTextOptionObserver = observer;
    }
    return layer;
  }

  app.modules.filterModals = Object.freeze({
    ...base,
    render,
    shortenAnyWord
  });
})();
