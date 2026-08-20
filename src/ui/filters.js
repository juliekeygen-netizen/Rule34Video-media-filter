(() => {
  "use strict";
  const app = globalThis.R34MF;
  const engine = app?.modules.filterEngine;
  if (!app || !engine) throw new Error("R34MF filter parent dependencies must load first.");

  const labels = Object.freeze({ title:"Title", duration:"Duration", views:"Views", rating:"Rating", ratingVotes:"Rating votes", hdAvailable:"HD available", favorited:"Favorited", hideSeenVideos:"Hide seen videos", uploadDate:"Upload date", artist:"Artist", uploader:"Uploader", tags:"Tags", categories:"Categories", subscriptionsOnly:"Subscriptions only" });
  const operatorLabels = Object.freeze({ contains:"contains", equals:"equals", startsWith:"starts with", endsWith:"ends with", wildcard:"wildcard", regex:"regex", gte:"at least", gt:"more than", lte:"at most", lt:"less than", between:"between", on:"on", after:"after", before:"before", within:"within", is:"is" });
  const toggleOnlyFields = new Set(["hdAvailable", "favorited", "hideSeenVideos"]);

  function el(tag, cls, text) { const node=document.createElement(tag); if(cls) node.className=cls; if(text!==undefined) node.textContent=text; return node; }
  function actionButton(text, action, cls="") { const node=el("button",`r34mf-filter-button ${cls}`.trim(),text); node.type="button"; node.dataset.action=action; return node; }

  function configuredSummary(entry, field) {
    if (toggleOnlyFields.has(field)) return "";
    if (field === "subscriptionsOnly") return entry?.value?.options?.includeWithoutDetails === true ? "Subs + N/A" : "Subs";
    const value=entry?.value;
    if (!value || (Array.isArray(value)&&!value.length)) return "Any";
    if (Array.isArray(value)) return value.length===1?String(value[0]):value.join("  ");
    if (typeof value !== "object") return String(value);
    const operator=operatorLabels[value.operator]??value.operator??"";
    if (value.operator === "between") {
      const suffix=field==="duration"?({seconds:"s",minutes:"m",hours:"h"}[value.unit]??""):field==="rating"?"%":"";
      return `${value.value??""}–${value.valueTo??""}${suffix}`;
    }
    if (value.operator === "within") return `${operator} ${value.value??""} ${value.unit??""}`.trim();
    const suffix=field==="rating"?"%":"";
    return `${operator} ${value.value??""}${suffix}`.trim()||"Any";
  }

  function createFilterRow(label, source, field) {
    const row=el("div","r34mf-filter-row"); row.dataset.filterSource=source; row.dataset.filterField=field;
    const checkboxCell=el("label","r34mf-filter-checkbox-cell");
    const checkbox=el("input","r34mf-filter-toggle"); checkbox.type="checkbox"; checkbox.dataset.action=source==="advanced"?"advanced-toggle":`filter-toggle:${source}:${field}`; checkbox.setAttribute("aria-label",`Enable ${label}`); checkboxCell.append(checkbox);
    const toggleOnly=toggleOnlyFields.has(field);
    const main=actionButton("",toggleOnly?"noop":source==="advanced"?"advanced":`edit:${source}:${field}`,"r34mf-filter-row-main");
    main.append(el("span","r34mf-filter-row-label",label));
    if (!toggleOnly) { const summary=el("small","r34mf-filter-row-summary","Any"); const arrow=el("span","r34mf-filter-arrow"); arrow.setAttribute("aria-hidden","true"); main.append(summary,arrow); }
    row.append(checkboxCell,main); return row;
  }

  function entitySummary(values, summary) {
    const selected=values.map((value)=>String(value??"").trim()).filter(Boolean); if(!selected.length) return "Any";
    const available=Math.max(0,summary?.clientWidth||summary?.getBoundingClientRect?.().width||0);
    for(let shown=selected.length;shown>=1;shown-=1){const remaining=selected.length-shown;const text=`${selected.slice(0,shown).join("  ")}${remaining?`  +${remaining}`:""}`;if(!available)return text;summary.textContent=text;if(!Number.isFinite(Number(summary.scrollWidth))||summary.scrollWidth<=available+1)return text;} return `+${selected.length}`;
  }

  function appendSection(column, heading, source, fields) {
    const title=el("h3","r34mf-filter-section",heading);
    title.dataset.filterSection=source;
    column.append(title);
    for(const field of fields) column.append(createFilterRow(labels[field]??engine.FIELD_DEFINITIONS[field]?.label??field,source,field));
  }

  function buildParent(state) {
    const surface=el("section","r34mf-filters-surface"); surface.dataset.filterSurface="parent";
    const header=el("header","r34mf-filter-header"); header.append(el("strong","","FILTERS"),actionButton("Disable all","disable-all","r34mf-filter-quiet"));
    const preset=actionButton("","presets","r34mf-preset-launch"); preset.append(el("span","r34mf-preset-label","Preset: Default"),el("span","r34mf-filter-arrow"));
    surface.append(header,preset);

    // Keep the familiar single vertical flow on desktop, but expose explicit
    // semantic columns so the last-loaded mobile layer can use the available
    // horizontal space instead of making the dropdown several screens tall.
    const columns=el("div","r34mf-filter-columns");
    const quickColumn=el("div","r34mf-filter-column r34mf-filter-column-quick");
    const detailedColumn=el("div","r34mf-filter-column r34mf-filter-column-detailed");
    appendSection(quickColumn,"QUICK FILTERS","quick",engine.QUICK_FIELDS);
    appendSection(detailedColumn,"DETAILED METADATA","detailed",engine.DETAILED_FIELDS);
    detailedColumn.append(el("h3","r34mf-filter-section","ADVANCED"),createFilterRow("Advanced filter","advanced","filter"));
    columns.append(quickColumn,detailedColumn);
    surface.append(columns);

    patchParent(surface,state);
    return surface;
  }

  function patchParent(surface,state){
    if(!surface)return; const preset=surface.querySelector(".r34mf-preset-label"); if(preset)preset.textContent=`Preset: ${state.preset?.name??"Default"}`;
    const disableAll=surface.querySelector("[data-action='disable-all']"); if(disableAll)disableAll.disabled=engine.countApplied(state.filters)===0;
    const detailedHeading=surface.querySelector("[data-filter-section='detailed']"); if(detailedHeading)detailedHeading.textContent="DETAILED METADATA";
    const patchRow=(source,field,entry)=>{const row=surface.querySelector(`[data-filter-source='${source}'][data-filter-field='${field}']`);if(!row)return;const checkbox=row.querySelector(".r34mf-filter-toggle");const summary=row.querySelector(".r34mf-filter-row-summary");const enabled=entry?.enabled===true;if(checkbox)checkbox.checked=enabled;row.classList.toggle("is-disabled",!enabled);row.classList.toggle("is-enabled",enabled);if(summary){const entity=["artist","uploader","tags","categories"].includes(field)&&Array.isArray(entry?.value);summary.textContent=entity?entitySummary(entry.value,summary):configuredSummary(entry,field);const full=entity?entry.value.join(", "):summary.textContent;const match=entity?` · ${entry.matchMode==="all"?"All selected":"Any selected"}`:"";summary.title=`${full}${match}`;if(entity)summary.setAttribute("aria-label",`${full}${match}`);else summary.removeAttribute("aria-label");}};
    for(const field of engine.QUICK_FIELDS)patchRow("quick",field,state.filters?.quick?.[field]); for(const field of engine.DETAILED_FIELDS)patchRow("detailed",field,state.filters?.detailed?.[field]);
    const advanced=state.filters?.advanced??{enabled:false,items:[]};const advancedRow=surface.querySelector("[data-filter-source='advanced'][data-filter-field='filter']");if(advancedRow){const checkbox=advancedRow.querySelector(".r34mf-filter-toggle");const summary=advancedRow.querySelector(".r34mf-filter-row-summary");const enabled=advanced.enabled===true;if(checkbox)checkbox.checked=enabled;advancedRow.classList.toggle("is-disabled",!enabled);advancedRow.classList.toggle("is-enabled",enabled);if(summary){const count=app.modules.filterDraft?.counts?.(advanced.items)?.rules??advanced.items?.length??0;summary.textContent=`${count} ${count===1?"rule":"rules"}`;}}
  }

  function bind(host,onIntent){
    if(host.dataset.r34mfFilterBound==="true")return;host.dataset.r34mfFilterBound="true";
    host.addEventListener("click",(event)=>{const target=event.target.closest("[data-action]");if(!target||!host.contains(target)||target.disabled)return;const action=target.dataset.action??"";if(action.startsWith("filter-toggle:")||action==="advanced-toggle")event.preventDefault();event.stopPropagation();onIntent(action,target);});
    host.addEventListener("contextmenu",(event)=>{const row=event.target.closest(".r34mf-filter-row");if(!row||!host.contains(row))return;const toggle=row.querySelector(".r34mf-filter-toggle[data-action]");if(!toggle||toggle.disabled)return;event.preventDefault();event.stopPropagation();onIntent(toggle.dataset.action??"",toggle);});
  }

  function applyMeasuredWidth(host,root){const filterBox=root.querySelector("[data-r34mf-action='filters']")?.getBoundingClientRect?.();const sortBox=root.querySelector("[data-r34mf-action='sort']")?.getBoundingClientRect?.();if(filterBox&&sortBox&&filterBox.width>0&&sortBox.width>0){host.style.setProperty("--r34mf-filter-popover-width",`${Math.round(Math.max(0, sortBox.right - filterBox.left))}px`);return;}const fallback=filterBox?.width;if(Number.isFinite(fallback)&&fallback>0)host.style.setProperty("--r34mf-filter-popover-width",`${Math.round(fallback)}px`);}
  function render(state,onIntent){let host=state.root.querySelector(":scope > .r34mf-tool-layer");if(!host){host=el("div","r34mf-tool-layer");host.dataset.r34mfOwned="true";state.root.append(host);}bind(host,onIntent);applyMeasuredWidth(host,state.root);let surface=host.querySelector(":scope > .r34mf-filters-surface[data-filter-surface='parent']");if(!surface){surface=buildParent(state);host.replaceChildren(surface);}else patchParent(surface,state);return host;}
  function close(root){root?.querySelector(":scope > .r34mf-tool-layer")?.remove();}
  app.modules.filtersUi=Object.freeze({render,close,labels,configuredSummary,entitySummary,patchParent,appendSection});
})();
