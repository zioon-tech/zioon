import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { resumeRun } from "../../../packages/runtime-client/src/runs.mjs";

let database;
beforeAll(async () => { database = await createPostgresTestDatabase("runtime_hooks"); });
afterAll(async () => { await database?.close(); });
const tools = { listTools: async () => [], invoke: async () => ({ ok: true, content: "ok" }) };
const engine = { id: "simple", async *streamTurn() { yield { type: "message.delta", delta: "done" }; } };
const approval = {
  id: "approval", stages: ["beforeModel"],
  async handle(context) {
    return context.resume?.input?.approved ? { action: "pass" } : { action: "pause", reason: "Approve model request" };
  }
};
const store = () => new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });

describe("persistent hook execution and HTTP resume", () => {
  it("keeps waiting outside terminal postprocessors and resumes through a new HTTP host", async () => {
    const runs = store();
    const afterRun = vi.fn(async () => {});
    const controllers = [approval, { id: "legacy-observer", afterRun }];
    const firstExecutor = createAgentExecutor({ engine, tools, runs, controllers });
    const first = firstExecutor.execute({ prompt: "test" });
    const waiting = await first.completion;
    expect(waiting.status).toBe("waiting");
    const projection = vi.fn(async () => {});
    const restarted = createRuntimeServer({
      executor: createAgentExecutor({ engine, tools, runs, controllers }),
      runs, port: 0, pollIntervalMs: 5, runControllers: controllers,
      runPostProcessors: [{ id: "observer", process: projection }]
    });
    const address = await restarted.start();
    try {
      await expect(resumeRun(address.url, first.runId, { waitId: "stale" })).rejects.toMatchObject({ statusCode: 409 });
      const response = await resumeRun(address.url, first.runId, { waitId: waiting.waiting.id, input: { approved: true } });
      expect(response.status).toBe("accepted");
      for (let i = 0; i < 100; i++) {
        if ((await runs.getEvents(first.runId)).some((event) => event.type === "run.finalized")) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(await runs.get(first.runId)).toMatchObject({ status: "completed" });
      expect(afterRun).toHaveBeenCalledOnce();
      expect(projection).toHaveBeenCalledOnce();
      expect((await runs.getEvents(first.runId)).filter((event) => event.type === "run.finalized")).toHaveLength(1);
      expect(await runs.getLatestCheckpoint(first.runId)).toBeNull();
    } finally { await restarted.close(); }
  });

  it("rolls back the wait event and status if checkpoint persistence fails", async () => {
    const runs = store();
    runs.writeCheckpoint = async () => { throw new Error("checkpoint unavailable"); };
    const first = createAgentExecutor({ engine, tools, runs, controllers: [approval] }).execute({ prompt: "test" });
    expect(await first.completion).toMatchObject({ status: "failed" });
    expect((await runs.getEvents(first.runId)).some((event) => event.type === "run.waiting")).toBe(false);
    expect(await runs.getLatestCheckpoint(first.runId)).toBeNull();
  });

  it("cancels a waiting Run after restart and releases its Session without model execution", async () => {
    const runs = store();
    const sessionId = "cancel-wait-session";
    await runs.createSession({ id: sessionId, status: "active", policy: {}, metadata: {}, createdAt: Date.now(), updatedAt: Date.now() });
    const streamTurn = vi.fn(engine.streamTurn);
    const first = createAgentExecutor({ engine: { ...engine, streamTurn }, tools, runs, controllers: [approval] })
      .execute({ sessionId, prompt: "await approval" });
    await first.completion;
    const observer = vi.fn(async () => ({ action: "pass" }));
    const controllers = [approval, { id: "cancel-observer", stages: ["afterRun"], handle: observer }];
    const host = createRuntimeServer({
      executor: createAgentExecutor({ engine: { ...engine, streamTurn }, tools, runs, controllers }),
      runs, runControllers: controllers
    });
    const address = await host.start();
    try {
      const response = await fetch(`${address.url}/v1/runs/${first.runId}/abort`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "cancel-approval" })
      });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(host.isIdle()).toBe(true));
      expect(await runs.get(first.runId)).toMatchObject({ status: "aborted", terminalReason: "cancel-approval" });
      expect((await runs.get(first.runId)).waiting).toBeUndefined();
      expect(await runs.getLatestCheckpoint(first.runId)).toBeNull();
      expect(streamTurn).not.toHaveBeenCalled();
      expect(observer).toHaveBeenCalledOnce();
      expect(observer.mock.calls[0][0].result.status).toBe("aborted");
      const next = await fetch(`${address.url}/v1/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "new task", sessionId })
      });
      expect(next.status).toBe(202);
    } finally { await host.close(); }
  });

  it("arbitrates cancellation against resume atomically and rejects foreign or stale waits", async () => {
    const runs = store();
    const first = createAgentExecutor({ engine, tools, runs, controllers: [approval] }).execute({ prompt: "wait" });
    const waiting = await first.completion;
    const checkpoint = await runs.getLatestCheckpoint(first.runId);
    const event = {
      schemaVersion: 1, eventId: "cancel-event", runId: first.runId, attemptId: first.attemptId,
      sequence: checkpoint.sequence + 1, type: "run.aborted", timestamp: Date.now(), data: { reason: "user" }
    };
    expect(await store().cancelWait(event, waiting.waiting.id)).toBe(false);
    expect(await runs.cancelWait(event, "stale")).toBe(false);
    const rival = new PostgresRunStore(database.pool, { spaceId: runs.spaceId });
    const [cancelled, resumed] = await Promise.all([
      runs.cancelWait(event, waiting.waiting.id),
      rival.claimResume({ runId: first.runId, previousAttemptId: first.attemptId,
        attemptId: "next-attempt", checkpointSequence: checkpoint.sequence,
        waitId: waiting.waiting.id, input: { approved: true } })
    ]);
    expect([cancelled, resumed].filter(Boolean)).toHaveLength(1);
    expect((await runs.get(first.runId)).status).toBe(cancelled ? "aborted" : "queued");
    expect((await runs.getEvents(first.runId)).filter((item) => item.type === "run.aborted")).toHaveLength(cancelled ? 1 : 0);
    if (cancelled) expect(await runs.getLatestCheckpoint(first.runId)).toBeNull();
  });

  it("claims a wait once across pools and preserves accepted input through recovery", async () => {
    const runs = store();
    const first = createAgentExecutor({ engine, tools, runs, controllers: [approval] }).execute({ prompt: "test" });
    const waiting = await first.completion;
    const checkpoint = await runs.getLatestCheckpoint(first.runId);
    const claims = await Promise.all([0, 1].map((index) => new PostgresRunStore(database.pool, { spaceId: runs.spaceId })
      .claimResume({ runId: first.runId, previousAttemptId: first.attemptId, attemptId: `claimed-${index}`,
        checkpointSequence: checkpoint.sequence, waitId: waiting.waiting.id, input: { approved: true } })));
    expect(claims.sort()).toEqual([false, true]);
    expect((await runs.getLatestCheckpoint(first.runId)).pending.resume.input).toEqual({ approved: true });
    await runs.reconcileActiveRuns();
    const resumed = await createAgentExecutor({ engine, tools, runs, controllers: [approval] }).resume(first.runId);
    expect(await resumed.completion).toMatchObject({ status: "completed" });
  });

  it("cannot access a wait from another account space", async () => {
    const runs = store();
    const first = createAgentExecutor({ engine, tools, runs, controllers: [approval] }).execute({ prompt: "test" });
    await first.completion;
    const other = store();
    expect(await other.get(first.runId)).toBeNull();
    await expect(createAgentExecutor({ engine, tools, runs: other, controllers: [approval] }).resume(first.runId))
      .rejects.toThrow("Run not found");
  });

  it("retries only the incomplete afterTool observer after a PostgreSQL host restart", async () => {
    const runs = store();
    const invoke = vi.fn(async () => ({ ok: true, content: "written-once" }));
    const acknowledged = vi.fn(async () => ({ action: "pass" }));
    const recordResult = vi.fn()
      .mockRejectedValueOnce(new Error("result ledger unavailable"))
      .mockResolvedValue({ action: "pass" });
    const controllers = [
      { id: "first-ledger", stages: ["afterTool"], handle: acknowledged },
      { id: "second-ledger", stages: ["afterTool"], handle: recordResult }
    ];
    const dependencies = {
      controllers,
      tools: { listTools: async () => [{ name: "write" }], invoke },
      engine: {
        id: "write-once",
        async *streamTurn({ turn }) {
          if (turn === 1) yield {
            type: "tool.call", call: { id: "write-1", name: "write", arguments: { path: "result.txt" } }
          };
          else yield { type: "message.delta", delta: "done" };
        }
      }
    };
    const first = createAgentExecutor({ ...dependencies, runs }).execute({
      prompt: "write and record", policy: { allowedTools: ["write"] }
    });
    expect(await first.completion).toMatchObject({ status: "failed" });
    expect((await runs.getLatestCheckpoint(first.runId)).pending).toMatchObject({
      stage: "afterTool", controllerIndex: 1, callIndex: 0, inFlight: false,
      afterToolResult: { ok: true, content: "written-once" }
    });
    const restartedStore = new PostgresRunStore(database.pool, { spaceId: runs.spaceId });
    const resumed = await createAgentExecutor({ ...dependencies, runs: restartedStore }).resume(first.runId);
    expect(await resumed.completion).toMatchObject({ status: "completed", output: "done" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(recordResult).toHaveBeenCalledTimes(2);
    expect(recordResult.mock.calls[1][0]).toMatchObject({
      result: { ok: true, content: "written-once" },
      idempotencyKey: recordResult.mock.calls[0][0].idempotencyKey
    });
    const transcript = await restartedStore.getTranscript(first.runId);
    expect(transcript.filter((message) => message.role === "tool")).toHaveLength(1);
  });

  it("records failed afterRun policy without changing a completed Run or continuing it", async () => {
    const runs = store();
    const report = vi.fn();
    const controllers = [{
      id: "failed-final-policy", stages: ["afterRun"],
      async handle() { throw new Error("private-external-secret"); }
    }];
    const host = createRuntimeServer({
      executor: createAgentExecutor({ engine, tools, runs, controllers }), runs,
      runControllers: controllers, onPostProcessorError: report
    });
    const address = await host.start();
    try {
      const response = await fetch(`${address.url}/v1/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "complete" })
      });
      expect(response.status).toBe(202);
      const started = await response.json();
      for (let i = 0; i < 100 && !report.mock.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(report).toHaveBeenCalledOnce();
      expect((await runs.get(started.runId)).status).toBe("completed");
      const events = await runs.getEvents(started.runId);
      expect(events.filter((event) => event.type === "run.finalized")).toHaveLength(1);
      expect(events.some((event) => event.type === "hook.failed")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("private-external-secret");
      await vi.waitFor(() => expect(host.isIdle()).toBe(true));
      for (const endpoint of ["events", "projection"]) {
        const result = await (await fetch(`${address.url}/v1/runs/${started.runId}/${endpoint}`)).json();
        expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining(["run.finalized", "hook.failed"]));
      }
      for (const endpoint of ["events/stream", "projection/stream"]) {
        const stream = await (await fetch(`${address.url}/v1/runs/${started.runId}/${endpoint}`)).text();
        expect(stream).toContain("run.finalized");
        expect(stream).toContain("hook.failed");
      }
    } finally { await host.close(); }
  });

  it("reserves Session admission before asynchronous waiting-state lookup", async () => {
    const runs = store();
    const sessionId = "concurrent-session";
    await runs.createSession({ id: sessionId, status: "active", policy: {}, metadata: {}, createdAt: Date.now(), updatedAt: Date.now() });
    let unblock;
    let lookups = 0;
    runs.getActiveRunForSession = async () => {
      lookups++;
      await new Promise((resolve) => { unblock = resolve; });
      return null;
    };
    const host = createRuntimeServer({ executor: createAgentExecutor({ engine, tools, runs }), runs });
    const address = await host.start();
    const send = () => fetch(`${address.url}/v1/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "run once", sessionId })
    });
    let first;
    try {
      first = send();
      await vi.waitFor(() => expect(lookups).toBe(1));
      expect((await send()).status).toBe(409);
      unblock();
      expect((await first).status).toBe(202);
      expect(await runs.listRuns()).toHaveLength(1);
    } finally { unblock?.(); await first; await host.close(); }
  });
});
