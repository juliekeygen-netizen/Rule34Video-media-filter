(() => {
  "use strict";
  const app = globalThis.R34MF;
  const uploadDate = app?.modules.uploadDate;
  if (!app) throw new Error("R34MF namespace must load before sorter.");

  const FIELDS = Object.freeze(["uploadDate", "views", "rating", "ratingVotes", "duration", "title"]);
  const defaultDirection = (field) => field === "title" ? "asc" : "desc";

  function normalize(raw = {}) {
    const field = FIELDS.includes(raw.field) ? raw.field : "uploadDate";
    return {
      field,
      direction: raw.direction === "asc" || raw.direction === "desc" ? raw.direction : defaultDirection(field)
    };
  }

  function select(current, field) {
    const previous = normalize(current);
    return previous.field === field
      ? { field, direction: previous.direction === "asc" ? "desc" : "asc" }
      : { field, direction: defaultDirection(field) };
  }

  function value(video, details, field) {
    if (field === "uploadDate") return uploadDate?.sortValue?.(video, details) ?? (details?.status === "complete" && details.exactUploadDate ? new Date(details.exactUploadDate).getTime() : null);
    if (field === "duration") return video.durationSec;
    if (field === "rating") return video.ratingPercent;
    return video[field];
  }

  function sort(records, detailsById, sortState) {
    const state = normalize(sortState);
    return records
      .map((record, index) => ({
        record,
        index,
        value: value(record, detailsById?.get?.(record.videoId) ?? detailsById?.[record.videoId], state.field)
      }))
      .sort((a, b) => {
        const aUnknown = a.value === null || a.value === undefined || a.value === "";
        const bUnknown = b.value === null || b.value === undefined || b.value === "";
        if (aUnknown || bUnknown) return aUnknown === bUnknown ? a.index - b.index : aUnknown ? 1 : -1;
        let compared = state.field === "title"
          ? String(a.value).localeCompare(String(b.value), undefined, { sensitivity: "base" })
          : Number(a.value) - Number(b.value);
        if (state.direction === "desc") compared *= -1;
        return compared || a.index - b.index;
      })
      .map(({ record }) => record);
  }

  app.modules.sorter = Object.freeze({ FIELDS, defaultDirection, normalize, select, value, sort });
})();