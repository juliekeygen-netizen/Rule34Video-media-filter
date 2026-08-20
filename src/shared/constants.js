(() => {
  "use strict";

  const app = globalThis.R34MF;
  if (!app) {
    throw new Error("R34MF namespace must load before constants.");
  }

  app.modules.constants = Object.freeze({
    targetPath: "/my/subscriptions/",
    selectors: Object.freeze({
      subscriptionsBlock: "#list_videos_videos_from_my_subscriptions",
      subscriptionsItems: "#list_videos_videos_from_my_subscriptions_items",
      subscriptionsPagination: "#list_videos_videos_from_my_subscriptions_pagination",
      subscriptionsHeading: "h1, h2, h3, h4, h5, h6",
      subscriptionsVideoCard: ".item.thumb",
      subscriptionsAdCard: ".spot-thumb",
      subscriptionsVideoLink: "a.th.js-open-popup[href*='/video/'], a.th.js-open-popup[href*='/videos/']",
      subscriptionsVideoLinkFallback: "a[href*='/video/'], a[href*='/videos/']",
      subscriptionsVideoTitle: ".thumb_title",
      subscriptionsVideoPreview: ".img.wrap_image[data-preview]",
      subscriptionsVideoThumbnail: ".img.wrap_image img.thumb, img.thumb",
      subscriptionsVideoDuration: ".time",
      subscriptionsVideoAdded: ".thumb_info .added, .added",
      subscriptionsVideoRating: ".thumb_info .rating, .rating",
      subscriptionsVideoViews: ".thumb_info .views, .views",
      subscriptionsVideoQuality: ".quality .custom-hd, .quality [class*='custom-hd'], .quality [data-hd='true']",
      membershipBlock: "#list_members_subscriptions_my_subscriptions",
      membershipItems: "#list_members_subscriptions_my_subscriptions_items",
      membershipPagination: "#list_members_subscriptions_my_subscriptions_pagination",
      extensionRoot: '[data-r34mf-root="subscriptions"]'
    }),
    storageKeys: Object.freeze({
      settings: "r34mf.settings",
      uiState: "r34mf.uiState",
      filterState: "r34mf.filterState",
      authCredentials: "r34mf.authCredentials",
      seenVideos: "r34mf.seenVideos.v1",
      favoriteVideos: "r34mf.favoriteVideos.v1",
      queueState: "r34mf.queueState.v1"
    }),
    database: Object.freeze({
      name: "r34video-media-filter",
      version: 2,
      catalogueStateKey: "subscriptions"
    })
  });
})();
