import { describe, expect, it, vi } from "vitest";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import {
  CancellationController,
  createAgentExecutor,
  MemoryRunStore,
  OpenAICompatibleEngine,
  type EngineTurnRequest
} from "../src/index";
import type { ModelTransportResponse } from "../src/openai-compatible-engine";
import { telemetryFixture } from "./telemetry-fixtures";

const telemetry = telemetryFixture();
function request(signal = new CancellationController().signal): EngineTurnRequest {
  return { runId: "run-1", attemptId: "attempt-1", turn: 1, signal,
    model: { providerId: "provider", modelId: "test-model" },
    messages: [{ role: "user", content: "SECRET_PROMPT" }], tools: [] };
}
function response(chunks: unknown[], options: Partial<ModelTransportResponse> = {}): ModelTransportResponse {
  return { ok: true, status: 200, headers: { "content-type": "text/event-stream" },
    body: (async function* () {
      for (const chunk of chunks) yield `data: ${JSON.stringify(chunk)}\n\n`;
    })(), async json() { return {}; }, async text() { return "SECRET_HTTP_BODY"; }, ...options };
}
async function collect(engine: OpenAICompatibleEngine, input = request()) {
  const events = [];
  for await (const event of engine.streamTurn(input)) events.push(event);
  return events;
}
function engineFor(value: ModelTransportResponse, extra = {}) {
  return new OpenAICompatibleEngine({
    endpoint: "https://user:SECRET_PASSWORD@example.com/private?api_key=SECRET_KEY",
    apiKey: "SECRET_KEY", model: "test-model", transport: async () => value, ...extra
  });
}

