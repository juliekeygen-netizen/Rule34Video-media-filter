(() => {
  "use strict";
  const app = globalThis.R34MF;
  if (!app) throw new Error("R34MF namespace must load before paginator model.");

  function clampPage(value, pageCount) { return Math.min(Math.max(1, Math.floor(Number(value) || 1)), Math.max(1, Number(pageCount) || 1)); }
  function pageLabel(page) { return String(page).padStart(2, "0"); }
  function paginationModel(page, pageCount) {
    const pages = Math.max(0, Number(pageCount) || 0);
    if (!pages) return { page: 1, pageCount: 0, items: [], jump: false };
    const current = clampPage(page, pages), items = [];
    const add = (type, value, label = null) => items.push({ type, value, label: label ?? (type === "page" ? pageLabel(value) : type) });
    if (pages === 1) { add("page", 1); return { page: current, pageCount: pages, items, jump: true }; }
    if (current > 1) { add("previous", current - 1, "«"); if (current > 5) add("first", 1, "First"); }
    let numbers;
    if (pages <= 9) numbers = Array.from({ length: pages }, (_, index) => index + 1);
    else if (current <= 5) numbers = [1,2,3,4,5,6,7,8,9];
    else if (current >= pages - 4) numbers = Array.from({ length: 9 }, (_, index) => pages - 8 + index);
    else numbers = [current - 3, current - 2, current - 1, current, current + 1, current + 2, current + 3];
    const firstNumber = numbers[0], lastNumber = numbers[numbers.length - 1];
    if (firstNumber > 1) add("ellipsis", null, "…");
    numbers.forEach((number) => add("page", number));
    if (lastNumber < pages) add("ellipsis", null, "…");
    if (current < pages) { if (current < pages - 4) add("last", pages, "Last"); add("next", current + 1, "»"); }
    return { page: current, pageCount: pages, items, jump: true };
  }
  function parseJump(value, pageCount) { const raw = String(value ?? "").trim(); if (!/^\d+$/.test(raw)) return null; const page = Number(raw); return page >= 1 && page <= pageCount ? page : null; }
  app.modules.paginatorModel = Object.freeze({ clampPage, pageLabel, paginationModel, parseJump });
})();
