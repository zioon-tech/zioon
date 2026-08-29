import { describe, expect, it } from "vitest";
import {
  getBuiltinModelLimits,
  resolveModelLimits,
  withResolvedModelLimits
} from "../extensions/dev.langchain-chat/model-limits.js";
import {
  buildContextWindowSnapshot,
  resolveModelContextWindowTokens
} from "../extensions/dev.langchain-chat/context-health.js";
import { claudeProvider } from "../extensions/dev.langchain-chat/claude-provider.js";
import { deepseekProvider } from "../extensions/dev.langchain-chat/deepseek-provider.js";
import { geminiProvider } from "../extensions/dev.langchain-chat/gemini-provider.js";
import {
  MAX_MODEL_DESCRIPTION_LENGTH,
  normalizeModelDescription
} from "../extensions/dev.langchain-chat/model-config-fields.js";

describe("model limits", () => {
  it("exposes model-specific builtin limits", () => {
    expect(getBuiltinModelLimits("deepseek", "deepseek-v4-flash")).toMatchObject({
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 384_000,
      source: "builtin"
    });
    expect(getBuiltinModelLimits("anthropic", "claude-haiku-4-5-20251001")).toMatchObject({
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000
    });
  });

  it("returns normalized limits from builtin providers without credentials", async () => {
    localStorage.clear();
    await expect(deepseekProvider.resolve("deepseek-v4-flash")).resolves.toMatchObject({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000
    });
    await expect(claudeProvider.resolve("claude-sonnet-5")).resolves.toMatchObject({
      contextWindowTokens: 1_000_000,
      max_tokens: 64_000,
      maxOutputTokens: 128_000
    });
    await expect(geminiProvider.resolve("gemini-3.6-flash")).resolves.toMatchObject({
      contextWindowTokens: 1_048_576,
      max_tokens: 32_768,
      maxOutputTokens: 65_536
    });
  });

  it("stores a bounded per-model description", async () => {
    localStorage.setItem("zion.deepseek.config", JSON.stringify({
      modelDescriptions: {
        "deepseek-v4-flash": "  Fast default model  "
      }
    }));
    await expect(deepseekProvider.resolve("deepseek-v4-flash")).resolves.toMatchObject({
      description: "Fast default model"
    });
    expect(normalizeModelDescription("x".repeat(700))).toHaveLength(MAX_MODEL_DESCRIPTION_LENGTH);
  });

  it("applies per-model overrides without changing sibling models", () => {
    const config = {
      max_tokens: 16_000,
      modelLimits: {
        "claude-sonnet-5": {
          contextWindowTokens: 750_000,
          maxInputTokens: 700_000,
          maxOutputTokens: 96_000,
          defaultOutputTokens: 32_000
        }
      }
    };

    expect(resolveModelLimits({
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
      config
    })).toMatchObject({
      contextWindowTokens: 750_000,
      maxInputTokens: 700_000,
      maxOutputTokens: 96_000,
      defaultOutputTokens: 32_000,
      source: "user"
    });
    expect(resolveModelLimits({
      providerId: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
      config
    })).toMatchObject({
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      defaultOutputTokens: 16_000,
      source: "builtin"
    });
  });

  it("keeps output request budgets separate from context limits", () => {
    const resolved = withResolvedModelLimits({
      max_tokens: 128_000
    }, {
      providerId: "user.dynamic",
      modelId: "custom"
    });

    expect(resolved.max_tokens).toBe(128_000);
    expect(resolved.contextWindowTokens).toBeUndefined();
    expect(resolveModelContextWindowTokens(resolved, {
      providerId: "user.dynamic",
      modelId: "custom"
    })).toBe(0);
  });

  it("marks context utilization as unknown when no input limit is available", () => {
    expect(buildContextWindowSnapshot({
      messages: [{ role: "user", content: "hello" }],
      model: { providerId: "user.dynamic", modelId: "custom" },
      cfg: { max_tokens: 4096 }
    })).toMatchObject({
      modelContextWindow: 0,
      contextWindowKnown: false,
      utilization: 0,
      reasons: ["context-window-unknown"]
    });
  });
});
