type ZionLlmRequestHost = {
  events?: {
    emit?: (topic: string, payload: Record<string, unknown>) => void;
  };
  llmPayloads?: {
    add?: (payload: Record<string, unknown>) => unknown;
  };
  __llmPayloadQueue?: Array<Record<string, unknown>>;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(
        value.map((item) => String(item || "").trim()).filter(Boolean)
      ))
    : [];
}

function summaryTools(toolNames: string[]): Array<Record<string, unknown>> | undefined {
  return toolNames.length
    ? toolNames.map((name) => ({
        type: "function",
        function: {
          name,
          description: ""
        }
      }))
    : undefined;
}

export function registerLlmRequestPayload(
  zion: ZionLlmRequestHost | null | undefined,
  payload: Record<string, unknown>
) {
  if (!zion || !payload || typeof payload !== "object") return null;
  zion.events?.emit?.("llm/requestPayload", payload);
  if (typeof zion.llmPayloads?.add === "function") {
    zion.llmPayloads.add(payload);
  } else {
    const queue = zion.__llmPayloadQueue || (zion.__llmPayloadQueue = []);
    queue.push(payload);
    while (queue.length > 80) queue.shift();
  }
  return payload;
}

export function preferDetailedLlmRequestRecord<
  T extends { summaryOnly?: boolean }
>(existing: T | null | undefined, incoming: T): T {
  if (existing && existing.summaryOnly !== true && incoming.summaryOnly === true) {
    return {
      ...incoming,
      ...existing
    };
  }
  return incoming;
}

export function llmRequestPayloadFromWorkbenchEvent(event: unknown) {
  const workbenchEvent = objectValue(event);
  if (workbenchEvent.type !== "llm.request") return null;
  const data = objectValue(workbenchEvent.data);
  const persistedPayload = objectValue(data.payload);
  const summaryOnly = Number(data.summaryVersion) === 1 && !data.payload;
  const toolNames = stringList(data.toolNames);
  const payload = summaryOnly
    ? {
        model: String(data.modelId || ""),
        ...objectValue(data.config),
        ...(toolNames.length ? { tools: summaryTools(toolNames) } : {}),
        _zionSummary: {
          messageCount: Number(data.messageCount || 0),
          toolCount: Number(data.toolCount || 0),
          toolNames,
          payloadBytes: Number(data.payloadBytes || 0),
          payloadHash: String(data.payloadHash || ""),
          messagesHash: String(data.messagesHash || ""),
          toolsHash: String(data.toolsHash || "")
        }
      }
    : persistedPayload;
  return {
    id: String(
      data.id
      || `runtime_llm_${workbenchEvent.sequence || Date.now()}`
    ),
    timestamp: Number(
      data.timestamp
      || workbenchEvent.createdAt
      || Date.now()
    ),
    runId: String(
      workbenchEvent.runId
      || data.parentRunId
      || ""
    ),
    sessionId: String(workbenchEvent.sessionId || ""),
    panelId: String(data.panelId || ""),
    source: String(data.source || data.requestSource || "runtime"),
    requestSource: String(data.requestSource || data.source || "runtime"),
    stepIndex: Number(data.stepIndex) || undefined,
    providerId: String(data.providerId || ""),
    providerType: String(data.providerType || ""),
    modelId: String(data.modelId || payload.model || ""),
    modelLabel: String(data.modelLabel || data.modelId || payload.model || ""),
    url: String(data.url || ""),
    stream: data.stream !== false,
    messageCount: Number(data.messageCount || 0),
    toolCount: Number(data.toolCount || 0),
    ...(summaryOnly ? { summaryOnly: true } : {}),
    payload
  };
}

export async function hydrateLlmRequestWorkbenchEvent(
  event: unknown,
  resolveDetail: (
    runId: string,
    sequence: number
  ) => Promise<unknown>
) {
  const workbenchEvent = objectValue(event);
  const data = objectValue(workbenchEvent.data);
  if (
    workbenchEvent.type !== "llm.request"
    || data.payload
    || data.detailAvailable !== true
    || !String(data.rawRunId || "")
    || !(Number(data.rawEventSequence) > 0)
  ) {
    return workbenchEvent;
  }
  const resolved = objectValue(await resolveDetail(
    String(data.rawRunId),
    Number(data.rawEventSequence)
  ));
  const detailEvent = objectValue(resolved.event || resolved);
  const detailData = objectValue(detailEvent.data);
  if (detailEvent.type !== "model.request" || !detailData.payload) {
    return workbenchEvent;
  }
  return {
    ...workbenchEvent,
    data: {
      ...detailData,
      ...data,
      payload: detailData.payload
    }
  };
}
