import { describe, expect, it, vi } from "vitest";
import {
  createInteractiveRuntimeHandle,
  createInteractiveRuntimePolicy,
  includeTerminalContextForRuntime,
  interactiveRuntimeEligibility,
  observeInteractiveRuntimeRun,
  persistInteractiveRuntimeProfileModel,
  prepareInteractiveRuntimeMessages,
  readInteractiveRuntimeConfig,
  runtimeBackedContributorIds,
  resolveInteractiveRuntimeProfileModel,
  resolveInteractiveRuntimeModel,
  syncWorkbenchModelProfiles
} from "../extensions/dev.langchain-chat/runtime-backend.js";
import { reconstructWidgetHistoryMessages } from "../src/chat/widget-history.ts";

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("interactive Runtime backend", () => {
  it("enables Runtime terminal context unless the Workbench toggle is off", () => {
    expect(includeTerminalContextForRuntime({
      get: vi.fn(() => undefined)
    })).toBe(true);
    expect(includeTerminalContextForRuntime({
      get: vi.fn(() => false)
    })).toBe(false);
    expect(includeTerminalContextForRuntime({
      get: vi.fn(() => true)
    })).toBe(true);
  });

  it("applies Workbench pre/post contributors before creating a Runtime Run", async () => {
    const calls = [];
    const runContributors = vi.fn(async (messages, stage, context) => {
      calls.push({ stage, context });
      if (stage === "pre") {
        return [
          { role: "system", content: "<identity>zion</identity>" },
          ...messages
        ];
      }
      return [
        ...messages,
        { role: "user", content: "<comment_summaries>one</comment_summaries>" }
      ];
    });

    const prepared = await prepareInteractiveRuntimeMessages({
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "hello"
        }, {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" }
        }]
      }],
      runContributors,
      contributorContext: {
        sessionId: "session-1",
        panelId: "panel-1",
        runId: "runtime-context-1"
      }
    });

    expect(prepared).toEqual([
      { role: "system", content: "<identity>zion</identity>" },
      {
        role: "user",
        content: [{
          type: "text",
          text: "hello"
        }, {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" }
        }]
      },
      { role: "user", content: "<comment_summaries>one</comment_summaries>" }
    ]);
    expect(calls.map((call) => call.stage)).toEqual(["pre", "post"]);
    expect(calls[0].context).toMatchObject({
      runtimeBackend: "external",
      sessionId: "session-1",
      excludedContributorIds: []
    });
  });

  it("reconstructs historical thinking and tool messages before post contributors", async () => {
    const stages = [];
    const docText = [
      "user inspect",
      "assistant <!-- zion-assistant:id=run-1 --> Before",
      "思考 <!-- zion-thinking:id=thinking-1 -->",
      "调用 read <!-- zion-tool:id=tool-1 -->",
      "After",
      "user continue"
    ].join("\n");
    const prepared = await prepareInteractiveRuntimeMessages({
      messages: [
        { role: "user", content: "inspect" },
        { role: "assistant", content: "Before\nAfter" },
        { role: "user", content: "continue" }
      ],
      runContributors: async (messages, stage) => {
        stages.push(stage);
        if (stage === "post") {
          expect(messages.some((message) => message.role === "tool")).toBe(true);
        }
        return messages;
      },
      transformMessages: (messages) => reconstructWidgetHistoryMessages(
        messages,
        docText,
        {
          thinking: [{ id: "thinking-1", text: "reasoning" }],
          tools: [{
            id: "tool-1",
            name: "read",
            args: { path: "a.txt" },
            result: "contents"
          }]
        },
        { preservedThinking: true }
      )
    });

    expect(stages).toEqual(["pre", "post"]);
    expect(prepared).toEqual([
      { role: "user", content: "inspect" },
      { role: "assistant", content: "Before", reasoning_content: "reasoning" },
      {
        role: "assistant",
        tool_calls: [{
          id: "tool-1",
          type: "function",
          function: { name: "read", arguments: "{\"path\":\"a.txt\"}" }
        }]
      },
      { role: "tool", tool_call_id: "tool-1", content: "contents" },
      { role: "assistant", content: "After" },
      { role: "user", content: "continue" }
    ]);
  });

  it("rejects contributor output that Runtime cannot serialize", async () => {
    await expect(prepareInteractiveRuntimeMessages({
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "hello"
        }, {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" }
        }]
      }],
      runContributors: async (_messages, stage) => (
        stage === "pre"
          ? [{ role: "tool", tool_call_id: "call-1", content: "result" }]
          : _messages
      )
    })).rejects.toMatchObject({
      code: "RUNTIME_CONTEXT_UNSUPPORTED"
    });
  });

  it("preserves enabled skill catalog injection for Runtime Runs", async () => {
    const prepared = await prepareInteractiveRuntimeMessages({
      messages: [{ role: "user", content: "hello" }],
      runContributors: async (messages, stage) => (
        stage === "pre"
          ? [{
              role: "user",
              content: "<available_skills><skill><name>biography-memory</name></skill></available_skills>"
            }, ...messages]
          : messages
      )
    });

    expect(prepared[0]).toEqual({
      role: "user",
      content: expect.stringContaining("<name>biography-memory</name>")
    });
  });

  it("excludes Workbench contributors already owned by active Runtime providers", async () => {
    const runtimeConnection = {
      backend: "runtime",
      runtimePlugins: [{
        id: "dev.skills",
        status: "active",
        contextProviderIds: ["dev.skills.available"]
      }, {
        id: "dev.memory",
        status: "active",
        contextProviderIds: ["dev.memory.context"]
      }, {
        id: "dev.identity",
        status: "failed",
        contextProviderIds: ["dev.identity.context"]
      }, {
        id: "dev.context-compression",
        status: "active",
        contextProviderIds: ["dev.context-compression"]
      }, {
        id: "dev.terminal-manager",
        status: "active",
        contextProviderIds: ["dev.terminal-manager.inventory"]
      }]
    };
    const calls = [];
    const runContributors = vi.fn(async (messages, stage, context) => {
      calls.push({ stage, excluded: context.excludedContributorIds });
      return messages;
    });

    expect(runtimeBackedContributorIds(runtimeConnection)).toEqual([
      "dev.skills.standard",
      "dev.memory.context",
      "dev.context-compression",
      "dev.terminal-manager.inventory",
      "dev.terminal-enhanced.context"
    ]);

    await prepareInteractiveRuntimeMessages({
      messages: [{ role: "user", content: "hello" }],
      runContributors,
      contributorContext: {
        runtimeConnection,
        excludedContributorIds: ["manual.skip"]
      }
    });

    expect(calls[0].excluded).toEqual([
      "manual.skip",
      "dev.skills.standard",
      "dev.memory.context",
      "dev.context-compression",
      "dev.terminal-manager.inventory",
      "dev.terminal-enhanced.context"
    ]);
  });

  it("defaults to auto and accepts every Runtime-supported tool contract", () => {
    expect(readInteractiveRuntimeConfig({
      state: { get: () => undefined },
      storage: { getItem: () => null }
    })).toEqual({
      mode: "auto",
      enabled: false,
      baseUrl: "http://127.0.0.1:8766"
    });

    expect(interactiveRuntimeEligibility({
      messages: [{ role: "user", content: "hello" }],
      tools: [
        { function: { name: "read" } },
        { function: { name: "webFetch" } }
      ],
      content: "user hello",
      requestSource: "",
      skipSessionPersistence: false
    })).toMatchObject({
      eligible: true,
      toolNames: ["read", "webFetch"]
    });
    expect(interactiveRuntimeEligibility({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ function: { name: "Bash" } }],
      content: "tool: Bash\nuser hello",
      requestSource: "",
      skipSessionPersistence: false
    })).toMatchObject({
      eligible: true,
      reason: null,
      toolNames: ["Bash"]
    });
    expect(interactiveRuntimeEligibility({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ function: { name: "sessionList" } }],
      content: "tool: sessionList\nuser hello",
      requestSource: "",
      skipSessionPersistence: false
    })).toMatchObject({
      eligible: true,
      reason: null,
      toolNames: ["sessionList"]
    });
    expect(interactiveRuntimeEligibility({
      messages: [{ role: "user", content: [{ type: "image_url" }] }],
      tools: [],
      content: "user hello",
      requestSource: "",
      skipSessionPersistence: false
    })).toEqual({
      eligible: false,
      reason: "unsupported-message-shape"
    });
    expect(interactiveRuntimeEligibility({
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "Inspect this image"
        }, {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" }
        }]
      }],
      tools: [],
      content: "user Inspect this image",
      requestSource: "",
      skipSessionPersistence: false
    })).toMatchObject({
      eligible: true,
      reason: null
    });
    expect(interactiveRuntimeEligibility({
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: "{\"path\":\"a.md\"}" }
        }]
      }, {
        role: "tool",
        tool_call_id: "call-1",
        content: "contents"
      }],
      tools: [],
      content: "assistant tool history",
      requestSource: "",
      skipSessionPersistence: false
    })).toMatchObject({
      eligible: true,
      reason: null
    });
    expect(interactiveRuntimeEligibility({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      content: "user hello",
      requestSource: "comments",
      skipSessionPersistence: false
    })).toEqual({
      eligible: false,
      reason: "non-interactive-source"
    });
    expect(interactiveRuntimeEligibility({
      messages: [{ role: "user", content: "hello" }],
      tools: [
        { function: { name: "read" } },
        { function: { name: "Bash" } }
      ],
      content: "user hello",
      requestSource: "",
      skipSessionPersistence: false
    })).toMatchObject({
      eligible: true,
      toolNames: ["read", "Bash"]
    });
    expect(createInteractiveRuntimePolicy([
      { function: { name: "plugin.echo" } }
    ], {
      supportedToolNames: ["plugin.echo"]
    })).toMatchObject({
      policy: {
        allowedTools: ["plugin.echo"],
        preset: "read-only"
      },
      unsupportedTools: []
    });
    expect(createInteractiveRuntimePolicy([
      { function: { name: "toolsManage" } }
    ])).toMatchObject({
      policy: {
        allowedTools: ["toolsManage"],
        preset: "trusted-automation"
      },
      unsupportedTools: []
    });
    expect(createInteractiveRuntimePolicy([
      { function: { name: "mailManage" } }
    ])).toMatchObject({
      policy: {
        allowedTools: ["mailManage"],
        preset: "trusted-automation"
      },
      unsupportedTools: []
    });
    expect(createInteractiveRuntimePolicy([
      { function: { name: "memoryManage" } }
    ])).toMatchObject({
      policy: {
        allowedTools: ["memoryManage"],
        preset: "workspace-write"
      },
      unsupportedTools: []
    });
    expect(createInteractiveRuntimePolicy([
      { function: { name: "agentsManage" } }
    ])).toMatchObject({
      policy: {
        allowedTools: ["agentsManage"],
        preset: "workspace-write"
      },
      unsupportedTools: []
    });
    expect(createInteractiveRuntimePolicy([
      { function: { name: "identityManage" } }
    ])).toMatchObject({
      policy: {
        allowedTools: ["identityManage"],
        preset: "workspace-write"
      },
      unsupportedTools: []
    });
    expect(createInteractiveRuntimePolicy([
      { function: { name: "projectAutomationManage" } }
    ])).toMatchObject({
      policy: {
        allowedTools: ["projectAutomationManage"],
        preset: "workspace-write"
      },
      unsupportedTools: []
    });
  });

  it("derives Runtime capability policy from the tools enabled in Workbench", () => {
    expect(createInteractiveRuntimePolicy([
      { function: { name: "read" } },
      { function: { name: "write" } },
      { function: { name: "Bash" } },
      { function: { name: "sendMail" } },
      { function: { name: "todoWrite" } },
      { function: { name: "sessionList" } },
      { function: { name: "sessionCreate" } }
    ])).toEqual({
      policy: {
        preset: "trusted-automation",
        allowedTools: ["read", "write", "Bash", "sendMail", "todoWrite", "sessionList", "sessionCreate"],
        fileRoots: [],
        allowedCommandPrefixes: [],
        allowedTerminalSessionIds: [],
        allowedRecipients: ["*"],
        maxMailPerRun: 10
      },
      selectedTools: [
        "read",
        "write",
        "Bash",
        "sendMail",
        "todoWrite",
        "sessionList",
        "sessionCreate"
      ],
      unsupportedTools: []
    });
  });

  it("adapts Runtime events to the existing interactive projection contract", async () => {
    const terminalEvent = {
      schemaVersion: 1,
      eventId: "event-completed",
      runId: "runtime-chat-1",
      attemptId: "attempt-chat-1",
      sequence: 1,
      type: "run.completed",
      timestamp: 123,
      data: {
        output: "hello from runtime",
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        }
      }
    };
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({
          activeProfileId: "runtime-profile",
          profiles: [{
            id: "runtime-profile",
            providerId: "test",
            providerType: "openai",
            model: "test-model",
            label: "Runtime Model"
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (value.endsWith("/v1/runs") && init.method === "POST") {
        return new globalThis.Response(JSON.stringify({
          runId: "runtime-chat-1",
          attemptId: "attempt-chat-1",
          status: "accepted",
          model: {
            profileId: "runtime-profile",
            providerId: "test",
            modelId: "test-model",
            label: "Runtime Model"
          }
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      if (value.includes("/projection/stream?after=0")) {
        return new globalThis.Response(
          `event: run.completed\ndata: ${JSON.stringify(terminalEvent)}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      throw new Error(`Unexpected Runtime request: ${value}`);
    });

    const handle = await createInteractiveRuntimeHandle({
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "hello"
        }, {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" }
        }]
      }],
      sessionHistory: [{
        role: "user",
        content: "earlier"
      }, {
        role: "assistant",
        content: "answer"
      }, {
        role: "user",
        content: "hello"
      }],
      tools: [{ function: { name: "read" } }],
      selectedModel: { providerId: "test", modelId: "test-model" },
      selectedModelConfig: {
        thinkingMode: "on",
        thinkingEffort: "high"
      },
      title: "Interactive test",
      workbenchSessionId: "session-1",
      metadata: {
        panelId: "panel-1",
        documentProjection: { appendUserPrompt: true }
      },
      baseUrl: "http://127.0.0.1:9876",
      fetchImpl
    });
    const [events, result] = await Promise.all([
      collect(handle.events),
      handle.completion
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        runId: "runtime-chat-1",
        type: "run.completed",
        ts: 123,
        data: expect.objectContaining({
          usage: expect.objectContaining({ input: 3, output: 4, total: 7 })
        })
      })
    ]);
    expect(result).toMatchObject({
      status: "completed",
      output: "hello from runtime"
    });
    expect(handle.model).toEqual({
      profileId: "runtime-profile",
      providerId: "test",
      modelId: "test-model",
      label: "Runtime Model"
    });
    expect(fetchImpl.mock.calls.some(([url]) =>
      String(url).includes(
        "/projection/stream"
        + "?after=0&reasoning=stream&max_delay_ms=200&max_chunk_chars=1024"
      )
    )).toBe(true);
    const createCall = fetchImpl.mock.calls.find(
      ([url, init]) => String(url).endsWith("/v1/runs") && init?.method === "POST"
    );
    const request = JSON.parse(createCall[1].body);
    expect(request).toMatchObject({
      interactionProfileId: "interactive.default",
      sessionId: "session-1",
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "hello"
        }, {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" }
        }]
      }],
      sessionHistory: [{
        role: "user",
        content: "earlier"
      }, {
        role: "assistant",
        content: "answer"
      }, {
        role: "user",
        content: "hello"
      }],
      model: {
        profileId: "runtime-profile",
        providerId: "test",
        modelId: "test-model"
      },
      modelOptions: {
        thinkingMode: "on",
        thinkingEffort: "high"
      },
      policy: { preset: "read-only", allowedTools: ["read"] },
      metadata: {
        source: "interactive-chat",
        workbenchProtocolVersion: 4,
        interactionProfileId: "interactive.default",
        workbenchSessionId: "session-1",
        panelId: "panel-1",
        documentProjection: { appendUserPrompt: true },
        workbenchEnabledTools: ["read"],
        runtimeEnabledTools: ["read"],
        runtimeUnsupportedTools: []
      }
    });
  });

  it("delivers projected previews and following text before registering eventual model request detail", async () => {
    const projectedRequest = {
      schemaVersion: 1,
      eventId: "projection-request",
      runId: "runtime-chat-detail",
      attemptId: "attempt-chat-detail",
      sequence: 1,
      type: "model.request",
      timestamp: 100,
      data: {
        messageCount: 1,
        toolCount: 1,
        detailAvailable: true,
        rawEventSequence: 1
      }
    };
    const terminalEvent = {
      schemaVersion: 1,
      eventId: "event-completed",
      runId: "runtime-chat-detail",
      attemptId: "attempt-chat-detail",
      sequence: 4,
      type: "run.completed",
      timestamp: 103,
      data: { output: "done", usage: {} }
    };
    const reasoningEvent = {
      ...projectedRequest,
      eventId: "reasoning-detail",
      sequence: 2,
      type: "reasoning.delta",
      timestamp: 101,
      data: { turn: 1, delta: "inspect first" }
    };
    const textEvent = {
      ...projectedRequest,
      eventId: "text-detail",
      sequence: 3,
      type: "message.delta",
      timestamp: 102,
      data: { delta: "done" }
    };
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "inspect this" }],
      tools: [{ type: "function", function: { name: "webFetch" } }]
    };
    const detailResponse = new globalThis.Response(JSON.stringify({
      event: {
        ...projectedRequest,
        eventId: "raw-request",
        data: { modelId: "test-model", payload }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    let releaseDetail;
    const heldDetail = new Promise((resolve) => { releaseDetail = resolve; });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({
          activeProfileId: "runtime-profile",
          profiles: [{
            id: "runtime-profile",
            providerId: "test",
            providerType: "openai",
            model: "test-model",
            label: "Runtime Model"
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (value.endsWith("/v1/runs") && init.method === "POST") {
        return new globalThis.Response(JSON.stringify({
          runId: "runtime-chat-detail",
          attemptId: "attempt-chat-detail",
          status: "accepted"
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      if (value.includes("/projection/stream?after=0")) {
        return new globalThis.Response(
          [
            `event: model.request\ndata: ${JSON.stringify(projectedRequest)}\n\n`,
            `event: reasoning.delta\ndata: ${JSON.stringify(reasoningEvent)}\n\n`,
            `event: message.delta\ndata: ${JSON.stringify(textEvent)}\n\n`,
            `event: run.completed\ndata: ${JSON.stringify(terminalEvent)}\n\n`
          ].join(""),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      if (value.endsWith("/v1/runs/runtime-chat-detail/events/1")) {
        return heldDetail;
      }
      throw new Error(`Unexpected Runtime request: ${value}`);
    });

    const previousZion = globalThis.window.zion;
    const addPayload = vi.fn();
    const emit = vi.fn();
    const controller = new AbortController();
    globalThis.window.zion = {
      llmPayloads: { add: addPayload },
      events: { emit }
    };
    let consumed;
    try {
      const handle = await createInteractiveRuntimeHandle({
        messages: [{ role: "user", content: "inspect this" }],
        tools: [{ function: { name: "webFetch" } }],
        selectedModel: { providerId: "test", modelId: "test-model" },
        selectedModelConfig: {},
        workbenchSessionId: "session-1",
        metadata: { panelId: "panel-detail" },
        baseUrl: "http://127.0.0.1:9876",
        signal: controller.signal,
        fetchImpl
      });
      const events = [];
      let streamFinished = false;
      consumed = (async () => {
        for await (const event of handle.events) events.push(event);
        streamFinished = true;
      })();

      await vi.waitFor(() => expect(streamFinished).toBe(true), { timeout: 1000 });
      await expect(handle.completion).resolves.toMatchObject({
        status: "completed", output: "done"
      });
      expect(events.map(({ sequence, type }) => ({ sequence, type }))).toEqual([
        { sequence: 1, type: "model.request" },
        { sequence: 2, type: "reasoning.delta" },
        { sequence: 3, type: "message.delta" },
        { sequence: 4, type: "run.completed" }
      ]);
      expect(events[0].data).toEqual(projectedRequest.data);
      expect(events[0].data.payload).toBeUndefined();
      expect(events[1].data).toMatchObject({ delta: "inspect first", stepIndex: 1 });
      expect(events[2].data).toEqual({ delta: "done" });
      expect(addPayload).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(fetchImpl.mock.calls.filter(([url]) =>
        String(url).endsWith("/v1/runs/runtime-chat-detail/events/1")
      )).toHaveLength(1);

      releaseDetail(detailResponse);
      await vi.waitFor(() => expect(addPayload).toHaveBeenCalledOnce());
      expect(addPayload.mock.calls[0][0]).toMatchObject({
        id: "raw-request",
        timestamp: 100,
        runId: "runtime-chat-detail",
        sessionId: "session-1",
        panelId: "panel-detail",
        source: "interactive-chat",
        modelId: "test-model",
        messageCount: 1,
        toolCount: 1
      });
      expect(addPayload.mock.calls[0][0].payload).toEqual(payload);
      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith("llm/requestPayload", addPayload.mock.calls[0][0]);
      expect(events).toHaveLength(4);
      expect(events[0].data).toEqual(projectedRequest.data);
    } finally {
      releaseDetail(detailResponse);
      controller.abort();
      await consumed;
      if (previousZion === undefined) delete globalThis.window.zion;
      else globalThis.window.zion = previousZion;
    }
  });

  it("rejects an unavailable selected model before creating a Run", async () => {
    const client = {
      getModels: vi.fn(async () => ({
        activeProfileId: "runtime-profile",
        profiles: [{
          id: "runtime-profile",
          providerId: "runtime",
          model: "runtime-model"
        }]
      }))
    };

    await expect(resolveInteractiveRuntimeModel(client, {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash"
    })).rejects.toMatchObject({
      code: "RUNTIME_MODEL_UNAVAILABLE"
    });
  });

  it("prefers the migrated Workbench profile over an unconfigured builtin model", async () => {
    const client = {
      getModels: vi.fn(async () => ({
        activeProfileId: "deepseek-v4-flash",
        profiles: [{
          id: "deepseek-v4-flash",
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          credentialConfigured: false
        }, {
          id: "workbench.deepseek.deepseek-v4-flash",
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
          credentialConfigured: true
        }]
      }))
    };

    await expect(resolveInteractiveRuntimeModel(client, {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash"
    })).resolves.toEqual({
      profileId: "workbench.deepseek.deepseek-v4-flash",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      label: "DeepSeek V4 Flash"
    });
  });

  it("imports an existing browser OpenAI-compatible model without re-entry", async () => {
    const client = {
      getModels: vi.fn(async () => ({
        activeProfileId: null,
        profiles: []
      })),
      upsertModelProfile: vi.fn(async (_id, input) => ({
        ...input.profile,
        credentialConfigured: true
      }))
    };

    await expect(resolveInteractiveRuntimeModel(
      client,
      {
        providerId: "user.dynamic",
        modelId: "private-model",
        label: "Private Model"
      },
      {
        providerId: "user.dynamic",
        providerType: "openai",
        url: "http://127.0.0.1:9000/v1/chat/completions",
        modelName: "private-model-v2",
        key: "browser-secret",
        max_tokens: 4096
      }
    )).resolves.toEqual({
      profileId: "workbench.user.dynamic.private-model",
      providerId: "user.dynamic",
      modelId: "private-model-v2",
      label: "Private Model"
    });
    expect(client.upsertModelProfile).toHaveBeenCalledWith(
      "workbench.user.dynamic.private-model",
      {
        profile: expect.objectContaining({
          providerType: "openai",
          endpoint: "http://127.0.0.1:9000/v1/chat/completions",
          model: "private-model-v2",
          maxOutputTokens: 4096
        }),
        credential: "browser-secret"
      }
    );
  });

  it("bulk-syncs configured OpenAI-compatible browser models", async () => {
    const imported = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({
          activeProfileId: "deepseek-v4-flash",
          profiles: [{
            id: "deepseek-v4-flash",
            providerId: "deepseek",
            sourceModelId: "deepseek-v4-flash",
            providerType: "openai",
            model: "deepseek-v4-flash",
            credentialConfigured: true
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (value.includes("/v1/model-profiles/") && init.method === "PUT") {
        const body = JSON.parse(init.body);
        imported.push(body);
        return new globalThis.Response(JSON.stringify({
          profile: {
            ...body.profile,
            credentialConfigured: !!body.credential
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected Runtime request: ${value}`);
    });

    const result = await syncWorkbenchModelProfiles({
      models: [{
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        label: "DeepSeek"
      }, {
        providerId: "user.dynamic",
        modelId: "private",
        label: "Private"
      }, {
        providerId: "anthropic",
        modelId: "claude",
        label: "Claude"
      }],
      baseUrl: "http://127.0.0.1:9876",
      fetchImpl,
      resolveConfig: async (model) => {
        if (model.providerId === "deepseek") {
          return {
            providerType: "openai",
            url: "https://api.deepseek.com/chat/completions",
            modelName: model.modelId,
            key: "already-configured"
          };
        }
        if (model.providerId === "user.dynamic") {
          return {
            providerType: "openai",
            url: "http://127.0.0.1:9000/v1/chat/completions",
            modelName: "private-v2",
            key: "private-secret"
          };
        }
        return {
          providerType: "claude",
          url: "https://api.anthropic.com/v1/messages",
          key: "claude-secret"
        };
      }
    });

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      profile: {
        providerId: "user.dynamic",
        sourceModelId: "private",
        model: "private-v2"
      },
      credential: "private-secret"
    });
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        model: expect.objectContaining({ providerId: "anthropic" }),
        reason: "unsupported-provider"
      })
    ]);
  });

  it("updates an existing Runtime profile after its Workbench config changes", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({
          profiles: [{
            id: "workbench.deepseek.deepseek-v4-flash",
            providerId: "deepseek",
            sourceModelId: "deepseek-v4-flash",
            providerType: "openai",
            model: "deepseek-v4-flash",
            credentialConfigured: true,
            capabilities: {
              preservedThinking: false,
              interleavedThinking: false
            }
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (value.includes("/v1/model-profiles/") && init.method === "PUT") {
        const body = JSON.parse(init.body);
        requests.push(body);
        return new globalThis.Response(JSON.stringify({
          profile: {
            ...body.profile,
            credentialConfigured: true
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected Runtime request: ${value}`);
    });

    const result = await syncWorkbenchModelProfiles({
      models: [{
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        label: "DeepSeek"
      }],
      baseUrl: "http://127.0.0.1:9876",
      fetchImpl,
      overwriteExisting: true,
      resolveConfig: async () => ({
        providerType: "openai",
        url: "https://api.deepseek.com/chat/completions",
        modelName: "deepseek-v4-flash",
        _credentialConfigured: true,
        preservedThinking: true,
        interleavedThinking: true
      })
    });

    expect(requests).toEqual([expect.objectContaining({
      profile: expect.objectContaining({
        id: "workbench.deepseek.deepseek-v4-flash",
        credentialRequired: true,
        capabilities: expect.objectContaining({
          preservedThinking: true,
          interleavedThinking: true
        })
      })
    })]);
    expect(requests[0].credential).toBeUndefined();
    expect(result.imported).toHaveLength(1);
  });

  it("resolves the active Workbench model from the Runtime interaction profile", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/v1/interaction-profiles/interactive.default")) {
        return new globalThis.Response(JSON.stringify({
          profile: {
            id: "interactive.default",
            modelProfileId: "workbench.user.dynamic.kimi-k2.5"
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({
          activeProfileId: "workbench.user.dynamic.kimi-k2.5",
          profiles: [{
            id: "workbench.user.dynamic.kimi-k2.5",
            providerId: "user.dynamic",
            sourceModelId: "kimi-k2.5",
            providerType: "openai",
            model: "moonshot-v1-kimi-k2.5",
            label: "Kimi K2.5"
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected Runtime request: ${value}`);
    });

    await expect(resolveInteractiveRuntimeProfileModel({
      baseUrl: "http://127.0.0.1:9876",
      fetchImpl
    })).resolves.toEqual({
      profileId: "workbench.user.dynamic.kimi-k2.5",
      providerId: "user.dynamic",
      modelId: "kimi-k2.5",
      label: "Kimi K2.5"
    });
  });

  it("persists the selected Workbench model as the Runtime interaction profile default", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({
          activeProfileId: null,
          profiles: [{
            id: "workbench.user.dynamic.kimi-k2.5",
            providerId: "user.dynamic",
            sourceModelId: "kimi-k2.5",
            providerType: "openai",
            model: "kimi-k2.5",
            label: "Kimi K2.5",
            credentialConfigured: true
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (
        value.endsWith("/v1/interaction-profiles/interactive.default")
        && init.method === "PATCH"
      ) {
        expect(JSON.parse(init.body)).toEqual({
          modelProfileId: "workbench.user.dynamic.kimi-k2.5"
        });
        return new globalThis.Response(JSON.stringify({
          profile: {
            id: "interactive.default",
            modelProfileId: "workbench.user.dynamic.kimi-k2.5"
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected Runtime request: ${value}`);
    });

    await expect(persistInteractiveRuntimeProfileModel({
      selectedModel: {
        providerId: "user.dynamic",
        modelId: "kimi-k2.5",
        label: "Kimi K2.5"
      },
      selectedModelConfig: {
        providerId: "user.dynamic",
        providerType: "openai",
        url: "https://models.example/v1/chat/completions",
        modelName: "kimi-k2.5",
        key: "configured"
      },
      baseUrl: "http://127.0.0.1:9876",
      fetchImpl
    })).resolves.toMatchObject({
      runtimeModel: {
        profileId: "workbench.user.dynamic.kimi-k2.5",
        providerId: "user.dynamic",
        modelId: "kimi-k2.5"
      },
      profile: {
        id: "interactive.default",
        modelProfileId: "workbench.user.dynamic.kimi-k2.5"
      }
    });
  });

  it("reattaches from the last persisted Runtime event sequence", async () => {
    let runReads = 0;
    const event = {
      schemaVersion: 1,
      eventId: "event-resumed",
      runId: "runtime-chat-resume",
      attemptId: "attempt-chat-resume",
      sequence: 4,
      type: "run.completed",
      timestamp: 456,
      data: { output: "resumed", usage: {} }
    };
    const fetchImpl = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/v1/runs/runtime-chat-resume")) {
        runReads += 1;
        return new globalThis.Response(JSON.stringify({
          run: {
            id: "runtime-chat-resume",
            attemptId: "attempt-chat-resume",
            status: runReads === 1 ? "running" : "completed",
            output: runReads === 1 ? "" : "resumed"
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (value.includes("/projection/stream?after=3")) {
        return new globalThis.Response(
          `event: run.completed\ndata: ${JSON.stringify(event)}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      throw new Error(`Unexpected Runtime request: ${value}`);
    });
    const onRun = vi.fn(async () => undefined);
    const onEvent = vi.fn(async () => undefined);

    await expect(observeInteractiveRuntimeRun({
      runtimeRunId: "runtime-chat-resume",
      afterSequence: 3,
      baseUrl: "http://127.0.0.1:9876",
      fetchImpl,
      onRun,
      onEvent
    })).resolves.toMatchObject({
      run: {
        id: "runtime-chat-resume",
        status: "completed",
        output: "resumed"
      },
      lastEventSequence: 4
    });
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ status: "running" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "run.completed",
      sequence: 4,
      ts: 456
    }));
  });
});
