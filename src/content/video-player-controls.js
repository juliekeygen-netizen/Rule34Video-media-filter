(() => {
  "use strict";

  const app = globalThis.R34MF;
  const settings = app?.modules.settings;
  if (!app || !settings) throw new Error("R34MF settings must load before improved video-player controls.");

  const VIDEO_PATH = /^\/videos?\/\d+(?:\/|$)/i;
  const ROOT_SELECTORS = ["#kt_player", ".kt-player", ".video-holder", ".video-container", "[data-video-id]"];
  const CONTROL_CANDIDATE_SELECTOR = [
    "button", "a", "[role='button']", "[title]", "[aria-label]", "[data-tooltip]", "[data-title]",
    "[class*='play']", "[class*='pause']", "[class*='volume']", "[class*='mute']", "[class*='sound']"
  ].join(", ");
  const INTERACTIVE_SELECTOR = "button, a, [role='button'], [tabindex], [class*='button'], [class*='control'], [class*='play'], [class*='volume'], [class*='mute']";
  const RETRY_MS = 300;
  const MAX_RETRIES = 24;
  const SEEK_SECONDS = 10;
  const FEEDBACK_MS = 650;
  const NATIVE_DBLCLICK_LEFT_EDGE = 0.45;
  const NATIVE_DBLCLICK_RIGHT_EDGE = 0.55;
  const RUNTIME_TOKEN = globalThis.crypto?.randomUUID?.() ?? `player-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  let rootObserver = null;
  let parentObserver = null;
  let observedRoot = null;
  let retryTimer = null;
  let retryCount = 0;
  let reconcileQueued = false;
  let started = false;
  let unsubscribe = null;
  const feedbackTimers = new Map();
  const doubleClickBindings = new Map();

  function isVideoPage(locationLike = globalThis.location) {
    return VIDEO_PATH.test(String(locationLike?.pathname ?? ""));
  }

  function token(node) {
    if (!node) return "";
    return [
      node.id,
      node.className,
      node.getAttribute?.("title"),
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("data-tooltip"),
      node.getAttribute?.("data-title"),
      node.textContent
    ].filter(Boolean).join(" ").toLocaleLowerCase();
  }

  function classHas(node, terms) {
    const value = String(node?.className ?? "").toLocaleLowerCase();
    return new RegExp(`(?:^|[\\s_-])(?:${terms.join("|")})(?:$|[\\s_-])`, "i").test(value);
  }

  function scoreVolume(node) {
    const value = token(node);
    let score = 0;
    if (/\b(volume|mute|unmute|sound)\b/.test(value)) score += 8;
    if (classHas(node, ["volume", "mute", "unmute", "sound"])) score += 5;
    if (node?.getAttribute?.("aria-label") && /volume|mute|sound/i.test(node.getAttribute("aria-label"))) score += 5;
    return score;
  }

  function scorePlay(node) {
    const value = token(node);
    let score = 0;
    if (/\b(play|pause|resume)\b/.test(value)) score += 7;
    if (classHas(node, ["play", "pause", "resume"])) score += 4;
    if (node?.getAttribute?.("aria-label") && /play|pause|resume/i.test(node.getAttribute("aria-label"))) score += 5;
    return score;
  }

  function videoRoot(documentLike = document) {
    for (const selector of ROOT_SELECTORS) {
      for (const root of documentLike.querySelectorAll?.(selector) ?? []) {
        if (root.querySelector?.("video")) return root;
      }
    }
    const video = documentLike.querySelector?.("video");
    if (!video) return null;
    return video.closest?.("#kt_player, .kt-player, .video-holder, .video-container") ?? video.parentElement;
  }

  function videoElement(root) {
    return root?.querySelector?.("video") ?? (isVideoPage() ? document.querySelector("video") : null);
  }

  function bestControl(root, scorer) {
    let best = null;
    let bestScore = 0;
    for (const node of root?.querySelectorAll?.(CONTROL_CANDIDATE_SELECTOR) ?? []) {
      if (node.closest?.(".r34mf-player-skip-controls")) continue;
      const score = scorer(node);
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best;
  }

  function directChild(container, node) {
    let current = node;
    while (current?.parentElement && current.parentElement !== container) current = current.parentElement;
    return current?.parentElement === container ? current : node;
  }

  function commonControlBar(root, play, volume) {
    if (!volume) return null;
    let current = volume.parentElement;
    let fallback = null;
    for (let depth = 0; current && current !== root && depth < 7; depth += 1, current = current.parentElement) {
      const interactive = current.querySelectorAll?.(INTERACTIVE_SELECTOR)?.length ?? 0;
      if (!fallback && interactive >= 3) fallback = current;
      if (play && current.contains(play) && interactive >= 2) return current;
    }
    return fallback ?? volume.parentElement;
  }

  function flowplayerAnchors(root) {
    const bar = root?.querySelector?.(".fp-controls");
    if (!bar) return null;
    // Rule34Video's current youtube.css skin uses direct .fp-play and .fp-volume
    // children. Keep the older aliases as a narrow compatibility fallback.
    const play = bar.querySelector(".fp-play, .fp-btns, .fp-small-switch, .fp-small-play, .fp-small-pause");
    const volume = bar.querySelector(".fp-volume, .fp-volume-control, .fp-volumebtn, .fp-volume-mute-unmute");
    if (!play || !volume) return null;
    const playUnit = directChild(bar, play);
    const volumeUnit = directChild(bar, volume);
    if (!playUnit || !volumeUnit || playUnit === volumeUnit) return null;
    return { bar, playUnit, volumeUnit };
  }

  function wrapperTagFor(nativeUnit) {
    const tag = String(nativeUnit?.tagName ?? "").toLocaleUpperCase();
    return new Set(["LI", "DIV", "SPAN"]).has(tag) ? tag.toLocaleLowerCase() : "span";
  }

  function icon(direction) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 32 32");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "r34mf-player-skip-ring");
    path.setAttribute("d", direction < 0
      ? "M10.2 8.1H5.5V3.4M5.9 7.7A11.2 11.2 0 1 1 4.8 18"
      : "M21.8 8.1h4.7V3.4M26.1 7.7A11.2 11.2 0 1 0 27.2 18");
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "16");
    text.setAttribute("y", "19.2");
    text.setAttribute("text-anchor", "middle");
    text.textContent = "10";
    svg.append(path, text);
    return svg;
  }

  function seek(video, delta) {
    if (!video) return;
    const current = Number(video.currentTime) || 0;
    const duration = Number(video.duration);
    const upper = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
    const next = Math.max(0, Math.min(upper, current + delta));
    try { video.currentTime = next; } catch { /* native player remains authoritative */ }
  }

  function feedbackNode(root, delta) {
    const back = delta < 0;
    const selector = `.r34mf-player-skip-feedback.${back ? "is-back" : "is-forward"}`;
    let node = root?.querySelector?.(selector) ?? null;
    if (node) return node;
    node = document.createElement("div");
    node.className = `r34mf-player-skip-feedback ${back ? "is-back" : "is-forward"}`;
    node.dataset.r34mfOwned = "true";
    node.setAttribute("aria-hidden", "true");
    const arrows = document.createElement("div");
    arrows.className = "r34mf-player-skip-feedback-icon";
    arrows.textContent = back ? "◀◀" : "▶▶";
    const label = document.createElement("div");
    label.className = "r34mf-player-skip-feedback-label";
    label.textContent = `${SEEK_SECONDS}s`;
    node.append(arrows, label);
    root?.append?.(node);
    return node;
  }

  function showSeekFeedback(root, delta) {
    if (!root || settings.value?.improvedPlayerPlaybackControls === false) return null;
    const node = feedbackNode(root, delta);
    if (!node) return null;
    const oldTimer = feedbackTimers.get(node);
    if (oldTimer !== undefined) globalThis.clearTimeout(oldTimer);
    node.classList.remove("is-showing");
    // Restart the short native-like scale/fade transition on repeated skips.
    void node.offsetWidth;
    node.classList.add("is-showing");
    const timer = globalThis.setTimeout(() => {
      node.classList.remove("is-showing");
      feedbackTimers.delete(node);
    }, FEEDBACK_MS);
    feedbackTimers.set(node, timer);
    return node;
  }

  function nativeSeekFeedbackVisible(root, delta) {
    const side = delta < 0 ? ".ktseek-back" : ".ktseek-fwd";
    return Boolean(root?.querySelector?.(`.ktseek-feedback${side}.ktseek-show`));
  }

  function nativeDoubleClickDirection(root, event) {
    if (!root || !event) return 0;
    const target = event.target;
    if (target?.closest?.(".fp-controls, .r34mf-player-skip-controls")) return 0;
    const rect = root.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0)) return 0;
    const ratio = (Number(event.clientX) - rect.left) / rect.width;
    if (ratio <= NATIVE_DBLCLICK_LEFT_EDGE) return -SEEK_SECONDS;
    if (ratio >= NATIVE_DBLCLICK_RIGHT_EDGE) return SEEK_SECONDS;
    return 0;
  }

  function bindNativeDoubleClickFeedback(root) {
    if (!root || doubleClickBindings.has(root)) return;
    const handler = (event) => {
      const delta = nativeDoubleClickDirection(root, event);
      if (!delta || settings.value?.improvedPlayerPlaybackControls === false) return;
      // Rule34Video already owns the actual double-click seek. We only fill its
      // missing visual feedback (notably fullscreen) and never seek a second time.
      globalThis.setTimeout(() => {
        if (!root.isConnected || settings.value?.improvedPlayerPlaybackControls === false) return;
        if (!nativeSeekFeedbackVisible(root, delta)) showSeekFeedback(root, delta);
      }, 0);
    };
    root.addEventListener("dblclick", handler, true);
    doubleClickBindings.set(root, handler);
  }

  function unbindNativeDoubleClickFeedback(root) {
    const handler = doubleClickBindings.get(root);
    if (!handler) return;
    root.removeEventListener("dblclick", handler, true);
    doubleClickBindings.delete(root);
  }

  function clearPlayerEnhancements() {
    for (const [node, timer] of feedbackTimers) {
      globalThis.clearTimeout(timer);
      node.classList.remove("is-showing");
    }
    feedbackTimers.clear();
    for (const root of [...doubleClickBindings.keys()]) unbindNativeDoubleClickFeedback(root);
    document.querySelectorAll(".r34mf-player-skip-feedback").forEach((node) => node.remove());
  }

  function skipButton(video, delta, root) {
    const back = delta < 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `r34mf-player-skip-button ${back ? "is-back" : "is-forward"}`;
    button.setAttribute("aria-label", back ? "Back 10 seconds" : "Forward 10 seconds");
    button.title = back ? "Back 10 seconds" : "Forward 10 seconds";
    button.append(icon(delta));
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      seek(video, delta);
      showSeekFeedback(root, delta);
    });
    return button;
  }

  function createControls(video, nativeUnit, extraClass = "", root = null) {
    const controls = document.createElement(wrapperTagFor(nativeUnit));
    controls.className = `r34mf-player-skip-controls${extraClass ? ` ${extraClass}` : ""}`;
    controls.dataset.r34mfOwned = "true";
    controls.dataset.r34mfPlayerRuntime = RUNTIME_TOKEN;
    controls.append(skipButton(video, -SEEK_SECONDS, root), skipButton(video, SEEK_SECONDS, root));
    return controls;
  }

  function follows(left, right) {
    return Boolean(left?.compareDocumentPosition?.(right) & 4);
  }

  function controlsBetween(playUnit, controls, volumeUnit) {
    return Boolean(controls?.isConnected && follows(playUnit, controls) && follows(controls, volumeUnit));
  }

  function placeFlowplayerControls(flow, controls) {
    if (controlsBetween(flow.playUnit, controls, flow.volumeUnit)) return controls;
    if (follows(flow.playUnit, flow.volumeUnit)) flow.playUnit.after(controls);
    else flow.volumeUnit.before(controls);
    return controls;
  }

  function install(root) {
    const video = videoElement(root);
    if (!video) return false;

    // Rule34Video's current KVS youtube.css skin uses a floated bottom control row.
    // Keep our wrapper directly between the real .fp-play and .fp-volume nodes so
    // CSS can join that same float chain instead of falling after the time labels.
    const flow = flowplayerAnchors(root);
    if (flow) {
      let existing = flow.bar.querySelector(":scope > .r34mf-player-skip-controls")
        ?? flow.bar.querySelector(".r34mf-player-skip-controls");
      if (existing?.dataset?.r34mfPlayerRuntime !== RUNTIME_TOKEN) {
        existing?.remove();
        existing = null;
      }
      const controls = existing ?? createControls(video, flow.volumeUnit, "is-flowplayer", root);
      controls.classList.add("is-flowplayer");
      placeFlowplayerControls(flow, controls);
      bindNativeDoubleClickFeedback(root);
      root.dataset.r34mfImprovedPlayer = "true";
      return true;
    }

    // Conservative fallback for a future/non-Flowplayer skin.
    const volume = bestControl(root, scoreVolume);
    const play = bestControl(root, scorePlay);
    const bar = commonControlBar(root, play, volume);
    if (!volume || !bar) return false;
    const volumeUnit = directChild(bar, volume);
    let existing = bar.querySelector(":scope > .r34mf-player-skip-controls")
      ?? bar.querySelector(".r34mf-player-skip-controls");
    if (existing?.dataset?.r34mfPlayerRuntime !== RUNTIME_TOKEN) {
      existing?.remove();
      existing = null;
    }
    if (!existing) volumeUnit.before(createControls(video, volumeUnit, "", root));
    bindNativeDoubleClickFeedback(root);
    root.dataset.r34mfImprovedPlayer = "true";
    return true;
  }

  function remove() {
    clearPlayerEnhancements();
    document.querySelectorAll(".r34mf-player-skip-controls").forEach((node) => node.remove());
    document.querySelectorAll("[data-r34mf-improved-player]").forEach((node) => delete node.dataset.r34mfImprovedPlayer);
  }

  function clearRetry() {
    if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function disconnectObservers() {
    rootObserver?.disconnect();
    parentObserver?.disconnect();
    rootObserver = null;
    parentObserver = null;
    observedRoot = null;
  }

  function bindObservers(root) {
    if (!root || observedRoot === root) return;
    disconnectObservers();
    observedRoot = root;
    rootObserver = new MutationObserver(() => schedule());
    rootObserver.observe(root, { childList: true, subtree: true });
    if (root.parentElement) {
      parentObserver = new MutationObserver((records) => {
        if (records.some((record) => [...record.removedNodes].includes(root) || [...record.addedNodes].some((node) => node?.nodeType === Node.ELEMENT_NODE && (node.matches?.("#kt_player, .kt-player") || node.querySelector?.("#kt_player, .kt-player"))))) {
          schedule();
        }
      });
      parentObserver.observe(root.parentElement, { childList: true });
    }
  }

  function scheduleRetry() {
    if (retryTimer !== null || retryCount >= MAX_RETRIES || !isVideoPage()) return;
    retryTimer = globalThis.setTimeout(() => {
      retryTimer = null;
      retryCount += 1;
      schedule();
    }, RETRY_MS);
  }

  function reconcile() {
    reconcileQueued = false;
    if (!isVideoPage() || settings.value?.improvedPlayerPlaybackControls === false) {
      clearRetry();
      retryCount = 0;
      disconnectObservers();
      remove();
      return false;
    }
    const root = videoRoot();
    if (!root) {
      disconnectObservers();
      scheduleRetry();
      return false;
    }
    for (const boundRoot of [...doubleClickBindings.keys()]) {
      if (boundRoot !== root || !boundRoot.isConnected) unbindNativeDoubleClickFeedback(boundRoot);
    }
    bindObservers(root);
    const installed = install(root);
    if (installed) {
      clearRetry();
      retryCount = 0;
    } else scheduleRetry();
    return installed;
  }

  function schedule() {
    if (reconcileQueued) return;
    reconcileQueued = true;
    queueMicrotask(() => {
      if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(reconcile);
      else globalThis.setTimeout?.(reconcile, 0);
    });
  }

  function start() {
    if (started) return;
    started = true;
    // main.js owns the single settings load. Defaults are safe until it completes,
    // and this subscription immediately removes/reinstalls controls if the stored
    // preference differs. Avoid a second storage read + settings emission on every
    // Rule34Video page solely for this optional player feature.
    document.addEventListener("fullscreenchange", schedule);
    window.addEventListener("pageshow", schedule);
    window.addEventListener("popstate", schedule);
    window.addEventListener("hashchange", schedule);
    unsubscribe = settings.subscribe?.((current, previous) => {
      if (current?.improvedPlayerPlaybackControls === previous?.improvedPlayerPlaybackControls) return;
      if (current?.improvedPlayerPlaybackControls === false) {
        clearRetry();
        disconnectObservers();
        remove();
      } else schedule();
    }) ?? null;
    schedule();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  app.modules.videoPlayerControls = Object.freeze({
    isVideoPage,
    token,
    classHas,
    scoreVolume,
    scorePlay,
    videoRoot,
    videoElement,
    commonControlBar,
    flowplayerAnchors,
    wrapperTagFor,
    seek,
    feedbackNode,
    showSeekFeedback,
    nativeSeekFeedbackVisible,
    nativeDoubleClickDirection,
    bindNativeDoubleClickFeedback,
    controlsBetween,
    placeFlowplayerControls,
    install,
    remove,
    reconcile,
    start,
    stop() {
      clearRetry();
      disconnectObservers();
      document.removeEventListener("fullscreenchange", schedule);
      window.removeEventListener("pageshow", schedule);
      window.removeEventListener("popstate", schedule);
      window.removeEventListener("hashchange", schedule);
      unsubscribe?.();
      unsubscribe = null;
      remove();
      started = false;
    }
  });
})();
