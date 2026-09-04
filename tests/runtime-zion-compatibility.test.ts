import { describe, expect, it, vi } from "vitest";

const chatMocks = vi.hoisted(() => ({
  proxyLLMRequest: vi.fn()
}));

vi.mock("../extensions/dev.langchain-chat/llm-proxy.ts", () => ({
  proxyLLMRequest: chatMocks.proxyLLMRequest
}));

import {
  createAgentExecutor,
  MemoryRunStore,
  normalizeCapabilityPolicy as normalizeRuntimePolicy,
  type EngineOutputEvent,
  type RunEvent
} from "../packages/runtime/src/index";
import {
  fromZionNextCapabilityPolicy,
  fromZionNextFunctionTool,
  toZionNextRunEvent
} from "../src/runtime/zion-next-compatibility";
import { normalizeRunUsage } from "../src/core/run-ledger";
import { runStream } from "../extensions/dev.langchain-chat/chat-service.js";
import { projectRunEventToSession } from "../extensions/dev.langchain-chat/programmatic-session.js";
import { createProgrammaticExecutor } from "../extensions/dev.langchain-chat/programmatic-runner.js";
import {
  normalizeCapabilityPolicy as normalizeZionNextPolicy
} from "../src/core/run-policy";

function runtimeEvent(type: string, data: Record<string, unknown>): RunEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${type}`,
    runId: "run-1",
    attemptId: "attempt-1",
    sequence: 1,
    type,
    timestamp: 1234,
    data
  };
}

function projectionHarness() {
  const emitted: Array<{ topic: string; payload: any }> = [];
  const usageRecords: any[] = [];
  const state = new Map<string, unknown>();
  return {
    emitted,
    usageRecords,
    state,
    zion: {
      commands: {
        executeCommand: vi.fn(async () => true)
      },
      state: {
        set(key: string, value: unknown) {
          state.set(key, value);
        }
      },
      events: {
        emit(topic: string, payload: any) {
          emitted.push({ topic, payload });
        }
      },
      usage: {
        record(payload: any) {
          usageRecords.push(payload);
        }
      }
    }
  };
}

function createSseResponse(payload: string) {
  const encoder = new TextEncoder();
  let consumed = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        async read() {
          if (consumed) return { done: true, value: undefined };
          consumed = true;
          return { done: false, value: encoder.encode(payload) };
        },
        async cancel() {}
      })
    }
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

const COMMON_LOOP_EVENTS = new Set([
  "run.started",
  "turn.started",
  "tool.requested",
  "tool.completed",
  "message.delta",
  "message.completed",
  "turn.completed",
  "run.completed"
]);

describe("Runtime compatibility with current zion-next contracts", () => {
  it("adapts existing RunPolicy fields and aliases outside Runtime Core", () => {
    const fixture: Parameters<typeof normalizeRuntimePolicy>[0] = {
      preset: "trusted-automation",
      allowedTools: ["fsWrite", "fsEdit", "terminalExecute", "sendMail"],
      fileRoots: ["/workspace/project"],
      allowedCommandPrefixes: ["npm test"],
      allowedTerminalSessionIds: ["terminal-1"],
      allowedRecipients: ["TEAM@example.com"],
      maxMailPerRun: 2,
      maxToolCalls: 12
    };

    expect(fromZionNextCapabilityPolicy(fixture)).toEqual(
      normalizeZionNextPolicy(fixture)
    );
    expect(fromZionNextCapabilityPolicy(fixture)).toMatchObject({
      preset: "trusted-automation",
      allowedTools: ["write", "edit", "Bash", "sendMail"],
      allowedRecipients: ["team@example.com"]
    });
    expect(normalizeRuntimePolicy(fixture).allowedTools).toEqual([
      "fsWrite",
      "fsEdit",
      "terminalExecute",
      "sendMail"
    ]);
  });

  it("normalizes the existing OpenAI function-tool schema", () => {
    expect(fromZionNextFunctionTool({
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            session_id: { type: "string" }
          },
          required: ["path", "session_id"],
          additionalProperties: false
        }
      }
    })).toEqual({
      name: "read",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          session_id: { type: "string" }
        },
        required: ["path", "session_id"],
        additionalProperties: false
      }
    });
  });

  it("projects Runtime tool events through the existing session projector", async () => {
    const harness = projectionHarness();
    const requested = toZionNextRunEvent(runtimeEvent("tool.requested", {
      turn: 1,
      callId: "call-1",
      name: "read",
      arguments: {
        path: "/workspace/package.json",
        session_id: "terminal-1"
      }
    }));
    const completed = toZionNextRunEvent(runtimeEvent("tool.completed", {
      turn: 1,
      callId: "call-1",
      name: "read",
      ok: true,
      result: "{\"name\":\"zion-next\"}",
      artifactIds: ["artifact-1"]
    }));

    const projectionOptions = {
      panelId: "panel-1",
      assistantBlockId: "assistant-1"
    };
    await projectRunEventToSession(
      harness.zion,
      "session-1",
      requested,
      projectionOptions
    );
    await projectRunEventToSession(
      harness.zion,
      "session-1",
      completed,
      projectionOptions
    );

    expect(requested.ts).toBe(1234);
    expect(harness.emitted).toEqual([
      {
        topic: "chat/toolCall",
        payload: expect.objectContaining({
          runId: "run-1",
          sessionId: "session-1",
          panelId: "panel-1",
          assistantBlockId: "assistant-1",
          toolCall: {
            id: "call-1",
            name: "read",
            args: {
              path: "/workspace/package.json",
              session_id: "terminal-1"
            },
            presentation: {
              version: 1,
              renderer: "generic",
              title: "read",
              status: "running"
            }
          }
        })
      },
      {
        topic: "chat/toolResult",
        payload: expect.objectContaining({
          runId: "run-1",
          sessionId: "session-1",
          toolCallId: "call-1",
          result: "{\"name\":\"zion-next\"}",
          ok: true,
          artifactIds: ["artifact-1"],
          presentation: {
            version: 1,
            renderer: "generic",
            title: "read",
            status: "completed",
            artifactIds: ["artifact-1"]
          }
        })
      }
    ]);
  });

  it("projects Runtime model requests into the existing LLM Requests panel contract", async () => {
    const harness = projectionHarness();
    const requestEvent = toZionNextRunEvent(runtimeEvent("model.request", {
      turn: 2,
      providerId: "deepseek",
      providerType: "openai",
      modelId: "deepseek-v4-flash",
      modelLabel: "DeepSeek V4 Flash",
      url: "https://api.deepseek.com/chat/completions",
      stream: true,
      payload: {
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: "identity context" },
          { role: "user", content: "hello" }
        ],
        tools: []
      }
    }));

    await projectRunEventToSession(
      harness.zion,
      "session-1",
      requestEvent,
      {
        requestSource: "interactive",
        panelId: "panel-1"
      }
    );

    expect(harness.emitted).toEqual([{
      topic: "llm/requestPayload",
      payload: expect.objectContaining({
        id: "event-model.request",
        runId: "run-1",
        sessionId: "session-1",
        panelId: "panel-1",
        source: "interactive",
        stepIndex: 2,
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        messageCount: 2,
        toolCount: 0,
        payload: expect.objectContaining({
          model: "deepseek-v4-flash",
          messages: expect.any(Array)
        })
      })
    }]);
    expect((harness.zion as any).__llmPayloadQueue).toHaveLength(1);
  });

  it("keeps interactive Runtime tokens on the existing editor anchor", async () => {
    const harness = projectionHarness();
    const appendAssistantToken = vi.fn(async () => true);
    const options = {
      panelId: "panel-1",
      assistantBlockId: "assistant-at-cursor",
      assistantBlockReady: true,
      appendAssistantToken
    };

    await projectRunEventToSession(
      harness.zion,
      "session-1",
      toZionNextRunEvent(runtimeEvent("run.started", {})),
      options
    );
    await projectRunEventToSession(
      harness.zion,
      "session-1",
      toZionNextRunEvent(runtimeEvent("message.delta", { delta: "anchored" })),
      options
    );

    expect(appendAssistantToken).toHaveBeenCalledWith(
      "anchored",
      expect.objectContaining({ type: "message.delta" })
    );
    expect(harness.zion.commands.executeCommand).not.toHaveBeenCalledWith(
      "zion.sessions.ensureAssistantBlock",
      expect.anything()
    );
    expect(harness.zion.commands.executeCommand).not.toHaveBeenCalledWith(
      "zion.sessions.appendAssistantToken",
      expect.anything()
    );
    expect(harness.emitted).toEqual([
      {
        topic: "chat/runStarted",
        payload: expect.objectContaining({
          panelId: "panel-1",
          assistantBlockId: "assistant-at-cursor"
        })
      },
      {
        topic: "chat/token",
        payload: expect.objectContaining({
          token: "anchored",
          panelId: "panel-1",
          assistantBlockId: "assistant-at-cursor"
        })
      }
    ]);
  });

  it("matches ordinary Chat reasoning, token, usage, and completion projection", async () => {
    chatMocks.proxyLLMRequest.mockReset();
    chatMocks.proxyLLMRequest.mockResolvedValueOnce(createSseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"inspect "},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":2}}}',
      "data: [DONE]",
      ""
    ].join("\n")));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));

    const currentEvents: Array<{ topic: string; payload: any }> = [];
    const currentRunId = "current-run";
    window.zion = {
      models: {
        getProvider: () => ({
          resolve: async () => ({
            providerType: "openai",
            modelName: "test-model",
            url: "https://example.test/v1/chat/completions",
            key: "test-key",
            stream: true,
            thinkingMode: "on"
          })
        })
      },
      events: {
        emit(topic: string, payload: any) {
          currentEvents.push({ topic, payload });
        }
      }
    } as any;
    currentEvents.push({
      topic: "chat/runStarted",
      payload: { runId: currentRunId, sessionId: "session-1" }
    });
    const currentResult = await runStream({
      messages: [{ role: "user", content: "inspect" }],
      activeModel: { providerId: "test", modelId: "test-model" },
      onToken(token: string) {
        currentEvents.push({
          topic: "chat/token",
          payload: { runId: currentRunId, sessionId: "session-1", token }
        });
      },
      onEnd() {
        currentEvents.push({
          topic: "chat/runFinished",
          payload: { runId: currentRunId, sessionId: "session-1" }
        });
      },
      onError: vi.fn(),
      runId: currentRunId,
      sessionId: "session-1",
      assistantBlockId: currentRunId,
      stepIndex: 1
    });
    vi.unstubAllGlobals();

    const runtimeHandle = createAgentExecutor({
      engine: {
        id: "test",
        async *streamTurn() {
          yield { type: "reasoning.delta" as const, delta: "inspect " };
          yield { type: "message.delta" as const, delta: "done" };
          yield {
            type: "model.usage" as const,
            usage: {
              inputTokens: 5,
              outputTokens: 3,
              cacheReadTokens: 2,
              reasoningTokens: 2
            }
          };
        }
      },
      tools: {
        async listTools() {
          return [];
        },
        async invoke() {
          return { ok: true, content: "" };
        }
      },
      runs: new MemoryRunStore()
    }).execute({
      prompt: "inspect",
      sessionId: "session-1",
      model: { providerId: "test", modelId: "test-model" }
    });
    const [, runtimeEvents] = await Promise.all([
      runtimeHandle.completion,
      collect(runtimeHandle.events)
    ]);
    const harness = projectionHarness();
    const adaptedEvents = runtimeEvents.map(toZionNextRunEvent);
    for (const event of adaptedEvents) {
      await projectRunEventToSession(harness.zion, "session-1", event);
    }

    const currentChatEvents = currentEvents.filter(({ topic }) =>
      topic.startsWith("chat/")
    );
    expect(harness.emitted.map(({ topic }) => topic)).toEqual(
      currentChatEvents.map(({ topic }) => topic)
    );
    expect(harness.emitted.find(({ topic }) => topic === "chat/reasoningToken")?.payload)
      .toMatchObject({ token: "inspect ", stepIndex: 1 });
    expect(harness.emitted.find(({ topic }) => topic === "chat/token")?.payload)
      .toMatchObject({ token: "done" });

    const adaptedUsage = adaptedEvents.find(({ type }) => type === "model.usage");
    expect(normalizeRunUsage(adaptedUsage?.data.usage)).toEqual({
      input: 5,
      output: 3,
      total: 8,
      cacheRead: 2,
      cacheWrite: 0,
      reasoning: 2
    });
    expect(currentResult.usage).toMatchObject({
      input: 5,
      output: 3,
      total: 8,
      cacheRead: 2,
      reasoning: 2
    });
    expect(harness.usageRecords).toEqual([
      expect.objectContaining({
        runId: runtimeHandle.runId,
        sessionId: "session-1",
        providerId: "test",
        modelId: "test-model",
        stepIndex: 1,
        usage: expect.objectContaining({
          input: 5,
          output: 3,
          total: 8,
          reasoning: 2
        })
      })
    ]);
  });

  it("matches ordinary Chat failure and abort terminal projection", async () => {
    const failed = projectionHarness();
    for (const event of [
      runtimeEvent("run.started", {}),
      runtimeEvent("reasoning.started", { turn: 1 }),
      runtimeEvent("reasoning.delta", { turn: 1, delta: "partial" }),
      runtimeEvent("run.failed", { error: "provider unavailable" })
    ]) {
      await projectRunEventToSession(
        failed.zion,
        "session-failed",
        toZionNextRunEvent(event)
      );
    }
    expect(failed.emitted.map(({ topic }) => topic)).toEqual([
      "chat/runStarted",
      "chat/reasoningStart",
      "chat/reasoningToken",
      "chat/runError",
      "chat/runFinished"
    ]);
    expect(failed.state.get("chat.runs.session-failed")).toMatchObject({
      streaming: false,
      aborted: false,
      awaiting: false,
      error: true
    });

    const aborted = projectionHarness();
    for (const event of [
      runtimeEvent("run.started", {}),
      runtimeEvent("run.aborted", { reason: "user" })
    ]) {
      await projectRunEventToSession(
        aborted.zion,
        "session-aborted",
        toZionNextRunEvent(event)
      );
    }
    expect(aborted.emitted.map(({ topic }) => topic)).toEqual([
      "chat/runStarted",
      "chat/aborted",
      "chat/runFinished"
    ]);
    expect(aborted.state.get("chat.runs.session-aborted")).toMatchObject({
      streaming: false,
      aborted: true,
      awaiting: false,
      error: false
    });
  });

  it("batches high-frequency reasoning deltas before UI projection", async () => {
    const harness = projectionHarness();
    await projectRunEventToSession(
      harness.zion,
      "session-reasoning",
      toZionNextRunEvent(runtimeEvent("reasoning.started", { turn: 1 }))
    );
    for (let index = 0; index < 100; index += 1) {
      await projectRunEventToSession(
        harness.zion,
        "session-reasoning",
        toZionNextRunEvent(runtimeEvent("reasoning.delta", {
          turn: 1,
          delta: "x"
        }))
      );
    }

    expect(harness.emitted.filter(({ topic }) =>
      topic === "chat/reasoningToken"
    )).toHaveLength(0);

    await projectRunEventToSession(
      harness.zion,
      "session-reasoning",
      toZionNextRunEvent(runtimeEvent("reasoning.completed", { turn: 1 }))
    );

    const tokens = harness.emitted.filter(({ topic }) =>
      topic === "chat/reasoningToken"
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0].payload.token).toBe("x".repeat(100));
    expect(harness.emitted.at(-1)?.topic).toBe("chat/reasoningEnd");
  });

  it("routes message completion to the pending assistant projection hook", async () => {
    const harness = projectionHarness();
    const completeAssistantMessage = vi.fn(async () => undefined);

    await projectRunEventToSession(
      harness.zion,
      "session-message",
      toZionNextRunEvent(runtimeEvent("message.completed", {
        turn: 1,
        content: "complete"
      })),
      {
        assistantBlockId: "run-1",
        completeAssistantMessage
      }
    );

    expect(completeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-message",
        runId: "run-1",
        content: "complete"
      }),
      expect.objectContaining({
        type: "message.completed"
      })
    );
  });



  it("matches the existing programmatic executor for a two-turn tool loop", async () => {
    let legacyTurn = 0;
    const legacyExecute = createProgrammaticExecutor({
      getTools: () => [{
        type: "function",
        function: {
          name: "read",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              session_id: { type: "string" }
            },
            required: ["path", "session_id"]
          }
        }
      }],
      getActiveModel: () => ({ providerId: "test", modelId: "test" }),
      runContributors: async (messages: any[]) => messages,
      runStream: async ({ onToolCall, onToken, onEnd }: any) => {
        legacyTurn += 1;
        if (legacyTurn === 1) {
          onToolCall({
            id: "call-1",
            name: "read",
            args: { path: "/workspace/package.json", session_id: "terminal-1" }
          });
        } else {
          onToken("zion-next");
        }
        onEnd();
        return {};
      },
      executeTool: async () => "{\"name\":\"zion-next\"}"
    });
    const legacyHandle = legacyExecute({
      prompt: "read package",
      executionMode: "local-only",
      sessionId: "session-1",
      policy: {
        preset: "read-only",
        allowedTools: ["read"],
        fileRoots: ["/workspace"],
        allowedTerminalSessionIds: ["terminal-1"]
      }
    });
    const [legacyResult, legacyEvents] = await Promise.all([
      legacyHandle.completion,
      collect(legacyHandle.events)
    ]);

    const runtimeTurns: EngineOutputEvent[][] = [[{
      type: "tool.call",
      call: {
        id: "call-1",
        name: "read",
        arguments: {
          path: "/workspace/package.json",
          session_id: "terminal-1"
        }
      }
    }], [{
      type: "message.delta",
      delta: "zion-next"
    }]];
    let runtimeTurn = 0;
    const runtimeHandle = createAgentExecutor({
      engine: {
        id: "test",
        async *streamTurn() {
          for (const event of runtimeTurns[runtimeTurn++] || []) yield event;
        }
      },
      tools: {
        async listTools() {
          return [{
            name: "read",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string" },
                session_id: { type: "string" }
              },
              required: ["path", "session_id"]
            }
          }];
        },
        async invoke() {
          return { ok: true, content: "{\"name\":\"zion-next\"}" };
        }
      },
      runs: new MemoryRunStore()
    }).execute({
      prompt: "read package",
      sessionId: "session-1",
      model: { providerId: "test", modelId: "test" },
      policy: {
        preset: "read-only",
        allowedTools: ["read"],
        fileRoots: ["/workspace"],
        allowedTerminalSessionIds: ["terminal-1"]
      }
    });
    const [runtimeResult, runtimeEvents] = await Promise.all([
      runtimeHandle.completion,
      collect(runtimeHandle.events)
    ]);

    expect(runtimeResult.output).toBe(legacyResult.output);
    expect(runtimeEvents
      .map(toZionNextRunEvent)
      .filter((event) => COMMON_LOOP_EVENTS.has(event.type))
      .map((event) => event.type)
    ).toEqual(
      legacyEvents
        .filter((event: any) => COMMON_LOOP_EVENTS.has(event.type))
        .map((event: any) => event.type)
    );
    expect(runtimeEvents
      .map(toZionNextRunEvent)
      .find((event) => event.type === "tool.requested")?.data)
      .toMatchObject(
        legacyEvents.find((event: any) => event.type === "tool.requested")?.data
      );
    expect(runtimeEvents.find((event) => event.type === "tool.completed")?.data)
      .toMatchObject({
        result: "{\"name\":\"zion-next\"}"
      });
  });
});
