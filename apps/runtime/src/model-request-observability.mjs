import { createHash } from "node:crypto";

const MODEL_REQUEST_CONFIG_KEYS = [
  "frequency_penalty",
  "max_completion_tokens",
  "max_tokens",
  "model",
  "presence_penalty",
  "reasoning_effort",
  "seed",
  "stop",
  "stream",
  "temperature",
  "thinking",
  "top_p"
];

function objectValue(value) {
  return value && typeof value === "object" ? value : {};
}

function encoded(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "null";
  }
}

function hash(value) {
  return createHash("sha256").update(encoded(value)).digest("hex");
}

function stringList(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(String).map((item) => item.trim()).filter(Boolean)))
    : [];
}

function toolName(value) {
  const tool = objectValue(value);
  const fn = objectValue(tool.function);
  return String(fn.name || tool.name || "").trim();
}

function requestSummary(request) {
  const observed = objectValue(request);
  if (Number(observed.summaryVersion) === 1) {
    return {
      summaryVersion: 1,
      messageCount: Number(observed.messageCount || 0),
      toolCount: Number(observed.toolCount || 0),
      toolNames: stringList(observed.toolNames),
      payloadBytes: Number(observed.payloadBytes || 0),
      payloadHash: String(observed.payloadHash || ""),
      messagesHash: String(observed.messagesHash || ""),
      toolsHash: String(observed.toolsHash || ""),
      config: objectValue(observed.config)
    };
  }
  const payload = objectValue(observed.payload);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const toolNames = Array.from(new Set(tools.map(toolName).filter(Boolean)));
  return {
    summaryVersion: 1,
    messageCount: messages.length,
    toolCount: tools.length,
    toolNames,
    payloadBytes: Buffer.byteLength(encoded(payload), "utf8"),
    payloadHash: hash(payload),
    messagesHash: hash(messages),
    toolsHash: hash(tools),
    config: Object.fromEntries(MODEL_REQUEST_CONFIG_KEYS
      .filter((key) => payload[key] !== undefined)
      .map((key) => [key, payload[key]]))
  };
}

export function createModelRequestPublisher({
  eventStore,
  eventType = "llm.request"
} = {}) {
  if (!eventStore?.appendEvent) {
    throw new Error("Model request publisher requires an event store");
  }
  return async ({
    request = {},
    requestContext = {},
    model = null,
    observationId = "",
    detailReference = null,
    timestamp = Date.now()
  } = {}) => {
    const observedRequest = objectValue(request);
    const context = objectValue(requestContext);
    const resolvedModel = objectValue(model);
    const summary = requestSummary(observedRequest);
    const source = String(context.source || "runtime");
    const runId = String(
      context.parentRunId || context.runId || ""
    );
    const rawRunId = String(
      detailReference?.runId
      || observedRequest.rawRunId
      || ""
    );
    const rawEventSequence = Number(
      detailReference?.sequence
      || observedRequest.rawEventSequence
      || 0
    );
    return eventStore.appendEvent(eventType, {
      sessionId: String(context.sessionId || ""),
      runId,
      timestamp,
      payload: {
        id: String(observationId || observedRequest.observationId || ""),
        source,
        requestSource: source,
        pluginId: String(context.pluginId || ""),
        operation: String(context.operation || ""),
        parentRunId: runId,
        panelId: String(context.panelId || ""),
        stepIndex: Number(
          context.stepIndex ?? observedRequest.turn ?? 0
        ) || null,
        providerId: String(
          observedRequest.providerId || resolvedModel.providerId || ""
        ),
        providerType: String(observedRequest.providerType || ""),
        modelId: String(
          observedRequest.modelId
          || resolvedModel.modelId
          || summary.config.model
          || ""
        ),
        modelLabel: String(
          observedRequest.modelLabel
          || resolvedModel.label
          || observedRequest.modelId
          || summary.config.model
          || ""
        ),
        url: String(observedRequest.url || ""),
        stream: observedRequest.stream !== false,
        ...summary,
        ...(rawRunId && rawEventSequence > 0 ? {
          detailAvailable: true,
          rawRunId,
          rawEventSequence
        } : {})
      }
    });
  };
}

export function observeRunModelRequests({
  runStore,
  publish,
  onError = null
} = {}) {
  if (!runStore?.subscribeEvents || !runStore?.get) {
    throw new Error("Run model observation requires a subscribable Run store");
  }
  if (typeof publish !== "function") {
    throw new Error("Run model observation requires a publisher");
  }
  return runStore.subscribeEvents((event) => {
    if (event?.type !== "model.request") return;
    return Promise.resolve(runStore.get(event.runId))
      .then((run) => publish({
        request: event.data,
        requestContext: {
          source: String(
            run?.metadata?.requestSource
            || run?.metadata?.source
            || "runtime-run"
          ),
          sessionId: run?.sessionId || "",
          runId: event.runId,
          panelId: run?.metadata?.panelId || "",
          stepIndex: event.data?.turn
        },
        model: event.data?.model || run?.model || null,
        observationId: event.eventId,
        ...(event.data?.detailAvailable === true ? {
          detailReference: {
            runId: event.data.rawRunId || event.runId,
            sequence: event.data.rawEventSequence || event.sequence
          }
        } : {}),
        timestamp: event.timestamp
      }))
      .catch((error) => {
        try {
          onError?.(error, event);
        } catch {
          // Model request observation must not affect the underlying Run.
        }
      });
  });
}
