import { describe, expect, it, vi } from "vitest";
import { createPluginModelService } from "../src/plugin-model-service.mjs";

describe("plugin model service", () => {
  it("generates plain text through the configured Agent engine without tools", async () => {
    const engine = {
      streamTurn: vi.fn(async function* (request) {
        expect(request.tools).toEqual([]);
        expect(request.model).toEqual({
          profileId: "runtime.default",
          providerId: "runtime",
          modelId: "kimi-k2.5",
          label: "Kimi K2.5"
        });
        yield { type: "model.request", request: { modelId: "kimi-k2.5" } };
        yield { type: "message.delta", delta: "hello " };
        yield { type: "message.delta", delta: "runtime" };
      })
    };
    const service = createPluginModelService({
      engine,
      resolveModel: (model) => ({
        profileId: model.profileId,
        providerId: "runtime",
        modelId: "kimi-k2.5",
        label: "Kimi K2.5"
      })
    });

    await expect(service.generateText({
      model: { profileId: "runtime.default" },
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "go" }
      ]
    })).resolves.toBe("hello runtime");
    expect(engine.streamTurn).toHaveBeenCalledOnce();
  });
});
