import { Compartment, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import {
  assistantBlockHeaderText,
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
const COLLABORATION_PROTOCOL = "5";
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

function containsCommittedPending(documentText, entry) {
  const source = String(documentText || "");
  const header = assistantBlockHeaderText(entry?.assistantBlockId);
  const start = source.lastIndexOf(header);
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
    if (containsCommittedPending(records.get(sessionId)?.text?.toString?.(), entry)) {
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
        text: previous.text + token
      };
      entries.set(runId, entry);
      pendingBySession.set(sessionId, entries);
      const committed = commitPendingEntry(sessionId, entry);
      // #region debug-point A:pending-token-accumulation
      void globalThis.fetch?.("/__trae_debug/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "workbench-content-disorder", runId: "post-fix", hypothesisId: "A", location: "extensions/dev.session-manager/collaboration-client.js:chat-token", msg: "[DEBUG] Collaboration pending token accumulated", data: { sessionId, runId, assistantBlockId: entry.assistantBlockId, documentWriter: entry.documentWriter === true, tokenChars: token.length, previousChars: previous.text.length, pendingChars: entry.text.length, recordReady: records.get(sessionId)?.ready === true, committed }, ts: Date.now() }), keepalive: true })?.catch?.(() => {});
      // #endregion
      if (committed) return;
      dispatchPending(sessionId, setPendingAssistant.of(entry));
      schedulePendingFollow(sessionId, runId, entry);
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
        if (containsCommittedPending(value, entry)) {
          clearPending(sessionId, entry.runId, { follow: true });
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
    // #region debug-point C:desktop-editor-binding
    globalThis.fetch?.("/__trae_debug/event",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:"mobile-desktop-transcript",runId:"post-fix",hypothesisId:"C",location:"extensions/dev.session-manager/collaboration-client.js:bindEditor",msg:"[DEBUG] Desktop collaboration decorator evaluated an editor",data:{editorExists:!!editor,viewExists:!!view,enabled,allowDeferred,editorSessionId:sessionId,panelId:String(editor?.panelId||""),documentLength:String(editor?.getValue?.()||"").length},ts:Date.now()}),keepalive:true}).catch(()=>{});
    // #endregion
    if (!enabled || !view) return { dispose() {} };
    if (view.dom?.dataset?.zionSessionPersistence === "skip") {
      // #region debug-point C:comment-collaboration-skipped
      void globalThis.fetch?.("/__trae_debug/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "comment-session-parenting", runId: "post-fix", hypothesisId: "C", location: "extensions/dev.session-manager/collaboration-client.js:bindEditor", msg: "[DEBUG] Durable collaboration skipped a non-durable editor", data: { commentSessionId: sessionId, panelId: String(editor?.panelId || ""), persistenceMode: String(view.dom.dataset.zionSessionPersistence || "") }, ts: Date.now() }), keepalive: true })?.catch?.(() => {});
      // #endregion
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
      // #region debug-point C:desktop-hydration-input
      globalThis.fetch?.("/__trae_debug/event",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:"mobile-desktop-transcript",runId:"post-fix",hypothesisId:"C",location:"extensions/dev.session-manager/collaboration-client.js:hydration-input",msg:"[DEBUG] Desktop collaboration hydration compared remote and local documents",data:{runtimeSessionId:sessionId,remoteLength:remoteText.length,remoteRoles:Array.from(remoteText.matchAll(/^(user|assistant|system|tool)(?:\s|$)/gm),(match)=>match[1]),remoteMarkers:(remoteText.match(/zion-assistant:id=/g)||[]).length,localLength:localText.length,localRoles:Array.from(localText.matchAll(/^(user|assistant|system|tool)(?:\s|$)/gm),(match)=>match[1]),willSeedRemote:!remoteText&&!!localText,willHydrateLocal:!!remoteText&&remoteText!==localText},ts:Date.now()}),keepalive:true}).catch(()=>{});
      // #endregion
      if (!remoteText && localText) {
        record.text.insert(0, localText);
      } else if (remoteText !== localText) {
        editor.setValue?.(remoteText, { source: "collaboration-hydration" });
      }
      // #region debug-point E:desktop-hydration-output
      globalThis.fetch?.("/__trae_debug/event",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:"mobile-desktop-transcript",runId:"post-fix",hypothesisId:"E",location:"extensions/dev.session-manager/collaboration-client.js:hydration-output",msg:"[DEBUG] Desktop editor state after collaboration hydration",data:{runtimeSessionId:sessionId,editorLength:String(editor.getValue?.()||"").length,editorRoles:Array.from(String(editor.getValue?.()||"").matchAll(/^(user|assistant|system|tool)(?:\s|$)/gm),(match)=>match[1]),editorMarkers:(String(editor.getValue?.()||"").match(/zion-assistant:id=/g)||[]).length},ts:Date.now()}),keepalive:true}).catch(()=>{});
      // #endregion
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
