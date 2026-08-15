import { describe, expect, it } from "vitest";
import {
  buildProviderRequestBody,
  buildProviderURL
} from "../extensions/dev.langchain-chat/chat-service.js";
import {
  getSupportedThinkingEfforts,
  normalizeThinkingEffort
} from "../extensions/dev.langchain-chat/model-config-fields.js";

const messages = [
  { role: "system", content: "Be precise." },
  { role: "user", content: "Solve this." }
];

describe("provider-specific thinking configuration", () => {
  it("uses DeepSeek's thinking toggle and high/max effort vocabulary", () => {
    const high = buildProviderRequestBody({
      modelName: "deepseek-v4-flash",
      stream: true,
      temperature: 0.7,
      max_tokens: 32000,
      thinkingMode: "on",
      thinkingEffort: "low"
    }, messages, null, "openai", "deepseek");

    expect(high.thinking).toEqual({ type: "enabled" });
    expect(high.reasoning_effort).toBe("high");
    expect(high.temperature).toBeUndefined();
    expect(high.stream_options).toEqual({ include_usage: true });

    const max = buildProviderRequestBody({
      modelName: "deepseek-v4-pro",
      thinkingMode: "on",
      thinkingEffort: "max"
    }, messages, null, "openai", "deepseek");
    expect(max.reasoning_effort).toBe("max");

    const off = buildProviderRequestBody({
      modelName: "deepseek-v4-flash",
      temperature: 0.4,
      thinkingMode: "off",
      thinkingEffort: "max"
    }, messages, null, "openai", "deepseek");
    expect(off.thinking).toEqual({ type: "disabled" });
    expect(off.reasoning_effort).toBeUndefined();
    expect(off.temperature).toBe(0.4);
  });

  it("uses adaptive thinking and output_config effort for current Claude models", () => {
    const body = buildProviderRequestBody({
      modelName: "claude-opus-4-8",
      temperature: 0.2,
      max_tokens: 64000,
      thinkingMode: "on",
      thinkingEffort: "xhigh"
    }, messages, null, "claude", "anthropic");

    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "xhigh" });
    expect(body.system).toBe("Be precise.");
    expect(body.messages).toEqual([{ role: "user", content: "Solve this." }]);
    expect(body.temperature).toBeUndefined();

    const sonnet = buildProviderRequestBody({
      modelName: "claude-sonnet-4-6",
      thinkingMode: "on",
      thinkingEffort: "xhigh"
    }, messages, null, "claude", "anthropic");
    expect(sonnet.output_config).toEqual({ effort: "max" });
  });

  it("keeps manual Claude thinking budgets below max_tokens", () => {
    const body = buildProviderRequestBody({
      modelName: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      thinkingMode: "on",
      thinkingEffort: "high"
    }, messages, null, "claude", "anthropic");

    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 7168 });
    expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
  });

  it("uses Gemini thinking levels and the SSE streaming endpoint", () => {
    const body = buildProviderRequestBody({
      modelName: "gemini-3.6-flash",
      stream: true,
      max_tokens: 32768,
      thinkingMode: "on",
      thinkingEffort: "high"
    }, messages, null, "gemini", "google");

    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be precise." }] });
    expect(body.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH"
    });

    const pro = buildProviderRequestBody({
      modelName: "gemini-3.1-pro-preview",
      thinkingMode: "on",
      thinkingEffort: "minimal"
    }, messages, null, "gemini", "google");
    expect(pro.generationConfig.thinkingConfig.thinkingLevel).toBe("LOW");

    expect(buildProviderURL({
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      modelName: "gemini-3.6-flash",
      key: "secret key",
      stream: true
    }, "gemini")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=secret%20key"
    );
  });

  it("preserves official OpenAI effort values for reasoning models", () => {
    const body = buildProviderRequestBody({
      url: "https://api.openai.com/v1/chat/completions",
      modelName: "gpt-5.6",
      temperature: 0.5,
      max_tokens: 25000,
      thinkingMode: "on",
      thinkingEffort: "xhigh"
    }, messages, null, "openai", "user.dynamic");

    expect(body.reasoning_effort).toBe("xhigh");
    expect(body.max_completion_tokens).toBe(25000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });
});

describe("thinking effort capabilities", () => {
  it("normalizes the extended official effort vocabulary", () => {
    expect(normalizeThinkingEffort("MINIMAL")).toBe("minimal");
    expect(normalizeThinkingEffort("xhigh")).toBe("xhigh");
    expect(normalizeThinkingEffort("max")).toBe("max");
  });

  it("only exposes meaningful DeepSeek effort levels", () => {
    expect(getSupportedThinkingEfforts({
      providerId: "deepseek",
      modelName: "deepseek-v4-flash"
    })).toEqual(["auto", "high", "max"]);
  });
});
