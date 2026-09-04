const projectionStateByZion = new WeakMap();
const REASONING_BATCH_CHARS = 256;
const REASONING_BATCH_INTERVAL_MS = 250;

function getProjectionState(zion) {
  let state = projectionStateByZion.get(zion);
  if (!state) {
    state = {
      activeReasoning: new Map(),
      reasoningBuffers: new Map()
    };
    projectionStateByZion.set(zion, state);
  }
  return state;
}

function reasoningPayload(payload, event) {
  const turn = Number(event.data?.turn ?? event.data?.stepIndex ?? 0);
  return {
    ...payload,
    stepIndex: turn || undefined,
    reasoningSegmentId: String(
      event.data?.reasoningSegmentId
      || (turn ? `${event.runId}:step:${turn}` : event.runId)
    )
  };
}

function reasoningKey(sessionId, event) {
  return `${sessionId}:${event.runId}:${reasoningPayload({}, event).reasoningSegmentId}`;
}

function startReasoningProjection(zion, sessionId, event, payload) {
  const state = getProjectionState(zion);
  const key = reasoningKey(sessionId, event);
  const projected = reasoningPayload(payload, event);
  if (!state.activeReasoning.has(key)) {
    state.activeReasoning.set(key, projected);
    zion.events.emit("chat/reasoningStart", projected);
  }
  return projected;
}

function emitReasoningBuffer(zion, key) {
  const state = getProjectionState(zion);
  const buffered = state.reasoningBuffers.get(key);
  if (!buffered?.token) return false;
  zion.events.emit("chat/reasoningToken", {
    ...buffered.payload,
    token: buffered.token
  });
  buffered.token = "";
  buffered.lastEmittedAt = Date.now();
  return true;
}

function bufferReasoningProjection(zion, sessionId, event, payload) {
  const state = getProjectionState(zion);
  const key = reasoningKey(sessionId, event);
  const projected = startReasoningProjection(
    zion,
    sessionId,
    event,
    payload
  );
  const now = Date.now();
  const buffered = state.reasoningBuffers.get(key) || {
    payload: projected,
    token: "",
    lastEmittedAt: now
  };
  buffered.payload = projected;
  buffered.token += String(event.data?.delta || "");
  state.reasoningBuffers.set(key, buffered);
  if (
    buffered.token.length >= REASONING_BATCH_CHARS
    || now - buffered.lastEmittedAt >= REASONING_BATCH_INTERVAL_MS
  ) {
    emitReasoningBuffer(zion, key);
  }
}

function finishReasoningProjection(zion, sessionId, event, { emit = true } = {}) {
  const state = getProjectionState(zion);
  const key = reasoningKey(sessionId, event);
  emitReasoningBuffer(zion, key);
  state.reasoningBuffers.delete(key);
  const projected = state.activeReasoning.get(key);
  if (!projected) return;
  state.activeReasoning.delete(key);
  if (emit) zion.events.emit("chat/reasoningEnd", projected);
}

function flushRunReasoningBuffers(zion, sessionId, runId) {
  const state = getProjectionState(zion);
  const prefix = `${sessionId}:${runId}:`;
  for (const key of state.reasoningBuffers.keys()) {
    if (key.startsWith(prefix)) emitReasoningBuffer(zion, key);
  }
}

function finishRunReasoningProjections(zion, sessionId, runId, { emit = true } = {}) {
  const state = getProjectionState(zion);
  const prefix = `${sessionId}:${runId}:`;
  for (const [key, projected] of state.activeReasoning.entries()) {
    if (!key.startsWith(prefix)) continue;
    emitReasoningBuffer(zion, key);
    state.reasoningBuffers.delete(key);
    state.activeReasoning.delete(key);
    if (emit) zion.events.emit("chat/reasoningEnd", projected);
  }
}

