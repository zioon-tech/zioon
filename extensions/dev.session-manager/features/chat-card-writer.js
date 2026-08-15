function getEditorSessionId(editor) {
  if (!editor) return "";
  const direct = String(editor.sessionId || "").trim();
  if (direct) return direct;
  try {
    const fromMethod = String(editor.getSessionId?.() || editor.core?.getSessionId?.() || "").trim();
    if (fromMethod) return fromMethod;
  } catch {}
  try {
    return String(editor.getView?.()?.dom?.getAttribute?.("data-session-id") || "").trim();
  } catch {
    return "";
  }
}

function getPanelsApi(zion) {
  return zion?.panels || zion?.panelManager || null;
}

function getPanel(panels, panelId) {
  if (!panels || !panelId) return null;
  try {
    const panel = panels.getPanel?.(panelId);
    if (panel) return panel;
  } catch {}
  try {
    return panels.list?.().find?.((item) => item?.id === panelId)
      || panels.listPanels?.().find?.((item) => item?.id === panelId)
      || null;
  } catch {
    return null;
  }
}

function getSessionEditor(panels, panelId, sessionId) {
  if (!panels || !panelId || !sessionId) return null;
  try {
    const editor = panels.getEditorBySession?.(panelId, sessionId);
    if (editor) return editor;
  } catch {}
  try {
    const entry = panels.listEditors?.(panelId)?.find?.((item) =>
      String(item?.panelId || "") === panelId
      && String(item?.sessionId || "") === sessionId
    );
    if (entry) return entry;
  } catch {}
  const panel = getPanel(panels, panelId);
  if (String(panel?.activeTabId || "") !== sessionId) return null;
  try {
    return panels.getEditor?.(panelId) || panel?.editor || null;
  } catch {
    return panel?.editor || null;
  }
}

/**
 * A live editor plugin is the sole writer for card markers when an event names
 * its source panel. Events without a panel use the active panel only; hidden
 * editor slots must not consume headless/background runs.
 */
export function hasLiveChatCardWriter(zion, { sessionId, panelId } = {}) {
  const sid = String(sessionId || "").trim();
  if (!sid) return false;
  const panels = getPanelsApi(zion);
  const sourcePanelId = String(panelId || "").trim();

  if (sourcePanelId) {
    return !!getSessionEditor(panels, sourcePanelId, sid);
  }

  let activePanelId = "";
  try {
    activePanelId = String(panels?.getActivePanelId?.() || "").trim();
  } catch {}
  if (activePanelId && getSessionEditor(panels, activePanelId, sid)) return true;

  const activeEditor = zion?.window?.activeEditor || null;
  if (!activeEditor) return false;
  const activeEditorPanelId = String(activeEditor.panelId || "").trim();
  if (activePanelId && activeEditorPanelId && activeEditorPanelId !== activePanelId) return false;
  const editorSessionId = getEditorSessionId(activeEditor);
  if (editorSessionId) return editorSessionId === sid;

  // Legacy single-editor builds do not expose a session id on the editor.
  try {
    return !activePanelId && String(zion?.state?.get?.("sessions.currentId") || "") === sid;
  } catch {
    return false;
  }
}

export function shouldPersistChatCardInBackground(zion, payload = {}) {
  const sessionId = String(payload?.sessionId || "").trim();
  return !!sessionId && !hasLiveChatCardWriter(zion, {
    sessionId,
    panelId: payload?.panelId
  });
}

