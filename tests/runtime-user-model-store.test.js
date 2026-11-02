import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteDynamicModel,
  dynamicConfigToRuntimeImport,
  findRuntimeModelProfile,
  invalidateRuntimeDynamicModelCache,
  loadDynamicModelStore,
  mergeRuntimeModelProfileConfig,
  runtimeProfileIdForDynamicModel,
  runtimeProfileToDynamicEntry,
  upsertDynamicModel
} from "../extensions/dev.langchain-chat/runtime-user-model-store.js";

function jsonResponse(status, value) {
  return new globalThis.Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    values
  };
}

function runtimeState() {
  return {
    get: vi.fn((key) => {
      if (key === "runtime.mode") return "auto";
      if (key === "runtime.connection") {
        return { backend: "runtime", baseUrl: "http://runtime.test" };
      }
      return undefined;
    })
  };
}

describe("Runtime-backed user.dynamic model store", () => {
  beforeEach(() => {
    invalidateRuntimeDynamicModelCache();
  });

  it("maps Workbench dynamic model config to a Runtime model profile import", () => {
    expect(runtimeProfileIdForDynamicModel("kimi/k2.5")).toBe(
      "workbench.user.dynamic.kimi-k2.5"
    );
    expect(dynamicConfigToRuntimeImport("kimi-k2.5", {
      label: "Kimi",
      url: "https://models.example/v1/chat/completions",
      modelName: "moonshot-kimi",
      key: "secret",
      temperature: 0.2,
      max_tokens: 4096,
      supportsThinking: true
    })).toMatchObject({
      profile: {
        id: "workbench.user.dynamic.kimi-k2.5",
        providerId: "user.dynamic",
        sourceModelId: "kimi-k2.5",
        endpoint: "https://models.example/v1/chat/completions",
        model: "moonshot-kimi",
        temperature: 0.2,
        maxOutputTokens: 4096,
        capabilities: {
          supportsThinking: true
        }
      },
      credential: "secret"
    });
  });

  it("maps Runtime model profiles back to user.dynamic config without exposing credentials", () => {
    expect(runtimeProfileToDynamicEntry({
      id: "workbench.user.dynamic.kimi-k2.5",
      label: "Kimi",
      providerId: "user.dynamic",
      sourceModelId: "kimi-k2.5",
      providerType: "openai",
      endpoint: "https://models.example/v1/chat/completions",
      model: "moonshot-kimi",
      maxOutputTokens: 4096,
      capabilities: { supportsThinking: true },
      metadata: { description: "Fast", stream: true },
      credentialConfigured: true
    })).toEqual({
      id: "kimi-k2.5",
      config: expect.objectContaining({
        label: "Kimi",
        description: "Fast",
        url: "https://models.example/v1/chat/completions",
        modelName: "moonshot-kimi",
        _runtimeBacked: true,
        _credentialConfigured: true
      })
    });
  });

  it("resolves the selected Runtime profile and applies its thinking capabilities", () => {
    const profiles = [{
      id: "workbench.deepseek.deepseek-v4-flash",
      providerId: "deepseek",
      sourceModelId: "deepseek-v4-flash",
      providerType: "openai",
      endpoint: "https://runtime.example/chat",
      model: "deepseek-v4-flash",
      credentialConfigured: true,
      capabilities: {
        supportsThinking: true,
        preservedThinking: true,
        interleavedThinking: true,
        thinkingMode: "on",
        thinkingEffort: "high"
      }
    }];
    const profile = findRuntimeModelProfile(profiles, {
      profileId: "workbench.deepseek.deepseek-v4-flash",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash"
    });

    expect(mergeRuntimeModelProfileConfig({
      preservedThinking: false,
      interleavedThinking: false,
      thinkingMode: "off"
    }, profile)).toMatchObject({
      preservedThinking: true,
      interleavedThinking: true,
      thinkingMode: "on",
      thinkingEffort: "high",
      _runtimeBacked: true,
      _runtimeProfileId: "workbench.deepseek.deepseek-v4-flash",
      _credentialConfigured: true
    });
  });

  it("loads Runtime dynamic models over local fallback when Runtime is connected", async () => {
    const storage = memoryStorage({
      "zion.models.dynamic": JSON.stringify({
        local: {
          label: "Local",
          url: "https://local.example/chat",
          key: "local-key"
        }
      })
    });
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe("http://127.0.0.1:8766/v1/models");
      return jsonResponse(200, {
        profiles: [{
          id: "workbench.user.dynamic.remote",
          providerId: "user.dynamic",
          sourceModelId: "remote",
          providerType: "openai",
          endpoint: "https://remote.example/chat",
          model: "remote-model",
          credentialConfigured: true
        }]
      });
    });

    await expect(loadDynamicModelStore({
      state: runtimeState(),
      storage,
      fetchImpl
    })).resolves.toMatchObject({
      local: { label: "Local" },
      remote: {
        url: "https://remote.example/chat",
        modelName: "remote-model",
        _runtimeBacked: true,
        _credentialConfigured: true
      }
    });
  });

  it("coalesces and briefly caches Runtime model catalog reads", async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      profiles: [{
        id: "workbench.user.dynamic.remote",
        providerId: "user.dynamic",
        sourceModelId: "remote",
        providerType: "openai",
        endpoint: "https://remote.example/chat",
        model: "remote-model",
        credentialConfigured: true
      }]
    }));
    const options = {
      state: runtimeState(),
      storage,
      fetchImpl
    };

    const [first, second] = await Promise.all([
      loadDynamicModelStore(options),
      loadDynamicModelStore(options)
    ]);
    const third = await loadDynamicModelStore(options);

    expect(first.remote._credentialConfigured).toBe(true);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("upserts and deletes Runtime profiles while keeping local fallback in sync", async () => {
    const storage = memoryStorage();
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push({
        url: String(url),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : null
      });
      if (init.method === "PUT") {
        return jsonResponse(200, {
          profile: {
            id: "workbench.user.dynamic.kimi",
            providerId: "user.dynamic",
            sourceModelId: "kimi",
            model: "kimi-model",
            credentialConfigured: true
          }
        });
      }
      if (init.method === "DELETE") {
        return jsonResponse(200, {
          profile: {
            id: "workbench.user.dynamic.kimi",
            providerId: "user.dynamic",
            sourceModelId: "kimi",
            model: "kimi-model",
            credentialConfigured: false
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(upsertDynamicModel({
      modelId: "kimi",
      config: {
        label: "Kimi",
        url: "https://models.example/chat",
        key: "secret",
        modelName: "kimi-model"
      },
      state: runtimeState(),
      storage,
      fetchImpl
    })).resolves.toMatchObject({
      savedTo: "runtime",
      profile: {
        id: "workbench.user.dynamic.kimi",
        credentialConfigured: true
      }
    });
    expect(calls[0].body.credential).toBe("secret");
    const localProjection = JSON.parse(storage.values.get("zion.models.dynamic"));
    expect(localProjection).toMatchObject({
      kimi: {
        label: "Kimi",
        _runtimeBacked: true,
        _credentialConfigured: true
      }
    });
    expect(localProjection.kimi.key).toBeUndefined();

    await expect(deleteDynamicModel({
      modelId: "kimi",
      state: runtimeState(),
      storage,
      fetchImpl
    })).resolves.toMatchObject({
      deletedFrom: "runtime"
    });
    expect(JSON.parse(storage.values.get("zion.models.dynamic"))).toEqual({});
    expect(calls.map((call) => call.method)).toEqual(["PUT", "DELETE"]);
  });
});
