import { describe, expect, it, vi } from "vitest";
import {
  createAgentExecutor,
  MemoryRunStore,
  type AgentEngine,
  type CancellationSignal,
  type EngineOutputEvent,
  type EngineTurnRequest,
  type RunRequest,
  type ToolBroker,
  type ToolInvocation
} from "../src/index";

class ScriptedEngine implements AgentEngine {
  readonly id = "scripted";
  readonly requests: EngineTurnRequest[] = [];

  constructor(private readonly turns: EngineOutputEvent[][]) {}

  async *streamTurn(request: EngineTurnRequest): AsyncIterable<EngineOutputEvent> {
    this.requests.push(request);
    for (const event of this.turns[this.requests.length - 1] || []) {
      yield event;
    }
  }
}

function ids() {
  let value = 0;
  return (prefix: string) => `${prefix}-${++value}`;
}

function clock() {
  let value = 1000;
  return () => ++value;
}

function toolBroker(options: {
  list?: ToolBroker["listTools"];
  invoke?: ToolBroker["invoke"];
} = {}): ToolBroker {
  return {
    listTools: options.list || (async () => []),
    invoke: options.invoke || (async () => ({ ok: true, content: "ok" }))
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("standalone agent executor", () => {
  it("previews the exact first model request without starting model transport", async () => {
    const store = new MemoryRunStore();
    let resumedAfterRequest = false;
    const engine: AgentEngine = {
      id: "preview",
      async *streamTurn(request) {
        yield {
          type: "model.request",
          request: {
            url: "https://model.test/v1/chat/completions",
            providerId: "test",
            providerType: "openai",
            modelId: "small",
            stream: true,
            payload: {
              model: "small",
              messages: request.messages,
              tools: request.tools
            }
          }
        };
        resumedAfterRequest = true;
        throw new Error("model transport must not start during preview");
      }
    };
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker({
        list: async () => [{
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: {} }
        }]
      }),
      contexts: [{
        id: "identity",
        stage: "pre",
        async prepare() {
          return [{ role: "system", content: "identity" }];
        }
      }, {
        id: "memory",
        stage: "post",
        async contribute(messages) {
          return [...messages, { role: "user", content: "memory" }];
        }
      }],
      runs: store,
      createId: ids(),
      now: clock()
    });

    const preview = await executor.preview({
      prompt: "hello",
      model: { providerId: "test", modelId: "small" },
      policy: { preset: "read-only", allowedTools: ["read"] }
    });

    expect(preview.request.payload).toEqual({
      model: "small",
      messages: [
        { role: "system", content: "identity" },
        { role: "user", content: "hello" },
        { role: "user", content: "memory" }
      ],
      tools: [{
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object", properties: {} }
      }]
    });
    expect(preview.contextFailures).toEqual([]);
    expect(resumedAfterRequest).toBe(false);
    await expect(store.get(preview.runId)).resolves.toBeNull();
  });

  it("keeps preview and executed first-turn provider payloads identical", async () => {
    const store = new MemoryRunStore();
    const engine: AgentEngine = {
      id: "preview-parity",
      async *streamTurn(request) {
        yield {
          type: "model.request",
          request: {
            url: "https://model.test/v1/chat/completions",
            providerId: "test",
            providerType: "openai",
            modelId: "small",
            stream: true,
            payload: {
              model: "small",
              messages: request.messages,
              tools: request.tools,
              temperature: 0
            }
          }
        };
        yield { type: "message.delta", delta: "done" };
      }
    };
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker({
        list: async () => [{
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: {} }
        }]
      }),
      contexts: [{
        id: "identity",
        stage: "pre",
        async prepare() {
          return [{ role: "system", content: "identity" }];
        }
      }, {
        id: "memory",
        stage: "post",
        async contribute(messages) {
          return [...messages, { role: "user", content: "memory" }];
        }
      }],
      runs: store,
      createId: ids(),
      now: clock()
    });
    const request: RunRequest = {
      prompt: "hello",
      model: { providerId: "test", modelId: "small" },
      policy: { preset: "read-only", allowedTools: ["read"] }
    };

    const preview = await executor.preview(request);
    const handle = executor.execute(request);
    const [, liveEvents] = await Promise.all([
      handle.completion,
      collect(handle.events)
    ]);
    const actual = liveEvents.find((event) =>
      event.type === "model.request"
    );

    expect(actual?.data.payload).toEqual(preview.request.payload);
  });

  it("persists an ordered no-tool run without browser dependencies", async () => {
    const store = new MemoryRunStore();
    const engine = new ScriptedEngine([[
      { type: "message.delta", delta: "hello " },
      { type: "message.delta", delta: "world" },
      {
        type: "model.usage",
        usage: { inputTokens: 4, outputTokens: 2 }
      }
    ]]);
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker(),
      runs: store,
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({
      prompt: "say hello",
      sessionId: "session-1",
      model: { providerId: "test", modelId: "small" }
    });
    const [result, events] = await Promise.all([
      handle.completion,
      collect(handle.events)
    ]);

    expect(result).toMatchObject({
      runId: handle.runId,
      attemptId: handle.attemptId,
      status: "completed",
      output: "hello world",
      usage: { inputTokens: 4, outputTokens: 2 }
    });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "turn.started",
      "message.delta",
      "message.delta",
      "model.usage",
      "message.completed",
      "turn.completed",
      "run.completed"
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(store.get(handle.runId)).resolves.toMatchObject({
      status: "completed",
      terminalReason: "completed"
    });
    expect((await store.getEvents(handle.runId)).map((event) => event.type))
      .toEqual([
        "run.started",
        "turn.started",
        "model.usage",
        "message.completed",
        "turn.completed",
        "run.completed"
      ]);
    await expect(store.getTranscript(handle.runId)).resolves.toEqual([
      expect.objectContaining({
        turn: 1,
        ordinal: 0,
        role: "assistant",
        content: "hello world"
      })
    ]);
  });

  it("persists model request diagnostics without prompt or tool schema bodies", async () => {
    const store = new MemoryRunStore();
    const engine = new ScriptedEngine([[
      {
        type: "model.request",
        request: {
          url: "https://model.test/v1/chat/completions",
          providerId: "test",
          providerType: "openai",
          modelId: "small",
          stream: true,
          payload: {
            model: "small",
            messages: [{ role: "user", content: "private prompt" }],
            tools: [{
              type: "function",
              function: {
                name: "read",
                parameters: { type: "object", properties: { secret: { type: "string" } } }
              }
            }],
            temperature: 0.2
          }
        }
      },
      { type: "message.delta", delta: "done" }
    ]]);
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker(),
      runs: store,
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({ prompt: "private prompt" });
    const [, liveEvents] = await Promise.all([
      handle.completion,
      collect(handle.events)
    ]);
    const requestEvent = (await store.getEvents(handle.runId))
      .find((event) => event.type === "model.request");
    const liveRequestEvent = liveEvents.find((event) =>
      event.type === "model.request"
    );

    expect(requestEvent?.data).toMatchObject({
      summaryVersion: 1,
      turn: 1,
      modelId: "small",
      stream: true,
      messageCount: 1,
      toolCount: 1,
      toolNames: ["read"],
      payloadBytes: expect.any(Number),
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      messagesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      toolsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      config: {
        temperature: 0.2
      }
    });
    expect(JSON.stringify(requestEvent)).not.toContain("private prompt");
    expect(JSON.stringify(requestEvent)).not.toContain("secret");
    expect(requestEvent?.data).not.toHaveProperty("payload");
    expect(liveRequestEvent?.data.payload).toMatchObject({
      messages: [{ role: "user", content: "private prompt" }]
    });
  });

  it("executes an allowed tool and gives its result to the next turn", async () => {
    const store = new MemoryRunStore();
    const engine = new ScriptedEngine([
      [{
        type: "reasoning.delta",
        delta: "inspect first"
      }, {
        type: "message.delta",
        delta: "searching"
      }, {
        type: "tool.call",
        call: {
          id: "call-1",
          name: "search",
          arguments: { query: "runtime" }
        }
      }],
      [{ type: "message.delta", delta: "found it" }]
    ]);
    const invocations: ToolInvocation[] = [];
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker({
        list: async () => [{ name: "search" }, { name: "write" }],
        invoke: async (invocation) => {
          invocations.push(invocation);
          return { ok: true, content: "three results" };
        }
      }),
      runs: store,
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({
      prompt: "search",
      target: { nodeId: "node:cloud-runtime" },
      policy: { allowedTools: ["search"], maxToolCalls: 2 }
    });
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      output: "searchingfound it"
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      invocationId: `${handle.runId}:turn:1:tool:0`,
      target: { nodeId: "node:cloud-runtime" },
      toolCall: { name: "search", arguments: { query: "runtime" } }
    });
    await expect(store.get(handle.runId)).resolves.toMatchObject({
      target: { nodeId: "node:cloud-runtime" }
    });
    expect(engine.requests[0].tools.map((tool) => tool.name)).toEqual(["search"]);
    expect(engine.requests[1].messages.at(-2)).toEqual({
      role: "assistant",
      content: "searching",
      reasoningContent: "inspect first",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: {
          name: "search",
          arguments: "{\"query\":\"runtime\"}"
        }
      }]
    });
    expect(engine.requests[1].messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-1",
      content: "three results",
      toolResultStatus: { ok: true }
    });
    const reasoningEvents = (await store.getEvents(handle.runId))
      .filter((event) => event.type.startsWith("reasoning."));
    expect(reasoningEvents.map((event) => event.type)).toEqual([
      "reasoning.started",
      "reasoning.completed"
    ]);
    expect(reasoningEvents.map((event) => event.data)).toEqual([
      { turn: 1 },
      { turn: 1, content: "inspect first" }
    ]);
    expect((await store.getEvents(handle.runId))
      .filter(event => event.type === "message.completed").map(event => event.data))
      .toEqual([{ turn: 1, content: "searching" }, { turn: 2, content: "found it" }]);
    await expect(store.getTranscript(handle.runId)).resolves.toEqual([
      expect.objectContaining({
        turn: 1,
        ordinal: 0,
        role: "assistant",
        reasoningContent: "inspect first",
        toolCalls: [expect.objectContaining({ id: "call-1" })]
      }),
      expect.objectContaining({
        turn: 1,
        ordinal: 1,
        role: "tool",
        toolCallId: "call-1",
        content: "three results"
      }),
      expect.objectContaining({
        turn: 2,
        ordinal: 0,
        role: "assistant",
        content: "found it"
      })
    ]);
  });

  it("matches zion-next pre-once and post-per-turn contributor semantics", async () => {
    const store = new MemoryRunStore();
    const engine = new ScriptedEngine([
      [{
        type: "tool.call",
        call: {
          id: "call-1",
          name: "search",
          arguments: { query: "runtime" }
        }
      }],
      [{ type: "message.delta", delta: "done" }]
    ]);
    const pre = vi.fn(async (messages) => [
      ...messages,
      { role: "system" as const, content: "pre context" }
    ]);
    const post = vi.fn(async (messages, context) => [
      ...messages,
      { role: "system" as const, content: `post turn ${context.turn}` }
    ]);
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker({
        list: async () => [{ name: "search" }],
        invoke: async () => ({ ok: true, content: "result" })
      }),
      contexts: [{
        id: "legacy",
        prepare: async () => [{ role: "system", content: "legacy context" }]
      }, {
        id: "pre",
        stage: "pre",
        order: 10,
        contribute: pre
      }, {
        id: "broken",
        stage: "pre",
        order: 20,
        contribute: async () => {
          throw new Error("context unavailable");
        }
      }, {
        id: "post",
        stage: "post",
        contribute: post
      }],
      runs: store,
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({
      prompt: "start",
      policy: { allowedTools: ["search"] }
    });
    const eventsPromise = collect(handle.events);
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      output: "done"
    });
    const events = await eventsPromise;

    expect(pre).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(engine.requests[0].messages.map((message) => message.content)).toEqual([
      "legacy context",
      "start",
      "pre context",
      "post turn 1"
    ]);
    expect(engine.requests[1].messages.at(-1)).toEqual({
      role: "system",
      content: "post turn 2"
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "context.failed",
        data: {
          providerId: "broken",
          stage: "pre",
          error: "context unavailable"
        }
      })
    ]));
  });

  it("applies the Interaction Profile Context Provider allowlist and denylist", async () => {
    const enabledPre = vi.fn(async (messages) => [
      ...messages,
      { role: "system" as const, content: "enabled pre" }
    ]);
    const disabledPre = vi.fn(async (messages) => messages);
    const unlistedPre = vi.fn(async (messages) => messages);
    const enabledPost = vi.fn(async (messages) => [
      ...messages,
      { role: "system" as const, content: "enabled post" }
    ]);
    const engine = new ScriptedEngine([[
      { type: "message.delta", delta: "done" }
    ]]);
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker(),
      contexts: [{
        id: "enabled-pre",
        stage: "pre",
        contribute: enabledPre
      }, {
        id: "disabled-pre",
        stage: "pre",
        contribute: disabledPre
      }, {
        id: "unlisted-pre",
        stage: "pre",
        contribute: unlistedPre
      }, {
        id: "enabled-post",
        stage: "post",
        contribute: enabledPost
      }],
      runs: new MemoryRunStore(),
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({
      prompt: "start",
      metadata: {
        contextProviders: {
          enabled: ["enabled-pre", "disabled-pre", "enabled-post"],
          disabled: ["disabled-pre"]
        }
      }
    });
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      output: "done"
    });

    expect(enabledPre).toHaveBeenCalledTimes(1);
    expect(enabledPost).toHaveBeenCalledTimes(1);
    expect(disabledPre).not.toHaveBeenCalled();
    expect(unlistedPre).not.toHaveBeenCalled();
    expect(engine.requests[0].messages.map((message) => message.content)).toEqual([
      "start",
      "enabled pre",
      "enabled post"
    ]);
  });

  it("returns invalid tool arguments to the engine without invoking a Tool Host", async () => {
    const engine = new ScriptedEngine([
      [{
        type: "tool.call",
        call: {
          id: "invalid-1",
          name: "search",
          arguments: {},
          validationError: "query is required"
        }
      }],
      [{ type: "message.delta", delta: "corrected" }]
    ]);
    const invoke = vi.fn();
    const store = new MemoryRunStore();
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker({
        list: async () => [{ name: "search" }],
        invoke
      }),
      runs: store,
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({
      prompt: "search",
      policy: { allowedTools: ["search"] }
    });
    const eventsPromise = collect(handle.events);
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      output: "corrected"
    });
    const events = await eventsPromise;

    expect(invoke).not.toHaveBeenCalled();
    expect(engine.requests[1].messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "invalid-1",
      content: expect.stringContaining("query is required")
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.denied",
        data: expect.objectContaining({
          callId: "invalid-1",
          denialType: "invalid_arguments",
          reason: "query is required"
        })
      })
    ]));
  });

  it("records capability policy denials separately from invalid arguments", async () => {
    const engine = new ScriptedEngine([
      [{
        type: "tool.call",
        call: {
          id: "denied-1",
          name: "search",
          arguments: { query: "status" }
        }
      }],
      [{ type: "message.delta", delta: "denied" }]
    ]);
    const store = new MemoryRunStore();
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker({
        list: async () => [{ name: "search" }]
      }),
      runs: store,
      authorizeTool: async () => ({
        allowed: false,
        reason: "approval required"
      }),
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({
      prompt: "search",
      policy: { allowedTools: ["search"] }
    });
    const eventsPromise = collect(handle.events);
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      output: "denied"
    });
    const events = await eventsPromise;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.denied",
        data: expect.objectContaining({
          callId: "denied-1",
          denialType: "policy",
          reason: "approval required"
        })
      })
    ]));
  });

  it("settles as failed and closes events when tool discovery throws", async () => {
    const store = new MemoryRunStore();
    const executor = createAgentExecutor({
      engine: new ScriptedEngine([]),
      tools: toolBroker({
        list: async () => {
          throw new Error("tool registry unavailable");
        }
      }),
      runs: store,
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({ prompt: "search" });
    const [result, events] = await Promise.all([
      handle.completion,
      collect(handle.events)
    ]);

    expect(result).toMatchObject({
      status: "failed",
      error: "tool registry unavailable"
    });
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      data: { error: "tool registry unavailable" }
    });
    await expect(store.get(handle.runId)).resolves.toMatchObject({
      status: "failed",
      error: "tool registry unavailable"
    });
  });

  it("propagates abort to a running engine and records a terminal event", async () => {
    const store = new MemoryRunStore();
    let observedSignal: CancellationSignal | null = null;
    const engine: AgentEngine = {
      id: "waiting",
      async *streamTurn(request) {
        yield* [];
        observedSignal = request.signal;
        await new Promise<void>((resolve) => {
          request.signal.onCancel(() => resolve());
        });
        request.signal.throwIfCancelled();
      }
    };
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker(),
      runs: store,
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({ prompt: "wait" });
    while (!observedSignal) await Promise.resolve();
    await handle.abort("user");

    const [result, events] = await Promise.all([
      handle.completion,
      collect(handle.events)
    ]);
    expect(result).toMatchObject({ status: "aborted", reason: "user" });
    expect(observedSignal?.cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "run.aborted",
      data: { reason: "user" }
    });
  });

  it("uses an injected scheduler to enforce timeout without browser timers", async () => {
    let timeoutCallback: (() => void) | null = null;
    const engine: AgentEngine = {
      id: "waiting",
      async *streamTurn(request) {
        yield* [];
        await new Promise<void>((resolve) => {
          request.signal.onCancel(() => resolve());
        });
        request.signal.throwIfCancelled();
      }
    };
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker(),
      runs: new MemoryRunStore(),
      createId: ids(),
      now: clock(),
      scheduleTimeout(callback) {
        timeoutCallback = callback;
        return { dispose: vi.fn() };
      }
    });

    const handle = executor.execute({ prompt: "wait", timeoutMs: 1000 });
    while (!timeoutCallback) await Promise.resolve();
    timeoutCallback();

    const [result, events] = await Promise.all([
      handle.completion,
      collect(handle.events)
    ]);
    expect(result).toMatchObject({ status: "aborted", reason: "timeout" });
    expect(events.at(-1)).toMatchObject({
      type: "run.aborted",
      data: { reason: "timeout" }
    });
  });

  it("fails bounded execution when every turn keeps requesting tools", async () => {
    const engine: AgentEngine = {
      id: "looping",
      async *streamTurn(request) {
        yield {
          type: "tool.call",
          call: {
            id: `call-${request.turn}`,
            name: "search",
            arguments: { query: "again" }
          }
        };
      }
    };
    const store = new MemoryRunStore();
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker({ list: async () => [{ name: "search" }] }),
      runs: store,
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({
      prompt: "loop",
      maxTurns: 2,
      policy: { allowedTools: ["search"], maxToolCalls: 10 }
    });
    const [result, events] = await Promise.all([
      handle.completion,
      collect(handle.events)
    ]);

    expect(result).toMatchObject({
      status: "failed",
      error: "Maximum agent turn count exceeded: 2 "
        + "(tool calls executed: 2/10)"
    });
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("run.failed");
  });

  it("does not let the implicit turn budget shadow the tool-call budget", async () => {
    const store = new MemoryRunStore();
    const engine: AgentEngine = {
      id: "long-tool-chain",
      async *streamTurn(request) {
        if (request.turn <= 16) {
          yield {
            type: "tool.call",
            call: {
              id: `call-${request.turn}`,
              name: "search",
              arguments: { query: String(request.turn) }
            }
          };
          return;
        }
        yield { type: "message.delta", delta: "done" };
      }
    };
    const storeInvoke = vi.fn(async () => ({ ok: true, content: "ok" }));
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker({
        list: async () => [{ name: "search" }],
        invoke: storeInvoke
      }),
      runs: store,
      createId: ids(),
      now: clock()
    });

    const handle = executor.execute({
      prompt: "complete a long tool chain",
      policy: { allowedTools: ["search"], maxToolCalls: 20 }
    });
    const [result, events] = await Promise.all([
      handle.completion,
      collect(handle.events)
    ]);

    expect(result).toMatchObject({
      status: "completed",
      output: "done"
    });
    expect(storeInvoke).toHaveBeenCalledTimes(16);
    expect(events.find((event) => event.type === "run.started")).toMatchObject({
      data: {
        maxTurns: 21,
        maxToolCalls: 20
      }
    });
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(17);
  });

  it("resumes an aborted Run from a checkpoint under a new Attempt", async () => {
    const store = new MemoryRunStore();
    let firstAttemptId = "";
    const contextPrepare = vi.fn(async () => [
      { role: "system" as const, content: "stable context" }
    ]);
    const engine: AgentEngine = {
      id: "resumable",
      async *streamTurn(request) {
        if (!firstAttemptId) firstAttemptId = request.attemptId;
        if (request.attemptId === firstAttemptId && request.turn === 1) {
          yield {
            type: "tool.call",
            call: {
              id: "call-1",
              name: "search",
              arguments: { query: "checkpoint" }
            }
          };
          return;
        }
        if (request.attemptId === firstAttemptId) {
          yield* [];
          await new Promise<void>((resolve) => request.signal.onCancel(() => resolve()));
          request.signal.throwIfCancelled();
          return;
        }
        expect(request.turn).toBe(2);
        expect(request.messages.at(-1)).toEqual({
          role: "tool",
          toolCallId: "call-1",
          content: "checkpoint result",
          toolResultStatus: { ok: true }
        });
        yield { type: "message.delta", delta: "resumed" };
      }
    };
    const executor = createAgentExecutor({
      engine,
      tools: toolBroker({
        list: async () => [{ name: "search" }],
        invoke: async () => ({ ok: true, content: "checkpoint result" })
      }),
      contexts: [{ id: "context", prepare: contextPrepare }],
      runs: store,
      createId: ids(),
      now: clock()
    });

    const first = executor.execute({
      prompt: "continue later",
      policy: { allowedTools: ["search"] }
    });
    let checkpoint = await store.getLatestCheckpoint(first.runId);
    while (!checkpoint || checkpoint.pending) {
      await Promise.resolve();
      checkpoint = await store.getLatestCheckpoint(first.runId);
    }
    expect(checkpoint).toMatchObject({
      attemptId: first.attemptId,
      nextTurn: 2,
      counters: { toolCalls: 1 }
    });
    await first.abort("pause");
    await expect(first.completion).resolves.toMatchObject({
      status: "aborted",
      reason: "pause"
    });

    const resumed = await executor.resume(first.runId);
    const [result, resumedEvents] = await Promise.all([
      resumed.completion,
      collect(resumed.events)
    ]);

    expect(resumed.attemptId).not.toBe(first.attemptId);
    expect(result).toMatchObject({
      runId: first.runId,
      attemptId: resumed.attemptId,
      status: "completed",
      output: "resumed"
    });
    expect(resumedEvents[0]).toMatchObject({
      type: "attempt.started",
      attemptId: resumed.attemptId,
      data: {
        previousAttemptId: first.attemptId,
        resumedFromSequence: checkpoint.sequence
      }
    });
    const allEvents = await store.getEvents(first.runId);
    expect(allEvents.every((event, index) =>
      index === 0 || event.sequence > allEvents[index - 1].sequence
    )).toBe(true);
    expect(allEvents.some((event, index) =>
      index > 0 && event.sequence > allEvents[index - 1].sequence + 1
    )).toBe(true);
    await expect(store.get(first.runId)).resolves.toMatchObject({
      attemptId: resumed.attemptId,
      status: "completed"
    });
    await expect(store.getLatestCheckpoint(first.runId)).resolves.toBeNull();
    expect(contextPrepare).toHaveBeenCalledTimes(1);
  });
});
