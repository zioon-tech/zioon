import { describe, expect, it } from "vitest";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { createAgentExecutor, MemoryRunStore, type AgentEngine } from "../src/index";
import { telemetryFixture } from "./telemetry-fixtures";

const telemetry = telemetryFixture();
const tools = { async listTools() { return [{ name: "read" }]; }, async invoke() { return { ok: true, content: "PRIVATE_RESULT" }; } };
async function drain(handle: ReturnType<ReturnType<typeof createAgentExecutor>["execute"]>) {
  const events = [];
  for await (const event of handle.events) events.push(event);
  return { result: await handle.completion, events };
}

describe("Attempt telemetry", () => {
  it("links the initiator, persists correlation and keeps ordered events content-free in traces", async () => {
    const store = new MemoryRunStore();
    const parent = trace.getTracer("test").startSpan("accept");
    const engine: AgentEngine = { id: "scripted", async *streamTurn() {
      for (let i = 0; i < 100; i++) yield { type: "message.delta", delta: "PRIVATE_PROMPT" };
    } };
    const executor = createAgentExecutor({ engine, tools, runs: store });
    const handle = context.with(trace.setSpan(context.active(), parent), () =>
      executor.execute({ prompt: "PRIVATE_PROMPT", title: "PRIVATE_TITLE", metadata: { password: "SECRET" } }));
    const { result, events } = await drain(handle);
    parent.end();
    const span = (await telemetry.spans()).find((item) => item.name === "invoke_agent")!;
    expect(result.status).toBe("completed");
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.links[0].context.spanId).toBe(parent.spanContext().spanId);
    expect(span.spanContext().traceId).not.toBe(parent.spanContext().traceId);
    expect(span.attributes["zion.run.status"]).toBe("completed");
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(span.events).toHaveLength(0);
    expect(JSON.stringify(span.attributes)).not.toMatch(/PRIVATE|SECRET/);
    const record = await store.get(handle.runId);
    expect(record?.metadata.zionTelemetry).toMatchObject({
      traceId: span.spanContext().traceId, spanId: span.spanContext().spanId, attemptId: handle.attemptId
    });
  });

  it.each(["failed", "cancelled", "timeout", "create-failed", "append-failed"])(
    "closes the Attempt on %s", async (mode) => {
      const store = new MemoryRunStore();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      let expire!: () => void;
      if (mode === "create-failed") store.create = async () => { throw new Error("SECRET_DB"); };
      if (mode === "append-failed") store.append = async () => { throw new Error("SECRET_DB"); };
      const engine: AgentEngine = { id: "failure", async *streamTurn(request) {
        started();
        if (mode === "cancelled" || mode === "timeout") {
          await new Promise<void>((resolve) => request.signal.onCancel(() => resolve()));
          request.signal.throwIfCancelled();
        }
        yield* [];
        throw new Error("SECRET_ERROR_BODY");
      } };
      const executor = createAgentExecutor({
        engine, tools, runs: store,
        scheduleTimeout(callback) { expire = callback; return { dispose() {} }; }
      });
      const handle = executor.execute({ prompt: "private", ...(mode === "timeout" ? { timeoutMs: 10 } : {}) });
      if (mode === "cancelled" || mode === "timeout") {
        await ready;
        if (mode === "timeout") expire();
        else await handle.abort("private cancellation text");
      }
      const { result } = await drain(handle);
      const spans = await telemetry.spans();
      expect(spans).toHaveLength(1);
      expect(spans[0].ended).toBe(true);
      expect(result.status).toBe(mode === "cancelled" || mode === "timeout" ? "aborted" : "failed");
      expect(spans[0].status.code).toBe(mode === "cancelled" ? SpanStatusCode.UNSET : SpanStatusCode.ERROR);
      expect(JSON.stringify({ attrs: spans[0].attributes, status: spans[0].status, events: spans[0].events }))
        .not.toMatch(/SECRET|private/);
    }
  );

  it("links successive resumes across executor instances and tolerates missing metadata", async () => {
    const store = new MemoryRunStore();
    const engine: AgentEngine = { id: "checkpoint", async *streamTurn(request) {
      yield { type: "tool.call", call: { id: `call-${request.turn}`, name: "read", arguments: { path: "/private" } } };
    } };
    const first = createAgentExecutor({ engine, tools, runs: store }).execute({
      prompt: "start", maxTurns: 1, policy: { allowedTools: ["read"] }
    });
    await drain(first);
    const secondExecutor = createAgentExecutor({ engine, tools, runs: store });
    const second = await secondExecutor.resume(first.runId, { maxTurns: 2 });
    await drain(second);
    const third = await secondExecutor.resume(first.runId, { maxTurns: 3 });
    await drain(third);
    const spans = (await telemetry.spans()).filter((span) => span.name === "invoke_agent");
    expect(spans).toHaveLength(3);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(3);
    expect(spans[1].links[0].context.spanId).toBe(spans[0].spanContext().spanId);
    expect(spans[2].links[0].context.spanId).toBe(spans[1].spanContext().spanId);
    const originalGet = store.get.bind(store);
    store.get = async (id) => { const value = await originalGet(id); return value ? { ...value, metadata: {} } : null; };
    await drain(await secondExecutor.resume(first.runId, { maxTurns: 4 }));
    expect((await telemetry.spans()).at(-1)?.links).toHaveLength(0);
  });

  it("isolates concurrent Attempts and does not create execution spans for denied tools", async () => {
    const seen: string[] = [];
    const engine: AgentEngine = { id: "parallel", async *streamTurn(request) {
      await Promise.resolve();
      seen.push(trace.getSpan(context.active())!.spanContext().traceId);
      if (request.turn === 1) yield { type: "tool.call", call: { id: "denied", name: "write", arguments: {} } };
      else yield { type: "message.delta", delta: "done" };
    } };
    const executor = createAgentExecutor({ engine, tools, runs: new MemoryRunStore() });
    const handles = [executor.execute({ prompt: "one" }), executor.execute({ prompt: "two" })];
    await Promise.all(handles.map(drain));
    const spans = await telemetry.spans();
    expect(spans).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect(spans.every((span) => span.events.some((event) => event.name === "tool.denied"))).toBe(true);
    expect(trace.getSpan(context.active())).toBeUndefined();
  });
});
