import { Compartment, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import {
  assistantBlockHeaderText
} from "../../src/chat/restore";
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
const PENDING_COMMIT_GRACE_MS = 5_000;

function websocketUrl(baseUrl, clientId) {
  const url = new globalThis.URL(String(baseUrl || ""));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/collaboration";
  url.search = "";
  url.searchParams.set("client_id", String(clientId || ""));
  url.searchParams.set("protocol", "2");
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

function containsCommittedPending(documentText, entry) {
  const source = String(documentText || "");
  const header = assistantBlockHeaderText(entry?.assistantBlockId);
  const start = source.indexOf(header);
  if (start < 0) return false;
  const tail = source.slice(start + header.length);
  const nextRole = tail.search(/\n(?:system|user|assistant|tool)\s+/);
  const block = nextRole < 0 ? tail : tail.slice(0, nextRole);
  return !!entry?.text && block.includes(entry.text);
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
  createPersistence
} = {}) {
  const records = new Map();
  const pendingBySession = new Map();
  const pendingClearTimers = new Map();
  const pendingFollowHandles = new Map();
  const enabled = runtimeConfig.mode !== "browser" && !!runtimeConfig.baseUrl;
  const providerFactory = createProvider || ((options) =>
    new HocuspocusProvider(options));
  const persistenceFactory = createPersistence || ((name, document) =>
    new IndexeddbPersistence(name, document));

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

  const schedulePendingFollow = (sessionId, runId) => {
    const record = records.get(sessionId);
    const entry = pendingBySession.get(sessionId)?.get(runId);
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
          revealPendingAssistantInView(view, {
            runId: entry?.runId || runId,
            sessionId
          });
        } catch {}
      };
      const handle = typeof globalThis.requestAnimationFrame === "function"
        ? globalThis.requestAnimationFrame(run)
        : globalThis.setTimeout(run, 16);
      pendingFollowHandles.set(view, handle);
    }
  };

  const clearPending = (sessionId, runId) => {
    const entries = pendingBySession.get(sessionId);
    entries?.delete(runId);
    if (entries?.size === 0) pendingBySession.delete(sessionId);
    const timerKey = `${sessionId}:${runId}`;
    if (pendingClearTimers.has(timerKey)) {
      globalThis.clearTimeout(pendingClearTimers.get(timerKey));
      pendingClearTimers.delete(timerKey);
    }
    dispatchPending(sessionId, clearPendingAssistant.of(runId));
  };

  const completePending = (payload = {}) => {
    const sessionId = String(payload.sessionId || "");
    const runId = String(payload.runId || "");
    if (!sessionId || !runId) return;
    const entries = pendingBySession.get(sessionId);
    const entry = entries?.get(runId);
    if (!entry) return;
    entry.terminal = true;
    if (containsCommittedPending(records.get(sessionId)?.text?.toString?.(), entry)) {
      clearPending(sessionId, runId);
      return;
    }
    const timerKey = `${sessionId}:${runId}`;
    if (pendingClearTimers.has(timerKey)) {
      globalThis.clearTimeout(pendingClearTimers.get(timerKey));
    }
    pendingClearTimers.set(timerKey, globalThis.setTimeout(() => {
      clearPending(sessionId, runId);
    }, PENDING_COMMIT_GRACE_MS));
  };

  const eventDisposables = [];
  if (enabled) {
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
        fallbackOffset: Number.isFinite(Number(payload.answerAnchorPos))
          ? Number(payload.answerAnchorPos)
          : null,
        text: "",
        terminal: false
      };
      const entry = {
        ...previous,
        assistantBlockId: String(
          payload.assistantBlockId
          || previous.assistantBlockId
          || runId
        ),
        fallbackOffset: Number.isFinite(Number(payload.answerAnchorPos))
          ? Number(payload.answerAnchorPos)
          : previous.fallbackOffset,
        text: previous.text + token
      };
      entries.set(runId, entry);
      pendingBySession.set(sessionId, entries);
      dispatchPending(sessionId, setPendingAssistant.of(entry));
      schedulePendingFollow(sessionId, runId);
    }));
    for (const topic of [
      "runtime/pendingAssistantCommitted",
      "chat/runFinished"
    ]) {
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
      const value = text.toString();
      zion?.state?.set?.(`sessions.doc.${sessionId}`, value);
      const entries = pendingBySession.get(sessionId);
      if (!entries) return;
      for (const entry of [...entries.values()]) {
        if (
          entry.terminal
          && containsCommittedPending(value, entry)
        ) {
          clearPending(sessionId, entry.runId);
        }
      }
    };
    text.observe(onTextChange);
    record = {
      document,
      text,
      provider,
      persistence,
      providerSynced,
      onTextChange,
      views: new Set(),
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
    if (!enabled || !view) return { dispose() {} };
    const sessionId = sessionIdForEditor(editor);
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
    try { view.dom.dataset.zionCollaborationBound = "true"; } catch {}
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
      view.dispatch({
        effects: compartment.reconfigure(pendingAssistantExtension())
      });
      collaborationState(zion, sessionId, {
        connected: false,
        synced: false,
        fallback: true,
        error: "Collaboration sync timed out"
      });
    }, 5_000);

    void Promise.all([
      record.providerSynced,
      record.persistence?.whenSynced || Promise.resolve()
    ]).then(() => {
      if (disposed || timedOut) return;
      globalThis.clearTimeout(timeout);
      const remoteText = record.text.toString();
      const localText = String(editor.getValue?.() || "");
      if (!remoteText && localText) {
        record.text.insert(0, localText);
      } else if (remoteText !== localText) {
        editor.setValue?.(remoteText, { source: "session-load" });
      }
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
      for (const entry of pendingBySession.get(sessionId)?.values?.() || []) {
        view.dispatch({ effects: setPendingAssistant.of(entry) });
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
