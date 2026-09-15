import { Compartment, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import {
  findAssistantBlockEndOffsetById
} from "../../src/chat/restore";
import {
  appendAssistantTokenToYText
} from "./session-document-projector.js";
import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";
import {
  clearPendingAssistant,
  pendingAssistantExtension,
  revealPendingAssistantInView,
  setPendingAssistant
} from "./editor/pending-assistant-plugin.js";

const COLLABORATION_TEXT_KEY = "content";
const COLLABORATION_CARDS_KEY = "cards";
const COLLABORATION_RUN_PROJECTION_KEY = "runProjection";
const COLLABORATION_PROTOCOL = "6";
const PENDING_COMMIT_GRACE_MS = 5_000;

function websocketUrl(baseUrl, clientId) {
  const url = new globalThis.URL(String(baseUrl || ""));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/collaboration";
  url.search = "";
  url.searchParams.set("client_id", String(clientId || ""));
  url.searchParams.set("protocol", COLLABORATION_PROTOCOL);
  return url.toString();
}

function sessionIdForEditor(editor) {
  return String(
    editor?.sessionId
    || editor?.getSessionId?.()
    || editor?.getView?.()?.dom?.getAttribute?.("data-session-id")
    || ""
  ).trim();
}

function optionalDocumentOffset(value) {
  if (value == null || value === "") return null;
  const offset = Number(value);
  return Number.isFinite(offset) ? offset : null;
}

function encodeBase64(bytes) {
  if (typeof globalThis.btoa !== "function") return "";
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return globalThis.btoa(binary);
}

function collaborationState(zion, sessionId, patch = {}) {
  const key = `sessions.collaboration.${sessionId}`;
  const current = zion?.state?.get?.(key) || {};
  zion?.state?.set?.(key, {
    ...current,
    ...patch
  });
}

function projectionAcknowledges(entry, projection) {
  const expected = Number(entry?.projectionSequence || 0);
  const actual = Number(projection?.lastSequence || 0);
  return expected > 0 && actual >= expected;
}

function mergeProjectedCards(current, cards) {
  const previous = current && typeof current === "object" ? current : {};
  const tools = new Map(
    (Array.isArray(previous.tools) ? previous.tools : [])
      .map((item) => [String(item?.id || ""), item])
      .filter(([id]) => id)
  );
  const thinking = new Map(
    (Array.isArray(previous.thinking) ? previous.thinking : [])
      .map((item) => [String(item?.id || ""), item])
      .filter(([id]) => id)
  );
  for (const value of cards.values()) {
    if (!value?.id) continue;
    const target = value.kind === "tool" ? tools : thinking;
    const previousItem = target.get(String(value.id)) || {};
    target.set(String(value.id), {
      ...previousItem,
      ...value,
      expanded: previousItem.expanded === true
    });
  }
  return {
    ...previous,
    tools: [...tools.values()],
    thinking: [...thinking.values()]
  };
}

export function createSessionCollaborationManager({
  zion = globalThis.window?.zion,
  clientId = "",
  runtimeConfig = readWorkbenchRuntimeConfig({
    state: zion?.state,
    storage: globalThis.localStorage
  }),
  createDocument = () => new Y.Doc(),
  createProvider,
  createPersistence,
  syncTimeoutMs = 5_000
} = {}) {
  const records = new Map();
  const pendingBySession = new Map();
  const pendingClearTimers = new Map();
  const pendingFollowHandles = new Map();
  const cardRestoreScheduled = new Set();
  const enabled = runtimeConfig.mode !== "browser" && !!runtimeConfig.baseUrl;
  const providerFactory = createProvider || ((options) =>
    new HocuspocusProvider(options));
  const persistenceFactory = createPersistence || (() => null);

  const dispatchPending = (sessionId, effect) => {
    const record = records.get(sessionId);
    if (!record) return;
    for (const view of record.views) {
      try { view.dispatch({ effects: effect }); } catch {}
    }
  };

  const cancelPendingFollow = (view) => {
    const handle = pendingFollowHandles.get(view);
    if (handle == null) return;
    try {
      if (typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(handle);
      } else {
        globalThis.clearTimeout(handle);
      }
    } catch {}
    pendingFollowHandles.delete(view);
  };

  const schedulePendingFollow = (sessionId, runId, entryHint = null) => {
    const record = records.get(sessionId);
    const entry = pendingBySession.get(sessionId)?.get(runId) || entryHint;
    if (!record) return;
    for (const view of record.views) {
      if (pendingFollowHandles.has(view)) continue;
      const run = () => {
        pendingFollowHandles.delete(view);
        if (
          zion?.state?.get?.(`chat.followLatest.${sessionId}`) === false
          || !view?.scrollDOM
        ) {
          return;
        }
        try {
          const revealed = revealPendingAssistantInView(view, {
            runId: entry?.runId || runId,
            sessionId
          });
          if (!revealed && entry?.assistantBlockId) {
            const position = findAssistantBlockEndOffsetById(
              view.state.doc.toString(),
              entry.assistantBlockId
            ) ?? view.state.doc.length;
            const suppressUntil = Date.now() + 160;
            zion?.state?.set?.(
              `chat.followSuppressUntil.${sessionId}`,
              suppressUntil
            );
            view.scrollDOM.__zionProgrammaticScrollUntil = Math.max(
              Number(view.scrollDOM.__zionProgrammaticScrollUntil) || 0,
              suppressUntil
            );
            view.dispatch({
              effects: EditorView.scrollIntoView(position, {
                y: "nearest",
                yMargin: 24
              })
            });
          }
        } catch {}
      };
      const handle = typeof globalThis.requestAnimationFrame === "function"
        ? globalThis.requestAnimationFrame(run)
        : globalThis.setTimeout(run, 16);
      pendingFollowHandles.set(view, handle);
    }
  };

  const scheduleSettledFollow = (sessionId, runId, entry) => {
    schedulePendingFollow(sessionId, runId, entry);
    globalThis.setTimeout(() => {
      schedulePendingFollow(sessionId, runId, entry);
    }, 120);
  };

  const clearPending = (sessionId, runId, { follow = false } = {}) => {
    const entries = pendingBySession.get(sessionId);
    const entry = entries?.get(runId) || null;
    entries?.delete(runId);
    if (entries?.size === 0) pendingBySession.delete(sessionId);
    const timerKey = `${sessionId}:${runId}`;
    if (pendingClearTimers.has(timerKey)) {
      globalThis.clearTimeout(pendingClearTimers.get(timerKey));
      pendingClearTimers.delete(timerKey);
    }
    dispatchPending(sessionId, clearPendingAssistant.of(runId));
    if (follow && entry) {
      scheduleSettledFollow(sessionId, runId, entry);
    }
  };

  const clearAcknowledgedPending = (sessionId) => {
    const record = records.get(sessionId);
    const entries = pendingBySession.get(sessionId);
    if (!record || !entries) return;
    for (const entry of [...entries.values()]) {
      if (
        projectionAcknowledges(
          entry,
          record.runProjections.get(entry.runId)
        )
      ) {
        clearPending(sessionId, entry.runId, { follow: true });
      }
    }
  };

  const syncProjectedCards = (sessionId) => {
    const record = records.get(sessionId);
    if (!record) return;
    const key = `sessions.annotations.${sessionId}`;
    const annotations = mergeProjectedCards(
      zion?.state?.get?.(key),
      record.cards
    );
    zion?.state?.set?.(key, annotations);
    if (cardRestoreScheduled.has(sessionId)) return;
    cardRestoreScheduled.add(sessionId);
    globalThis.queueMicrotask(() => {
      cardRestoreScheduled.delete(sessionId);
      try {
        zion?.commands?.executeCommand?.("zion.chatCards.restoreSession", {
          sessionId,
          annotations,
          clearFirst: false
        });
      } catch {}
    });
  };

  const commitPendingEntry = (sessionId, entry) => {
    const record = records.get(sessionId);
    if (!record?.ready || entry?.documentWriter !== true || !entry?.text) {
      return false;
    }
    let committed = false;
    record.document.transact(() => {
      committed = appendAssistantTokenToYText(record.text, {
        runId: entry.assistantBlockId,
        token: entry.text
      });
    }, { source: "runtime-stream", clientId });
    if (!committed) return false;
    schedulePendingFollow(sessionId, entry.runId, entry);
    clearPending(sessionId, entry.runId);
    return true;
  };

  const completePending = (payload = {}) => {
    const sessionId = String(payload.sessionId || "");
    const runId = String(payload.runId || "");
    if (!sessionId || !runId) return;
    const entries = pendingBySession.get(sessionId);
    const entry = entries?.get(runId);
    if (!entry) return;
    entry.terminal = true;
    if (
      projectionAcknowledges(
        entry,
        records.get(sessionId)?.runProjections?.get(runId)
      )
    ) {
      clearPending(sessionId, runId, { follow: true });
      return;
    }
    const timerKey = `${sessionId}:${runId}`;
    if (pendingClearTimers.has(timerKey)) {
      globalThis.clearTimeout(pendingClearTimers.get(timerKey));
    }
    pendingClearTimers.set(timerKey, globalThis.setTimeout(() => {
      clearPending(sessionId, runId, { follow: true });
    }, PENDING_COMMIT_GRACE_MS));
  };

  const eventDisposables = [];
  if (enabled) {
    eventDisposables.push(zion?.events?.on?.("chat/preparing", (payload = {}) => {
      const sessionId = String(payload.sessionId || "");
      const runId = String(payload.submissionId || "");
      if (!sessionId || !runId) return;
      const entries = pendingBySession.get(sessionId) || new Map();
      const entry = {
        runId,
        assistantBlockId: String(payload.assistantBlockId || runId),
        fallbackOffset: optionalDocumentOffset(payload.answerAnchorPos),
        text: "",
        status: String(payload.status || ""),
        documentWriter: false
      };
      entries.set(runId, entry);
      pendingBySession.set(sessionId, entries);
      dispatchPending(sessionId, setPendingAssistant.of(entry));
      schedulePendingFollow(sessionId, runId, entry);
    }));
    eventDisposables.push(zion?.events?.on?.("chat/prepared", (payload = {}) => {
      clearPending(String(payload.sessionId || ""), String(payload.submissionId || ""));
    }));
    eventDisposables.push(zion?.events?.on?.("chat/token", (payload = {}) => {
      if (payload.backend !== "runtime") return;
      const sessionId = String(payload.sessionId || "");
      const runId = String(payload.runId || "");
      const token = String(payload.token || "");
      if (!sessionId || !runId || !token) return;
      const entries = pendingBySession.get(sessionId) || new Map();
      const previous = entries.get(runId) || {
        runId,
        assistantBlockId: String(payload.assistantBlockId || runId),
        fallbackOffset: optionalDocumentOffset(payload.answerAnchorPos),
        text: "",
        terminal: false
      };
      const nextFallbackOffset = optionalDocumentOffset(payload.answerAnchorPos);
      const entry = {
        ...previous,
        documentWriter: payload.documentWriter === true,
        assistantBlockId: String(
          payload.assistantBlockId
          || previous.assistantBlockId
          || runId
        ),
        fallbackOffset: nextFallbackOffset ?? previous.fallbackOffset,
        projectionSequence: Math.max(
          Number(previous.projectionSequence || 0),
          Number(
            payload.projectionSequence
            ?? payload.sourceSequenceEnd
            ?? payload.sequence
            ?? 0
          )
        ),
        text: previous.text + token
      };
      entries.set(runId, entry);
      pendingBySession.set(sessionId, entries);
      if (
        !entry.documentWriter
        && projectionAcknowledges(
          entry,
          records.get(sessionId)?.runProjections?.get(runId)
        )
      ) {
        clearPending(sessionId, runId);
        return;
      }
      const committed = commitPendingEntry(sessionId, entry);
      if (committed) return;
      dispatchPending(sessionId, setPendingAssistant.of(entry));
      schedulePendingFollow(sessionId, runId, entry);
    }));
    for (const topic of ["chat/runFinished"]) {
      eventDisposables.push(zion?.events?.on?.(topic, completePending));
    }
    for (const topic of ["chat/runError", "chat/aborted"]) {
      eventDisposables.push(zion?.events?.on?.(topic, (payload = {}) => {
        clearPending(
          String(payload.sessionId || ""),
          String(payload.runId || "")
        );
      }));
    }
  }

  const disposeRecord = (sessionId) => {
    const record = records.get(sessionId);
    if (!record) return;
    records.delete(sessionId);
    try { record.text.unobserve(record.onTextChange); } catch {}
    try { record.cards.unobserve(record.onCardsChange); } catch {}
    try {
      record.runProjections.unobserve(record.onRunProjectionChange);
    } catch {}
    try { record.provider.destroy(); } catch {}
    try { record.persistence?.destroy?.(); } catch {}
    try { record.document.destroy(); } catch {}
    for (const view of record.views) cancelPendingFollow(view);
    collaborationState(zion, sessionId, {
      connected: false,
      synced: false,
      disposed: true
    });
  };

  const acquire = (sessionId) => {
    let record = records.get(sessionId);
    if (record) {
      record.references += 1;
      return record;
    }

    const document = createDocument();
    const text = document.getText(COLLABORATION_TEXT_KEY);
    const cards = document.getMap(COLLABORATION_CARDS_KEY);
    const runProjections = document.getMap(
      COLLABORATION_RUN_PROJECTION_KEY
    );
    const persistenceName = [
      "zion-collaboration",
      encodeURIComponent(runtimeConfig.baseUrl),
      encodeURIComponent(sessionId)
    ].join(":");
    let persistence = null;
    try {
      persistence = persistenceFactory(persistenceName, document);
    } catch {}
    let resolveProviderSynced;
    const providerSynced = new Promise((resolve) => {
      resolveProviderSynced = resolve;
    });
    const provider = providerFactory({
      url: websocketUrl(runtimeConfig.baseUrl, clientId),
      name: sessionId,
      document,
      token: "",
      flushDelay: 25,
      onStatus({ status }) {
        collaborationState(zion, sessionId, {
          connected: status === "connected",
          ...(status === "connected" ? {} : { synced: false }),
          status
        });
      },
      onSynced() {
        resolveProviderSynced();
        collaborationState(zion, sessionId, {
          connected: true,
          synced: true,
          error: null
        });
      },
      onAuthenticationFailed({ reason }) {
        collaborationState(zion, sessionId, {
          connected: false,
          synced: false,
          error: reason || "Collaboration authentication failed"
        });
      }
    });
    const onTextChange = () => {
      if (!record?.ready) return;
      const value = text.toString();
      zion?.state?.set?.(`sessions.doc.${sessionId}`, value);
    };
    const onCardsChange = () => syncProjectedCards(sessionId);
    const onRunProjectionChange = () =>
      clearAcknowledgedPending(sessionId);
    text.observe(onTextChange);
    cards.observe(onCardsChange);
    runProjections.observe(onRunProjectionChange);
    record = {
      document,
      text,
      cards,
      runProjections,
      provider,
      persistence,
      providerSynced,
      onTextChange,
      onCardsChange,
      onRunProjectionChange,
      views: new Set(),
      ready: false,
      references: 1
    };
    records.set(sessionId, record);
    collaborationState(zion, sessionId, {
      connected: false,
      synced: false,
      disposed: false
    });
    return record;
  };

  const bindEditor = (editor, { allowDeferred = true } = {}) => {
    const view = editor?.getView?.();
    const sessionId = sessionIdForEditor(editor);
    if (!enabled || !view) return { dispose() {} };
    if (view.dom?.dataset?.zionSessionPersistence === "skip") {
      return { dispose() {} };
    }
    if (!sessionId && allowDeferred) {
      let disposed = false;
      let binding = null;
      globalThis.queueMicrotask(() => {
        if (disposed) return;
        binding = bindEditor(editor, { allowDeferred: false });
      });
      return {
        dispose() {
          disposed = true;
          binding?.dispose?.();
        }
      };
    }
    if (!sessionId) return { dispose() {} };
    const compartment = new Compartment();
    editor.addVisualExtension?.(
      compartment.of(
        Prec.highest([
          EditorView.editable.of(false),
          pendingAssistantExtension()
        ])
      )
    );
    const record = acquire(sessionId);
    record.views.add(view);
    let disposed = false;
    let timedOut = false;
    const timeout = globalThis.setTimeout(() => {
      if (disposed) return;
      timedOut = true;
      try { delete view.dom.dataset.zionCollaborationBound; } catch {}
      view.dispatch({
        effects: compartment.reconfigure(pendingAssistantExtension())
      });
      collaborationState(zion, sessionId, {
        connected: false,
        synced: false,
        fallback: true,
        error: "Collaboration sync timed out"
      });
    }, Math.max(1, Number(syncTimeoutMs) || 5_000));

    void Promise.all([
      record.providerSynced,
      record.persistence?.whenSynced || Promise.resolve()
    ]).then(() => {
      if (disposed || timedOut) return;
      globalThis.clearTimeout(timeout);
      const remoteText = record.text.toString();
      const localText = String(editor.getValue?.() || "");
      const localSnapshot = zion?.state?.get?.(`sessions.doc.${sessionId}`);
      if (
        !remoteText
        && localText
        && typeof localSnapshot === "string"
        && localSnapshot === localText
      ) {
        record.text.insert(0, localText);
      } else if (remoteText !== localText) {
        editor.setValue?.(remoteText, { source: "collaboration-hydration" });
      }
      try { view.dom.dataset.zionCollaborationBound = "true"; } catch {}
      view.dispatch({
        effects: compartment.reconfigure(
          Prec.highest([
            yCollab(
              record.text,
              record.provider.awareness
            ),
            pendingAssistantExtension()
          ])
        )
      });
      record.ready = true;
      zion?.state?.set?.(`sessions.doc.${sessionId}`, record.text.toString());
      syncProjectedCards(sessionId);
      clearAcknowledgedPending(sessionId);
      for (const entry of pendingBySession.get(sessionId)?.values?.() || []) {
        if (!commitPendingEntry(sessionId, entry)) {
          view.dispatch({ effects: setPendingAssistant.of(entry) });
        }
      }
      record.provider.awareness?.setLocalStateField?.("user", {
        id: clientId,
        name: "Workbench"
      });
      collaborationState(zion, sessionId, {
        connected: true,
        synced: true,
        error: null
      });
    }).catch((error) => {
      try { delete view.dom.dataset.zionCollaborationBound; } catch {}
      collaborationState(zion, sessionId, {
        connected: false,
        synced: false,
        error: error?.message || String(error)
      });
    });

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        try { delete view.dom.dataset.zionCollaborationBound; } catch {}
        globalThis.clearTimeout(timeout);
        try {
          view.dispatch({ effects: compartment.reconfigure([]) });
        } catch {}
        record.views.delete(view);
        record.references -= 1;
        if (record.references <= 0) disposeRecord(sessionId);
      }
    };
  };

  return {
    enabled,
    bindEditor,
    isSynced(sessionId) {
      const state = zion?.state?.get?.(
        `sessions.collaboration.${String(sessionId || "")}`
      );
      return state?.connected === true && state?.synced === true;
    },
    createAnchor(sessionId, index, fallback = {}) {
      const record = records.get(String(sessionId || ""));
      const offset = Math.max(0, Number(index) || 0);
      const relative = record?.text
        ? Y.createRelativePositionFromTypeIndex(
            record.text,
            Math.min(record.text.length, offset),
            1
          )
        : null;
      return {
        kind: "y-relative-position-v1",
        ...(relative
          ? { encoded: encodeBase64(Y.encodeRelativePosition(relative)) }
          : {}),
        fallback: {
          offset,
          before: String(fallback.before || "").slice(-64),
          after: String(fallback.after || "").slice(0, 64)
        }
      };
    },
    dispose() {
      for (const disposable of eventDisposables) {
        try { disposable?.dispose?.(); } catch {}
      }
      for (const timer of pendingClearTimers.values()) {
        globalThis.clearTimeout(timer);
      }
      for (const view of pendingFollowHandles.keys()) cancelPendingFollow(view);
      pendingClearTimers.clear();
      pendingBySession.clear();
      for (const sessionId of [...records.keys()]) disposeRecord(sessionId);
    }
  };
}
