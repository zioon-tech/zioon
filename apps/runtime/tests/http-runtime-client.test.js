import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import {
  createHttpRuntimeClient,
  createRemoteRunHandle,
  RuntimeHttpError
} from "../../../src/runtime/http-runtime-client.ts";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const resources = [];
let database;

beforeAll(async () => {
  database = await createPostgresTestDatabase("http_client");
});

afterAll(async () => {
  await database.close();
});

function createHarness(engine) {
  const store = new PostgresRunStore(database.pool, {
    spaceId: database.nextSpaceId()
  });
  const executor = createAgentExecutor({
    engine,
    tools: {
      async listTools() {
        return [];
      },
      async invoke() {
        throw new Error("No tools configured");
      }
    },
    runs: store
  });
  const server = createRuntimeServer({
    executor,
    runs: store,
    port: 0,
    pollIntervalMs: 5
  });
  resources.push({ server, store });
  return server;
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    try {
      await resource.server.close();
    } catch {}
    try {
      await resource.store.close();
    } catch {}
  }
});

describe("HttpRuntimeClient", () => {
  it("creates, observes, and catches up a Run through the Runtime Host API", async () => {
    const server = createHarness({
      id: "echo",
      async *streamTurn(request) {
        yield {
          type: "message.delta",
          delta: `echo:${request.messages.at(-1)?.content || ""}`
        };
      }
    });
    const address = await server.start();
    const client = createHttpRuntimeClient({
      baseUrl: `${address.url}/`
    });

    await expect(client.getModels()).resolves.toEqual({
      activeProfileId: null,
      profiles: []
    });
    const accepted = await client.createRun({ prompt: "hello" });
    expect(accepted).toMatchObject({
      status: "accepted",
      runId: expect.any(String),
      attemptId: expect.any(String)
    });

    const streamed = await collect(client.subscribe(accepted.runId));
    expect(streamed.map((event) => event.type)).toEqual([
      "run.started",
      "turn.started",
      "message.delta",
      "message.completed",
      "turn.completed",
      "run.completed"
    ]);

    await expect(client.getRun(accepted.runId)).resolves.toMatchObject({
      id: accepted.runId,
      attemptId: accepted.attemptId,
      status: "completed",
      output: "echo:hello"
    });
    await expect(client.getEvents(accepted.runId, 4)).resolves.toEqual([
      expect.objectContaining({ sequence: 5, type: "turn.completed" }),
      expect.objectContaining({ sequence: 6, type: "run.completed" })
    ]);
    await expect(client.getEvent(accepted.runId, 3)).resolves.toMatchObject({
      sequence: 3,
      type: "message.delta",
      data: { delta: "echo:hello" }
    });
  });

  it("reads capability catalog and interaction profiles through the client", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/v1/capabilities/tools")) {
        return new Response(JSON.stringify({
          tools: [{ name: "read", hostKinds: ["local-tools"] }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.endsWith("/v1/interaction-profiles") && !init.method) {
        return new Response(JSON.stringify({
          profiles: [{ id: "interactive.default", modelProfileId: "kimi" }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.endsWith("/v1/interaction-profiles/interactive.default") && !init.method) {
        return new Response(JSON.stringify({
          profile: { id: "interactive.default", modelProfileId: "kimi" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.endsWith("/v1/model-profiles/kimi") && init.method === "DELETE") {
        return new Response(JSON.stringify({
          profile: {
            id: "kimi",
            providerId: "user.dynamic",
            model: "kimi-k2.5",
            credentialConfigured: false
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.endsWith("/v1/interaction-profiles/interactive.default") && init.method === "PATCH") {
        return new Response(JSON.stringify({
          profile: {
            id: "interactive.default",
            modelProfileId: "kimi",
            metadata: { includeTerminalContext: false }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.endsWith("/v1/interaction-profiles/interactive.default") && init.method === "PUT") {
        return new Response(JSON.stringify({
          profile: {
            id: "interactive.default",
            modelProfileId: "kimi",
            policy: { allowedTools: ["read"] }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected Runtime request: ${value}`);
    });
    const client = createHttpRuntimeClient({
      baseUrl: "http://runtime.test",
      fetchImpl
    });

    await expect(client.getCapabilityTools()).resolves.toEqual([
      { name: "read", hostKinds: ["local-tools"] }
    ]);
    await expect(client.getInteractionProfiles()).resolves.toEqual([
      { id: "interactive.default", modelProfileId: "kimi" }
    ]);
    await expect(client.getInteractionProfile("interactive.default"))
      .resolves.toMatchObject({ id: "interactive.default" });
    await expect(client.patchInteractionProfile("interactive.default", {
      metadata: { includeTerminalContext: false }
    })).resolves.toMatchObject({
      metadata: { includeTerminalContext: false }
    });
    await expect(client.upsertInteractionProfile("interactive.default", {
      id: "interactive.default",
      modelProfileId: "kimi",
      policy: { allowedTools: ["read"] }
    })).resolves.toMatchObject({
      policy: { allowedTools: ["read"] }
    });
    await expect(client.deleteModelProfile("kimi")).resolves.toMatchObject({
      id: "kimi",
      credentialConfigured: false
    });
  });

  it("applies shared authentication headers to every transport request", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      activeProfileId: null,
      profiles: []
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const client = createHttpRuntimeClient({
      baseUrl: "https://runtime.test",
      fetchImpl,
      headers: { authorization: "Bearer paired-client" },
      credentials: "include"
    });

    await client.getModels();

    const [, init] = fetchImpl.mock.calls[0];
    expect(init).toMatchObject({
      credentials: "include",
      headers: {
        accept: "application/json",
        authorization: "Bearer paired-client"
      }
    });
  });

  it("adapts a remote Run to the existing RunHandle contract", async () => {
    const server = createHarness({
      id: "echo",
      async *streamTurn() {
        yield { type: "message.delta", delta: "runtime output" };
      }
    });
    const address = await server.start();
    const client = createHttpRuntimeClient({ baseUrl: address.url });
    const handle = await createRemoteRunHandle(client, { prompt: "run remotely" });

    const [events, result] = await Promise.all([
      collect(handle.events),
      handle.completion
    ]);

    expect(events.at(-1)).toMatchObject({ type: "run.completed" });
    expect(result).toMatchObject({
      runId: handle.runId,
      attemptId: handle.attemptId,
      status: "completed",
      output: "runtime output"
    });
  });

  it("subscribes to the coalesced projection stream", async () => {
    const server = createHarness({
      id: "projection",
      async *streamTurn() {
        for (let index = 0; index < 50; index += 1) {
          yield { type: "reasoning.delta", delta: "r" };
        }
        for (let index = 0; index < 20; index += 1) {
          yield { type: "message.delta", delta: "x" };
        }
      }
    });
    const address = await server.start();
    const client = createHttpRuntimeClient({ baseUrl: address.url });
    const handle = await createRemoteRunHandle(
      client,
      { prompt: "project remotely" },
      {
        subscription: {
          mode: "projection",
          reasoningMode: "stream",
          maxChunkChars: 4096
        }
      }
    );

    const [events, result] = await Promise.all([
      collect(handle.events),
      handle.completion
    ]);

    expect(events.filter((event) =>
      event.type === "reasoning.delta"
    )).toHaveLength(1);
    expect(events.find((event) =>
      event.type === "reasoning.delta"
    )?.data.delta).toBe("r".repeat(50));
    expect(events.filter((event) =>
      event.type === "message.delta"
    )).toHaveLength(1);
    expect(events.find((event) =>
      event.type === "message.delta"
    )?.data.delta).toBe("x".repeat(20));
    expect(result).toMatchObject({
      status: "completed",
      output: "x".repeat(20)
    });
  });

  it("reconnects a remote Run from the last delivered raw sequence", async () => {
    const subscribedAfter = [];
    let subscriptions = 0;
    const client = {
      createRun: vi.fn(async () => ({
        runId: "run-reconnect",
        attemptId: "attempt-reconnect",
        status: "accepted"
      })),
      subscribe(_runId, options) {
        subscribedAfter.push(options.afterSequence);
        subscriptions += 1;
        return {
          async *[Symbol.asyncIterator]() {
            if (subscriptions === 1) {
              yield {
                runId: "run-reconnect",
                attemptId: "attempt-reconnect",
                sequence: 4,
                type: "turn.started",
                timestamp: 100,
                data: { turn: 1 }
              };
              throw new Error("transport lost");
            }
            yield {
              runId: "run-reconnect",
              attemptId: "attempt-reconnect",
              sequence: 9,
              type: "run.completed",
              timestamp: 200,
              data: {
                output: "done",
                usage: {}
              }
            };
          }
        };
      },
      getRun: vi.fn(async () => ({
        id: "run-reconnect",
        attemptId: "attempt-reconnect",
        status: "running",
        output: "",
        usage: {}
      })),
      abort: vi.fn()
    };
    const handle = await createRemoteRunHandle(
      client,
      { prompt: "reconnect" },
      {
        subscription: { mode: "projection" },
        reconnectDelayMs: 1
      }
    );

    const [events, result] = await Promise.all([
      collect(handle.events),
      handle.completion
    ]);

    expect(subscribedAfter).toEqual([0, 4]);
    expect(events.map((event) => event.sequence)).toEqual([4, 9]);
    expect(result).toMatchObject({
      status: "completed",
      output: "done"
    });
  });

  it("bounds queued client events to propagate stream backpressure", async () => {
    let produced = 0;
    const client = {
      createRun: vi.fn(async () => ({
        runId: "run-backpressure",
        attemptId: "attempt-backpressure",
        status: "accepted"
      })),
      subscribe() {
        return {
          async *[Symbol.asyncIterator]() {
            for (let sequence = 1; sequence <= 100; sequence += 1) {
              produced += 1;
              yield {
                runId: "run-backpressure",
                attemptId: "attempt-backpressure",
                sequence,
                type: "turn.started",
                timestamp: sequence,
                data: { turn: sequence }
              };
            }
            produced += 1;
            yield {
              runId: "run-backpressure",
              attemptId: "attempt-backpressure",
              sequence: 101,
              type: "run.completed",
              timestamp: 101,
              data: { output: "done", usage: {} }
            };
          }
        };
      },
      getRun: vi.fn(),
      abort: vi.fn()
    };
    const handle = await createRemoteRunHandle(
      client,
      { prompt: "backpressure" },
      { maxQueuedEvents: 16 }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(produced).toBeLessThanOrEqual(17);

    const [events, result] = await Promise.all([
      collect(handle.events),
      handle.completion
    ]);
    expect(events).toHaveLength(101);
    expect(result).toMatchObject({
      status: "completed",
      output: "done"
    });
  });

  it("detaches observation without aborting the remote Run", async () => {
    const abort = vi.fn(async () => undefined);
    const client = {
      createRun: vi.fn(async () => ({
        runId: "run-detach",
        attemptId: "attempt-detach",
        status: "accepted",
        model: {
          providerId: "runtime",
          modelId: "runtime-model",
          label: "Runtime Model"
        }
      })),
      subscribe(_runId, options) {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) => {
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener("abort", resolve, { once: true });
            });
            throw new DOMException("Detached", "AbortError");
          }
        };
      },
      getRun: vi.fn(),
      getEvents: vi.fn(),
      abort
    };
    const handle = await createRemoteRunHandle(client, { prompt: "stay alive" });

    handle.detach();

    await expect(handle.completion).resolves.toMatchObject({
      runId: "run-detach",
      status: "aborted",
      reason: "detached"
    });
    expect(handle.model).toEqual({
      providerId: "runtime",
      modelId: "runtime-model",
      label: "Runtime Model"
    });
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts only the selected active Run", async () => {
    let signal;
    const server = createHarness({
      id: "waiting",
      async *streamTurn(request) {
        yield* [];
        signal = request.signal;
        await new Promise((resolve) => request.signal.onCancel(resolve));
        request.signal.throwIfCancelled();
      }
    });
    const address = await server.start();
    const client = createHttpRuntimeClient({ baseUrl: address.url });
    const accepted = await client.createRun({ prompt: "wait" });

    await vi.waitFor(() => expect(signal).toBeTruthy());
    await client.abort(accepted.runId, "workbench-user");

    const events = await collect(client.subscribe(accepted.runId));
    expect(events.at(-1)).toMatchObject({
      type: "run.aborted",
      data: { reason: "workbench-user" }
    });
    await expect(client.getRun(accepted.runId)).resolves.toMatchObject({
      status: "aborted",
      terminalReason: "workbench-user"
    });
  });

  it("surfaces Runtime HTTP failures without hiding their status", async () => {
    const server = createHarness({
      id: "unused",
      async *streamTurn() {
        yield { type: "message.delta", delta: "unused" };
      }
    });
    const address = await server.start();
    const client = createHttpRuntimeClient({ baseUrl: address.url });

    await expect(client.getRun("missing")).rejects.toMatchObject({
      name: RuntimeHttpError.name,
      status: 404,
      message: "Run not found"
    });
  });
});
