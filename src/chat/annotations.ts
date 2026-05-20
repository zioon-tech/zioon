import { ChatCardRuntime, type ChatCardType } from "./card-runtime";

type Disposable = { dispose(): void };

type StateLike = {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
};

type EventsLike = {
  emit(topic: string, payload?: any): void;
  on?(topic: string, fn: (payload?: any) => void): Disposable;
};

type CommandsLike = {
  registerCommand(id: string, fn: (...args: any[]) => any): Disposable;
};

export type SessionAnnotations = Record<string, any> & {
  tools?: any[];
  thinking?: any[];
  deletedToolIds?: string[];
  deletedThinkingIds?: string[];
  toolActions?: Record<string, any>;
  writeHistory?: any[];
};

type PendingKind = string;

type RestoreSessionOptions = {
  sessionId: string | null | undefined;
  panelId?: string | null;
  annotations?: SessionAnnotations | null;
  clearFirst?: boolean;
};

type CreateChatAnnotationsApiOptions = {
  state: StateLike;
  events: EventsLike;
  commands: CommandsLike;
  getSessionMeta?: (sessionId: string) => any;
  getActivePanelId?: () => string | null;
};

function normalizeAnnotations(value: any): SessionAnnotations {
  return value && typeof value === "object" ? value : {};
}

function cloneArrayMaybe<T = any>(value: unknown): T[] | null {
  return Array.isArray(value) ? value.slice() as T[] : null;
}

