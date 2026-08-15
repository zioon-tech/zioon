import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyLLMRequest: vi.fn()
}));

vi.mock("../extensions/dev.langchain-chat/llm-proxy.ts", () => ({
  proxyLLMRequest: mocks.proxyLLMRequest
}));

import { runStream } from "../extensions/dev.langchain-chat/chat-service.js";

describe("runStream abort handling", () => {
  beforeEach(() => {
    mocks.proxyLLMRequest.mockReset();
    window.zion = {
      models: {
      getProvider: () => ({
        resolve: async () => ({
          providerType: "openai",
          modelName: "test-model",
          url: "https://example.test/v1/chat/completions",
          key: "test-key",
          stream: true
        })
      })
      }
    };
  });

  it("does not flush buffered tool calls or report normal completion after abort", async () => {
    let controller;
    let releaseSecondRead;
    const encoder = new TextEncoder();
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({
          done: false,
          value: encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-old","function":{"name":"read","arguments":"{\\"path\\":\\"old.txt\\"}"}}]}}]}\n'
          )
        })
        .mockImplementationOnce(() => new Promise((resolve) => {
          releaseSecondRead = resolve;
        })),
      cancel: vi.fn().mockResolvedValue(undefined)
    };
    mocks.proxyLLMRequest.mockResolvedValue({
      ok: true,
      body: { getReader: () => reader }
    });
    const onToolCall = vi.fn();
    const onEnd = vi.fn();

    const pending = runStream({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      activeModel: { providerId: "test", modelId: "test-model" },
      onToken: vi.fn(),
      onToolCall,
      onEnd,
      onError: vi.fn(),
      getController: (value) => {
        controller = value;
      },
      runId: "run-old",
      sessionId: "session-1",
      assistantBlockId: "run-old"
    });

    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2));
    controller.abort();
    releaseSecondRead({ done: false, value: encoder.encode("\n") });

    await expect(pending).resolves.toMatchObject({ aborted: true });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(reader.cancel).toHaveBeenCalledOnce();
  });
});
