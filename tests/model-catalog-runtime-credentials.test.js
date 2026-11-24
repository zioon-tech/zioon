import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildModelCatalog } from "../extensions/dev.langchain-chat/model-catalog.js";
import { installModelSwitcher } from "../extensions/dev.langchain-chat/model-switcher.js";
import {
  invalidateRuntimeDynamicModelCache
} from "../extensions/dev.langchain-chat/runtime-user-model-store.js";

const originalFetch = globalThis.fetch;

describe("model catalog Runtime credentials", () => {
  it("uses Runtime profiles as the catalog, hides phantom presets and includes configured custom Claude models", async () => {
    const values = new Map();
    const profiles = [
      { id: "deepseek-live", providerId: "deepseek", model: "deepseek-v4-flash", credentialConfigured: true },
      { id: "custom-claude", providerId: "anthropic", model: "custom-claude", label: "我的 Claude", credentialConfigured: true,
        capabilities: { supportsThinking: true } }
    ];
    globalThis.fetch = vi.fn(async () => Response.json({ profiles }));
    window.zion = { models: { listProviders: () => ["deepseek", "anthropic", "gemini"],
      getProvider: id => ({ list: async () => [{ id: id === "deepseek" ? "deepseek-v4-flash" : id === "anthropic" ? "claude-opus-4-8" : "gemini-3-pro" }],
        resolve: async () => ({ _requiresConfig: true }) }) }, state: {
      get: key => key === "runtime.mode" ? "runtime" : key === "runtime.connection"
        ? { backend: "runtime", baseUrl: "http://runtime.test" } : values.get(key),
      set: (key, value) => values.set(key, value)
    } };
    const models = await rebuildModelCatalog();
    expect(models.map(model => model.runtimeProfileId).sort()).toEqual(profiles.map(profile => profile.id).sort());
    expect(models.some(model => ["claude-opus-4-8", "gemini-3-pro"].includes(model.id))).toBe(false);
    expect(models.find(model => model.id === "custom-claude")).toMatchObject({ label: "我的 Claude", requiresConfig: false, supportsThinking: true });
  });
  it("combines own and received models without requiring a browser provider for the received model", async () => {
    const values = new Map();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ profiles: [{
      id: "own.profile", providerId: "own", sourceModelId: "mine", model: "mine", credentialConfigured: true
    }, {
      id: "share.share1", providerId: "shared", model: "share1", label: "共享模型", credentialConfigured: true,
      metadata: { source: "account-share", providerName: "Alice" }
    }] }), { headers: { "content-type": "application/json" } }));
    window.zion = { models: { listProviders: () => ["own"], getProvider: () => ({
      list: async () => [{ id: "mine" }], resolve: async () => ({ _credentialConfigured: true })
    }) }, state: {
      get: key => key === "runtime.mode" ? "runtime" : key === "runtime.connection"
        ? { backend: "runtime", baseUrl: "http://runtime.test" } : values.get(key),
      set: (key, value) => values.set(key, value)
    } };
    const models = await rebuildModelCatalog();
    expect(models).toHaveLength(2);
    expect(models.find(model => model.providerId === "shared")).toMatchObject({
      runtimeProfileId: "share.share1", providerName: "Alice", sharedModel: true, requiresConfig: false
    });
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const switcher = installModelSwitcher();
    try {
      switcher.open();
      const rows = document.querySelectorAll("#zion-model-switcher-root [data-index]");
      expect(rows).toHaveLength(2);
      expect(rows[0].querySelector(".shared-resource-marker")).toBeNull();
      expect(rows[1].querySelector(".shared-resource-marker")?.getAttribute("title")).toBe("Alice 分享的资源");
    } finally {
      switcher.dispose();
      if (scroll) HTMLElement.prototype.scrollIntoView = scroll;
      else delete HTMLElement.prototype.scrollIntoView;
    }
  });
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
