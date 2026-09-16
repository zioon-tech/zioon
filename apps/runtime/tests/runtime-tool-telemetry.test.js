import { describe, expect, it, vi } from "vitest";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { CancellationController, createAgentExecutor, MemoryRunStore, OpenAICompatibleEngine } from "../../../packages/runtime/src/index";
import { telemetryFixture } from "../../../packages/runtime/tests/telemetry-fixtures";
import { RuntimeToolBroker } from "../src/runtime-tool-broker.mjs";

const telemetry = telemetryFixture();
function setup(mode = "local") {
  const receipts = new Map();
  const delegated = vi.fn(async () => {
    if (mode === "throw") throw new Error("SECRET_TOOL_ERROR");
    return { ok: mode !== "false", content: "SECRET_RESULT" };
  });
  const broker = new RuntimeToolBroker({
    localTools: { listTools: async () => [{ name: "read" }], invoke: delegated },
    pluginTools: mode === "plugin" ? { hasTool: () => true, invoke: delegated } : null,
    receipts: {
      getToolReceipt: (id) => receipts.get(id),
      saveToolReceipt: (input) => { receipts.set(input.invocationId, input); return input; }
    }
  });
  const invocation = {
    invocationId: "invocation-1", runId: "run-1", attemptId: "attempt-1",
    policy: { allowedTools: ["read"] },
    toolCall: { id: "call-1", name: "read", arguments: { path: "/SECRET_PATH" } }
  };
  return { broker, invocation, delegated };
}

describe("logical Tool telemetry", () => {
  it.each(["local", "plugin", "false", "throw", "denied", "cancelled"])(
    "closes the %s invocation without recording arguments or results", async (mode) => {
      const { broker, invocation, delegated } = setup(mode);
      const cancellation = new CancellationController();
      if (mode === "denied") invocation.policy.allowedTools = [];
      if (mode === "cancelled") {
        delegated.mockImplementation(async () => { cancellation.cancel("user"); cancellation.signal.throwIfCancelled(); });
      }
      const parent = trace.getTracer("test").startSpan("parent");
      const operation = context.with(trace.setSpan(context.active(), parent), () => broker.invoke(invocation, cancellation.signal));
      if (["throw", "denied", "cancelled"].includes(mode)) await expect(operation).rejects.toThrow();
      else await operation;
      const spans = await telemetry.spans();
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("execute_tool");
      expect(spans[0].parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(spans[0].status.code).toBe(["false", "throw", "denied"].includes(mode) ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
      if (mode === "denied") {
        expect(spans[0].attributes["error.type"]).toBe("policy_denied");
        expect(delegated).not.toHaveBeenCalled();
      }
      expect(JSON.stringify({ attrs: spans[0].attributes, status: spans[0].status, events: spans[0].events }))
        .not.toContain("SECRET");
      parent.end();
    }
  );

  it("distinguishes receipt replay and rejects conflicting arguments without a second execution", async () => {
    const { broker, invocation, delegated } = setup();
    const signal = new CancellationController().signal;
    await broker.invoke(invocation, signal);
    await broker.invoke(invocation, signal);
    await expect(broker.invoke({
      ...invocation, toolCall: { ...invocation.toolCall, arguments: { path: "/different" } }
    }, signal)).rejects.toThrow("reused");
    const spans = await telemetry.spans();
    expect(spans).toHaveLength(3);
    expect(delegated).toHaveBeenCalledOnce();
    expect(spans[1].attributes["zion.tool.receipt_hit"]).toBe(true);
    expect(spans[2].attributes["error.type"]).toBe("receipt_conflict");
  });

  it("creates one golden trace for a model-tool-model Attempt in execution order", async () => {
    const { broker, delegated } = setup();
    delegated.mockImplementation(async () => {
      expect((await telemetry.spans()).map((span) => span.name)).toEqual(["chat"]);
      return { ok: true, content: "SECRET_RESULT" };
    });
    let turn = 0;
    const engine = new OpenAICompatibleEngine({
      model: "test", endpoint: "https://example.com", transport: async () => ({
        ok: true, status: 200, body: null,
        async text() { return ""; },
        async json() {
          turn++;
          if (turn === 2) {
            expect((await telemetry.spans()).map((span) => span.name)).toEqual(["chat", "execute_tool"]);
          }
          return { choices: [{ message: turn === 1 ? {
            tool_calls: [{ id: "call-1", function: { name: "read", arguments: '{"path":"/SECRET_PATH"}' } }]
          } : { content: "done" }, finish_reason: turn === 1 ? "tool_calls" : "stop" }] };
        }
      })
    });
    const executor = createAgentExecutor({ engine, tools: broker, runs: new MemoryRunStore() });
    const handle = executor.execute({ prompt: "SECRET_PROMPT", policy: { allowedTools: ["read"] } });
    for await (const event of handle.events) { /* drain durable stream */ }
    expect((await handle.completion).status).toBe("completed");
    const spans = await telemetry.spans();
    expect(spans.map((span) => span.name)).toEqual(["chat", "execute_tool", "chat", "invoke_agent"]);
    const root = spans[3];
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(spans.slice(0, 3).every((span) => span.parentSpanContext?.spanId === root.spanContext().spanId)).toBe(true);
    expect(delegated).toHaveBeenCalledOnce();
  });
});
