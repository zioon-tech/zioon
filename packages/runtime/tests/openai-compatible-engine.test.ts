import { describe, expect, it, vi } from "vitest";
import {
  CancellationController,
  OpenAICompatibleEngine,
  type EngineOutputEvent,
  type EngineTurnRequest,
  type ModelTransportResponse
} from "../src/index";

function response(options: {
  status?: number;
  headers?: Record<string, string>;
  chunks?: string[];
  payload?: unknown;
  text?: string;
} = {}): ModelTransportResponse {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: options.headers || {},
    body: options.chunks
      ? {
          async *[Symbol.asyncIterator]() {
            for (const chunk of options.chunks || []) yield chunk;
          }
        }
      : null,
    async json() {
      return options.payload;
    },
    async text() {
      return options.text || JSON.stringify(options.payload || {});
    }
  };
}

function turnRequest(
  signal = new CancellationController().signal
): EngineTurnRequest {
  return {
    runId: "run-1",
    attemptId: "attempt-1",
    turn: 1,
    messages: [{ role: "user", content: "find runtime" }],
    tools: [{
      name: "search",
      description: "Search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }],
    model: { providerId: "test", modelId: "test-model" },
    signal
  };
}

async function collect(iterable: AsyncIterable<EngineOutputEvent>) {
  const events: EngineOutputEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function modelRequestEvent() {
  return {
    type: "model.request",
    request: expect.objectContaining({
      url: "https://model.example/v1/chat/completions",
      providerId: "test",
      providerType: "openai",
      modelId: "test-model",
      stream: true,
      payload: expect.objectContaining({
        model: "test-model",
        messages: [{ role: "user", content: "find runtime" }],
        stream: true
      })
    })
  };
}

describe("OpenAICompatibleEngine", () => {
  it("applies per-Run thinking options without mutating the model profile", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const engine = new OpenAICompatibleEngine({
      endpoint: "https://api.deepseek.com/chat/completions",
      apiKey: "secret",
      model: "deepseek-v4-flash",
      requestBody: {
        thinking: { type: "enabled" },
        reasoning_effort: "high"
      },
      transport: async (request) => {
        requests.push(JSON.parse(request.body));
        return response({
          headers: { "content-type": "application/json" },
          payload: {
            choices: [{ message: { content: "ok" } }]
          }
        });
      }
    });

    await collect(engine.streamTurn({
      ...turnRequest(),
      model: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash"
      },
      modelOptions: {
        thinkingMode: "off",
        thinkingEffort: "max"
      }
    }));
    await collect(engine.streamTurn({
      ...turnRequest(),
      model: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash"
      },
      modelOptions: {
        thinkingMode: "on",
        thinkingEffort: "max"
      }
    }));

    expect(requests[0]).toMatchObject({
      thinking: { type: "disabled" }
    });
    expect(requests[0].reasoning_effort).toBeUndefined();
    expect(requests[1]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max"
    });
  });

  it("normalizes streamed text, reasoning, usage, and split tool calls", async () => {
    const toolPayload = JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call-1",
            function: {
              name: "search",
              arguments: "{\"query\":\"runtime\"}"
            }
          }]
        },
        finish_reason: "tool_calls"
      }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 3,
        completion_tokens_details: { reasoning_tokens: 2 }
      }
    });
    const splitAt = toolPayload.indexOf("runtime") + 3;
    const transport = vi.fn(async () => response({
      headers: { "content-type": "text/event-stream" },
      chunks: [
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"check \"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"working \"}}]}\n\n"
          + `data: ${toolPayload.slice(0, splitAt)}`,
        `${toolPayload.slice(splitAt)}\n\ndata: [DONE]\n\n`
      ]
    }));
    const engine = new OpenAICompatibleEngine({
      endpoint: "https://model.example/v1/chat/completions",
      apiKey: "secret",
      model: "fallback",
      requestBody: {
        thinking: { type: "enabled" },
        reasoning_effort: "high"
      },
      transport
    });

    const events = await collect(engine.streamTurn(turnRequest()));

    expect(events).toEqual([
      modelRequestEvent(),
      { type: "reasoning.delta", delta: "check " },
      { type: "message.delta", delta: "working " },
      {
        type: "model.usage",
        usage: {
          inputTokens: 8,
          outputTokens: 3,
          reasoningTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        }
      },
      {
        type: "tool.call",
        call: {
          id: "call-1",
          name: "search",
          arguments: { query: "runtime" }
        }
      }
    ]);
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://model.example/v1/chat/completions",
        headers: expect.objectContaining({
          authorization: "Bearer secret"
        })
      }),
      expect.any(Object)
    );
    const sent = JSON.parse(transport.mock.calls[0][0].body);
    expect(sent).toMatchObject({
      model: "test-model",
      stream: true,
      messages: [{ role: "user", content: "find runtime" }],
      thinking: { type: "enabled" },
      reasoning_effort: "high"
    });
    expect(sent.tools[0].function.name).toBe("search");
  });

  it("sends preserved reasoning content back with assistant tool messages", async () => {
    const transport = vi.fn(async () => response({
      payload: {
        choices: [{ message: { content: "done" } }]
      },
      headers: { "content-type": "application/json" }
    }));
    const engine = new OpenAICompatibleEngine({
      endpoint: "https://model.example/v1/chat/completions",
      model: "test-model",
      transport
    });
    const request = turnRequest();
    request.messages = [{
      role: "assistant",
      content: "",
      reasoningContent: "inspect the repository",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: {
          name: "search",
          arguments: "{\"query\":\"runtime\"}"
        }
      }]
    }, {
      role: "tool",
      toolCallId: "call-1",
      content: "result"
    }];

    await collect(engine.streamTurn(request));

    const sent = JSON.parse(transport.mock.calls[0][0].body);
    expect(sent.messages[0]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "inspect the repository",
      tool_calls: request.messages[0].toolCalls
    });
  });

  it("preserves text and image_url content parts in model requests", async () => {
    const transport = vi.fn(async () => response({
      payload: {
        choices: [{ message: { content: "described" } }]
      },
      headers: { "content-type": "application/json" }
    }));
    const engine = new OpenAICompatibleEngine({
      endpoint: "https://model.example/v1/chat/completions",
      model: "test-model",
      transport
    });
    const request = turnRequest();
    request.messages = [{
      role: "user",
      content: [{
        type: "text",
        text: "Describe this image"
      }, {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,AAAA",
          detail: "high"
        }
      }]
    }];

    await collect(engine.streamTurn(request));

    const sent = JSON.parse(transport.mock.calls[0][0].body);
    expect(sent.messages[0]).toEqual(request.messages[0]);
  });

  it("marks malformed or schema-invalid tool arguments for correction", async () => {
    const engine = new OpenAICompatibleEngine({
      endpoint: "https://model.example/v1/chat/completions",
      model: "test-model",
      transport: async () => response({
        payload: {
          choices: [{
            message: {
              tool_calls: [{
                id: "call-1",
                function: { name: "search", arguments: "{}" }
              }]
            }
          }]
        },
        headers: { "content-type": "application/json" }
      })
    });

    const events = await collect(engine.streamTurn(turnRequest()));
    expect(events).toEqual([
      modelRequestEvent(),
      {
        type: "tool.call",
        call: {
          id: "call-1",
          name: "search",
          arguments: {},
          validationError: "query is required"
        }
      }
    ]);
  });

  it("propagates cancellation to an injected transport", async () => {
    const cancellation = new CancellationController();
    let transportStarted = false;
    const engine = new OpenAICompatibleEngine({
      endpoint: "https://model.example/v1/chat/completions",
      model: "test-model",
      transport: async (_request, signal) => {
        transportStarted = true;
        await new Promise<void>((resolve) => signal.onCancel(() => resolve()));
        signal.throwIfCancelled();
        return response();
      }
    });

    const collecting = collect(engine.streamTurn(turnRequest(cancellation.signal)));
    while (!transportStarted) await Promise.resolve();
    cancellation.cancel("user");
    await expect(collecting).rejects.toThrow("Run cancelled: user");
  });

  it("surfaces upstream HTTP failures without exposing request credentials", async () => {
    const engine = new OpenAICompatibleEngine({
      endpoint: "https://model.example/v1/chat/completions",
      apiKey: "do-not-log",
      model: "test-model",
      transport: async () => response({
        status: 429,
        text: "rate limited"
      })
    });

    await expect(collect(engine.streamTurn(turnRequest())))
      .rejects.toThrow("Model HTTP 429: rate limited");
  });

  it("acquires scoped credential headers for a turn and releases the lease", async () => {
    const release = vi.fn();
    const acquire = vi.fn(async () => ({
      headers: { "x-api-key": "scoped-secret" },
      release
    }));
    const transport = vi.fn(async (request) => {
      expect(request.headers["x-api-key"]).toBe("scoped-secret");
      expect(request.headers.authorization).toBeUndefined();
      return response({
        payload: {
          choices: [{ message: { content: "ok" } }]
        },
        headers: { "content-type": "application/json" }
      });
    });
    const engine = new OpenAICompatibleEngine({
      endpoint: "https://model.example/v1/messages",
      model: "test-model",
      credentialProvider: { acquire },
      credentialRef: "model.default",
      credentialRequired: true,
      transport
    });

    await expect(collect(engine.streamTurn(turnRequest()))).resolves.toEqual([
      {
        ...modelRequestEvent(),
        request: expect.objectContaining({
          url: "https://model.example/v1/messages"
        })
      },
      { type: "message.delta", delta: "ok" }
    ]);
    expect(acquire).toHaveBeenCalledWith({
      ref: "model.default",
      providerId: "test",
      modelId: "test-model"
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails before transport when a required credential is unavailable", async () => {
    const transport = vi.fn();
    const engine = new OpenAICompatibleEngine({
      endpoint: "https://model.example/v1/chat/completions",
      model: "test-model",
      credentialProvider: { acquire: async () => null },
      credentialRef: "model.default",
      credentialRequired: true,
      transport
    });

    await expect(collect(engine.streamTurn(turnRequest())))
      .rejects.toThrow("Credential is required: model.default");
    expect(transport).not.toHaveBeenCalled();
  });
});
