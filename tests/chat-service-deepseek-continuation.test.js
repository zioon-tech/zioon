import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyLLMRequest: vi.fn()
}));

vi.mock("../extensions/dev.langchain-chat/llm-proxy.ts", () => ({
  proxyLLMRequest: mocks.proxyLLMRequest
}));

import {
  runStream,
  shouldAutoContinueDeepSeek
} from "../extensions/dev.langchain-chat/chat-service.js";
import { deepseekProvider } from "../extensions/dev.langchain-chat/deepseek-provider.js";

function createSseResponse(payload) {
  const encoder = new TextEncoder();
  let consumed = false;
  return {
    ok: true,
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

function deepSeekConfig() {
  return {
    providerId: "deepseek",
    providerType: "openai",
    modelName: "deepseek-v4-flash",
    url: "https://api.deepseek.com/chat/completions",
    key: "test-key",
    stream: true,
    thinkingMode: "off"
  };
}

describe("DeepSeek colon-stop continuation", () => {
  beforeEach(() => {
    mocks.proxyLLMRequest.mockReset();
    localStorage.clear();
    window.zion = {
      models: {
        getProvider: () => ({
          resolve: async () => deepSeekConfig()
        })
      }
    };
  });

  it("continues once in the same output when a stop follows a trailing colon", async () => {
    mocks.proxyLLMRequest
      .mockResolvedValueOnce(createSseResponse([
        'data: {"choices":[{"delta":{"content":"计划如下："},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":8}}}',
        "data: [DONE]",
        ""
      ].join("\n")))
      .mockResolvedValueOnce(createSseResponse([
        'data: {"choices":[{"delta":{"content":"第一步，检查配置。"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":10}}}',
        "data: [DONE]",
        ""
      ].join("\n")));

    const onToken = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    const result = await runStream({
      messages: [{ role: "user", content: "给我一个计划" }],
      activeModel: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
      onToken,
      onEnd,
      onError,
      runId: "run-deepseek-colon",
      sessionId: "session-1"
    });

    expect(mocks.proxyLLMRequest).toHaveBeenCalledTimes(2);
    expect(onToken.mock.calls.map(([token]) => token).join("")).toBe("计划如下：第一步，检查配置。");
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      deepSeekAutoContinued: true,
      usage: {
        input: 22,
        output: 5,
        total: 27,
        cacheRead: 18
      }
    });

    const continuationBody = JSON.parse(mocks.proxyLLMRequest.mock.calls[1][0].body);
    expect(continuationBody.messages.slice(-2)).toEqual([
      { role: "assistant", content: "计划如下：" },
      {
        role: "user",
        content: "上一条回答在冒号后意外中断。请从冒号后直接继续回答，不要重复已经输出的内容，也不要解释中断原因。"
      }
    ]);
  });

  it("continues when DeepSeek stops after reasoning without content or tool calls", async () => {
    mocks.proxyLLMRequest
      .mockResolvedValueOnce(createSseResponse([
        'data: {"choices":[{"delta":{"content":null,"reasoning_content":"[reasoning"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":null,"reasoning_content":" omitted]"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"","reasoning_content":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25,"completion_tokens_details":{"reasoning_tokens":5}}}',
        "data: [DONE]",
        ""
      ].join("\n")))
      .mockResolvedValueOnce(createSseResponse([
        'data: {"choices":[{"delta":{"content":"这是正式回答。","reasoning_content":null},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"","reasoning_content":null},"finish_reason":"stop"}]}',
        "data: [DONE]",
        ""
      ].join("\n")));

    const onToken = vi.fn();
    const onEnd = vi.fn();
    const result = await runStream({
      messages: [{ role: "user", content: "回答问题" }],
      activeModel: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
      onToken,
      onEnd,
      onError: vi.fn(),
      runId: "run-deepseek-reasoning-only",
      sessionId: "session-1"
    });

    expect(mocks.proxyLLMRequest).toHaveBeenCalledTimes(2);
    expect(onToken.mock.calls.map(([token]) => token).join("")).toBe("这是正式回答。");
    expect(onEnd).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      deepSeekAutoContinued: true,
      reasoning_content: "[reasoning omitted]"
    });

    const continuationBody = JSON.parse(mocks.proxyLLMRequest.mock.calls[1][0].body);
    expect(continuationBody.messages.at(-1)).toEqual({
      role: "user",
      content: "上一轮只返回了推理内容，没有给出正式回答或工具调用。请继续完成当前任务：直接输出正式内容；如果需要工具，请正常发起工具调用。不要复述推理过程，也不要解释中断原因。"
    });
    expect(continuationBody.messages.some((message) => message.role === "assistant")).toBe(false);
  });

  it("honors model, tool-call, disabled, and attempt-limit guards", () => {
    const base = {
      active: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
      cfg: deepSeekConfig(),
      finishReason: "stop",
      content: "计划如下："
    };

    expect(shouldAutoContinueDeepSeek(base)).toBe(true);
    expect(shouldAutoContinueDeepSeek({ ...base, attempt: 1 })).toBe(true);
    expect(shouldAutoContinueDeepSeek({ ...base, attempt: 1, maxAttempts: 1 })).toBe(false);
    expect(shouldAutoContinueDeepSeek({ ...base, maxAttempts: 0 })).toBe(false);
    expect(shouldAutoContinueDeepSeek({ ...base, hasToolCalls: true })).toBe(false);
    expect(shouldAutoContinueDeepSeek({
      ...base,
      content: "",
      reasoningContent: "[reasoning omitted]"
    })).toBe(true);
    expect(shouldAutoContinueDeepSeek({
      ...base,
      content: "",
      reasoningContent: ""
    })).toBe(false);
    expect(shouldAutoContinueDeepSeek({
      ...base,
      active: { providerId: "openai", modelId: "gpt-4.1" },
      cfg: { ...base.cfg, providerId: "openai", modelName: "gpt-4.1" }
    })).toBe(false);
  });

  it("uses the configured continuation limit", async () => {
    window.zion.models.getProvider = () => ({
      resolve: async () => ({
        ...deepSeekConfig(),
        autoContinueOnColonMaxAttempts: 2
      })
    });
    mocks.proxyLLMRequest
      .mockResolvedValueOnce(createSseResponse([
        'data: {"choices":[{"delta":{"content":"第一段："},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
        "data: [DONE]",
        ""
      ].join("\n")))
      .mockResolvedValueOnce(createSseResponse([
        'data: {"choices":[{"delta":{"content":"第二段："},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
        "data: [DONE]",
        ""
      ].join("\n")))
      .mockResolvedValueOnce(createSseResponse([
        'data: {"choices":[{"delta":{"content":"完成。"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
        "data: [DONE]",
        ""
      ].join("\n")));

    const onToken = vi.fn();
    const onEnd = vi.fn();
    await runStream({
      messages: [{ role: "user", content: "继续测试" }],
      activeModel: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
      onToken,
      onEnd,
      onError: vi.fn(),
      runId: "run-deepseek-limit",
      sessionId: "session-1"
    });

    expect(mocks.proxyLLMRequest).toHaveBeenCalledTimes(3);
    expect(onToken.mock.calls.map(([token]) => token).join("")).toBe("第一段：第二段：完成。");
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("loads the default and configured limits from the DeepSeek provider", async () => {
    expect((await deepseekProvider.resolve("deepseek-v4-flash")).autoContinueOnColonMaxAttempts).toBe(3);

    localStorage.setItem("zion.deepseek.config", JSON.stringify({
      autoContinueOnColonMaxAttempts: 7
    }));
    expect((await deepseekProvider.resolve("deepseek-v4-flash")).autoContinueOnColonMaxAttempts).toBe(7);

    localStorage.setItem("zion.deepseek.config", JSON.stringify({
      autoContinueOnColonMaxAttempts: 999
    }));
    expect((await deepseekProvider.resolve("deepseek-v4-flash")).autoContinueOnColonMaxAttempts).toBe(20);
  });
});
