import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildModelCatalog } from "../extensions/dev.langchain-chat/model-catalog.js";
import {
  invalidateRuntimeDynamicModelCache
} from "../extensions/dev.langchain-chat/runtime-user-model-store.js";

const originalFetch = globalThis.fetch;

describe("model catalog Runtime credentials", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateRuntimeDynamicModelCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves a provider catalog concurrently and accepts write-only credentials", async () => {
    const values = new Map();
    const pending = [];
    const provider = {
      list: vi.fn(async () => [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
        { id: "three", label: "Three" }
      ]),
      resolve: vi.fn((modelId) => new Promise((resolve) => {
        pending.push(() => resolve({
          id: modelId,
          url: `https://models.example/${modelId}`,
          key: "",
          _requiresConfig: true
        }));
      }))
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      profiles: ["one", "two", "three"].map((modelId) => ({
        id: `runtime-${modelId}`,
        providerId: "anthropic",
        sourceModelId: modelId,
        model: modelId,
        credentialConfigured: true,
        capabilities: {
          supportsThinking: true,
          preservedThinking: true,
          interleavedThinking: modelId === "two"
        }
      }))
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    window.zion = {
      models: {
        listProviders: () => ["anthropic"],
        getProvider: () => provider
      },
      state: {
        get: (key) => {
          if (key === "runtime.mode") return "runtime";
          if (key === "runtime.connection") {
            return { backend: "runtime", baseUrl: "http://runtime.test" };
          }
          return values.get(key);
        },
        set: (key, value) => values.set(key, value)
      }
    };

    const rebuilding = rebuildModelCatalog();
    await vi.waitFor(() => {
      expect(provider.resolve).toHaveBeenCalledTimes(3);
    });
    pending.forEach((resolve) => resolve());

    const catalog = await rebuilding;
    expect(catalog).toHaveLength(3);
    expect(catalog.every((item) => item.requiresConfig === false)).toBe(true);
    expect(catalog.every((item) =>
      item.availability?.status === "available"
    )).toBe(true);
    expect(catalog.every((item) => item.preservedThinking === true)).toBe(true);
    expect(catalog.find((item) => item.id === "two")).toMatchObject({
      supportsThinking: true,
      interleavedThinking: true
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it("lists account plugin models without a browser provider or upstream URL", async () => {
    const values = new Map();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ profiles: [{
      id: "extension.profile", providerId: "extension.provider", model: "local:model", label: "内网模型",
      credentialConfigured: true, supportsStreaming: false,
      metadata: { source: "account-extension", stream: false, contextWindowTokens: 32000 },
      capabilities: { supportsImage: false }
    }] }), { status: 200, headers: { "content-type": "application/json" } }));
    window.zion = { models: { listProviders: () => [], getProvider: () => null }, state: {
      get: (key) => key === "runtime.mode" ? "runtime" : key === "runtime.connection"
        ? { backend: "runtime", baseUrl: "http://runtime.test" } : values.get(key),
      set: (key, value) => values.set(key, value)
    } };
    expect(await rebuildModelCatalog()).toMatchObject([{
      providerId: "extension.provider", id: "local:model", label: "内网模型", accountExtension: true,
      runtimeProfileId: "extension.profile", stream: false, requiresConfig: false
    }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
