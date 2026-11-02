const viewportStates = new WeakMap();

function resolveStateStore(state) {
  return state || globalThis.window?.zion?.state || null;
}

function legacyFollowKey(sessionId) {
  return sessionId ? `chat.followLatest.${sessionId}` : "";
}

function scheduleFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return {
      kind: "animation-frame",
      id: globalThis.requestAnimationFrame(callback)
    };
  }
  return {
    kind: "timeout",
    id: globalThis.setTimeout(callback, 16)
  };
}

function cancelFrame(frame) {
  if (!frame) return;
  try {
    if (
      frame.kind === "animation-frame"
      && typeof globalThis.cancelAnimationFrame === "function"
    ) {
      globalThis.cancelAnimationFrame(frame.id);
    } else {
      globalThis.clearTimeout(frame.id);
    }
  } catch {}
}

function captureViewportAnchor(view) {
  const scrollDOM = view?.scrollDOM;
  const scrollTop = Number(scrollDOM?.scrollTop);
  if (!view || !scrollDOM || !Number.isFinite(scrollTop)) {
    return null;
  }
  try {
    const block = typeof view.lineBlockAtHeight === "function"
      ? view.lineBlockAtHeight(scrollTop)
      : null;
    const pos = Number(block?.from);
    const blockTop = Number(block?.top);
    if (!Number.isFinite(pos) || !Number.isFinite(blockTop)) {
      return null;
    }
    return {
      pos,
      yOffset: scrollTop - blockTop,
      scrollTop,
      scrollLeft: Number(scrollDOM.scrollLeft || 0)
    };
  } catch {}
  return null;
}

function mapAnchor(anchor, update) {
  if (!anchor || !update?.changes || typeof update.changes.mapPos !== "function") {
    return anchor;
  }
  try {
    return {
      ...anchor,
      pos: update.changes.mapPos(anchor.pos, 1)
    };
  } catch {}
  return anchor;
}

function clampScrollTop(scrollDOM, scrollTop) {
  const maxScrollTop = Math.max(
    0,
    Number(scrollDOM?.scrollHeight || 0)
      - Number(scrollDOM?.clientHeight || 0)
  );
  return Math.max(
    0,
    maxScrollTop > 0 ? Math.min(maxScrollTop, scrollTop) : scrollTop
  );
}

function getViewportState(view, { sessionId = "", state } = {}) {
  if (!view || (typeof view !== "object" && typeof view !== "function")) {
    return null;
  }
  const sid = String(sessionId || "");
  let current = viewportStates.get(view);
  if (current && current.sessionId === sid) return current;

  cancelFrame(current?.frame);
  const store = resolveStateStore(state);
  const key = legacyFollowKey(sid);
  current = {
    sessionId: sid,
    followLatest: key ? store?.get?.(key) !== false : true,
    epoch: 0,
    frame: null,
    pending: null,
    cycleId: "",
    completedInitialCycleId: "",
    initialScrollTop: null,
    initialAnchor: null,
    stabilizeScrollTop: null,
    stabilizeAnchor: null,
    stabilizeUntil: 0,
    stabilizeFrame: null
  };
  viewportStates.set(view, current);
  return current;
}

function clearViewportStability(current) {
  cancelFrame(current?.stabilizeFrame);
  if (!current) return;
  current.stabilizeFrame = null;
  current.stabilizeScrollTop = null;
  current.stabilizeAnchor = null;
  current.stabilizeUntil = 0;
}

function scheduleViewportStabilityGuard(view, current) {
  if (!current || current.stabilizeFrame) return;
  current.stabilizeFrame = scheduleFrame(() => {
    current.stabilizeFrame = null;
    if (!current.followLatest || current.stabilizeUntil <= Date.now()) {
      clearViewportStability(current);
      return;
    }
    restoreConversationViewportStability(view, {
      sessionId: current.sessionId
    });
    scheduleViewportStabilityGuard(view, current);
  });
}

export function initializeConversationViewport(
  view,
  { sessionId = "", state } = {}
) {
  return getViewportState(view, { sessionId, state })?.followLatest !== false;
}

export function isConversationViewportFollowing(
  view,
  { sessionId = "", state } = {}
) {
  return getViewportState(view, { sessionId, state })?.followLatest !== false;
}

export function setConversationViewportFollowing(
  view,
  followLatest,
  {
    sessionId = "",
    state,
    mirrorLegacy = false
  } = {}
) {
  const current = getViewportState(view, { sessionId, state });
  if (!current) return false;
  current.followLatest = followLatest !== false;
  current.epoch += 1;
  if (!current.followLatest) {
    cancelFrame(current.frame);
    current.frame = null;
    current.pending = null;
    current.initialAnchor = null;
    clearViewportStability(current);
  }
  if (mirrorLegacy) {
    const key = legacyFollowKey(current.sessionId);
    try {
      if (key) resolveStateStore(state)?.set?.(key, current.followLatest);
    } catch {}
  }
  return current.followLatest;
}

