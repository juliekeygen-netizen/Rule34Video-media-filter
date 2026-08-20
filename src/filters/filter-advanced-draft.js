(() => {
  "use strict";

  const app = globalThis.R34MF;
  const base = app?.modules.filterDraft;
  const engine = app?.modules.filterEngine;
  if (!app || !base || !engine) throw new Error("R34MF filter drafts must load before Advanced-field draft polish.");

  function formatRule(rule) {
    if (rule?.field !== "duplicates") return base.formatRule(rule);
    const enabled = engine.DUPLICATE_OPTIONS
      .filter(([key]) => rule.options?.[key] === true)
      .map(([key, label]) => {
        const short = label.replace(/^Matching\s+/i, "").toLocaleLowerCase();
        return key === "matchingTitleWords" ? `${short} ≥${engine.positiveWordCount?.(rule.options?.matchingTitleWordCount) ?? 1}` : short;
      });
    const criteria = ["shared artist", ...enabled];
    return `${rule.polarity === "exclude" ? "Exclude " : ""}Duplicates · ${criteria.join(" + ")}`;
  }

  app.modules.filterDraft = Object.freeze({ ...base, formatRule });
})();
