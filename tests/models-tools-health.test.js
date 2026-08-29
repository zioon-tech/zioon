import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelsTools } from "../extensions/dev.langchain-chat/models-tools.js";

function createState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn((key) => values.get(key)),
    set: vi.fn((key, value) => {
      values.set(key, value);
      return value;
    })
  };
}

describe("modelsManage health queries", () => {
  let provider;

  beforeEach(() => {
    localStorage.clear();
    provider = {
      id: "test-provider",
      list: vi.fn(async () => [
        { id: "ready", label: "Ready" },
        { id: "down", label: "Down" }
      ]),
      resolve: vi.fn(async (modelId) => ({
        id: modelId,
        url: "https://provider.test/v1/chat/completions",
        key: "key",
        modelName: modelId,
        providerType: "openai"
      })),
      checkAvailability: vi.fn(async ({ modelIds }) => ({
        models: Object.fromEntries(modelIds.map((modelId) => [
          modelId,
          {
            status: modelId === "ready" ? "available" : "unavailable",
            reason: modelId === "ready" ? "provider_list" : "model_not_found",
            source: "provider-list",
            checkedAt: Date.now(),
            expiresAt: Date.now() + 60_000
          }
        ]))
      }))
    };
    const providers = new Map([[provider.id, provider]]);
    window.zion = {
      state: createState({
        "chat.tools": [],
        "chat.toolHandlers": {}
      }),
      events: { emit: vi.fn() },
      models: {
        listProviders: vi.fn(() => Array.from(providers.keys())),
        getProvider: vi.fn((id) => providers.get(id) || null),
        registerProvider: vi.fn((next) => {
          providers.set(next.id, next);
          return { dispose() {} };
        })
      }
    };
    registerModelsTools();
  });

  it("returns and filters model availability for the meta agent", async () => {
    const handler = window.zion.state.get("chat.toolHandlers").modelsManage;
    const result = JSON.parse(await handler({
      action: "list",
      availability: "available"
    }));

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      providerId: "test-provider",
      id: "ready",
      availability: {
        status: "available",
        reason: "provider_list"
      }
    });
    expect(result.summary).toEqual({
      available: 1,
      unavailable: 1
    });
  });

  it("does not activate a known unavailable model unless forced", async () => {
    const handler = window.zion.state.get("chat.toolHandlers").modelsManage;
    await handler({ action: "list" });

    const blocked = JSON.parse(await handler({
      action: "set_active",
      provider_id: "test-provider",
      model_id: "down"
    }));
    expect(blocked).toMatchObject({
      error: "Model is not currently usable",
      availability: { status: "unavailable" }
    });

    const forced = JSON.parse(await handler({
      action: "set_active",
      provider_id: "test-provider",
      model_id: "down",
      force: true
    }));
    expect(forced.set_active).toBe("test-provider:down");
  });
});