export function beginConversationViewportFollow(
  view,
  {
    sessionId = "",
    state,
    cycleId = "",
    followLatest = true,
    mirrorLegacy = true
  } = {}
) {
  const current = getViewportState(view, { sessionId, state });
  if (!current) return false;
  cancelFrame(current.frame);
  current.frame = null;
  current.pending = null;
  current.epoch += 1;
  current.cycleId = String(cycleId || "");
  current.completedInitialCycleId = "";
  current.initialScrollTop = Number.isFinite(Number(view?.scrollDOM?.scrollTop))
    ? Number(view.scrollDOM.scrollTop)
    : null;
  current.initialAnchor = captureViewportAnchor(view);
  clearViewportStability(current);
  current.followLatest = followLatest !== false;
  if (mirrorLegacy) {
    const key = legacyFollowKey(current.sessionId);
    try {
      if (key) resolveStateStore(state)?.set?.(key, current.followLatest);
    } catch {}
  }
  return current.followLatest;
}

export function scheduleConversationViewportFollow(
  view,
  {
    sessionId = "",
    state,
    cycleId = "",
    initial = false,
    reveal
  } = {}
) {
  const current = getViewportState(view, { sessionId, state });
  if (!current || !current.followLatest || typeof reveal !== "function") {
    return false;
  }
  const normalizedCycleId = String(cycleId || current.cycleId || "");
  if (
    initial
    && normalizedCycleId
    && current.completedInitialCycleId === normalizedCycleId
  ) {
    return false;
  }

  current.pending = {
    cycleId: normalizedCycleId,
    initial: initial === true,
    epoch: current.epoch,
    reveal
  };
  if (current.frame) return true;

  current.frame = scheduleFrame(() => {
    current.frame = null;
    const pending = current.pending;
    current.pending = null;
    if (
      !pending
      || !current.followLatest
      || pending.epoch !== current.epoch
      || (
        pending.initial
        && pending.cycleId
        && current.completedInitialCycleId === pending.cycleId
      )
    ) {
      return;
    }

    let resolved = false;
    // A follow requested after document growth supersedes submit preservation.
    // Otherwise its 350ms guard pulls the viewport back after every token.
    if (!pending.initial) clearViewportStability(current);
    const scrollDOM = view?.scrollDOM;
    const beforeReveal = Number(scrollDOM?.scrollTop);
    try {
      resolved = pending.reveal() !== false;
    } catch {}
    if (resolved && pending.initial && pending.cycleId) {
      const afterReveal = Number(scrollDOM?.scrollTop);
      const revealMovedViewport = Number.isFinite(beforeReveal)
        && Number.isFinite(afterReveal)
        && Math.abs(afterReveal - beforeReveal) >= 1;
      if (
        Number.isFinite(current.initialScrollTop)
        && Number.isFinite(beforeReveal)
        && Number.isFinite(afterReveal)
        && Math.abs(afterReveal - beforeReveal) < 1
        && Math.abs(beforeReveal - current.initialScrollTop) >= 1
      ) {
        const maxScrollTop = Math.max(
          0,
          Number(scrollDOM?.scrollHeight || 0)
            - Number(scrollDOM?.clientHeight || 0)
        );
        scrollDOM.scrollTop = Math.max(
          0,
          maxScrollTop > 0
            ? Math.min(maxScrollTop, current.initialScrollTop)
            : current.initialScrollTop
        );
      }
      if (!revealMovedViewport && Number.isFinite(current.initialScrollTop)) {
        current.stabilizeScrollTop = current.initialScrollTop;
        current.stabilizeAnchor = current.initialAnchor;
        current.stabilizeUntil = Date.now() + 350;
        scheduleViewportStabilityGuard(view, current);
      }
      current.completedInitialCycleId = pending.cycleId;
      current.initialScrollTop = null;
      current.initialAnchor = null;
    }
  });
  return true;
}

export function cancelConversationViewportFollow(view) {
  const current = viewportStates.get(view);
  if (!current) return;
  cancelFrame(current.frame);
  current.frame = null;
  current.pending = null;
  current.epoch += 1;
  current.initialAnchor = null;
  clearViewportStability(current);
}

export function restoreConversationViewportStability(
  view,
  { sessionId = "", state, update } = {}
) {
  const current = getViewportState(view, { sessionId, state });
  const scrollDOM = view?.scrollDOM;
  if (current?.initialAnchor) {
    current.initialAnchor = mapAnchor(current.initialAnchor, update);
  }
  if (current?.stabilizeAnchor) {
    current.stabilizeAnchor = mapAnchor(current.stabilizeAnchor, update);
  }
  if (
    !current
    || !scrollDOM
    || !current.followLatest
    || !Number.isFinite(current.stabilizeScrollTop)
    || current.stabilizeUntil <= Date.now()
  ) {
    return false;
  }
  let nextScrollTop = current.stabilizeScrollTop;
  try {
    if (
      current.stabilizeAnchor
      && typeof view.lineBlockAt === "function"
      && Number.isFinite(Number(current.stabilizeAnchor.pos))
    ) {
      const block = view.lineBlockAt(current.stabilizeAnchor.pos);
      const blockTop = Number(block?.top);
      if (Number.isFinite(blockTop)) {
        nextScrollTop = blockTop + Number(current.stabilizeAnchor.yOffset || 0);
      }
    }
  } catch {}
  nextScrollTop = clampScrollTop(scrollDOM, nextScrollTop);
  if (Math.abs(Number(scrollDOM.scrollTop || 0) - nextScrollTop) < 1) {
    return false;
  }
  scrollDOM.__zionProgrammaticScrollUntil = Math.max(
    Number(scrollDOM.__zionProgrammaticScrollUntil) || 0,
    Date.now() + 80
  );
  scrollDOM.scrollTop = nextScrollTop;
  return true;
}
