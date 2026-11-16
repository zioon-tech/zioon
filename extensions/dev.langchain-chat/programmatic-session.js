import {
  registerLlmRequestPayload
} from "../../src/runtime/llm-request-observability.ts";

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

function startReasoningProjection(zion, sessionId, event, payload, emit) {
  const state = getProjectionState(zion);
  const key = reasoningKey(sessionId, event);
  const projected = reasoningPayload(payload, event);
  if (!state.activeReasoning.has(key)) {
    state.activeReasoning.set(key, projected);
    emit("chat/reasoningStart", projected);
  }
  return projected;
}

function emitReasoningBuffer(zion, key, emit) {
  const state = getProjectionState(zion);
  const buffered = state.reasoningBuffers.get(key);
  if (!buffered?.token) return false;
  emit("chat/reasoningToken", {
    ...buffered.payload,
    token: buffered.token,
    ...(buffered.payload.replay ? { reasoningText: buffered.fullText } : {})
  });
  buffered.token = "";
  buffered.lastEmittedAt = Date.now();
  return true;
}

function bufferReasoningProjection(zion, sessionId, event, payload, emit) {
  const state = getProjectionState(zion);
  const key = reasoningKey(sessionId, event);
  const projected = startReasoningProjection(
    zion,
    sessionId,
    event,
    payload,
    emit
  );
  const now = Date.now();
  const buffered = state.reasoningBuffers.get(key) || {
    payload: projected,
    token: "",
    fullText: "",
    lastEmittedAt: now
  };
  buffered.payload = projected;
  buffered.token += String(event.data?.delta || "");
  buffered.fullText += String(event.data?.delta || "");
  state.reasoningBuffers.set(key, buffered);
  if (
    // Runtime projection already batches deltas. Buffering again here can
    // strand a short chunk until another event arrives.
    payload.backend === "runtime"
    || buffered.token.length >= REASONING_BATCH_CHARS
    || now - buffered.lastEmittedAt >= REASONING_BATCH_INTERVAL_MS
  ) {
    emitReasoningBuffer(zion, key, emit);
  }
}

function finishReasoningProjection(zion, sessionId, event, dispatch, { emit = true } = {}) {
  const state = getProjectionState(zion);
  const key = reasoningKey(sessionId, event);
  emitReasoningBuffer(zion, key, dispatch);
  state.reasoningBuffers.delete(key);
  const projected = state.activeReasoning.get(key);
  if (!projected) return;
  state.activeReasoning.delete(key);
  if (emit) dispatch("chat/reasoningEnd", projected);
}

function flushRunReasoningBuffers(zion, sessionId, runId, emit) {
  const state = getProjectionState(zion);
  const prefix = `${sessionId}:${runId}:`;
  for (const key of state.reasoningBuffers.keys()) {
    if (key.startsWith(prefix)) emitReasoningBuffer(zion, key, emit);
  }
}

function finishRunReasoningProjections(zion, sessionId, runId, dispatch, { emit = true } = {}) {
  const state = getProjectionState(zion);
  const prefix = `${sessionId}:${runId}:`;
  for (const [key, projected] of state.activeReasoning.entries()) {
    if (!key.startsWith(prefix)) continue;
    emitReasoningBuffer(zion, key, dispatch);
    state.reasoningBuffers.delete(key);
    state.activeReasoning.delete(key);
    if (emit) dispatch("chat/reasoningEnd", projected);
  }
}

