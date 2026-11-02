import { describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../src/model-registry.mjs";
import { ProfileRoutingEngine } from "../src/profile-routing-engine.mjs";

function registry() {
  return new ModelRegistry({
    defaultProfileId: "model-a",
    profiles: [{
      id: "model-a",
      label: "Model A",
      providerId: "provider-a",
      providerType: "openai",
      endpoint: "https://models.example/a",
      model: "model-a"
    }, {
      id: "model-b",
      label: "Model B",
      providerId: "provider-b",
      providerType: "openai",
      endpoint: "https://models.example/b",
      model: "model-b"
    }]
  });
}

describe("ProfileRoutingEngine", () => {
  it("resolves the default and explicitly selected Runtime profiles", () => {
    const router = new ProfileRoutingEngine({
      registry: registry(),
      activeProfileId: "model-a",
      createEngine: vi.fn()
    });

    expect(router.resolveModel()).toEqual({
      profileId: "model-a",
      providerId: "provider-a",
      modelId: "model-a",
      label: "Model A"
    });
    expect(router.resolveModel({
      profileId: "model-b",
      providerId: "provider-b",
      modelId: "model-b"
    })).toMatchObject({
      profileId: "model-b",
      providerId: "provider-b",
      modelId: "model-b"
    });
  });

  it("routes each Run turn through its selected profile engine", async () => {
    const streamTurn = vi.fn(async function* (request) {
      yield { type: "message.delta", delta: request.model.profileId };
    });
    const createEngine = vi.fn(() => ({ streamTurn }));
    const router = new ProfileRoutingEngine({
      registry: registry(),
      activeProfileId: "model-a",
      createEngine
    });
    const events = [];

    for await (const event of router.streamTurn({
      model: {
        profileId: "model-b",
        providerId: "provider-b",
        modelId: "model-b"
      }
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "message.delta", delta: "model-b" }
    ]);
    expect(createEngine).toHaveBeenCalledWith(expect.objectContaining({
      id: "model-b",
      endpoint: "https://models.example/b"
    }));
  });

  it("rejects unavailable profiles instead of selecting another model", () => {
    const router = new ProfileRoutingEngine({
      registry: registry(),
      activeProfileId: "model-a",
      createEngine: vi.fn()
    });

    expect(() => router.resolveModel({
      profileId: "missing",
      providerId: "provider-x",
      modelId: "model-x"
    })).toThrow("Model profile not found");
  });
});
