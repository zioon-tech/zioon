import { ChangeSet, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { diffChars } from "diff";
import { EditorView } from "@codemirror/view";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import * as Y from "yjs";
import { currentAccountSession } from "../../packages/account-ui/src/client";
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
  cancelConversationViewportFollow,
  initializeConversationViewport,
  scheduleConversationViewportFollow
} from "../../src/chat/conversation-viewport.js";
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
  const durableFollowBySession = new Map();
  const pendingClearTimers = new Map();
  const tokenFollowRuns = new Set();
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

  const schedulePendingFollow = (
    sessionId,
    runId,
    entryHint = null,
    { initial = false } = {}
  ) => {
    const record = records.get(sessionId);
    const entry = pendingBySession.get(sessionId)?.get(runId) || entryHint;
    if (!record) return;
    const targetViews = entry?.sourceView && record.views.has(entry.sourceView)
      ? [entry.sourceView]
      : record.views;
    for (const view of targetViews) {
      scheduleConversationViewportFollow(view, {
        sessionId,
        state: zion?.state,
        cycleId: entry?.followCycleId || entry?.runId || runId,
        initial,
        reveal: () => {
          if (!view?.scrollDOM) return false;
          try {
            const revealed = revealPendingAssistantInView(view, {
              runId: entry?.runId || runId,
              sessionId,
              preserveVisible: initial
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
              return true;
            }
            return revealed;
          } catch {}
          return false;
        }
      });
    }
  };

  const scheduleSettledFollow = (sessionId, runId, entry) => {
    schedulePendingFollow(sessionId, runId, entry, { initial: true });
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
    tokenFollowRuns.delete(`${sessionId}:${runId}`);
    durableFollowBySession.get(sessionId)?.delete(runId);
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
    eventDisposables.push(zion?.events?.on?.("session/deleting", ({ sessionId } = {}) => {
      for (const runId of pendingBySession.get(sessionId)?.keys?.() || []) {
        clearPending(sessionId, runId);
      }
      disposeRecord(sessionId);
    }));
    eventDisposables.push(zion?.state?.onDidChange?.("workbench.accessChanged", (changed) => {
      if (!changed) return;
      for (const record of records.values()) record.provider.destroy();
    }));
    const showSubmitted = (payload = {}, submittedHeader = false) => {
      const sessionId = String(payload.sessionId || "");
      const runId = String(payload.submissionId || "");
      if (!sessionId || !runId) return;
      const entries = pendingBySession.get(sessionId) || new Map();
      const entry = {
        runId,
        assistantBlockId: String(payload.assistantBlockId || runId),
        fallbackOffset: optionalDocumentOffset(payload.answerAnchorPos),
        text: "",
        submittedHeader,
        status: submittedHeader ? "" : String(payload.status || ""),
        existingHeaders: [...(records.get(sessionId)?.text?.toString() || "").matchAll(/<!-- zion-assistant:id=([^\s]+) -->/g)].map(match => match[1]),
        documentWriter: false,
        sourceView: payload.editorView || null,
        followCycleId: String(payload.followCycleId || runId)
      };
      entries.set(runId, entry);
      pendingBySession.set(sessionId, entries);
      dispatchPending(sessionId, setPendingAssistant.of(entry));
      schedulePendingFollow(sessionId, runId, entry, { initial: true });
    };
    eventDisposables.push(zion?.events?.on?.("chat/submitted", payload => showSubmitted(payload, true)));
    eventDisposables.push(zion?.events?.on?.("chat/preparing", payload => showSubmitted(payload)));
    eventDisposables.push(zion?.events?.on?.("chat/prepared", (payload = {}) => {
      clearPending(String(payload.sessionId || ""), String(payload.submissionId || ""));
    }));
    eventDisposables.push(zion?.events?.on?.("chat/token", (payload = {}) => {
      if (payload.backend !== "runtime") return;
      const sessionId = String(payload.sessionId || "");
      const runId = String(payload.runId || "");
      const token = String(payload.token || "");
      if (!sessionId || !runId || !token) return;
      if (zion?.state?.get?.(`sessions.deleted.${sessionId}`)) return;
      const followRunKey = `${sessionId}:${runId}`;
      const initialToken = !tokenFollowRuns.has(followRunKey);
      tokenFollowRuns.add(followRunKey);
      // Synced editors receive the durable text over Yjs. Rendering a second
      // token widget here briefly duplicates text and changes line layout.
      if (payload.documentWriter === false && records.get(sessionId)?.ready) {
        clearPending(sessionId, runId);
        const follows = durableFollowBySession.get(sessionId) || new Map();
        follows.set(runId, {
          runId, assistantBlockId: String(payload.assistantBlockId || runId),
          sourceView: payload.editorView || null,
          followCycleId: String(payload.followCycleId || runId)
        });
        durableFollowBySession.set(sessionId, follows);
        const sequence = Number(payload.projectionSequence ?? payload.sourceSequenceEnd ?? payload.sequence ?? 0);
        if (sequence > 0 && Number(records.get(sessionId)?.runProjections.get(runId)?.lastSequence || 0) >= sequence) {
          const entry = follows.get(runId);
          schedulePendingFollow(sessionId, runId, entry);
        }
        return;
      }
      const entries = pendingBySession.get(sessionId) || new Map();
      const previous = entries.get(runId) || {
        runId,
        assistantBlockId: String(payload.assistantBlockId || runId),
        fallbackOffset: optionalDocumentOffset(payload.answerAnchorPos),
        text: "",
        terminal: false,
        sourceView: payload.editorView || null,
        followCycleId: String(payload.followCycleId || runId)
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
        sourceView: payload.editorView || previous.sourceView || null,
        followCycleId: String(
          payload.followCycleId
          || previous.followCycleId
          || runId
        ),
        plainText: records.get(sessionId)?.ready === true,
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
        schedulePendingFollow(sessionId, runId, entry, {
          initial: initialToken
        });
        return;
      }
      const committed = commitPendingEntry(sessionId, entry);
      if (committed) return;
      dispatchPending(sessionId, setPendingAssistant.of(entry));
      schedulePendingFollow(sessionId, runId, entry, {
        initial: initialToken
      });
    }));
    for (const topic of ["chat/runFinished"]) {
      eventDisposables.push(zion?.events?.on?.(topic, completePending));
    }
    for (const topic of ["chat/runError", "chat/aborted"]) {
      eventDisposables.push(zion?.events?.on?.(topic, (payload = {}) => {
        durableFollowBySession.get(String(payload.sessionId || ""))?.delete(String(payload.runId || ""));
        tokenFollowRuns.delete(
          `${String(payload.sessionId || "")}:${String(payload.runId || "")}`
        );
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
    durableFollowBySession.delete(sessionId);
    record.deleted = zion?.state?.get?.(`sessions.deleted.${sessionId}`) === true;
    try { record.text.unobserve(record.onTextChange); } catch {}
    try { record.cards.unobserve(record.onCardsChange); } catch {}
    try {
      record.runProjections.unobserve(record.onRunProjectionChange);
    } catch {}
    try { record.provider.destroy(); } catch {}
    try { record.persistence?.destroy?.(); } catch {}
    try { record.document.destroy(); } catch {}
    for (const view of record.views) cancelConversationViewportFollow(view);
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
        if (record) record.connected = status === "connected";
        collaborationState(zion, sessionId, {
          connected: status === "connected",
          ...(status === "connected" ? {} : { synced: false }),
          status
        });
      },
      onUnsyncedChanges({ number }) {
        collaborationState(zion, sessionId, { pendingChanges: Number(number) || 0 });
        if (Number(number) === 0) globalThis.queueMicrotask(() => {
          if (!record?.connected || Number(record.provider.unsyncedChanges || 0) > 0) return;
          for (const cleanup of record.draftCleanups) cleanup();
        });
      },
      onSynced() {
        if (record) record.connected = true;
        resolveProviderSynced();
        collaborationState(zion, sessionId, {
          connected: true,
          synced: record?.ready === true,
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
      for (const entry of [...(pendingBySession.get(sessionId)?.values() || [])]) {
        if (entry.submittedHeader && [...value.matchAll(/<!-- zion-assistant:id=([^\s]+) -->/g)].some(match => !entry.existingHeaders.includes(match[1]))) {
          clearPending(sessionId, entry.runId);
        }
      }
      // Yjs observers run before y-codemirror dispatches the document change.
      // Queue the reveal so it measures the updated editor, not the SSE token.
      const follows = durableFollowBySession.get(sessionId);
      if (follows?.size) globalThis.queueMicrotask(() => {
        if (records.get(sessionId) !== record) return;
        for (const entry of follows.values()) schedulePendingFollow(sessionId, entry.runId, entry);
      });
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
      draftCleanups: new Set(),
      appliedDrafts: new Set(),
      ready: false,
      connected: true,
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
    if (!sessionId || zion?.state?.get?.(`sessions.deleted.${sessionId}`)) return { dispose() {} };
    const compartment = new Compartment();
    editor.addVisualExtension?.(
      compartment.of(
        Prec.highest([
          pendingAssistantExtension()
        ])
      )
    );
    const record = acquire(sessionId);
    record.views.add(view);
    initializeConversationViewport(view, {
      sessionId,
      state: zion?.state
    });
    let disposed = false;
    let baseline = view.state.doc.toString();
    let pendingChanges = ChangeSet.empty(view.state.doc.length);
    let hydrating = false;
    let bound = false;
    let restoreDraft = null;
    view.dom.dataset.zionCollaborationPending = "true";
    const identity = currentAccountSession();
    let draftClientId = clientId;
    try {
      draftClientId = globalThis.sessionStorage?.getItem("zion.collaboration.draftClient") || clientId || "local";
      globalThis.sessionStorage?.setItem("zion.collaboration.draftClient", draftClientId);
    } catch {}
    const draftKey = `zion.collaboration.draft:${encodeURIComponent(runtimeConfig.baseUrl)}:${identity?.user?.id || "local"}:${identity?.space?.id || "local"}:${encodeURIComponent(sessionId)}:${draftClientId}`;
    try {
      const saved = JSON.parse(globalThis.localStorage?.getItem(draftKey) || "null");
      if (saved?.text && saved.text !== baseline) {
        restoreDraft = saved;
        zion?.state?.set?.(`sessions.collaborationDraft.${sessionId}`, saved);
        zion?.notification?.show?.("此会话有保留的本地草稿。", {
          type: "info", duration: 8000,
          actions: [{
            label: "恢复为新会话",
            handler: () => zion?.commands?.executeCommand?.("zion.sessions.restoreCollaborationDraft", sessionId)
          }]
        });
      }
    } catch {}
    const saveDraft = () => {
      const draft = { baseline, text: view.state.doc.toString(), savedAt: Date.now() };
      zion?.state?.set?.(`sessions.collaborationDraft.${sessionId}`, draft);
      try { globalThis.localStorage?.setItem(draftKey, JSON.stringify(draft)); } catch {}
    };
    const clearAcknowledgedDraft = () => {
      if (disposed || !bound || restoreDraft || view.state.doc.toString() !== record.text.toString()) return;
      try {
        const saved = JSON.parse(globalThis.localStorage?.getItem(draftKey) || "null");
        if (saved?.text !== record.text.toString()) return;
        globalThis.localStorage?.removeItem(draftKey);
        zion?.state?.set?.(`sessions.collaborationDraft.${sessionId}`, undefined);
      } catch {}
    };
    record.draftCleanups.add(clearAcknowledgedDraft);
    const draftCompartment = new Compartment();
    editor.addVisualExtension?.(draftCompartment.of(EditorView.updateListener.of((update) => {
      if (disposed || hydrating || !update.docChanged) return;
      if (update.transactions.some(tr =>
        tr.annotation(Transaction.userEvent) === "zion.sessionLoad"
        || tr.annotation(Transaction.userEvent) === "zion.sessionSeed"
        || tr.annotation(ySyncAnnotation) != null
      )) return;
      saveDraft();
    })));
    editor.addVisualExtension?.(EditorState.transactionFilter.of((transaction) => {
      if (!disposed && !bound && !hydrating && !pendingChanges.empty
        && transaction.docChanged
        && transaction.annotation(Transaction.userEvent) === "zion.sessionLoad") return [];
      return transaction;
    }));
    editor.addVisualExtension?.(EditorView.updateListener.of((update) => {
      if (disposed || bound || hydrating || !update.docChanged) return;
      if (update.transactions.some((tr) =>
        tr.annotation(Transaction.userEvent) === "zion.sessionLoad"
        || tr.annotation(Transaction.userEvent) === "zion.sessionSeed"
      )) {
        baseline = update.state.doc.toString();
        pendingChanges = ChangeSet.empty(update.state.doc.length);
        return;
      }
      pendingChanges = pendingChanges.compose(update.changes);
    }));
    const timeout = globalThis.setTimeout(() => {
      if (disposed || record.deleted) return;
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
      if (disposed || record.deleted) return;
      globalThis.clearTimeout(timeout);
      const remoteText = record.text.toString();
      const localText = String(editor.getValue?.() || "");
      const draftSignature = JSON.stringify([baseline, pendingChanges.toJSON()]);
      const alreadyApplied = record.appliedDrafts.has(draftSignature);
      const remoteEdits = [];
      let offset = 0;
      for (const part of diffChars(baseline, remoteText)) {
        if (part.added) remoteEdits.push({ from: offset, insert: part.value });
        else if (part.removed) {
          remoteEdits.push({ from: offset, to: offset + part.value.length });
          offset += part.value.length;
        } else offset += part.value.length;
      }
      const remoteChanges = ChangeSet.of(remoteEdits, baseline.length);
      let conflict = false;
      if (!alreadyApplied) pendingChanges.iterChangedRanges((from, to) => {
        remoteChanges.iterChangedRanges((remoteFrom, remoteTo) => {
          if (Math.max(from, remoteFrom) < Math.min(to, remoteTo)
            || (from === to && remoteFrom < from && from < remoteTo)
            || (remoteFrom === remoteTo && from < remoteFrom && remoteFrom < to)) {
            conflict = true;
          }
        });
      });
      if (conflict) {
        saveDraft();
        zion?.notification?.show?.("远端会话已修改，本地草稿已保留。可从命令面板恢复草稿为新会话。", {
          type: "warning", duration: 0, dismissible: true,
          actions: [{
            label: "恢复草稿为新会话",
            handler: () => zion?.commands?.executeCommand?.("zion.sessions.restoreCollaborationDraft", sessionId)
          }]
        });
        collaborationState(zion, sessionId, {
          synced: false,
          fallback: true,
          error: "远端会话已修改，本地草稿已保留。请重新打开会话后恢复草稿。",
          draftKey
        });
        return;
      }
      const replay = alreadyApplied ? ChangeSet.empty(remoteText.length) : pendingChanges.map(remoteChanges);
      if (!replay.empty) {
        record.document.transact(() => {
          // Apply backwards so offsets continue to refer to the server baseline.
          const edits = [];
          replay.iterChanges((from, to, _fromB, _toB, inserted) => {
            edits.push({ from, to, text: inserted.toString() });
          });
          for (const edit of edits.reverse()) {
            if (edit.to > edit.from) record.text.delete(edit.from, edit.to - edit.from);
            if (edit.text) record.text.insert(edit.from, edit.text);
          }
        }, { source: "local-draft", clientId });
        record.appliedDrafts.add(draftSignature);
      }
      hydrating = true;
      if (record.text.toString() !== localText) {
        editor.setValue?.(record.text.toString(), { source: "collaboration-hydration" });
      }
      hydrating = false;
      bound = true;
      delete view.dom.dataset.zionCollaborationPending;
      if (pendingChanges.empty && !restoreDraft) {
        try { globalThis.localStorage?.removeItem(draftKey); } catch {}
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
        fallback: false,
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
        if (!bound && !pendingChanges.empty) saveDraft();
        delete view.dom.dataset.zionCollaborationPending;
        try { delete view.dom.dataset.zionCollaborationBound; } catch {}
        globalThis.clearTimeout(timeout);
        try {
          view.dispatch({ effects: compartment.reconfigure([]) });
          view.dispatch({ effects: draftCompartment.reconfigure([]) });
        } catch {}
        cancelConversationViewportFollow(view);
        record.views.delete(view);
        record.draftCleanups.delete(clearAcknowledgedDraft);
        record.references -= 1;
        if (record.references <= 0) disposeRecord(sessionId);
      }
    };
  };

  return {
    enabled,
    bindEditor,
    async flush({ timeoutMs = 5000, sessionId = "" } = {}) {
      const started = Date.now();
      while ([...records.entries()].filter(([id]) => !sessionId || id === sessionId).some(([, record]) =>
        !record.ready || !record.connected || Number(record.provider.unsyncedChanges || 0) > 0
        || [...record.views].some(view => view.dom?.dataset?.zionCollaborationPending === "true")
      )) {
        if (Date.now() - started >= timeoutMs) return false;
        await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
      }
      return true;
    },
    isSynced(sessionId) {
      const state = zion?.state?.get?.(
        `sessions.collaboration.${String(sessionId || "")}`
      );
      const record = records.get(String(sessionId || ""));
      return state?.connected === true && state?.synced === true
        && ![...(record?.views || [])].some(view =>
          view.dom?.dataset?.zionCollaborationPending === "true"
        );
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
      pendingClearTimers.clear();
      pendingBySession.clear();
      tokenFollowRuns.clear();
      for (const sessionId of [...records.keys()]) disposeRecord(sessionId);
    }
  };
}
