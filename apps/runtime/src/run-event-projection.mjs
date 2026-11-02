const DELTA_EVENT_TYPES = new Set([
  "message.delta",
  "reasoning.delta"
]);

const REASONING_MODES = new Set([
  "stream",
  "summary",
  "none"
]);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : fallback;
}

function clamp(value, minimum, maximum, fallback) {
  return Math.max(
    minimum,
    Math.min(maximum, positiveInteger(value, fallback))
  );
}

function eventGroup(event) {
  return [
    event.type,
    Number(event.data?.turn ?? event.data?.stepIndex ?? 0) || 0,
    String(event.data?.reasoningSegmentId || "")
  ].join(":");
}

function projectionMetadata(first, last, count, characters) {
  return {
    sourceSequenceStart: Number(first.sequence) || 0,
    sourceSequenceEnd: Number(last.sequence) || 0,
    sourceEventCount: count,
    characterCount: characters
  };
}

function jsonSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function toolName(value) {
  const tool = value && typeof value === "object" ? value : {};
  const fn = tool.function && typeof tool.function === "object"
    ? tool.function
    : {};
  return String(fn.name || tool.name || "").trim();
}

function resultText(value) {
  if (typeof value === "string") return value;
  try {
    return value == null ? "" : JSON.stringify(value);
  } catch {
    return String(value || "");
  }
}

function projectedSemanticEvent(event) {
  const data = event?.data && typeof event.data === "object"
    ? event.data
    : {};
  if (event.type === "model.request") {
    if (!data.payload || typeof data.payload !== "object") return event;
    const payload = data.payload && typeof data.payload === "object"
      ? data.payload
      : {};
    const { payload: _payload, ...summary } = data;
    return {
      ...event,
      data: {
        ...summary,
        messageCount: Array.isArray(payload.messages)
          ? payload.messages.length
          : Number(data.messageCount || 0),
        toolCount: Array.isArray(payload.tools)
          ? payload.tools.length
          : Number(data.toolCount || 0),
        toolNames: Array.from(new Set(
          (Array.isArray(payload.tools) ? payload.tools : [])
            .map(toolName)
            .filter(Boolean)
        )),
        payloadBytes: jsonSize(payload),
        detailAvailable: true,
        rawEventSequence: event.sequence
      }
    };
  }
  if (event.type === "tool.requested") {
    const argumentsValue = data.arguments ?? data.args ?? {};
    if (jsonSize(argumentsValue) <= 16 * 1024) return event;
    const { arguments: _arguments, args: _args, ...summary } = data;
    return {
      ...event,
      data: {
        ...summary,
        argumentKeys: Object.keys(argumentsValue || {}).slice(0, 30),
        argumentsBytes: jsonSize(argumentsValue),
        detailAvailable: true,
        rawEventSequence: event.sequence
      }
    };
  }
  if (event.type === "tool.completed") {
    const value = data.result ?? data.content ?? "";
    const text = resultText(value);
    if (text.length <= 16 * 1024) return event;
    const { result: _result, content: _content, ...summary } = data;
    return {
      ...event,
      data: {
        ...summary,
        resultPreview: text.slice(0, 4_096),
        resultSize: text.length,
        resultTruncated: true,
        detailAvailable: true,
        rawEventSequence: event.sequence
      }
    };
  }
  return event;
}

function projectedDelta(pending) {
  const { first, last, delta, count, reasoningMode } = pending;
  const existing = last.data?.projection;
  const projection = existing
    && Number(existing.sourceSequenceStart) > 0
    && Number(existing.sourceSequenceEnd) > 0
    ? { ...existing }
    : projectionMetadata(first, last, count, delta.length);
  if (first.type === "reasoning.delta" && reasoningMode === "none") {
    return {
      ...last,
      eventId: `projection:${last.runId}:${first.sequence}-${last.sequence}`,
      type: "projection.cursor",
      data: {
        sourceType: "reasoning.delta",
        projection
      }
    };
  }
  if (first.type === "reasoning.delta" && reasoningMode === "summary") {
    return {
      ...last,
      eventId: `projection:${last.runId}:${first.sequence}-${last.sequence}`,
      type: "reasoning.progress",
      data: {
        turn: last.data?.turn,
        reasoningSegmentId: last.data?.reasoningSegmentId,
        projection
      }
    };
  }
  return {
    ...last,
    eventId: `projection:${last.runId}:${first.sequence}-${last.sequence}`,
    data: {
      ...(last.data || {}),
      delta,
      projection
    }
  };
}

export function normalizeRunProjectionOptions(input = {}) {
  const reasoningMode = REASONING_MODES.has(String(input.reasoningMode || ""))
    ? String(input.reasoningMode)
    : "stream";
  return {
    reasoningMode,
    maxDelayMs: clamp(input.maxDelayMs, 50, 2_000, 200),
    maxChunkChars: clamp(input.maxChunkChars, 64, 16_384, 1_024)
  };
}

export function createRunEventProjector(input = {}) {
  const options = normalizeRunProjectionOptions(input);
  let pending = null;

  const flush = () => {
    if (!pending) return [];
    const event = projectedDelta(pending);
    pending = null;
    return [event];
  };

  const push = (event, now = Date.now()) => {
    if (!event || typeof event !== "object") return [];
    if (!DELTA_EVENT_TYPES.has(event.type)) {
      return [...flush(), projectedSemanticEvent(event)];
    }
    const delta = String(event.data?.delta || "");
    if (!delta) {
      return [...flush(), event];
    }
    const group = eventGroup(event);
    const emitted = [];
    if (pending && pending.group !== group) emitted.push(...flush());
    if (!pending) {
      pending = {
        first: event,
        last: event,
        group,
        delta: "",
        count: 0,
        startedAt: now,
        reasoningMode: options.reasoningMode
      };
    }
    pending.last = event;
    pending.delta += delta;
    pending.count += 1;
    if (
      pending.delta.length >= options.maxChunkChars
      || now - pending.startedAt >= options.maxDelayMs
    ) {
      emitted.push(...flush());
    }
    return emitted;
  };

  return {
    options,
    push,
    flush,
    flushDue(now = Date.now()) {
      if (!pending || now - pending.startedAt < options.maxDelayMs) return [];
      return flush();
    },
    get pendingSequence() {
      return Number(pending?.last?.sequence || 0);
    }
  };
}

export function projectRunEvents(events, options = {}) {
  const projector = createRunEventProjector(options);
  const projected = [];
  for (const event of Array.isArray(events) ? events : []) {
    projected.push(...projector.push(event, 0));
  }
  projected.push(...projector.flush());
  return projected;
}