export async function projectRunEventToSession(
  zion,
  sessionId,
  event,
  options = {}
) {
  if (!sessionId || !event) return;
  let deliveries = Promise.resolve();
  const errors = [];
  const emit = (topic, value) => {
    if (typeof zion.events.emitAsync !== "function") return zion.events.emit(topic, value);
    deliveries = deliveries.then(() => zion.events.emitAsync(topic, value))
      .catch((error) => { errors.push(error); });
  };
  try {
  const requestSource = String(options.requestSource || "scheduled-task");
  const panelId = options.panelId || null;
  const assistantBlockId = options.assistantBlockId || event.runId;
  const assistantBlockReady = options.assistantBlockReady === true;
  const documentWriter = options.documentWriter !== false;
  const payload = {
    runId: event.runId,
    assistantBlockId,
    sessionId,
    panelId,
    requestSource,
    documentWriter,
    ...(options.documentProjectionMode ? { documentProjectionMode: options.documentProjectionMode } : {}),
    projectionSequence: Number(
      event.data?.projection?.sourceSequenceEnd
      ?? event.sequence
      ?? 0
    ),
    ...(options.replay ? { replay: true } : {}),
    ...(options.editorView ? { editorView: options.editorView } : {}),
    ...(options.followCycleId
      ? { followCycleId: String(options.followCycleId) }
      : {}),
    ...(Number.isFinite(Number(options.answerAnchorPos))
      ? { answerAnchorPos: Number(options.answerAnchorPos) }
      : {}),
    ...(options.backend ? { backend: String(options.backend) } : {}),
    ...(options.runtimeRunId ? { runtimeRunId: String(options.runtimeRunId) } : {})
  };
  if (event.type === "run.started" || event.type === "attempt.started" || event.type === "run.resumed") {
    if (options.resetProjection === true) {
      const state = getProjectionState(zion);
      const prefix = `${sessionId}:${event.runId}:`;
      for (const key of state.activeReasoning.keys()) {
        if (key.startsWith(prefix)) state.activeReasoning.delete(key);
      }
      for (const key of state.reasoningBuffers.keys()) {
        if (key.startsWith(prefix)) state.reasoningBuffers.delete(key);
      }
    }
    if (documentWriter && !assistantBlockReady) {
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
      error: false,
      waiting: null
    });
    emit("chat/runStarted", payload);
    return;
  }
  if (event.type === "message.delta") {
    flushRunReasoningBuffers(zion, sessionId, event.runId, emit);
    const token = String(event.data?.delta || "");
    const handled = typeof options.appendAssistantToken === "function"
      ? await options.appendAssistantToken(token, event) === true
      : false;
    if (!handled && documentWriter) {
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
    emit("chat/token", {
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
    startReasoningProjection(zion, sessionId, event, payload, emit);
    return;
  }
  if (event.type === "reasoning.delta") {
    bufferReasoningProjection(zion, sessionId, event, payload, emit);
    return;
  }
  if (event.type === "reasoning.completed") {
    finishReasoningProjection(zion, sessionId, event, emit);
    return;
  }
  if (event.type === "model.request") {
    let detailEvent = event;
    if (
      !event.data?.payload
      && event.data?.detailAvailable === true
      && Number(event.data?.rawEventSequence) > 0
      && typeof options.resolveEventDetail === "function"
    ) {
      try {
        const resolved = await options.resolveEventDetail(
          Number(event.data.rawEventSequence),
          event
        );
        if (resolved?.type === "model.request") detailEvent = resolved;
      } catch (error) {
        console.warn(
          "[langchain-chat] failed to load Runtime model request detail:",
          error
        );
      }
    }
    const detailData = detailEvent.data || {};
    const summaryOnly = Number(detailData.summaryVersion) === 1
      && !detailData.payload;
    const rawPayload = detailData.payload && typeof detailData.payload === "object"
      ? detailData.payload
      : summaryOnly
        ? {
            model: String(detailData.modelId || ""),
            ...(detailData.config && typeof detailData.config === "object"
              ? detailData.config
              : {}),
            _zionSummary: {
              messageCount: Number(detailData.messageCount || 0),
              toolCount: Number(detailData.toolCount || 0),
              payloadBytes: Number(detailData.payloadBytes || 0),
              payloadHash: String(detailData.payloadHash || ""),
              messagesHash: String(detailData.messagesHash || ""),
              toolsHash: String(detailData.toolsHash || "")
            }
          }
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
      stepIndex: Number(
        detailData.turn
        ?? detailData.stepIndex
        ?? event.data?.turn
        ?? event.data?.stepIndex
        ?? 0
      ) || undefined,
      providerId: String(
        detailData.providerId
        || detailData.model?.providerId
        || event.data?.providerId
        || event.data?.model?.providerId
        || ""
      ),
      providerType: String(
        detailData.providerType
        || event.data?.providerType
        || "openai"
      ),
      modelId: String(
        detailData.modelId
        || detailData.model?.modelId
        || event.data?.modelId
        || event.data?.model?.modelId
        || rawPayload.model
        || ""
      ),
      modelLabel: String(
        detailData.modelLabel
        || detailData.model?.label
        || event.data?.modelLabel
        || event.data?.model?.label
        || rawPayload.model
        || ""
      ),
      url: String(detailData.url || event.data?.url || ""),
      stream: (detailData.stream ?? event.data?.stream) !== false,
      messageCount: Array.isArray(rawPayload.messages)
        ? rawPayload.messages.length
        : Number(event.data?.messageCount || 0),
      toolCount: Array.isArray(rawPayload.tools)
        ? rawPayload.tools.length
        : Number(event.data?.toolCount || 0),
      ...(summaryOnly ? { summaryOnly: true } : {}),
      payload: rawPayload
    };
    registerLlmRequestPayload(zion, requestPayload);
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
    emit("chat/toolCall", {
      ...payload,
      toolCall: {
        id: event.data?.callId,
        name: event.data?.name,
        args: event.data?.args ?? event.data?.arguments ?? {},
        presentation: event.data?.presentation || null
      },
      presentation: event.data?.presentation || null
    });
    return;
  }
  if (event.type === "tool.completed" || event.type === "tool.denied") {
    emit("chat/toolResult", {
      ...payload,
      toolCallId: event.data?.callId,
      result: event.data?.result ?? event.data?.error ?? event.data?.reason ?? "",
      ok: event.type === "tool.completed" && event.data?.ok !== false && !event.data?.error,
      presentation: event.data?.presentation || null,
      artifactIds: Array.isArray(event.data?.artifactIds)
        ? event.data.artifactIds
        : []
    });
    return;
  }
  if (event.type === "run.waiting") {
    finishRunReasoningProjections(zion, sessionId, event.runId, emit);
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId, streaming: false, aborted: false,
      awaiting: true, error: false, waiting: event.data?.waiting || null
    });
    emit("chat/runWaiting", { ...payload, waiting: event.data?.waiting });
    return;
  }
  if (event.type === "run.completed") {
    finishRunReasoningProjections(zion, sessionId, event.runId, emit);
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: false,
      awaiting: true,
      error: false
    });
    emit("chat/runFinished", payload);
    return;
  }
  if (event.type === "run.failed") {
    finishRunReasoningProjections(zion, sessionId, event.runId, emit, { emit: false });
    const error = event.data?.error || options.defaultError || "Programmatic run failed";
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: false,
      awaiting: false,
      error: true
    });
    emit("chat/runError", { ...payload, error });
    emit("chat/runFinished", payload);
    return;
  }
  if (event.type === "run.aborted") {
    finishRunReasoningProjections(zion, sessionId, event.runId, emit, { emit: false });
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: true,
      awaiting: false,
      error: false
    });
    emit("chat/aborted", {
      ...payload,
      reason: event.data?.reason || "user"
    });
    emit("chat/runFinished", payload);
  }
  } finally {
    await deliveries;
    if (errors.length) throw errors[0];
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
