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
  dispose?: () => void;
  abortOnDispose?: boolean;
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
  error?: boolean;
  waiting?: { id: string; reason: string; [key: string]: unknown } | null;
  model?: {
    providerId: string;
    modelId: string;
    label?: string;
  } | null;
};

export function createChatRuntime(opts: CreateChatRuntimeOptions) {
  const runControllers = new Map<string, { runId: string | null; controller: AbortLike }>();

  const getRunState = (sid: string | undefined): ChatRunState | null => {
    if (!sid) return null;
    return opts.state.get<ChatRunState>(`chat.runs.${sid}`) || null;
  };

  const isCurrentRun = (sid: string | undefined, runId: string | null | undefined) => {
    if (!sid || !runId) return false;
    return String(getRunState(sid)?.runId || "") === String(runId);
  };

  const isRunActive = (sid: string | undefined, runId: string | null | undefined) => {
    if (!isCurrentRun(sid, runId)) return false;
    const state = getRunState(sid);
    return !!state?.streaming && !state?.aborted && !state?.error;
  };

  const syncGlobalStreamingForActiveSession = () => {
    const sid = opts.getSessionId();
    const streaming = sid ? !!getRunState(sid)?.streaming : false;
    try { opts.state.set("chat.streaming", streaming); } catch {}
    return streaming;
  };

  const setRunState = (
    sid: string | undefined,
    patch: ChatRunState,
    expectedRunId?: string | null
  ) => {
    if (!sid) return null;
    const cur = getRunState(sid) || {};
    if (expectedRunId && String(cur.runId || "") !== String(expectedRunId)) return null;
    opts.state.set(`chat.runs.${sid}`, { ...cur, ...patch });
    syncGlobalStreamingForActiveSession();
    return opts.state.get(`chat.runs.${sid}`) || null;
  };

  const clearController = (sid: string | undefined, expectedRunId?: string | null) => {
    if (!sid) return false;
    const entry = runControllers.get(sid);
    if (!entry) return false;
    if (expectedRunId && entry.runId !== String(expectedRunId)) return false;
    runControllers.delete(sid);
    return true;
  };

  const setController = (
    sid: string | undefined,
    controller: AbortLike | null | undefined,
    runId?: string | null
  ) => {
    if (!sid || !controller) return false;
    const state = getRunState(sid);
    const ownerRunId = String(runId || state?.runId || "");
    if (!ownerRunId || !isCurrentRun(sid, ownerRunId) || state?.aborted || !state?.streaming) {
      try { controller.abort?.(); } catch {}
      return false;
    }
    runControllers.set(sid, { runId: ownerRunId, controller });
    return true;
  };

  const getController = (sid: string | undefined) => {
    if (!sid) return null;
    return runControllers.get(sid)?.controller || null;
  };

  const beginRun = (sid: string | undefined, runId: string) => {
    if (!sid) return;
    const previous = runControllers.get(sid);
    if (previous && previous.runId !== String(runId)) {
      try { previous.controller.abort?.(); } catch {}
    }
    opts.state.set("chat.runId", runId);
    opts.state.set("chat.error", null);
    clearController(sid);
    setRunState(sid, { runId, streaming: true, aborted: false, awaiting: false, error: false, waiting: null });
  };

  const markAwaiting = (sid: string | undefined, runId?: string | null) => {
    if (!sid) return false;
    const expectedRunId = runId || getRunState(sid)?.runId || null;
    if (!expectedRunId || !isCurrentRun(sid, expectedRunId)) return false;
    setRunState(sid, { streaming: false, awaiting: true, error: false, waiting: null }, expectedRunId);
    clearController(sid, expectedRunId);
    return true;
  };

  const markWaiting = (sid: string, runId: string, waiting: ChatRunState["waiting"]) => {
    if (!isCurrentRun(sid, runId)) return false;
    setRunState(sid, { streaming: false, awaiting: true, error: false, waiting }, runId);
    return true;
  };

  const markAborted = (sid: string | undefined, runId?: string | null) => {
    if (!sid) return false;
    const expectedRunId = runId || getRunState(sid)?.runId || null;
    if (!expectedRunId || !isCurrentRun(sid, expectedRunId)) return false;
    const current = getRunState(sid);
    if (current?.aborted && !current.streaming) {
      clearController(sid, expectedRunId);
      return true;
    }
    setRunState(
      sid,
      { aborted: true, streaming: false, awaiting: true, error: false, waiting: null },
      expectedRunId
    );
    clearController(sid, expectedRunId);
    opts.events.emit("chat/aborted", { runId: expectedRunId, sessionId: sid });
    return true;
  };

  const markError = (sid: string | undefined, error: any, runId?: string | null) => {
    if (!sid) return false;
    const expectedRunId = runId || getRunState(sid)?.runId || null;
    if (!expectedRunId || !isCurrentRun(sid, expectedRunId)) return false;
    try { opts.state.set("chat.error", error?.message); } catch {}
    setRunState(
      sid,
      { aborted: false, streaming: false, awaiting: true, error: true },
      expectedRunId
    );
    clearController(sid, expectedRunId);
    return true;
  };

  const stopSession = (sid = opts.getSessionId()) => {
    if (!sid) return null;
    const rs = getRunState(sid);
    const runId = rs?.runId ? String(rs.runId) : null;
    const entry = runControllers.get(sid);
    if (!runId || entry?.runId === runId) {
      try { entry?.controller?.abort?.(); } catch {}
    }
    if (runId) {
      markAborted(sid, runId);
    } else {
      setRunState(sid, { streaming: false, aborted: true, awaiting: true, error: false });
      clearController(sid);
      opts.events.emit("chat/aborted", { runId: null, sessionId: sid });
    }
    return rs || null;
  };

  const sessionSub = opts.state.onDidChange("sessions.currentId", () => {
    syncGlobalStreamingForActiveSession();
  });

  syncGlobalStreamingForActiveSession();

  return {
    getRunState,
    isCurrentRun,
    isRunActive,
    setRunState,
    beginRun,
    markAwaiting,
    markWaiting,
    markAborted,
    markError,
    getController,
    setController,
    clearController,
    stopSession,
    syncGlobalStreamingForActiveSession,
    dispose() {
      try { sessionSub?.dispose?.(); } catch {}
      for (const entry of runControllers.values()) {
        try {
          if (entry.controller?.abortOnDispose === false) {
            entry.controller?.dispose?.();
          } else {
            entry.controller?.abort?.();
          }
        } catch {}
      }
      runControllers.clear();
    }
  };
}
