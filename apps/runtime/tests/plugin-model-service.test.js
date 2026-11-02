import { describe, expect, it, vi } from "vitest";
import { createPluginModelService } from "../src/plugin-model-service.mjs";
import { CancellationController } from "../../../packages/runtime/src/index";

describe("plugin model service", () => {
  it("propagates parent cancellation and observes summary usage/output limits", async () => {
    const parent = new CancellationController();
    const usage = vi.fn();
    const service = createPluginModelService({ engine: {
      async *streamTurn(request) {
        expect(request.maxOutputTokens).toBe(512);
        expect(request.modelOptions).toEqual({ thinkingMode: "off" });
        yield { type: "model.usage", usage: { inputTokens: 120, outputTokens: 10 } };
        parent.cancel("user");
        request.signal.throwIfCancelled();
      }
    }});
    await expect(service.generateText({ messages: [{ role: "user", content: "summary" }],
      signal: parent.signal, maxOutputTokens: 512, modelOptions: { thinkingMode: "off" }, onUsage: usage
    })).rejects.toThrow("cancelled");
    expect(usage).toHaveBeenCalledWith({ inputTokens: 120, outputTokens: 10 });
  });

  it("rejects oversized generated summaries", async () => {
    const service = createPluginModelService({ engine: { async *streamTurn() {
      yield { type: "message.delta", delta: "too much output" };
    }}});
    await expect(service.generateText({ messages: [{ role: "user", content: "summary" }], maxOutputChars: 3 }))
      .rejects.toThrow("exceeded its budget");
  });

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
