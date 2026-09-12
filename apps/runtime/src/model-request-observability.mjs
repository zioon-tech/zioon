function objectValue(value) {
  return value && typeof value === "object" ? value : {};
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
    const payload = objectValue(observedRequest.payload);
    const detail = objectValue(detailReference);
    const hasDetailReference = String(detail.runId || "")
      && Number(detail.sequence) > 0;
    const source = String(context.source || "runtime");
    const runId = String(
      context.parentRunId || context.runId || ""
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
          || payload.model
          || ""
        ),
        modelLabel: String(
          observedRequest.modelLabel
          || resolvedModel.label
          || observedRequest.modelId
          || payload.model
          || ""
        ),
        url: String(observedRequest.url || ""),
        stream: observedRequest.stream !== false,
        messageCount: Array.isArray(payload.messages)
          ? payload.messages.length
          : 0,
        toolCount: Array.isArray(payload.tools)
          ? payload.tools.length
          : 0,
        ...(hasDetailReference
          ? {
              detailAvailable: true,
              rawRunId: String(detail.runId),
              rawEventSequence: Number(detail.sequence)
            }
          : { payload })
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
        detailReference: {
          runId: event.runId,
          sequence: event.sequence
        },
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
