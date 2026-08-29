import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyLLMRequest: vi.fn()
}));

vi.mock("../extensions/dev.langchain-chat/llm-proxy.ts", () => ({
  proxyLLMRequest: mocks.proxyLLMRequest
}));

import { runStream } from "../extensions/dev.langchain-chat/chat-service.js";
import { getModelAvailability } from "../extensions/dev.langchain-chat/model-health.js";

function createSseResponse(payload) {
  const encoder = new globalThis.TextEncoder();
  let consumed = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: vi.fn(async () => {
          if (consumed) return { done: true, value: undefined };
          consumed = true;
          return { done: false, value: encoder.encode(payload) };
        }),
        cancel: vi.fn(async () => {})
      })
    }
  };
}

function createHttpErrorResponse(status, body) {
  return {
    ok: false,
    status,
    headers: { get: vi.fn(() => null) },
    text: vi.fn(async () => body)
  };
}

function createSuccessStream(content = "ok") {
  return createSseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}`,
    'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
    "data: [DONE]",
    ""
  ].join("\n"));
}

function run(overrides = {}) {
  return runStream({
    messages: [{ role: "user", content: "hello" }],
    activeModel: { providerId: "test", modelId: "test-model" },
    onToken: vi.fn(),
    onEnd: vi.fn(),
    onError: vi.fn(),
    runId: "run-errors",
    sessionId: "session-1",
    _retryBaseDelay: 0,
    ...overrides
  });
}

describe("runStream error propagation and retries", () => {
  beforeEach(() => {
    mocks.proxyLLMRequest.mockReset();
    localStorage.clear();
    window.zion = {
      notification: { show: vi.fn() },
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

  it("surfaces an upstream auth error wrapped in a successful SSE response", async () => {
    mocks.proxyLLMRequest.mockResolvedValue(createSseResponse(
      'data: {"error":{"code":"invalid_api_key","message":"invalid access token","type":"invalid_request_error"}}\n\n'
    ));
    const onEnd = vi.fn();
    const onError = vi.fn();

    const result = await run({ onEnd, onError });

    expect(mocks.proxyLLMRequest).toHaveBeenCalledOnce();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({
      code: "invalid_api_key",
      retryable: false
    });
    expect(result.error?.message).toContain("invalid access token");
    expect(getModelAvailability("test", "test-model")).toMatchObject({
      status: "unavailable",
      reason: "invalid_credentials",
      source: "actual-run"
    });
  });

  it("retries a transient in-stream proxy error before any output", async () => {
    mocks.proxyLLMRequest
      .mockResolvedValueOnce(createSseResponse(
        'data: {"error":"upstream connection reset"}\n\n'
      ))
      .mockResolvedValueOnce(createSuccessStream("recovered"));
    const onToken = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();

    await run({ onToken, onEnd, onError });

    expect(mocks.proxyLLMRequest).toHaveBeenCalledTimes(2);
    expect(onToken.mock.calls.map(([token]) => token).join("")).toBe("recovered");
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(getModelAvailability("test", "test-model")).toMatchObject({
      status: "available",
      reason: "request_succeeded",
      source: "actual-run"
    });
    expect(window.zion.notification.show).toHaveBeenCalledWith(
      expect.stringContaining("自动重试 (1/3)"),
      expect.objectContaining({ type: "warning" })
    );
  });

  it("retries transient HTTP failures before opening the stream", async () => {
    mocks.proxyLLMRequest
      .mockResolvedValueOnce(createHttpErrorResponse(503, "temporarily unavailable"))
      .mockResolvedValueOnce(createSuccessStream("recovered"));
    const onToken = vi.fn();
    const onError = vi.fn();

    await run({ onToken, onError });

    expect(mocks.proxyLLMRequest).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenCalledWith("recovered");
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces an error object from a non-streaming 200 response", async () => {
    window.zion.models.getProvider = () => ({
      resolve: async () => ({
        providerType: "openai",
        modelName: "test-model",
        url: "https://example.test/v1/chat/completions",
        key: "test-key",
        stream: false
      })
    });
    mocks.proxyLLMRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        error: {
          code: "invalid_request_error",
          message: "invalid request",
          type: "invalid_request_error"
        }
      }))
    });
    const onEnd = vi.fn();
    const onError = vi.fn();

    await run({ onEnd, onError });

    expect(mocks.proxyLLMRequest).toHaveBeenCalledOnce();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({
      code: "invalid_request_error",
      retryable: false
    });
  });

  it("reports an interrupted partial response without replaying it", async () => {
    mocks.proxyLLMRequest.mockResolvedValue(createSseResponse(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
    ));
    const onToken = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();

    const result = await run({ onToken, onEnd, onError });

    expect(mocks.proxyLLMRequest).toHaveBeenCalledOnce();
    expect(onToken).toHaveBeenCalledWith("partial");
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(result.error).toMatchObject({
      code: "incomplete_stream",
      retryable: false
    });
  });
});