export async function projectRunEventToSession(
  zion,
  sessionId,
  event,
  options = {}
) {
  if (!sessionId || !event) return;
  const requestSource = String(options.requestSource || "scheduled-task");
  const panelId = options.panelId || null;
  const assistantBlockId = options.assistantBlockId || event.runId;
  const assistantBlockReady = options.assistantBlockReady === true;
  const payload = {
    runId: event.runId,
    assistantBlockId,
    sessionId,
    panelId,
    requestSource,
    documentWriter: options.documentWriter !== false,
    ...(Number.isFinite(Number(options.answerAnchorPos))
      ? { answerAnchorPos: Number(options.answerAnchorPos) }
      : {}),
    ...(options.backend ? { backend: String(options.backend) } : {}),
    ...(options.runtimeRunId ? { runtimeRunId: String(options.runtimeRunId) } : {})
  };
  if (event.type === "run.started") {
    if (!assistantBlockReady) {
      await zion.commands.executeCommand("zion.sessions.ensureAssistantBlock", {
        id: sessionId,
        assistantBlockId
      });
    }
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: true,
      aborted: false,
      awaiting: false,
      error: false
    });
    zion.events.emit("chat/runStarted", payload);
    return;
  }
  if (event.type === "message.delta") {
    flushRunReasoningBuffers(zion, sessionId, event.runId);
    const token = String(event.data?.delta || "");
    const handled = typeof options.appendAssistantToken === "function"
      ? await options.appendAssistantToken(token, event) === true
      : false;
    if (!handled) {
      if (assistantBlockReady) {
        await zion.commands.executeCommand("zion.sessions.ensureAssistantBlock", {
          id: sessionId,
          assistantBlockId
        });
      }
      await zion.commands.executeCommand("zion.sessions.appendAssistantToken", {
        id: sessionId,
        token,
        runId: event.runId,
        assistantBlockId
      });
    }
    zion.events.emit("chat/token", {
      ...payload,
      token
    });
    return;
  }
  if (event.type === "message.completed") {
    await options.completeAssistantMessage?.({
      ...payload,
      content: String(event.data?.content || "")
    }, event);
    return;
  }
  if (event.type === "reasoning.started") {
    startReasoningProjection(zion, sessionId, event, payload);
    return;
  }
  if (event.type === "reasoning.delta") {
    bufferReasoningProjection(zion, sessionId, event, payload);
    return;
  }
  if (event.type === "reasoning.completed") {
    finishReasoningProjection(zion, sessionId, event);
    return;
  }
  if (event.type === "model.request") {
    const rawPayload = event.data?.payload && typeof event.data.payload === "object"
      ? event.data.payload
      : {};
    const requestPayload = {
      id: String(
        event.eventId
        || `runtime_llm_${event.runId}_${event.sequence || event.data?.turn || 0}`
      ),
      timestamp: event.ts ?? event.timestamp ?? Date.now(),
      runId: event.runId,
      sessionId,
      panelId,
      source: requestSource,
      requestSource,
      stepIndex: Number(event.data?.turn ?? event.data?.stepIndex ?? 0) || undefined,
      providerId: String(
        event.data?.providerId
        || event.data?.model?.providerId
        || ""
      ),
      providerType: String(event.data?.providerType || "openai"),
      modelId: String(
        event.data?.modelId
        || event.data?.model?.modelId
        || rawPayload.model
        || ""
      ),
      modelLabel: String(
        event.data?.modelLabel
        || event.data?.model?.label
        || rawPayload.model
        || ""
      ),
      url: String(event.data?.url || ""),
      stream: event.data?.stream !== false,
      messageCount: Array.isArray(rawPayload.messages)
        ? rawPayload.messages.length
        : 0,
      toolCount: Array.isArray(rawPayload.tools) ? rawPayload.tools.length : 0,
      payload: rawPayload
    };
    zion.events.emit("llm/requestPayload", requestPayload);
    if (typeof zion.llmPayloads?.add === "function") {
      zion.llmPayloads.add(requestPayload);
    } else {
      const queue = zion.__llmPayloadQueue || (zion.__llmPayloadQueue = []);
      queue.push(requestPayload);
      while (queue.length > 80) queue.shift();
    }
    return;
  }
  if (event.type === "model.usage") {
    const model = event.data?.model || {};
    const usage = event.data?.usage || {};
    zion.usage?.record?.({
      id: event.eventId,
      ts: event.ts ?? event.timestamp,
      runId: event.runId,
      sessionId,
      panelId,
      providerId: model.providerId,
      providerType: model.providerType || model.providerId,
      modelId: model.modelId,
      modelName: model.modelName || model.modelId,
      label: model.label || model.modelName || model.modelId,
      stepIndex: Number(event.data?.turn ?? event.data?.stepIndex ?? 0) || undefined,
      usage
    });
    return;
  }
  if (event.type === "tool.requested") {
    zion.events.emit("chat/toolCall", {
      ...payload,
      toolCall: {
        id: event.data?.callId,
        name: event.data?.name,
        args: event.data?.args || {},
        presentation: event.data?.presentation || null
      },
      presentation: event.data?.presentation || null
    });
    return;
  }
  if (event.type === "tool.completed" || event.type === "tool.denied") {
    zion.events.emit("chat/toolResult", {
      ...payload,
      toolCallId: event.data?.callId,
      result: event.data?.result || event.data?.error || event.data?.reason || "",
      ok: event.type === "tool.completed" && !event.data?.error,
      presentation: event.data?.presentation || null,
      artifactIds: Array.isArray(event.data?.artifactIds)
        ? event.data.artifactIds
        : []
    });
    return;
  }
  if (event.type === "run.completed") {
    finishRunReasoningProjections(zion, sessionId, event.runId);
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: false,
      awaiting: true,
      error: false
    });
    zion.events.emit("chat/runFinished", payload);
    return;
  }
  if (event.type === "run.failed") {
    finishRunReasoningProjections(zion, sessionId, event.runId, { emit: false });
    const error = event.data?.error || options.defaultError || "Programmatic run failed";
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: false,
      awaiting: false,
      error: true
    });
    zion.events.emit("chat/runError", { ...payload, error });
    zion.events.emit("chat/runFinished", payload);
    return;
  }
  if (event.type === "run.aborted") {
    finishRunReasoningProjections(zion, sessionId, event.runId, { emit: false });
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: true,
      awaiting: false,
      error: false
    });
    zion.events.emit("chat/aborted", {
      ...payload,
      reason: event.data?.reason || "user"
    });
    zion.events.emit("chat/runFinished", payload);
  }
}

export async function finalizeProgrammaticSession(zion, sessionId, metaPatch = {}) {
  if (!sessionId) return;
  await zion.commands.executeCommand("zion.sessions.transformDoc", {
    id: sessionId,
    transform: (doc) => {
      const text = String(doc || "");
      if (/\nuser\s*$/.test(text)) return text;
      return `${text}${text.endsWith("\n") ? "" : "\n"}user `;
    }
  });
  await zion.commands.executeCommand("zion.sessions.patchMeta", {
    id: sessionId,
    patch: metaPatch
  });
  zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sessionId);
}
