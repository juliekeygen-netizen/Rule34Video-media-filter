(() => {
  "use strict";

  const app = globalThis.R34MF;
  const controller = app?.modules.subscriptionsController;
  const seenStore = app?.modules.seenStore;
  const favoriteStore = app?.modules.favoriteStore;
  if (!app || !controller || !seenStore || !favoriteStore) throw new Error("R34MF local state stores and subscriptions controller must load before local-state filter refresh hooks.");

  function inspectField(items, field) {
    return (items ?? []).some((item) => item?.enabled !== false
      && (item.kind === "group" ? inspectField(item.items, field) : item.field === field));
  }

  function needsSeen(filters) {
    if (filters?.quick?.hideSeenVideos?.enabled === true) return true;
    return filters?.advanced?.enabled === true && inspectField(filters.advanced.items, "seenVideos");
  }

  function needsFavorited(filters) {
    if (filters?.quick?.favorited?.enabled === true) return true;
    return filters?.advanced?.enabled === true && inspectField(filters.advanced.items, "favorited");
  }

  seenStore.load().catch((error) => app.modules.logger?.warn?.("seen-state-initial-load-failed", { message: error?.message ?? String(error) }));
  favoriteStore.load().catch((error) => app.modules.logger?.warn?.("favorite-state-initial-load-failed", { message: error?.message ?? String(error) }));

  const refresh = (kind) => {
    if (!controller.root?.isConnected || controller.state?.mode !== "local") return;
    const relevant = kind === "seen" ? needsSeen(controller.state.filters) : needsFavorited(controller.state.filters);
    if (!relevant) return;
    controller.renderLocal().catch?.((error) => app.modules.logger?.warn?.(`${kind}-filter-refresh-failed`, { message: error?.message ?? String(error) }));
  };

  const unsubscribeSeen = seenStore.subscribe(() => refresh("seen"));
  const unsubscribeFavorite = favoriteStore.subscribe(() => refresh("favorite"));
  const unsubscribe = () => { unsubscribeSeen(); unsubscribeFavorite(); };

  app.modules.seenFilterController = Object.freeze({ needsSeen, needsFavorited, unsubscribe });
})();
