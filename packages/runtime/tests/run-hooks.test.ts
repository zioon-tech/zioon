import { describe, expect, it, vi } from "vitest";
import {
  createAgentExecutor, dispatchRunHook, CancellationController, MemoryRunStore,
  normalizeCapabilityPolicy, type AgentEngine, type RunController, type RunHookStage,
  type ToolBroker, type EngineTurnRequest
} from "../src/index.js";

let serial = 0;
const id = (prefix: string) => `${prefix}-hook-${++serial}`;
const simple: AgentEngine = {
  id: "simple", async *streamTurn() { yield { type: "message.delta", delta: "done" }; }
};
const empty: ToolBroker = { listTools: async () => [], invoke: async () => ({ ok: true, content: "ok" }) };
const pause = (stage: RunHookStage): RunController => ({
  id: "approval", stages: [stage],
  async handle(context) {
    return context.resume?.input === "approved" ? { action: "pass" }
      : { action: "pause", reason: "Review requested", data: { form: "approval" } };
  }
});

describe("durable Run hook boundaries", () => {
  it("cancels a wait once without allowing its checkpoint to be resumed", async () => {
    const runs = new MemoryRunStore();
    const config = { runs, engine: simple, tools: empty, controllers: [pause("beforeModel")] };
    const handle = createAgentExecutor(config).execute({ prompt: "wait" });
    const waiting = await handle.completion;
    const checkpoint = (await runs.getLatestCheckpoint(handle.runId))!;
    const event = {
      schemaVersion: 1 as const, eventId: "cancel-wait", runId: handle.runId,
      attemptId: handle.attemptId, sequence: checkpoint.sequence + 1,
      type: "run.aborted", timestamp: Date.now(), data: { reason: "user" }
    };
    expect(await runs.cancelWait(event, "stale")).toBe(false);
    const [cancelled, claimed] = await Promise.all([
      runs.cancelWait(event, waiting.waiting!.id),
      runs.claimResume({ runId: handle.runId, previousAttemptId: handle.attemptId,
        attemptId: "resumed", checkpointSequence: checkpoint.sequence, waitId: waiting.waiting!.id })
    ]);
    expect(cancelled).toBe(true);
    expect(claimed).toBe(false);
    expect(await runs.getLatestCheckpoint(handle.runId)).toBeNull();
    expect(await runs.cancelWait(event, waiting.waiting!.id)).toBe(false);
    await expect(createAgentExecutor(config).resume(handle.runId)).rejects.toThrow("checkpoint");
  });

  for (const stage of ["beforeStart", "beforeTurn", "beforeModel", "beforeStop"] as const) {
    it(`resumes ${stage} from a new executor without repeating model work`, async () => {
      const runs = new MemoryRunStore();
      const requests: EngineTurnRequest[] = [];
      const engine: AgentEngine = {
        id: "tracked", async *streamTurn(request) {
          requests.push(request);
          yield { type: "message.delta", delta: "done" };
        }
      };
      const prepare = vi.fn(async () => [{ role: "system" as const, content: "context" }]);
      const config = { runs, engine, tools: empty, controllers: [pause(stage)], createId: id,
        contexts: [{ id: "context", prepare }] };
      const first = createAgentExecutor(config).execute({ prompt: "test" });
      const result = await first.completion;
      expect(result.status).toBe("waiting");
      expect(await runs.get(first.runId)).toMatchObject({ status: "waiting", waiting: result.waiting });
      const restarted = createAgentExecutor(config);
      await expect(restarted.resume(first.runId, { waitId: "stale", input: "approved" })).rejects.toThrow("waitId");
      const resumed = await restarted.resume(first.runId, { waitId: result.waiting!.id, input: "approved" });
      expect(await resumed.completion).toMatchObject({ status: "completed", output: "done" });
      expect(requests).toHaveLength(1);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(await runs.getLatestCheckpoint(first.runId)).toBeNull();
      const events = await runs.getEvents(first.runId);
      expect(events.filter((event) => event.type === "message.completed")).toHaveLength(1);
    });
  }

  it("retains a tool batch and claims exactly one concurrent resume", async () => {
    const runs = new MemoryRunStore();
    let modelCalls = 0;
    const engine: AgentEngine = {
      id: "batch", async *streamTurn(request) {
        modelCalls++;
        if (request.turn === 1) {
          for (const call of ["first", "second", "third"]) {
            yield { type: "tool.call", call: { id: call, name: "write", arguments: { call } } };
          }
        } else yield { type: "message.delta", delta: "done" };
      }
    };
    const invoked: string[] = [];
    const tools: ToolBroker = {
      listTools: async () => [{ name: "write" }],
      invoke: async (invocation) => {
        invoked.push(invocation.toolCall.id);
        return { ok: true, content: invocation.toolCall.id };
      }
    };
    const approval: RunController = {
      id: "approval", stages: ["beforeTool"],
      async handle(context) {
        return context.invocation?.toolCall.id === "second" && context.resume?.input !== "approved"
          ? { action: "pause", reason: "Approve write" } : { action: "pass" };
      }
    };
    const earlier = vi.fn(async () => ({ action: "pass" as const }));
    const config = { engine, tools, runs, createId: id,
      controllers: [{ id: "earlier", stages: ["beforeTool" as const], handle: earlier }, approval] };
    const first = createAgentExecutor(config).execute({ prompt: "write three", policy: { allowedTools: ["write"] } });
    const result = await first.completion;
    expect(invoked).toEqual(["first"]);
    const outcomes = await Promise.allSettled([0, 1].map(async () =>
      createAgentExecutor(config).resume(first.runId, { waitId: result.waiting!.id, input: "approved" })
    ));
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<ReturnType<typeof createAgentExecutor>["resume"]>>>;
    expect(await winner.value.completion).toMatchObject({ status: "completed" });
    expect(invoked).toEqual(["first", "second", "third"]);
    expect(modelCalls).toBe(2);
    expect(earlier).toHaveBeenCalledTimes(3);
    const transcript = await runs.getTranscript(first.runId);
    expect(transcript.filter((item) => item.role === "tool").map((item) => item.toolCallId)).toEqual(invoked);
  });

  it("reauthorizes after a hook and rejects a revoked grant before invoking tools", async () => {
    let revoked = false;
    const invoke = vi.fn(empty.invoke);
    const engine: AgentEngine = { id: "write", async *streamTurn() {
      yield { type: "tool.call", call: { id: "write", name: "write", arguments: {} } };
    } };
    const executor = createAgentExecutor({
      engine, runs: new MemoryRunStore(), tools: { listTools: async () => [{ name: "write" }], invoke },
      authorizeRun: (request) => normalizeCapabilityPolicy({ ...request.policy, allowedTools: revoked ? [] : ["write"] }),
      controllers: [{ id: "revoke", stages: ["beforeTool"], async handle() { revoked = true; } }]
    });
    expect(await executor.execute({ prompt: "write", policy: { allowedTools: ["write"] } }).completion).toMatchObject({ status: "aborted" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not let late hooks mutate policy and bounds hung observers", async () => {
    const control = new CancellationController();
    const context = {
      schemaVersion: 1 as const, stage: "beforeModel" as const, controllerId: "hung",
      idempotencyKey: "test", runId: "run", attemptId: "attempt",
      request: { prompt: "test", policy: { allowedTools: ["read"] } }, messages: [],
      signal: control.signal
    };
    let captured: typeof context | undefined;
    const decision = await dispatchRunHook({
      id: "hung", stages: ["beforeModel"], timeoutMs: 2, failurePolicy: "fail-open",
      async handle(input) { captured = input as typeof context; await new Promise(() => {}); }
    }, context);
    expect(decision.action).toBe("pass");
    captured!.request.policy!.allowedTools!.push("write");
    expect(context.request.policy.allowedTools).toEqual(["read"]);
    expect(captured!.signal.cancelled).toBe(true);
  });

  it("observes replaced tool results while preserving legacy stop/deny decisions", async () => {
    const afterTool = vi.fn(async () => {});
    const invoke = vi.fn(empty.invoke);
    const engine: AgentEngine = { id: "tool", async *streamTurn(request) {
      if (request.turn === 1) yield { type: "tool.call", call: { id: "read", name: "read", arguments: {} } };
      else yield { type: "message.delta", delta: "done" };
    } };
    const executor = createAgentExecutor({
      engine, runs: new MemoryRunStore(),
      tools: { listTools: async () => [{ name: "read" }], invoke },
      controllers: [{ id: "legacy", beforeTool: async () => ({ ok: true, content: "cached" }), afterTool }]
    });
    expect(await executor.execute({ prompt: "read", policy: { allowedTools: ["read"] } }).completion).toMatchObject({ status: "completed" });
    expect(invoke).not.toHaveBeenCalled();
    expect(afterTool).toHaveBeenCalledOnce();
    expect(afterTool.mock.calls[0][1]).toMatchObject({ ok: true, content: "cached" });
  });

  it("rejects invalid observer decisions and changed controller chains", async () => {
    const runs = new MemoryRunStore();
    const first = createAgentExecutor({ engine: simple, tools: empty, runs, controllers: [pause("beforeModel")] }).execute({ prompt: "test" });
    const result = await first.completion;
    await expect(createAgentExecutor({ engine: simple, tools: empty, runs, controllers: [] })
      .resume(first.runId, { waitId: result.waiting!.id })).rejects.toThrow("chain changed");
    const control = new CancellationController();
    await expect(dispatchRunHook({
      id: "bad", stages: ["afterTool"], async handle() { return { action: "pause", reason: "bad" }; }
    }, { schemaVersion: 1, stage: "afterTool", controllerId: "bad", idempotencyKey: "bad",
      runId: "run", attemptId: "attempt", request: {}, messages: [], signal: control.signal
    })).rejects.toThrow("Hook failed");
  });

  it("resumes a pause at the maximum-turn stop without re-running a tool or model", async () => {
    const runs = new MemoryRunStore();
    const invoke = vi.fn(async () => ({ ok: true, content: "written" }));
    let modelCalls = 0;
    const engine: AgentEngine = { id: "one-turn", async *streamTurn() {
      modelCalls++;
      yield { type: "tool.call", call: { id: "call", name: "write", arguments: {} } };
    } };
    const controller: RunController = {
      id: "limit", stages: ["beforeStop"], async handle(context) {
        return context.resume ? { action: "accept-stop" } : { action: "pause", reason: "Review boundary" };
      }
    };
    const config = { runs, engine, tools: { listTools: async () => [{ name: "write" }], invoke }, controllers: [controller] };
    const first = createAgentExecutor(config).execute({ prompt: "write", maxTurns: 1, policy: { allowedTools: ["write"] } });
    const waiting = await first.completion;
    expect(waiting.status).toBe("waiting");
    const resumed = await createAgentExecutor(config).resume(first.runId, { waitId: waiting.waiting!.id });
    expect(await resumed.completion).toMatchObject({ status: "completed" });
    expect(modelCalls).toBe(1);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("does not replay an interrupted side effect whose result was never checkpointed", async () => {
    const runs = new MemoryRunStore();
    const engine: AgentEngine = { id: "one-turn", async *streamTurn() {
      yield { type: "tool.call", call: { id: "call", name: "write", arguments: {} } };
    } };
    const config = { runs, engine, tools: {
      listTools: async () => [{ name: "write" }],
      invoke: async () => { throw new Error("broken transport"); }
    } };
    const save = runs.saveCheckpoint.bind(runs);
    runs.saveCheckpoint = async (checkpoint) => {
      if (checkpoint.pending && !checkpoint.pending.inFlight) throw new Error("result checkpoint unavailable");
      await save(checkpoint);
    };
    const first = createAgentExecutor(config).execute({ prompt: "write", policy: { allowedTools: ["write"] } });
    expect((await first.completion).status).toBe("failed");
    await expect(createAgentExecutor(config).resume(first.runId)).rejects.toThrow("unknown");
  });

  it("retains a preceding continue decision across a later approval pause", async () => {
    const runs = new MemoryRunStore();
    let modelCalls = 0;
    const engine: AgentEngine = { id: "counted", async *streamTurn() {
      modelCalls++;
      yield { type: "message.delta", delta: "checked" };
    } };
    const firstPolicy = vi.fn(async (context: Parameters<NonNullable<RunController["handle"]>>[0]) =>
      context.turn === 1 ? { action: "continue" as const, instruction: "Verify the result" }
        : { action: "accept-stop" as const });
    const config = { runs, engine, tools: empty, controllers: [
      { id: "verification", stages: ["beforeStop" as const], handle: firstPolicy }, pause("beforeStop")
    ] };
    const first = createAgentExecutor(config).execute({ prompt: "verify", maxTurns: 2 });
    const waiting = await first.completion;
    const resumed = await createAgentExecutor(config).resume(first.runId, { waitId: waiting.waiting!.id, input: "approved" });
    const secondWait = await resumed.completion;
    expect(secondWait.status).toBe("waiting");
    const final = await createAgentExecutor(config).resume(first.runId, { waitId: secondWait.waiting!.id, input: "approved" });
    expect((await final.completion).status).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(firstPolicy).toHaveBeenCalledTimes(2);
  });

  it("retries an unfinished afterTool hook without repeating its tool or prior hooks", async () => {
    const runs = new MemoryRunStore();
    let available = false;
    const earlier = vi.fn(async () => ({ action: "pass" as const }));
    const journal = vi.fn(async () => {
      if (!available) throw new Error("journal offline");
      return { action: "pass" as const };
    });
    const invoke = vi.fn(async () => ({ ok: true, content: "written" }));
    let modelCalls = 0;
    const engine: AgentEngine = { id: "write", async *streamTurn(request) {
      modelCalls++;
      if (request.turn === 1) yield { type: "tool.call", call: { id: "call", name: "write", arguments: {} } };
      else yield { type: "message.delta", delta: "done" };
    } };
    const config = { runs, engine, tools: { listTools: async () => [{ name: "write" }], invoke },
      controllers: [
        { id: "earlier", stages: ["afterTool" as const], handle: earlier },
        { id: "journal", stages: ["afterTool" as const], handle: journal }
      ] };
    const first = createAgentExecutor(config).execute({ prompt: "write", policy: { allowedTools: ["write"] } });
    expect((await first.completion).status).toBe("failed");
    expect((await runs.getLatestCheckpoint(first.runId))?.pending).toMatchObject({ stage: "afterTool", controllerIndex: 1, afterToolResult: { content: "written" } });
    available = true;
    const restarted = await createAgentExecutor(config).resume(first.runId);
    expect((await restarted.completion).status).toBe("completed");
    expect(invoke).toHaveBeenCalledOnce();
    expect(earlier).toHaveBeenCalledOnce();
    expect(journal).toHaveBeenCalledTimes(2);
    expect(modelCalls).toBe(2);
  });

  it("gives each tool result its own stable afterTool idempotency key", async () => {
    const keys: string[] = [];
    const engine: AgentEngine = { id: "batch", async *streamTurn(request) {
      if (request.turn === 1) {
        for (const call of ["a", "b"]) yield { type: "tool.call", call: { id: call, name: "read", arguments: {} } };
      } else yield { type: "message.delta", delta: "done" };
    } };
    const executor = createAgentExecutor({
      runs: new MemoryRunStore(), engine, tools: { listTools: async () => [{ name: "read" }], invoke: empty.invoke },
      controllers: [{ id: "observer", stages: ["afterTool"], async handle(context) { keys.push(context.idempotencyKey); } }]
    });
    expect((await executor.execute({ prompt: "read", policy: { allowedTools: ["read"] } }).completion).status).toBe("completed");
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});
