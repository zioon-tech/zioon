import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type SpanContext
} from "@opentelemetry/api";

// GenAI conventions are Development. Keep the mapping in this module and
// never pass RunEvent.data, exceptions, URLs or content into the OTel API.
export const runtimeTracer = trace.getTracer("@zion/runtime", "0.1.0");
export const MODEL_CONSUMER_WAIT_ATTRIBUTE = "zion.model.consumer_wait.duration";

export function telemetryIdentifier(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(value)
    ? value
    : "unknown";
}

export function failSpan(span: Span, type: string): void {
  span.setAttribute("error.type", type);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

export function cancellationType(reason?: string): string {
  return reason === "timeout" ? "timeout" : "cancelled";
}

export function storedAttemptContext(
  metadata: Record<string, unknown> | undefined,
  attemptId: string | undefined
): SpanContext | undefined {
  const saved = metadata?.zionTelemetry as Record<string, unknown> | undefined;
  if (!saved || saved.version !== 1 || saved.attemptId !== attemptId) return;
  const candidate: SpanContext = {
    traceId: typeof saved.traceId === "string" ? saved.traceId : "",
    spanId: typeof saved.spanId === "string" ? saved.spanId : "",
    traceFlags: saved.traceFlags === 1 ? 1 : 0
  };
  return isSpanContextValid(candidate) ? candidate : undefined;
}

export function startAttempt(attributes: Attributes, previous?: SpanContext): Span {
  const initiator = trace.getSpanContext(context.active());
  const links = [initiator, previous]
    .filter((value): value is SpanContext => !!value && isSpanContextValid(value))
    .map((value) => ({ context: value }));
  return runtimeTracer.startSpan("invoke_agent", {
    attributes: { "gen_ai.operation.name": "invoke_agent", ...attributes },
    links
  }, ROOT_CONTEXT);
}

export function attemptMetadata(span: Span, attemptId: string): Record<string, unknown> {
  const value = span.spanContext();
  return isSpanContextValid(value) ? {
    zionTelemetry: {
      version: 1,
      attemptId,
      traceId: value.traceId,
      spanId: value.spanId,
      traceFlags: value.traceFlags
    }
  } : {};
}

export function recordModelUsage(span: Span, usage: Record<string, unknown>): void {
  const mapping = {
    inputTokens: "gen_ai.usage.input_tokens",
    outputTokens: "gen_ai.usage.output_tokens",
    reasoningTokens: "gen_ai.usage.reasoning.output_tokens",
    cacheReadTokens: "gen_ai.usage.cache_read.input_tokens",
    cacheWriteTokens: "gen_ai.usage.cache_write.input_tokens"
  };
  for (const [key, attribute] of Object.entries(mapping)) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      span.setAttribute(attribute, Math.floor(value));
    }
  }
}

export function recordModelResponse(span: Span, model: unknown, finishReason: unknown): void {
  if (model) span.setAttribute("gen_ai.response.model", telemetryIdentifier(model));
  if (finishReason) {
    const reason = String(finishReason);
    span.setAttribute("gen_ai.response.finish_reasons", [
      ["stop", "tool_calls", "function_call", "length", "max_tokens", "content_filter"]
        .includes(reason) ? reason : "other"
    ]);
  }
}
