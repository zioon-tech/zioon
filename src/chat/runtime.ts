type Disposable = { dispose(): void };

type StateLike = {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  onDidChange<T = unknown>(
    key: string,
    handler: (newVal: T | undefined, oldVal: T | undefined) => void
  ): Disposable;
};

type EventsLike = {
  emit(topic: string, payload?: any): void;
};

type AbortLike = {
  abort?: () => void;
};

type CreateChatRuntimeOptions = {
  state: StateLike;
  events: EventsLike;
  getSessionId: () => string | undefined;
};

export type ChatRunState = {
  runId?: string | null;
  streaming?: boolean;
  aborted?: boolean;
  awaiting?: boolean;
};

export function createChatRuntime(opts: CreateChatRuntimeOptions) {
  const runControllers = new Map<string, AbortLike>();

  const getRunState = (sid: string | undefined): ChatRunState | null => {
    if (!sid) return null;
    return opts.state.get<ChatRunState>(`chat.runs.${sid}`) || null;
  };

  const syncGlobalStreamingForActiveSession = () => {
    const sid = opts.getSessionId();
    const streaming = sid ? !!getRunState(sid)?.streaming : false;
    try { opts.state.set("chat.streaming", streaming); } catch {}
    return streaming;
  };

  const setRunState = (sid: string | undefined, patch: ChatRunState) => {
    if (!sid) return null;
    const cur = getRunState(sid) || {};
    opts.state.set(`chat.runs.${sid}`, { ...cur, ...patch });
    if (sid === opts.getSessionId()) syncGlobalStreamingForActiveSession();
    return opts.state.get(`chat.runs.${sid}`) || null;
  };

  const clearController = (sid: string | undefined) => {
    if (!sid) return;
    runControllers.delete(sid);
  };

  const setController = (sid: string | undefined, controller: AbortLike | null | undefined) => {
    if (!sid || !controller) return;
    if (getRunState(sid)?.aborted) {
      try { controller.abort?.(); } catch {}
      return;
    }
    runControllers.set(sid, controller);
  };

  const getController = (sid: string | undefined) => {
    if (!sid) return null;
    return runControllers.get(sid) || null;
  };

  const beginRun = (sid: string | undefined, runId: string) => {
    if (!sid) return;
    opts.state.set("chat.runId", runId);
    opts.state.set("chat.error", null);
    clearController(sid);
    setRunState(sid, { runId, streaming: true, aborted: false, awaiting: false });
  };

  const markAwaiting = (sid: string | undefined) => {
    if (!sid) return;
    setRunState(sid, { streaming: false, awaiting: true });
    clearController(sid);
  };

  const markAborted = (sid: string | undefined) => {
    if (!sid) return;
    setRunState(sid, { aborted: true, streaming: false });
    clearController(sid);
  };

  const markError = (sid: string | undefined, error: any) => {
    if (!sid) return;
    try { opts.state.set("chat.error", error?.message); } catch {}
    setRunState(sid, { aborted: true, streaming: false });
    clearController(sid);
  };

  const stopSession = (sid = opts.getSessionId()) => {
    if (!sid) return null;
    const rs = getRunState(sid);
    setRunState(sid, { streaming: false, aborted: true });
    const controller = getController(sid);
    try { controller?.abort?.(); } catch {}
    clearController(sid);
    opts.events.emit("chat/aborted", { runId: rs?.runId, sessionId: sid });
    return rs || null;
  };

  const sessionSub = opts.state.onDidChange("sessions.currentId", () => {
    syncGlobalStreamingForActiveSession();
  });

  syncGlobalStreamingForActiveSession();

  return {
    getRunState,
    setRunState,
    beginRun,
    markAwaiting,
    markAborted,
    markError,
    getController,
    setController,
    clearController,
    stopSession,
    syncGlobalStreamingForActiveSession,
    dispose() {
      try { sessionSub?.dispose?.(); } catch {}
      for (const c of runControllers.values()) {
        try { c?.abort?.(); } catch {}
      }
      runControllers.clear();
    }
  };
}