export function createChatCardWriterLeases(zion) {
  const backgroundRuns = new Set();
  const backgroundCards = new Set();
  const activeRuns = new Map();
  const closedRuns = new Set();
  const cancelledRuns = new Set();
  const sessionGenerations = new Map();
  const runGenerations = new Map();
  const runKey = (payload = {}) =>
    `${String(payload?.sessionId || "")}:${String(payload?.runId || "")}`;
  const cardKey = (payload = {}, cardId = "") =>
    `${runKey(payload)}:${String(cardId || "")}`;
  const releaseRun = (payload = {}) => {
    const key = runKey(payload);
    backgroundRuns.delete(key);
    for (const card of Array.from(backgroundCards)) {
      if (card.startsWith(`${key}:`)) backgroundCards.delete(card);
    }
  };
  const trimRunSet = (set) => {
    while (set.size > 256) set.delete(set.values().next().value);
  };
  const acceptsRun = (payload = {}) => {
    const sessionId = String(payload?.sessionId || "");
    const runId = String(payload?.runId || "");
    if (!sessionId || !runId) return false;
    const key = runKey(payload);
    if (closedRuns.has(key)) return false;
    const activeRunId = activeRuns.get(sessionId);
    return !activeRunId || activeRunId === runId;
  };

  return {
    startRun(payload = {}) {
      const sessionId = String(payload?.sessionId || "");
      const runId = String(payload?.runId || "");
      if (!sessionId || !runId) return false;
      const key = runKey(payload);
      if (activeRuns.get(sessionId) === runId && runGenerations.has(key)) return true;
      const previousRunId = activeRuns.get(sessionId);
      if (previousRunId && previousRunId !== runId) {
        const previousPayload = { sessionId, runId: previousRunId };
        const previousKey = runKey(previousPayload);
        closedRuns.add(previousKey);
        cancelledRuns.add(previousKey);
        releaseRun(previousPayload);
      }
      const generation = (sessionGenerations.get(sessionId) || 0) + 1;
      sessionGenerations.set(sessionId, generation);
      runGenerations.set(key, generation);
      activeRuns.set(sessionId, runId);
      closedRuns.delete(key);
      cancelledRuns.delete(key);
      return true;
    },
    finishRun(payload = {}) {
      const sessionId = String(payload?.sessionId || "");
      const runId = String(payload?.runId || "");
      if (!sessionId || !runId) return;
      closedRuns.add(runKey(payload));
      trimRunSet(closedRuns);
      if (activeRuns.get(sessionId) === runId) activeRuns.delete(sessionId);
      releaseRun(payload);
    },
    cancelRun(payload = {}) {
      const sessionId = String(payload?.sessionId || "");
      const runId = String(payload?.runId || "");
      if (!sessionId || !runId) return;
      closedRuns.add(runKey(payload));
      cancelledRuns.add(runKey(payload));
      trimRunSet(closedRuns);
      trimRunSet(cancelledRuns);
      if (activeRuns.get(sessionId) === runId) activeRuns.delete(sessionId);
      releaseRun(payload);
    },
    acceptsRun,
    isWriteValid(payload = {}) {
      const sessionId = String(payload?.sessionId || "");
      const runId = String(payload?.runId || "");
      const key = runKey(payload);
      if (!sessionId || !runId || cancelledRuns.has(key)) return false;
      const runGeneration = runGenerations.get(key);
      const currentGeneration = sessionGenerations.get(sessionId);
      if (runGeneration && currentGeneration && runGeneration !== currentGeneration) return false;
      const activeRunId = activeRuns.get(sessionId);
      return !activeRunId || activeRunId === runId;
    },
    claimRun(payload = {}) {
      if (!acceptsRun(payload)) return false;
      if (!runGenerations.has(runKey(payload))) this.startRun(payload);
      const key = runKey(payload);
      const ownsBackground = shouldPersistChatCardInBackground(zion, payload);
      if (ownsBackground) backgroundRuns.add(key);
      else backgroundRuns.delete(key);
      return ownsBackground;
    },
    ownsRun(payload = {}) {
      return backgroundRuns.has(runKey(payload));
    },
    releaseRun(payload = {}) {
      releaseRun(payload);
    },
    claimCard(payload = {}, cardId = "") {
      if (!acceptsRun(payload)) return false;
      if (!runGenerations.has(runKey(payload))) this.startRun(payload);
      const key = cardKey(payload, cardId);
      const ownsBackground = shouldPersistChatCardInBackground(zion, payload);
      if (ownsBackground) backgroundCards.add(key);
      else backgroundCards.delete(key);
      return ownsBackground;
    },
    ownsCard(payload = {}, cardId = "") {
      return backgroundCards.has(cardKey(payload, cardId));
    },
    releaseCard(payload = {}, cardId = "") {
      backgroundCards.delete(cardKey(payload, cardId));
    }
  };
}
