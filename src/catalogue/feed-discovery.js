(() => {
  "use strict";

  const app = globalThis.R34MF;
  const constants = app?.modules.constants;
  const parsing = app?.modules.catalogueParsing;
  const urls = app?.modules.urls;
  if (!app || !constants || !parsing || !urls) {
    throw new Error("R34MF shared helpers must load before feed discovery.");
  }

  function pageFromText(value) {
    const text = String(value ?? "");
    const from = text.match(/(?:^|[;?&])from[:=]?(\d+)/i);
    return from ? Number(from[1]) : null;
  }

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function findSubscriptionsGrid(documentLike) {
    const block = documentLike.querySelector(constants.selectors.subscriptionsBlock);
    const grid = block?.querySelector(constants.selectors.subscriptionsItems)
      ?? documentLike.querySelector(constants.selectors.subscriptionsItems);
    return { block, grid, structureValid: Boolean(grid) };
  }

  function isSubscriptionsVideoCard(node) {
    return node?.matches?.(constants.selectors.subscriptionsVideoCard) === true
      && node.matches(constants.selectors.subscriptionsAdCard) !== true
      && Boolean(node.querySelector?.(`${constants.selectors.subscriptionsVideoLink}, ${constants.selectors.subscriptionsVideoLinkFallback}`));
  }

  function extractPaginatorState(pagination) {
    if (!pagination) return { currentPageNumber: null, lastPageNumber: null, observedPageCount: null };
    const links = [...pagination.querySelectorAll(".item a[data-parameters], a[data-parameters]")];
    const pages = links.map((link) => pageFromText(link.getAttribute("data-parameters"))).filter(Number.isInteger);
    const current = pagination.querySelector(".item.active a[data-parameters], .item.current a[data-parameters], .item.selected a[data-parameters]");
    const last = links.find((link) => {
      const text = parsing.cleanText(link.textContent) ?? "";
      const label = [link.getAttribute("aria-label"), link.getAttribute("title")].filter(Boolean).join(" ");
      const classes = `${link.className ?? ""} ${link.parentElement?.className ?? ""}`;
      return (link.getAttribute("rel") ?? "").split(/\s+/).includes("last") || /^last$/i.test(text) || /\blast\b/i.test(label) || /(?:^|[\s_-])last(?:[\s_-]|$)/i.test(classes);
    });
    return {
      currentPageNumber: pageFromText(current?.getAttribute("data-parameters")),
      lastPageNumber: pageFromText(last?.getAttribute("data-parameters")),
      observedPageCount: pages.length ? Math.max(...pages) : null
    };
  }

  function pageCapacityFromGrid(grid, currentPage, reliablePageCount, nativeTotal = null) {
    const declared = ["data-per-page", "data-page-size", "data-items-per-page"]
      .map((name) => positiveInteger(grid?.getAttribute?.(name)))
      .find(Boolean);
    if (declared) return declared;
    const currentCount = grid ? [...grid.children].filter(isSubscriptionsVideoCard).length : 0;
    // A non-final page is reliable evidence that its card count is the normal capacity.
    if (currentPage && reliablePageCount && currentPage < reliablePageCount && currentCount > 0) return currentCount;
    // A full first page plus a larger native total proves this is normal capacity
    // even when the paginator's Last control is unavailable or icon-only.
    return (!currentPage || currentPage === 1) && Number(nativeTotal) > currentCount && currentCount > 0 ? currentCount : null;
  }

  function derivePageCount({ nativeTotal, pageCapacity, reliablePaginatorPageCount }) {
    if (reliablePaginatorPageCount) return reliablePaginatorPageCount;
    return parsing.calculatePageCount(nativeTotal, pageCapacity);
  }

  function discoverFeed(documentLike = document) {
    const { block, grid } = findSubscriptionsGrid(documentLike);
    const heading = block ? [...block.querySelectorAll(constants.selectors.subscriptionsHeading)]
      .find((node) => /videos\s+from\s+my\s+subscriptions/i.test(node.textContent ?? "")) : null;
    const total = parsing.parseNativeTotal(heading?.textContent);
    const cardCandidates = grid ? [...grid.children].filter(isSubscriptionsVideoCard) : [];
    const pagination = (block ?? documentLike).querySelector(constants.selectors.subscriptionsPagination);
    const paginator = extractPaginatorState(pagination);
    const paginationNodes = [...(block ?? documentLike).querySelectorAll("[data-parameters], a[href*='from='], [data-total-pages], [data-page-count], [data-max-page]")];
    const pages = paginationNodes.map((node) => pageFromText(node.getAttribute("data-parameters") ?? node.getAttribute("href")))
      .filter((page) => Number.isInteger(page) && page > 0);
    const fallbackPaginatorPageCount = paginationNodes
      .map((node) => positiveInteger(node.getAttribute("data-total-pages") ?? node.getAttribute("data-page-count") ?? node.getAttribute("data-max-page")))
      .find(Boolean) ?? null;
    const reliablePaginatorPageCount = paginator.lastPageNumber ?? fallbackPaginatorPageCount;
    const currentPageNumber = paginator.currentPageNumber ?? paginationNodes
      .filter((node) => node.getAttribute("aria-current") === "page" || /(?:^|\s)(?:active|current|selected)(?:\s|$)/i.test(node.className ?? ""))
      .map((node) => pageFromText(node.getAttribute("data-parameters") ?? node.getAttribute("href")))
      .find(Number.isInteger) ?? null;
    const pageCapacity = pageCapacityFromGrid(grid, currentPageNumber, reliablePaginatorPageCount, total);
    return {
      nativeTotal: total,
      currentPageCardCount: cardCandidates.length,
      pageCapacity,
      // `pageSize` remains an alias during this Phase 2 storage transition.
      pageSize: pageCapacity,
      pageCount: derivePageCount({ nativeTotal: total, pageCapacity, reliablePaginatorPageCount }),
      paginationPageCount: paginator.observedPageCount ?? (pages.length ? Math.max(...pages) : null),
      reliablePaginatorPageCount,
      currentPageNumber,
      blockId: constants.selectors.subscriptionsBlock.slice(1),
      currentCards: cardCandidates.length
    };
  }

  function buildKvsPageUrl({ pageNumber, origin = globalThis.location?.origin, blockId, sortBy = "" } = {}) {
    const from = parsing.formatPageParameter(pageNumber);
    if (!from) throw new Error("A positive page number is required for a KVS request.");
    const url = new URL("/my/subscriptions/", origin ?? "https://rule34video.com");
    url.searchParams.set("mode", "async");
    url.searchParams.set("function", "get_block");
    url.searchParams.set("block_id", blockId || constants.selectors.subscriptionsBlock.slice(1));
    url.searchParams.set("sort_by", sortBy);
    url.searchParams.set("from", from);
    return urls.rule34VideoUrl(url.href, url.origin);
  }

  function extractCards(documentLike) {
    const { grid } = findSubscriptionsGrid(documentLike);
    if (!grid) return [];
    return [...grid.children].filter(isSubscriptionsVideoCard);
  }

  app.modules.feedDiscovery = Object.freeze({
    pageFromText,
    findSubscriptionsGrid,
    isSubscriptionsVideoCard,
    extractPaginatorState,
    pageCapacityFromGrid,
    derivePageCount,
    discoverFeed,
    buildKvsPageUrl,
    extractCards
  });
})();