export function createChatAnnotationsApi(opts: CreateChatAnnotationsApiOptions) {
  const disposables: Disposable[] = [];
  const reasoningSeq = new Map<string, number>();
  const activeThinkingByRun = new Map<string, string>();

  const debugLog = (_event: string, _payload?: any) => {};

  const getMetaAnnotations = (sessionId: string | null | undefined): SessionAnnotations | null => {
    if (!sessionId) return null;
    try {
      const meta = opts.getSessionMeta?.(sessionId);
      const ann = meta?.annotations;
      return ann && typeof ann === "object" ? ann : null;
    } catch {
      return null;
    }
  };

  const getStateAnnotations = (sessionId: string | null | undefined): SessionAnnotations | null => {
    if (!sessionId) return null;
    try {
      const ann = opts.state.get<SessionAnnotations>(`sessions.annotations.${sessionId}`);
      return ann && typeof ann === "object" ? ann : null;
    } catch {
      return null;
    }
  };

  const getPendingRestore = (sessionId: string | null | undefined, kind: PendingKind): any[] | null => {
    if (!sessionId) return null;
    try {
      return cloneArrayMaybe(opts.state.get(`sessions.pendingRestore.${kind}.${sessionId}`));
    } catch {
      return null;
    }
  };

  const getSessionAnnotations = (
    sessionId: string | null | undefined,
    opts2?: { includeMetaFallback?: boolean; includePending?: boolean }
  ): SessionAnnotations => {
    if (!sessionId) return {};
    const includeMetaFallback = opts2?.includeMetaFallback !== false;
    const includePending = opts2?.includePending !== false;
    const stateAnn = normalizeAnnotations(getStateAnnotations(sessionId));
    const metaAnn = includeMetaFallback ? normalizeAnnotations(getMetaAnnotations(sessionId)) : {};
    const tools = Array.isArray(stateAnn.tools)
      ? stateAnn.tools
      : (Array.isArray(metaAnn.tools)
        ? metaAnn.tools
        : (includePending ? (getPendingRestore(sessionId, "tools") || []) : []));
    const thinking = Array.isArray(stateAnn.thinking)
      ? stateAnn.thinking
      : (Array.isArray(metaAnn.thinking)
        ? metaAnn.thinking
        : (includePending ? (getPendingRestore(sessionId, "thinking") || []) : []));
    return {
      ...metaAnn,
      ...stateAnn,
      tools,
      thinking
    };
  };

  const setSessionAnnotations = (sessionId: string | null | undefined, annotations: SessionAnnotations | null | undefined) => {
    if (!sessionId) return {};
    const next = normalizeAnnotations(annotations);
    try { opts.state.set(`sessions.annotations.${sessionId}`, next); } catch {}
    return next;
  };

  const mergeSessionAnnotations = (sessionId: string | null | undefined, patch: SessionAnnotations | null | undefined) => {
    if (!sessionId) return {};
    const prev = getSessionAnnotations(sessionId);
    const next = { ...prev, ...normalizeAnnotations(patch) };
    setSessionAnnotations(sessionId, next);
    return next;
  };

  const updateSessionAnnotations = (
    sessionId: string | null | undefined,
    updater: (prev: SessionAnnotations) => SessionAnnotations | null | undefined
  ) => {
    if (!sessionId || typeof updater !== "function") return {};
    const prev = getSessionAnnotations(sessionId);
    const next = normalizeAnnotations(updater(prev));
    setSessionAnnotations(sessionId, next);
    return next;
  };

  const upsertAnnotationItem = (
    sessionId: string | null | undefined,
    key: "tools" | "thinking",
    item: Record<string, any>
  ) => {
    const id = item?.id ? String(item.id) : "";
    if (!sessionId || !id) return;
    updateSessionAnnotations(sessionId, (prev) => {
      const prevList = Array.isArray(prev[key]) ? prev[key] : [];
      const idx = prevList.findIndex((it) => String(it?.id || "") === id);
      const nextList = prevList.slice();
      if (idx >= 0) {
        nextList[idx] = { ...nextList[idx], ...item };
      } else {
        nextList.push(item);
      }
      return { ...prev, [key]: nextList };
    });
  };

  const updateAnnotationItem = (
    sessionId: string | null | undefined,
    key: "tools" | "thinking",
    id: string | null | undefined,
    patch: Record<string, any>
  ) => {
    const itemId = id ? String(id) : "";
    if (!sessionId || !itemId) return;
    updateSessionAnnotations(sessionId, (prev) => {
      const prevList = Array.isArray(prev[key]) ? prev[key] : [];
      const idx = prevList.findIndex((it) => String(it?.id || "") === itemId);
      if (idx < 0) {
        return { ...prev, [key]: [...prevList, { id: itemId, ...patch }] };
      }
      const nextList = prevList.slice();
      nextList[idx] = { ...nextList[idx], ...patch };
      return { ...prev, [key]: nextList };
    });
  };

  const setPendingRestore = (
    sessionId: string | null | undefined,
    kind: PendingKind,
    items: any[] | null | undefined
  ) => {
    if (!sessionId) return null;
    const next = cloneArrayMaybe(items);
    try { opts.state.set(`sessions.pendingRestore.${kind}.${sessionId}`, next); } catch {}
    debugLog("pending.set", {
      sessionId,
      kind,
      count: next?.length || 0,
      ids: Array.isArray(next) ? next.map((it: any) => it?.id).filter(Boolean).map(String) : []
    });
    return next;
  };

  const cardRuntime = new ChatCardRuntime({
    events: opts.events,
    getAnnotations: (sessionId) => getSessionAnnotations(sessionId),
    setPendingRestore
  });
  disposables.push(
    cardRuntime.registerType({
      kind: "tools",
      annotationKey: "tools",
      pendingKind: "tools",
      restoreEvent: "toolcards/restore",
      clearEvent: "toolcards/clear",
      snapshotEvent: "toolcards/snapshot"
    }),
    cardRuntime.registerType({
      kind: "thinking",
      annotationKey: "thinking",
      pendingKind: "thinking",
      restoreEvent: "thinking/restore",
      clearEvent: "thinking/clear",
      snapshotEvent: "thinking/snapshot"
    })
  );
  disposables.push(cardRuntime.attachSessionLifecycle());

  const clearPendingRestore = (sessionId: string | null | undefined, kind?: PendingKind) => {
    if (!sessionId) return;
    debugLog("pending.clear", { sessionId, kind: kind || "all" });
    if (!kind || kind === "tools") setPendingRestore(sessionId, "tools", null);
    if (!kind || kind === "thinking") setPendingRestore(sessionId, "thinking", null);
  };

  const restoreSession = (restoreOpts: RestoreSessionOptions) => {
    const sessionId = restoreOpts?.sessionId;
    if (!sessionId) return { annotations: null, tools: [], thinking: [] };
    const panelId = restoreOpts?.panelId ?? opts.getActivePanelId?.() ?? null;
    const annotations = normalizeAnnotations(restoreOpts?.annotations || getSessionAnnotations(sessionId));
    const tools = Array.isArray(annotations.tools) ? annotations.tools : [];
    const thinking = Array.isArray(annotations.thinking) ? annotations.thinking : [];
    setSessionAnnotations(sessionId, annotations);
    debugLog("restoreSession", {
      sessionId,
      panelId,
      clearFirst: restoreOpts?.clearFirst !== false,
      tools: tools.length,
      thinking: thinking.length
    });
    cardRuntime.restoreSession({ ...restoreOpts, sessionId, panelId, annotations });
    return { annotations, tools, thinking };
  };

  const auditPanels = (reason = "manual") => {
    const g = globalThis as any;
    const panelsApi = g.window?.zion?.panels || g.window?.zion?.panelManager || null;
    const panels = (() => {
      try {
        const list = panelsApi?.list?.();
        if (Array.isArray(list)) return list;
      } catch {}
      return [];
    })();
    const report = panels.map((panel: any) => {
      const panelId = String(panel?.id || "");
      const sessionId = panel?.activeTabId || null;
      const annotations = getSessionAnnotations(sessionId, { includeMetaFallback: true, includePending: true });
      const editor = (() => {
        try { return panelsApi?.getEditor?.(panelId) || null; } catch { return null; }
      })();
      const view = (() => {
        try { return editor?.getView?.() || null; } catch { return null; }
      })();
      const text = (() => {
        try { return String(editor?.getValue?.() || view?.state?.doc?.toString?.() || ""); } catch { return ""; }
      })();
      const dom = view?.dom || null;
      const toolAnnotationIds = Array.isArray(annotations.tools)
        ? annotations.tools.map((it: any) => String(it?.id || "")).filter(Boolean)
        : [];
      const thinkingAnnotationIds = Array.isArray(annotations.thinking)
        ? annotations.thinking.map((it: any) => String(it?.id || "")).filter(Boolean)
        : [];
      const pendingTools = getPendingRestore(sessionId, "tools") || [];
      const pendingThinking = getPendingRestore(sessionId, "thinking") || [];
      return {
        panelId,
        sessionId,
        docLength: text.length,
        toolTextCount: (text.match(/调用\s+[^\n]+/g) || []).length,
        thinkingTextCount: (text.match(/思考/g) || []).length,
        annotationTools: toolAnnotationIds.length,
        annotationThinking: thinkingAnnotationIds.length,
        pendingTools: pendingTools.length,
        pendingThinking: pendingThinking.length,
        toolDom: dom?.querySelectorAll?.(".zion-tool-call-inline,.zion-tool-call-card")?.length || 0,
        thinkingDom: dom?.querySelectorAll?.(".zion-thinking-inline,.zion-thinking-card")?.length || 0,
        toolAnnotationIds,
        thinkingAnnotationIds
      };
    });
    const result = { reason, panels: report };
    debugLog("panel.audit", result);
    return result;
  };

  const commandDisposables = [
    opts.commands.registerCommand("zion.chatCards.getSessionAnnotations", (sessionId: string, options?: any) => {
      return getSessionAnnotations(sessionId, options);
    }),
    opts.commands.registerCommand("zion.chatCards.setSessionAnnotations", ({ sessionId, annotations }: any) => {
      return setSessionAnnotations(sessionId, annotations);
    }),
    opts.commands.registerCommand("zion.chatCards.mergeSessionAnnotations", ({ sessionId, patch }: any) => {
      return mergeSessionAnnotations(sessionId, patch);
    }),
    opts.commands.registerCommand("zion.chatCards.updateSessionAnnotations", ({ sessionId, updater }: any) => {
      return updateSessionAnnotations(sessionId, updater);
    }),
    opts.commands.registerCommand("zion.chatCards.getPendingRestore", ({ sessionId, kind }: any) => {
      return getPendingRestore(sessionId, kind);
    }),
    opts.commands.registerCommand("zion.chatCards.setPendingRestore", ({ sessionId, kind, items }: any) => {
      return setPendingRestore(sessionId, kind, items);
    }),
    opts.commands.registerCommand("zion.chatCards.clearPendingRestore", ({ sessionId, kind }: any) => {
      return clearPendingRestore(sessionId, kind);
    }),
    opts.commands.registerCommand("zion.chatCards.restoreSession", (restoreOpts: RestoreSessionOptions) => {
      return restoreSession(restoreOpts);
    }),
    opts.commands.registerCommand("zion.chatCards.snapshotSession", ({ sessionId, panelId }: any) => {
      return cardRuntime.snapshotSession({ sessionId, panelId: panelId ?? opts.getActivePanelId?.() ?? null });
    }),
    opts.commands.registerCommand("zion.chatCards.registerType", (type: ChatCardType) => {
      const disp = cardRuntime.registerType(type);
      disposables.push(disp);
      return { ok: true };
    }),
    opts.commands.registerCommand("zion.chatCards.auditPanels", (reason?: string) => {
      return auditPanels(reason || "manual");
    }),
    opts.commands.registerCommand("zion.chatCards.debugSession", (sessionId: string) => {
      const annotations = getSessionAnnotations(sessionId);
      return {
        sessionId,
        annotations,
        counts: {
          tools: Array.isArray(annotations.tools) ? annotations.tools.length : 0,
          thinking: Array.isArray(annotations.thinking) ? annotations.thinking.length : 0,
          pendingTools: getPendingRestore(sessionId, "tools")?.length || 0,
          pendingThinking: getPendingRestore(sessionId, "thinking")?.length || 0
        },
        pending: {
          tools: getPendingRestore(sessionId, "tools"),
          thinking: getPendingRestore(sessionId, "thinking")
        }
      };
    })
  ];
  disposables.push(...commandDisposables);

  try {
    const g = globalThis as any;
    const win = g.window;
    if (win?.addEventListener) {
      const onVisibility = () => {
        if (!win.document?.hidden) setTimeout(() => auditPanels("visibility-visible"), 200);
      };
      const onFocus = () => setTimeout(() => auditPanels("window-focus"), 200);
      const onPageShow = () => setTimeout(() => auditPanels("pageshow"), 200);
      win.addEventListener("visibilitychange", onVisibility);
      win.addEventListener("focus", onFocus);
      win.addEventListener("pageshow", onPageShow);
      disposables.push({
        dispose() {
          try { win.removeEventListener("visibilitychange", onVisibility); } catch {}
          try { win.removeEventListener("focus", onFocus); } catch {}
          try { win.removeEventListener("pageshow", onPageShow); } catch {}
        }
      });
    }
  } catch {}

  const eventOn = typeof opts.events.on === "function" ? opts.events.on.bind(opts.events) : null;
  if (eventOn) {
    disposables.push(eventOn("chat/runStarted", (payload: any) => {
      const sessionId = payload?.sessionId;
      const runId = payload?.runId;
      if (!sessionId || !runId) return;
      reasoningSeq.set(`${sessionId}:${runId}`, 0);
      activeThinkingByRun.delete(`${sessionId}:${runId}`);
      debugLog("event.runStarted", { sessionId, runId, panelId: payload?.panelId });
    }));
    disposables.push(eventOn("chat/toolCall", (payload: any) => {
      const sessionId = payload?.sessionId;
      const tc = payload?.toolCall || payload;
      if (!sessionId || !tc?.id) return;
      upsertAnnotationItem(sessionId, "tools", {
        id: String(tc.id),
        name: tc.name || "tool",
        args: tc.args,
        result: null,
        ok: null,
        expanded: false
      });
      debugLog("event.toolCall", { sessionId, panelId: payload?.panelId, id: tc.id, name: tc.name || "tool" });
    }));
    disposables.push(eventOn("chat/toolResult", (payload: any) => {
      const sessionId = payload?.sessionId;
      const id = payload?.toolCallId || payload?.id;
      if (!sessionId || !id) return;
      updateAnnotationItem(sessionId, "tools", id, {
        result: payload?.result,
        ok: payload?.ok
      });
      debugLog("event.toolResult", { sessionId, panelId: payload?.panelId, id, ok: payload?.ok });
    }));
    disposables.push(eventOn("chat/reasoningStart", (payload: any) => {
      if (payload?.silentReasoning) return;
      if (!opts.state.get("chat.thinkingVisible")) return;
      const sessionId = payload?.sessionId;
      const runId = payload?.runId || "run";
      if (!sessionId) return;
      const key = `${sessionId}:${runId}`;
      const seq = (reasoningSeq.get(key) || 0) + 1;
      reasoningSeq.set(key, seq);
      const id = `thinking:${runId}:${seq}`;
      activeThinkingByRun.set(key, id);
      upsertAnnotationItem(sessionId, "thinking", {
        id,
        text: "",
        expanded: false
      });
      debugLog("event.reasoningStart", { sessionId, panelId: payload?.panelId, runId, id });
    }));
    disposables.push(eventOn("chat/reasoningToken", (payload: any) => {
      if (payload?.silentReasoning) return;
      if (!opts.state.get("chat.thinkingVisible")) return;
      const sessionId = payload?.sessionId;
      const runId = payload?.runId || "run";
      const token = String(payload?.token || "");
      if (!sessionId || !token) return;
      const key = `${sessionId}:${runId}`;
      let id = activeThinkingByRun.get(key);
      if (!id) {
        const seq = (reasoningSeq.get(key) || 0) + 1;
        reasoningSeq.set(key, seq);
        id = `thinking:${runId}:${seq}`;
        activeThinkingByRun.set(key, id);
      }
      updateSessionAnnotations(sessionId, (prev) => {
        const prevList = Array.isArray(prev.thinking) ? prev.thinking : [];
        const idx = prevList.findIndex((it) => String(it?.id || "") === id);
        const nextList = prevList.slice();
        if (idx >= 0) {
          const prevText = String(nextList[idx]?.text || "");
          nextList[idx] = { ...nextList[idx], text: prevText + token };
        } else {
          nextList.push({ id, text: token, expanded: false });
        }
        return { ...prev, thinking: nextList };
      });
      debugLog("event.reasoningToken", { sessionId, panelId: payload?.panelId, runId, id, tokenLength: token.length });
    }));
    disposables.push(eventOn("chat/reasoningEnd", (payload: any) => {
      const sessionId = payload?.sessionId;
      const runId = payload?.runId || "run";
      if (!sessionId) return;
      activeThinkingByRun.delete(`${sessionId}:${runId}`);
      debugLog("event.reasoningEnd", { sessionId, panelId: payload?.panelId, runId });
    }));
  }

  return {
    getSessionAnnotations,
    setSessionAnnotations,
    mergeSessionAnnotations,
    updateSessionAnnotations,
    getPendingRestore,
    setPendingRestore,
    clearPendingRestore,
    restoreSession,
    dispose() {
      for (const disp of disposables) {
        try { disp?.dispose?.(); } catch {}
      }
    }
  };
}