describe("model operation telemetry", () => {
  it("separates caller backpressure from model call-chain wall time", async () => {
    class SlowRunStore extends MemoryRunStore {
      override async append(...args: Parameters<MemoryRunStore["append"]>) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return super.append(...args);
      }
    }
    const engine = engineFor(response([
      { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }
    ]));
    const executor = createAgentExecutor({
      engine,
      tools: {
        async listTools() { return []; },
        async invoke() { return { ok: true, content: "" }; }
      },
      runs: new SlowRunStore()
    });
    const handle = executor.execute({ prompt: "private" });
    for await (const _event of handle.events) {
      // Drain the durable event stream.
    }
    await handle.completion;

    const span = (await telemetry.spans()).find((item) => item.name === "chat")!;
    const wallMs = span.duration[0] * 1000 + span.duration[1] / 1_000_000;
    const consumerWaitMs = Number(
      span.attributes["zion.model.consumer_wait.duration"]
    ) * 1000;

    // Transient text deltas no longer wait for durable storage. The remaining
    // wait is caused by semantic events such as usage.
    expect(consumerWaitMs).toBeGreaterThanOrEqual(10);
    expect(consumerWaitMs).toBeLessThan(30);
    expect(wallMs).toBeGreaterThan(consumerWaitMs);
    expect(wallMs - consumerWaitMs).toBeGreaterThanOrEqual(0);
  });

  it("covers the stream through credential release with usage, finish reason and first chunk timing", async () => {
    let transportContext = "";
    let releaseContext = "";
    const released = vi.fn(async () => {
      releaseContext = trace.getSpan(context.active())!.spanContext().spanId;
      expect(telemetry.exporter.getFinishedSpans()).toHaveLength(0);
    });
    const responseBody = response([
      { model: "returned-model", choices: [{ delta: { reasoning_content: "SECRET_REASONING" } }] },
      { choices: [{ delta: { content: "SECRET_RESPONSE" }, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 12, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 } } }
    ]);
    const engine = engineFor(responseBody, {
      credentialRef: "SECRET_REF",
      credentialProvider: { async acquire() { return { headers: { authorization: "SECRET" }, release: released }; } },
      transport: async () => {
        transportContext = trace.getSpan(context.active())!.spanContext().spanId;
        return responseBody;
      }
    });
    const parent = trace.getTracer("test").startSpan("attempt");
    await context.with(trace.setSpan(context.active(), parent), async () => {
      for await (const event of engine.streamTurn(request())) {
        expect(trace.getSpan(context.active())?.spanContext().spanId).toBe(parent.spanContext().spanId);
      }
    });
    const spans = await telemetry.spans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe("chat");
    expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(transportContext).toBe(span.spanContext().spanId);
    expect(releaseContext).toBe(transportContext);
    expect(span.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 12, "gen_ai.usage.output_tokens": 7,
      "gen_ai.usage.reasoning.output_tokens": 3,
      "gen_ai.response.finish_reasons": ["stop"], "gen_ai.response.model": "returned-model",
      "gen_ai.response.time_to_first_chunk": expect.any(Number), "http.response.status_code": 200
    });
    expect(JSON.stringify({ attrs: span.attributes, status: span.status, events: span.events })).not.toContain("SECRET");
    parent.end();
  });

  it.each(["no-usage", "json", "http-error", "incomplete", "truncated", "parse-error", "credential-error", "release-error"])(
    "settles exactly once for %s", async (mode) => {
      let value = response([{ choices: [{ delta: { content: "text" }, finish_reason: "stop" }] }]);
      const extra: Record<string, unknown> = {};
      if (mode === "json") value = response([], { body: null, async json() {
        return { model: "json-model", choices: [{ message: { content: "json" }, finish_reason: "stop" }] };
      } });
      if (mode === "http-error") value = response([], { ok: false, status: 401 });
      if (mode === "incomplete") value = response([{ choices: [{ delta: { content: "partial" } }] }]);
      if (mode === "truncated") value = response([{ choices: [{ finish_reason: "length" }] }]);
      if (mode === "parse-error") value = response([], { body: (async function* () { yield "data: SECRET_INVALID_JSON\n\n"; })() });
      if (mode === "credential-error") Object.assign(extra, {
        credentialRef: "private", credentialProvider: { async acquire() { throw new Error("SECRET_CREDENTIAL"); } }
      });
      if (mode === "release-error") Object.assign(extra, {
        credentialRef: "private", credentialProvider: { async acquire() {
          return { headers: {}, async release() { throw new Error("SECRET_RELEASE"); } };
        } }
      });
      const operation = collect(engineFor(value, extra));
      const success = mode === "no-usage" || mode === "json";
      if (success) await operation;
      else await expect(operation).rejects.toThrow();
      const spans = await telemetry.spans();
      expect(spans).toHaveLength(1);
      const span = spans[0];
      expect(span.status.code).toBe(success ? SpanStatusCode.UNSET : SpanStatusCode.ERROR);
      expect(span.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
      if (mode === "incomplete" || mode === "truncated") expect(span.attributes["error.type"]).toBe("incomplete_stream");
      if (mode === "json") expect(span.attributes["gen_ai.response.time_to_first_chunk"]).toBeUndefined();
      expect(JSON.stringify({ attrs: span.attributes, status: span.status, events: span.events })).not.toContain("SECRET");
    }
  );

  it.each(["user", "timeout", "consumer"])("cleans up a partially consumed stream on %s", async (mode) => {
    const cancellation = new CancellationController();
    const release = vi.fn(async () => {});
    const engine = engineFor(response([{ choices: [{ delta: { content: "partial" } }] }]), {
      credentialRef: "ref", credentialProvider: { async acquire() { return { headers: {}, release }; } }
    });
    const iterator = engine.streamTurn(request(cancellation.signal))[Symbol.asyncIterator]();
    await iterator.next(); // model.request
    await iterator.next(); // content
    if (mode !== "consumer") cancellation.cancel(mode);
    await iterator.return?.();
    const spans = await telemetry.spans();
    expect(spans).toHaveLength(1);
    expect(release).toHaveBeenCalledOnce();
    expect(spans[0].attributes["zion.cancellation.reason"]).toBe(
      mode === "consumer" ? "consumer_closed" : mode === "user" ? "cancelled" : "timeout"
    );
    expect(spans[0].status.code).toBe(mode === "timeout" ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
  });

  it("keeps simultaneous model requests under their own parent context", async () => {
    const parents = [trace.getTracer("test").startSpan("a"), trace.getTracer("test").startSpan("b")];
    await Promise.all(parents.map((parent) => context.with(trace.setSpan(context.active(), parent), () =>
      collect(engineFor(response([{ choices: [{ finish_reason: "stop" }] }]))))));
    const spans = await telemetry.spans();
    expect(spans.map((span) => span.parentSpanContext?.spanId).sort())
      .toEqual(parents.map((span) => span.spanContext().spanId).sort());
    expect(trace.getSpan(context.active())).toBeUndefined();
    parents.forEach((span) => span.end());
  });
});
