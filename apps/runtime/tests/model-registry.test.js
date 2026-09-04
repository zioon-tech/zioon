import { describe, expect, it } from "vitest";
import {
  createBuiltinModelRegistry,
  ModelRegistry
} from "../src/model-registry.mjs";

describe("ModelRegistry", () => {
  it("resolves the built-in DeepSeek profile without credentials", () => {
    const profile = createBuiltinModelRegistry().get("deepseek-v4-flash");

    expect(profile).toMatchObject({
      id: "deepseek-v4-flash",
      providerId: "deepseek",
      providerType: "openai",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-flash",
      credentialRef: "model.deepseek",
      temperature: 0,
      maxOutputTokens: 8192,
      requestBody: {
        thinking: { type: "enabled" },
        reasoning_effort: "high"
      },
      capabilities: {
        supportsThinking: true,
        preservedThinking: true
      }
    });
    expect(JSON.stringify(profile)).not.toContain("sk-");
    expect(createBuiltinModelRegistry().resolveModelRef({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro"
    })).toMatchObject({
      id: "deepseek-v4-pro",
      providerId: "deepseek",
      model: "deepseek-v4-pro"
    });
  });

  it("rejects inline credentials and duplicate profile IDs", () => {
    expect(() => new ModelRegistry({
      profiles: [{
        id: "unsafe",
        providerType: "openai",
        url: "https://model.example/chat",
        modelName: "model",
        key: "secret"
      }]
    })).toThrow("must use credentialRef");

    expect(() => new ModelRegistry({
      profiles: [{
        id: "same",
        providerType: "openai",
        endpoint: "https://model.example/chat",
        model: "one"
      }, {
        id: "same",
        providerType: "openai",
        endpoint: "https://model.example/chat",
        model: "two"
      }]
    })).toThrow("Duplicate model profile");
  });

  it("normalizes compatible profile aliases", () => {
    const registry = new ModelRegistry({
      profiles: [{
        id: "custom",
        label: "Custom",
        providerType: "openai",
        url: "http://127.0.0.1:9000/chat",
        modelName: "local-model",
        max_tokens: 2048,
        credentialRequired: false
      }]
    });

    expect(registry.get()).toMatchObject({
      id: "custom",
      endpoint: "http://127.0.0.1:9000/chat",
      model: "local-model",
      maxOutputTokens: 2048,
      credentialRequired: false
    });
    expect(registry.delete("custom")).toMatchObject({
      id: "custom",
      model: "local-model"
    });
    expect(() => registry.get("custom")).toThrow("Model profile not found");
  });
});
