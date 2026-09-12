import { describe, expect, it, vi } from "vitest";
import { createPluginModelService } from "../src/plugin-model-service.mjs";

describe("plugin model service", () => {
  it("generates plain text through the configured Agent engine without tools", async () => {
    const onRequest = vi.fn();
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
      }),
      onRequest
    });

    await expect(service.generateText({
      model: { profileId: "runtime.default" },
      requestContext: {
        source: "identity-biography",
        parentRunId: "run-1",
        sessionId: "session-1"
      },
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "go" }
      ]
    })).resolves.toBe("hello runtime");
    expect(engine.streamTurn).toHaveBeenCalledOnce();
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
      request: { modelId: "kimi-k2.5" },
      requestContext: {
        source: "identity-biography",
        parentRunId: "run-1",
        sessionId: "session-1"
      },
      model: expect.objectContaining({
        modelId: "kimi-k2.5"
      }),
      timestamp: expect.any(Number)
    }));
  });
});
