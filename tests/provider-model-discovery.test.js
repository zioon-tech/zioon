import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderModelDiscovery
} from "../extensions/dev.langchain-chat/provider-model-discovery.js";
import {
  deriveOpenAIModelsUrl,
  userModelsProvider
} from "../extensions/dev.langchain-chat/user-models-provider.js";

describe("provider model discovery", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("caches a successful provider model listing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new globalThis.Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const discover = createProviderModelDiscovery({
      buildRequest: () => ({ url: "https://provider.test/v1/models" }),
      parseModels: (payload) => new Map(payload.data.map((item) => [item.id, item]))
    });

    expect(discover.peek({ credential: "key" })).toBeNull();
    const first = await discover({ credential: "key" });
    const second = await discover({ credential: "key" });

    expect(first.status).toBe("available");
    expect(first.models.has("model-a")).toBe(true);
    expect(discover.peek({ credential: "key" })).toBe(first);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("classifies provider authentication failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new globalThis.Response("unauthorized", { status: 401 })
    );
    const discover = createProviderModelDiscovery({
      buildRequest: () => ({ url: "https://provider.test/v1/models" }),
      parseModels: () => new Map()
    });

    await expect(discover({ credential: "bad-key" })).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid_credentials",
      httpStatus: 401
    });
  });

  it("recognizes providers that report invalid keys as HTTP 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new globalThis.Response('{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid"}}', {
        status: 400
      })
    );
    const discover = createProviderModelDiscovery({
      buildRequest: () => ({ url: "https://provider.test/v1/models" }),
      parseModels: () => new Map()
    });

    await expect(discover({ credential: "invalid-key" })).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid_credentials",
      httpStatus: 400
    });
  });

  it("derives and probes an OpenAI-compatible models endpoint", async () => {
    expect(deriveOpenAIModelsUrl("https://gateway.test/openai/v1/chat/completions"))
      .toBe("https://gateway.test/openai/v1/models");
    localStorage.setItem("zion.models.dynamic", JSON.stringify({
      custom: {
        url: "https://gateway.test/openai/v1/chat/completions",
        key: "custom-key",
        modelName: "remote-model",
        providerType: "openai"
      }
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new globalThis.Response(JSON.stringify({ data: [{ id: "remote-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    const result = await userModelsProvider.checkAvailability({
      modelIds: ["custom"],
      force: true
    });

    expect(result.models.custom).toMatchObject({
      status: "available",
      reason: "provider_list"
    });
  });

  it("keeps custom models unknown when the gateway has no models endpoint", async () => {
    localStorage.setItem("zion.models.dynamic", JSON.stringify({
      customWithoutList: {
        url: "https://gateway-without-list.test/v1/chat/completions",
        key: "custom-key-2",
        modelName: "remote-model",
        providerType: "openai"
      }
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new globalThis.Response("not found", { status: 404 })
    );

    const result = await userModelsProvider.checkAvailability({
      modelIds: ["customWithoutList"],
      force: true
    });

    expect(result.models.customWithoutList).toMatchObject({
      status: "unknown",
      reason: "probe_unsupported"
    });
  });
});
