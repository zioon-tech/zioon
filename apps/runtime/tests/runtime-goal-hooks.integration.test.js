import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { activateRuntimePlugin } from "../../../extensions/dev.goal/runtime.js";
import { createRuntimeServer } from "../src/server.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let database;
beforeAll(async () => { database = await createPostgresTestDatabase("goal_hooks"); });
afterAll(async () => { await database?.close(); });

async function goalHarness(runs, state = new Map()) {
    const controllers = [];
    const contexts = [];
    const definitions = [];
    const events = [];
    await activateRuntimePlugin({
      config: { runStore: runs },
      state: { namespace: () => ({ get: (key) => state.get(key), put: async (key, value) => state.set(key, value), entries: () => state.entries() }) },
      events: { emit: (type, data) => events.push({ type, data }) },
      runs: { registerController: (controller) => controllers.push(controller), registerCommands: () => {} },
      context: { registerProvider: (provider) => contexts.push(provider) },
      tools: { registerTool: (tool) => definitions.push(tool) }
    });
    return { state, controllers, contexts, definitions, events };
}

describe("real Goal plugin compatibility with unified lifecycle Hooks", () => {
  it("continues into a new Run and completes only after criterion evidence is reported", async () => {
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const { state, controllers, contexts, definitions, events } = await goalHarness(runs);
    const afterRun = vi.spyOn(controllers[0], "afterRun");
    let firstRunId;
    const modelRuns = [];
    const engine = {
      id: "goal", async *streamTurn(request) {
        firstRunId ||= request.runId;
        modelRuns.push(request.runId);
        if (request.runId === firstRunId) yield { type: "message.delta", delta: "先检查已有结果。" };
        else yield {
          type: "tool.call", call: {
            id: "complete", name: "goalManage",
            arguments: { action: "complete", evidence: [{ criterion: 0, reference: "file:///verified-result.md" }] }
          }
        };
      }
    };
    const tools = {
      listTools: async () => definitions,
      invoke: async (invocation) => ({
        ok: true, content: await definitions[0].invoke(invocation.toolCall.arguments, {
          runId: invocation.runId, request: await runs.get(invocation.runId)
        })
      })
    };
    const runtime = createRuntimeServer({
      executor: createAgentExecutor({ engine, tools, runs, controllers, contexts }),
      runs, runControllers: controllers, pollIntervalMs: 5
    });
    const address = await runtime.start();
    try {
      const sessionResponse = await fetch(`${address.url}/v1/sessions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: { allowedTools: ["goalManage"] } })
      });
      expect(sessionResponse.status).toBe(201);
      const { session } = await sessionResponse.json();
      const response = await fetch(`${address.url}/v1/sessions/${session.id}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "/goal 完成有证据的任务", maxTurns: 1 })
      });
      expect(response.status).toBe(202);
      for (let i = 0; i < 200 && afterRun.mock.calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      const record = [...state.values()].find((entry) => entry.objective);
      expect(record).toMatchObject({ status: "completed", cycles: 2, evidenceSource: "model-report", activeRunId: null });
      expect(record.runIds).toHaveLength(2);
      expect(new Set(modelRuns).size).toBe(2);
      expect(afterRun).toHaveBeenCalledTimes(2);
      expect(events.some((event) => event.data.status === "completed")).toBe(true);
    } finally { await runtime.close(); }
  });

  it("preserves the previously accepted size of legacy Goal objectives", async () => {
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const { controllers, contexts, definitions } = await goalHarness(runs);
    const executor = createAgentExecutor({
      runs, controllers, contexts,
      engine: { id: "long-goal", async *streamTurn() { yield { type: "message.delta", delta: "started" }; } },
      tools: { listTools: async () => definitions, invoke: async () => ({ ok: true, content: "unused" }) }
    });
    const result = await executor.execute({
      sessionId: "long-goal-session", prompt: `/goal ${"x".repeat(33000)}`,
      maxTurns: 1, policy: { allowedTools: ["goalManage"] }
    }).completion;
    expect(result).toMatchObject({ status: "completed", reason: "controller-yield" });
  });

  it("retains Goal policy state across a durable wait and plugin restart", async () => {
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const firstPlugin = await goalHarness(runs);
    const approval = {
      id: "approval", stages: ["beforeModel"],
      async handle(context) {
        return context.resume?.input?.approved ? { action: "pass" } : { action: "pause", reason: "Review Goal execution" };
      }
    };
    const engine = { id: "goal", async *streamTurn() {
      yield { type: "tool.call", call: { id: "complete", name: "goalManage",
        arguments: { action: "complete", evidence: [{ criterion: 0, reference: "file:///verified-goal.md" }] } } };
    } };
    const make = (plugin) => createAgentExecutor({
      runs, engine, contexts: plugin.contexts, controllers: [...plugin.controllers, approval],
      tools: {
        listTools: async () => plugin.definitions,
        invoke: async (invocation) => ({ ok: true, content: await plugin.definitions[0].invoke(
          invocation.toolCall.arguments, { runId: invocation.runId, request: await runs.get(invocation.runId) }
        ) })
      }
    });
    const first = make(firstPlugin).execute({
      sessionId: "waiting-goal", prompt: "/goal 完成审批后的目标", maxTurns: 1,
      policy: { allowedTools: ["goalManage"] }
    });
    const waiting = await first.completion;
    expect(waiting.status).toBe("waiting");
    const restarted = await goalHarness(runs, firstPlugin.state);
    const resumed = await make(restarted).resume(first.runId, { waitId: waiting.waiting.id, input: { approved: true } });
    expect((await resumed.completion).status).toBe("completed");
    expect([...restarted.state.values()][0].status).toBe("completed");
  });
});
