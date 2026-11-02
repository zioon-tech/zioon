import { resourceFromAttributes } from "@opentelemetry/resources";

// This policy is intentionally independent of SDK environment configuration.
// Only our domain instrumentation is exported; third-party spans are dropped.
const STRING_KEYS = new Set([
  "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model",
  "gen_ai.response.model", "gen_ai.tool.name", "gen_ai.tool.call.id",
  "zion.run.id", "zion.attempt.id", "zion.policy.preset", "zion.run.status",
  "zion.cancellation.reason", "zion.tool.host_kind", "error.type",
  "zion.tool.denial"
]);
const NUMBER_KEYS = new Set([
  "zion.turn.number", "zion.checkpoint.sequence", "http.response.status_code",
  "zion.model.credential.duration", "zion.model.consumer_wait.duration",
  "gen_ai.response.time_to_first_chunk",
  "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens",
  "gen_ai.usage.reasoning.output_tokens", "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_write.input_tokens", "zion.tool.artifact_count",
  "zion.tool.change_count"
]);
const BOOLEAN_KEYS = new Set([
  "gen_ai.request.stream", "zion.tool.receipt_hit", "zion.tool.ok"
]);
const SPAN_NAMES = new Set(["invoke_agent", "chat", "execute_tool"]);
const EVENT_NAMES = new Set(["checkpoint.created", "tool.denied"]);
const RESOURCE_KEYS = new Set([
  "service.name", "service.version", "service.instance.id", "deployment.environment.name"
]);

function identifier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(value);
}

export function allowedAttributes(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (STRING_KEYS.has(key) && identifier(value)) output[key] = value;
    if (NUMBER_KEYS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      output[key] = value;
    }
    if (BOOLEAN_KEYS.has(key) && typeof value === "boolean") output[key] = value;
    if (key === "gen_ai.response.finish_reasons" && Array.isArray(value)) {
      output[key] = value.slice(0, 4).filter((reason) =>
        ["stop", "tool_calls", "function_call", "length", "max_tokens", "content_filter", "other"]
          .includes(reason));
    }
  }
  return output;
}

function cleanContext(value) {
  return { traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags };
}

export function sanitizeSpan(span) {
  if (span.instrumentationScope.name !== "@zion/runtime" || !SPAN_NAMES.has(span.name)) return null;
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => cleanContext(span.spanContext()),
    parentSpanContext: span.parentSpanContext ? cleanContext(span.parentSpanContext) : undefined,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    attributes: allowedAttributes(span.attributes),
    status: { code: span.status.code },
    events: span.events.filter((event) => EVENT_NAMES.has(event.name)).slice(0, 32)
      .map((event) => ({ name: event.name, time: event.time, attributes: allowedAttributes(event.attributes) })),
    links: span.links.slice(0, 2).map((link) => ({
      context: cleanContext(link.context), attributes: {}
    })),
    resource: resourceFromAttributes(Object.fromEntries(
      Object.entries(span.resource.attributes).filter(([key, value]) =>
        RESOURCE_KEYS.has(key) && typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value))
    )),
    instrumentationScope: { name: "@zion/runtime", version: "0.1.0" },
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount
  };
}

export class MetadataOnlyExporter {
  constructor(exporter, onFailure = () => {}) {
    this.exporter = exporter;
    this.onFailure = onFailure;
  }

  export(spans, callback) {
    const finish = (result) => {
      if (result.code !== 0) this.onFailure();
      // SDK diagnostics must never print an exporter response body.
      callback({ code: result.code });
    };
    try {
      const safe = spans.map(sanitizeSpan).filter(Boolean);
      if (safe.length) this.exporter.export(safe, finish);
      else finish({ code: 0 });
    } catch {
      finish({ code: 1 });
    }
  }

  async shutdown() {
    try { await this.exporter.shutdown(); } catch { this.onFailure(); }
  }
}
