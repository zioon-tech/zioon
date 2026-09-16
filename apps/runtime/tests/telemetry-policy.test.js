import { describe, expect, it, vi } from "vitest";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { allowedAttributes, MetadataOnlyExporter, sanitizeSpan } from "../src/telemetry/export-policy.mjs";

function dirtySpan() {
  return {
    name: "chat", kind: 2, ended: true, startTime: [1, 0], endTime: [2, 0], duration: [1, 0],
    spanContext: () => ({
      traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1,
      traceState: { serialize: () => "SECRET_TRACESTATE" }
    }),
    instrumentationScope: { name: "@zion/runtime", version: "PRIVATE", schemaUrl: "SECRET_SCHEMA" },
    attributes: {
      "gen_ai.request.model": "test-model", "http.response.status_code": 200,
      "zion.model.consumer_wait.duration": 0.125,
      "gen_ai.response.finish_reasons": ["stop", "SECRET_REASON"],
      prompt: "SECRET_PROMPT", payload: { key: "SECRET_KEY" },
      "http.request.header.authorization": "SECRET_AUTH", "url.full": "https://example.com/SECRET_PATH?key=SECRET_KEY",
      "gen_ai.tool.name": "cat /SECRET_PATH"
    },
    status: { code: 2, message: "SECRET_ERROR" },
    events: [
      { name: "exception", attributes: { "exception.stacktrace": "SECRET_STACK" }, time: [1, 0] },
      { name: "tool.denied", attributes: { "zion.tool.denial": "policy", reason: "SECRET_REASON" }, time: [1, 0] }
    ],
    links: [{ context: { traceId: "3".repeat(32), spanId: "4".repeat(16), traceFlags: 1, traceState: "SECRET_STATE" }, attributes: { prompt: "SECRET" } }],
    resource: resourceFromAttributes({
      "service.name": "zion-runtime", "process.command_args": ["SECRET_ARG"],
      "host.name": "SECRET_HOST", "service.version": "https://SECRET_VERSION"
    }),
    droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0
  };
}

describe("telemetry export policy", () => {
  it("removes content from attributes, resources, status, events, links and scope", () => {
    const input = dirtySpan();
    const output = sanitizeSpan(input);
    expect(JSON.stringify({ ...output, context: output.spanContext(), resource: output.resource.attributes }))
      .not.toMatch(/SECRET|PRIVATE/);
    expect(output.attributes).toEqual({
      "gen_ai.request.model": "test-model", "http.response.status_code": 200,
      "zion.model.consumer_wait.duration": 0.125,
      "gen_ai.response.finish_reasons": ["stop"]
    });
    expect(output.resource.attributes).toEqual({ "service.name": "zion-runtime" });
    expect(input.status.message).toBe("SECRET_ERROR");
    expect(output.events).toHaveLength(1);
  });

  it("drops unrelated instrumentation and bounds values", () => {
    expect(sanitizeSpan({ ...dirtySpan(), name: "SECRET_DYNAMIC_NAME" })).toBeNull();
    expect(sanitizeSpan({ ...dirtySpan(), instrumentationScope: { name: "external" } })).toBeNull();
    expect(allowedAttributes({
      "gen_ai.request.model": "x".repeat(129), "gen_ai.usage.input_tokens": NaN,
      "gen_ai.usage.output_tokens": -1, "gen_ai.request.stream": true,
      "zion.tool.artifact_count": 3, secret: "PRIVATE"
    })).toEqual({ "gen_ai.request.stream": true, "zion.tool.artifact_count": 3 });
  });

  it.each(["throw", "callback", "success", "empty"])("isolates %s export and shutdown outcomes", async (mode) => {
    const failure = vi.fn();
    const exporter = new MetadataOnlyExporter({
      export(spans, callback) {
        expect(JSON.stringify(spans)).not.toMatch(/SECRET|PRIVATE/);
        if (mode === "throw") throw new Error("SECRET_EXPORT");
        callback({ code: mode === "callback" ? 1 : 0, error: new Error("SECRET_EXPORT") });
      },
      async shutdown() { if (mode === "throw") throw new Error("SECRET_SHUTDOWN"); }
    }, failure);
    const callback = vi.fn();
    exporter.export(mode === "empty" ? [] : [dirtySpan()], callback);
    expect(callback).toHaveBeenCalledWith({ code: ["throw", "callback"].includes(mode) ? 1 : 0 });
    await exporter.shutdown();
    expect(failure.mock.calls.length).toBe(mode === "throw" ? 2 : mode === "callback" ? 1 : 0);
  });
});
