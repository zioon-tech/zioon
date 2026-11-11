import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresWebhookStore } from "../src/postgres-webhook-store.mjs";
import { RuntimeWebhookWorker } from "../src/webhook-worker.mjs";
import { createWebhookHttpHandler } from "../src/webhook-http-handler.mjs";
import { environmentWebhookSecret } from "../src/runtime-extension-credentials.mjs";
import { extensionTerminalOutbox } from "../src/marketplace/run-bindings.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let database;
beforeAll(async () => { database = await createPostgresTestDatabase("release_hooks"); });
afterAll(async () => { await database?.close(); });
const tools = { listTools: async () => [], invoke: async () => ({ ok: true, content: "ok" }) };
const engine = { id: "simple", async *streamTurn() { yield { type: "message.delta", delta: "done" }; } };
const approval = { id: "approval", stages: ["beforeModel"], async handle(context) {
  return context.resume ? { action: "pass" } : { action: "pause", reason: "Approve" };
} };
const store = () => new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
const request = async (url, path, body) => fetch(`${url}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});
const plan = [{ listingId: "cleanup", epoch: 1, digest: "fixed", configDigest: "fixed",
  handlers: [{ id: "cleanup", handle: "cleanup", kind: "controller", hooks: ["afterRun"] }] }];

describe("integrated release boundaries", () => {
  it("rejects foreign Space and Hook-only keys at creation, delivery and replay", async () => {
    const runs = store();
    const ownRef = "ZION_WEBHOOK_SECRET_OWN", foreignRef = "ZION_WEBHOOK_SECRET_FOREIGN";
    const environment = {
      [ownRef]: "own-secret-at-least-thirty-two-bytes", [foreignRef]: "foreign-secret-at-least-thirty-two-bytes",
      ZION_HOOK_SECRET_OPERATOR: "hook-secret-at-least-thirty-two-bytes",
      ZION_WEBHOOK_SECRET_BINDINGS: JSON.stringify({ [runs.spaceId]: [ownRef, "ZION_HOOK_SECRET_OPERATOR"] })
    };
    const secret = (ref, context) => environmentWebhookSecret(ref, context, environment);
    const webhooks = new PostgresWebhookStore(database.pool, { spaceId: runs.spaceId });
    const handler = createWebhookHttpHandler({ store: webhooks, secret });
    const response = { writeHead() {}, end() {} };
    for (const secretRef of [foreignRef, "ZION_HOOK_SECRET_OPERATOR"]) {
      await expect(handler({ method: "POST", zionAccessBody: {
        endpoint: "https://example.com/events", secretRef, eventTypes: ["run.completed"]
      } }, response, new URL("http://localhost/v1/webhooks"))).rejects.toMatchObject({ statusCode: 400 });
    }
    await handler({ method: "POST", zionAccessBody: {
      endpoint: "https://example.com/events", secretRef: ownRef, eventTypes: ["run.completed"]
    } }, response, new URL("http://localhost/v1/webhooks"));
    const sub = (await webhooks.list())[0];
    runs.webhooks = webhooks;
    const handle = createAgentExecutor({ engine, tools, runs }).execute({ prompt: "complete" });
    await handle.completion;
    environment.ZION_WEBHOOK_SECRET_BINDINGS = "{}";
    const transport = vi.fn(async () => ({ status: 204 }));
    await new RuntimeWebhookWorker({ store: webhooks, secret, transport, maxAttempts: 1 }).tick();
    expect(transport).not.toHaveBeenCalled();
    const delivery = (await webhooks.deliveries())[0];
    expect(delivery.status).toBe("dead");
    await expect(handler({ method: "POST", zionAccessBody: { reason: "retry" } }, response,
      new URL(`http://localhost/v1/webhooks/deliveries/${delivery.id}/replay`))).rejects.toThrow("not authorized");
    await expect(handler({ method: "PATCH", zionAccessBody: { enabled: true } }, response,
      new URL(`http://localhost/v1/webhooks/${sub.id}`))).rejects.toThrow("not authorized");
    expect((await webhooks.audit(delivery.id))).toEqual([]);
  });

  it("notifies an accepted wait resume with the canonical durable event identity", async () => {
    const runs = store();
    const webhooks = new PostgresWebhookStore(database.pool, { spaceId: runs.spaceId });
    runs.webhooks = webhooks;
    await webhooks.create({ endpoint: "https://example.com", secretRef: "ZION_WEBHOOK_SECRET_TEST",
      eventTypes: ["run.resumed"] }, "owner");
    const executor = createAgentExecutor({ engine, tools, runs, controllers: [approval] });
    const first = executor.execute({ prompt: "wait" });
    const waiting = await first.completion;
    await (await executor.resume(first.runId, { waitId: waiting.waiting.id, input: {} })).completion;
    const resumed = (await runs.getEvents(first.runId)).find((event) => event.type === "attempt.started");
    const [job] = await webhooks.claim();
    expect(job.payload).toMatchObject({ type: "run.resumed", eventId: resumed.eventId, attemptId: resumed.attemptId });
  });

  it.each(["user", "timeout"])("honors %s cancellation while the wait transaction is in flight", async (reason) => {
    const runs = store();
    const original = runs.suspend.bind(runs);
    let release, entered;
    const blocked = new Promise((resolve) => { entered = resolve; });
    runs.suspend = async (...args) => {
      entered();
      await new Promise((resolve) => { release = resolve; });
      await original(...args);
    };
    const executor = createAgentExecutor({
      engine, tools, runs, controllers: [approval],
      bindRun: async (request) => ({ metadata: { extensionPlan: plan },
        terminalOutbox: (result) => extensionTerminalOutbox({ ...request, metadata: { extensionPlan: plan } }, result) })
    });
    const handle = executor.execute({ prompt: "wait", principal: { userId: "owner" } });
    await blocked;
    await handle.abort(reason);
    release();
    expect(await handle.completion).toMatchObject({ status: "aborted", reason });
    expect((await runs.get(handle.runId)).status).toBe("aborted");
    expect(await runs.getLatestCheckpoint(handle.runId)).toBeNull();
    expect((await database.pool.query("SELECT id FROM runtime_run_outbox WHERE space_id=$1 AND run_id=$2",
      [runs.spaceId, handle.runId])).rowCount).toBe(1);
  });

  it("atomically persists waiting cancellation and extension cleanup after restart", async () => {
    const runs = store();
    const first = createAgentExecutor({ engine, tools, runs, controllers: [approval],
      bindRun: async () => ({ metadata: { extensionPlan: plan } })
    }).execute({ prompt: "wait", principal: { userId: "owner" } });
    await first.completion;
    const host = createRuntimeServer({ executor: createAgentExecutor({ engine, tools, runs }), runs,
      waitingTerminalOutbox: extensionTerminalOutbox });
    const { url } = await host.start();
    try {
      expect((await request(url, `/v1/runs/${first.runId}/abort`, {})).status).toBe(202);
      await vi.waitFor(() => expect(host.isIdle()).toBe(true));
      expect((await database.pool.query("SELECT id FROM runtime_run_outbox WHERE space_id=$1 AND run_id=$2",
        [runs.spaceId, first.runId])).rowCount).toBe(1);
      expect(await runs.getLatestCheckpoint(first.runId)).toBeNull();
    } finally { await host.close(); }
  });

  it("projects the final assistant message after a multi-turn beforeStop resume", async () => {
    const runs = store(), sessionId = "final-message";
    await runs.createSession({ id: sessionId, status: "active", policy: {}, metadata: {},
      createdAt: Date.now(), updatedAt: Date.now() });
    const controllers = [{ id: "stop", stages: ["beforeStop"], async handle(context) {
      return context.resume ? { action: "accept-stop" } : { action: "pause", reason: "confirm" };
    } }];
    const executor = createAgentExecutor({ runs, controllers,
      tools: { ...tools, listTools: async () => [{ name: "read" }] },
      engine: { id: "multi", async *streamTurn({ turn }) {
        if (turn === 1) {
          yield { type: "message.delta", delta: "PLAN " };
          yield { type: "tool.call", call: { id: "read-1", name: "read", arguments: {} } };
        } else yield { type: "message.delta", delta: "FINAL" };
      } }
    });
    const first = executor.execute({ sessionId, prompt: "plan then answer", policy: { allowedTools: ["read"] } });
    const waiting = await first.completion;
    const host = createRuntimeServer({ executor, runs, runControllers: controllers });
    const { url } = await host.start();
    try {
      expect((await request(url, `/v1/runs/${first.runId}/resume`, { waitId: waiting.waiting.id, input: {} })).status).toBe(202);
      await vi.waitFor(async () => expect((await runs.get(first.runId)).status).toBe("completed"));
      await vi.waitFor(() => expect(host.isIdle()).toBe(true));
      const messages = await runs.getSessionMessages(sessionId);
      expect(messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["FINAL"]);
    } finally { await host.close(); }
  });

  it("gives failed and resumed terminal attempts independent afterRun keys", async () => {
    const runs = store(), keys = [];
    let fail = true;
    const controllers = [
      { id: "journal", stages: ["afterTool"], async handle() {
        if (fail) { fail = false; throw new Error("journal unavailable"); }
        return { action: "pass" };
      } },
      { id: "terminal", stages: ["afterRun"], async handle(context) {
        keys.push([context.idempotencyKey, context.result.status]);
        return { action: "pass" };
      } }
    ];
    const executor = createAgentExecutor({ runs, controllers,
      tools: { ...tools, listTools: async () => [{ name: "read" }] },
      engine: { id: "journal", async *streamTurn({ turn }) {
        if (turn === 1) yield { type: "tool.call", call: { id: "read", name: "read", arguments: {} } };
        else yield { type: "message.delta", delta: "done" };
      } }
    });
    const host = createRuntimeServer({ executor, runs, runControllers: controllers });
    const { url } = await host.start();
    try {
      const { runId } = await (await request(url, "/v1/runs", {
        prompt: "read", policy: { allowedTools: ["read"] }
      })).json();
      await vi.waitFor(() => expect(keys).toHaveLength(1));
      await vi.waitFor(() => expect(host.isIdle()).toBe(true));
      expect((await request(url, `/v1/runs/${runId}/resume`, {})).status).toBe(202);
      await vi.waitFor(() => expect(keys).toHaveLength(2));
      expect(keys.map((entry) => entry[1])).toEqual(["failed", "completed"]);
      expect(keys[0][0]).not.toBe(keys[1][0]);
    } finally { await host.close(); }
  });

  it("repairs the final Session reply after completion was committed before a restart", async () => {
    const runs = store(), sessionId = "restart-final";
    await runs.createSession({ id: sessionId, status: "active", policy: {}, metadata: {},
      createdAt: Date.now(), updatedAt: Date.now() });
    const controllers = [{ id: "stop", stages: ["beforeStop"], async handle(context) {
      return context.resume ? { action: "accept-stop" } : { action: "pause", reason: "confirm" };
    } }];
    const executor = createAgentExecutor({ runs, controllers,
      tools: { ...tools, listTools: async () => [{ name: "read" }] },
      engine: { id: "multi", async *streamTurn({ turn }) {
        if (turn === 1) {
          yield { type: "message.delta", delta: "PLAN " };
          yield { type: "tool.call", call: { id: "read", name: "read", arguments: {} } };
        } else yield { type: "message.delta", delta: "FINAL" };
      } }
    });
    const first = executor.execute({ sessionId, prompt: "answer", policy: { allowedTools: ["read"] } });
    const waiting = await first.completion;
    await runs.appendSessionMessages(sessionId, [{ schemaVersion: 1, id: "user", sessionId,
      runId: first.runId, role: "user", content: "answer", createdAt: Date.now() }]);
    await (await executor.resume(first.runId, { waitId: waiting.waiting.id, input: {} })).completion;
    await runs.reconcileCompletedSessionMessages();
    expect((await runs.getSessionMessages(sessionId)).find((message) => message.role === "assistant")?.content).toBe("FINAL");
  });
});
