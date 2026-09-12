import { describe, expect, it, vi } from "vitest";
import {
  hydrateLlmRequestWorkbenchEvent,
  llmRequestPayloadFromWorkbenchEvent,
  registerLlmRequestPayload
} from "../src/runtime/llm-request-observability";

describe("LLM request observability", () => {
  it("maps Runtime Workbench events to the LLM request panel contract", () => {
    expect(llmRequestPayloadFromWorkbenchEvent({
      sequence: 18,
      type: "llm.request",
      runId: "run-1",
      sessionId: "session-1",
      createdAt: 1234,
      data: {
        id: "event-7",
        source: "identity-biography",
        providerId: "deepseek",
        providerType: "openai",
        modelId: "deepseek-v4",
        modelLabel: "DeepSeek V4",
        stream: true,
        messageCount: 2,
        toolCount: 0,
        payload: {
          model: "deepseek-v4",
          messages: [
            { role: "system", content: "distill" },
            { role: "user", content: "conversation" }
          ]
        }
      }
    })).toEqual({
      id: "event-7",
      timestamp: 1234,
      runId: "run-1",
      sessionId: "session-1",
      panelId: "",
      source: "identity-biography",
      requestSource: "identity-biography",
      stepIndex: undefined,
      providerId: "deepseek",
      providerType: "openai",
      modelId: "deepseek-v4",
      modelLabel: "DeepSeek V4",
      url: "",
      stream: true,
      messageCount: 2,
      toolCount: 0,
      payload: {
        model: "deepseek-v4",
        messages: [
          { role: "system", content: "distill" },
          { role: "user", content: "conversation" }
        ]
      }
    });
  });

  it("registers requests with the live panel or its startup queue", () => {
    const emit = vi.fn();
    const add = vi.fn();
    const liveHost = {
      events: { emit },
      llmPayloads: { add }
    };
    const payload = { id: "request-1", payload: { messages: [] } };

    expect(registerLlmRequestPayload(liveHost, payload)).toBe(payload);
    expect(emit).toHaveBeenCalledWith("llm/requestPayload", payload);
    expect(add).toHaveBeenCalledWith(payload);

    const queuedHost = {
      events: { emit: vi.fn() },
      __llmPayloadQueue: [] as Array<Record<string, unknown>>
    };
    registerLlmRequestPayload(queuedHost, payload);
    expect(queuedHost.__llmPayloadQueue).toEqual([payload]);
  });

  it("hydrates Run-backed request details without losing source metadata", async () => {
    const resolveDetail = vi.fn(async () => ({
      event: {
        type: "model.request",
        data: {
          providerId: "deepseek",
          modelId: "deepseek-v4",
          payload: {
            model: "deepseek-v4",
            messages: [{ role: "user", content: "background task" }]
          }
        }
      }
    }));

    await expect(hydrateLlmRequestWorkbenchEvent({
      sequence: 22,
      type: "llm.request",
      runId: "run-background",
      sessionId: "agent-task:review",
      data: {
        id: "event-22",
        source: "agent-task",
        detailAvailable: true,
        rawRunId: "run-background",
        rawEventSequence: 4
      }
    }, resolveDetail)).resolves.toMatchObject({
      data: {
        id: "event-22",
        source: "agent-task",
        providerId: "deepseek",
        modelId: "deepseek-v4",
        payload: {
          messages: [{ role: "user", content: "background task" }]
        }
      }
    });
    expect(resolveDetail).toHaveBeenCalledWith("run-background", 4);
  });
});
