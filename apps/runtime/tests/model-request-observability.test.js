import { describe, expect, it, vi } from "vitest";
import {
  createModelRequestPublisher,
  observeRunModelRequests
} from "../src/model-request-observability.mjs";

describe("model request observability", () => {
  it("publishes a complete request through the Workbench event feed", async () => {
    const eventStore = {
      appendEvent: vi.fn(() => ({ sequence: 42 }))
    };
    const publish = createModelRequestPublisher({ eventStore });

    await expect(publish({
      observationId: "event-7",
      timestamp: 1234,
      requestContext: {
        source: "scheduler-worker",
        sessionId: "scheduled:daily",
        runId: "run-1",
        panelId: "panel-1",
        stepIndex: 2
      },
      model: {
        providerId: "runtime",
        modelId: "fallback-model",
        label: "Fallback"
      },
      request: {
        url: "https://model.test/v1/chat/completions",
        providerId: "deepseek",
        providerType: "openai",
        modelId: "deepseek-v4",
        modelLabel: "DeepSeek V4",
        stream: true,
        payload: {
          model: "deepseek-v4",
          messages: [{ role: "user", content: "hello" }],
          tools: [{ type: "function" }]
        }
      }
    })).resolves.toEqual({ sequence: 42 });

    expect(eventStore.appendEvent).toHaveBeenCalledWith("llm.request", {
      sessionId: "scheduled:daily",
      runId: "run-1",
      timestamp: 1234,
      payload: expect.objectContaining({
        id: "event-7",
        source: "scheduler-worker",
        requestSource: "scheduler-worker",
        parentRunId: "run-1",
        panelId: "panel-1",
        stepIndex: 2,
        providerId: "deepseek",
        providerType: "openai",
        modelId: "deepseek-v4",
        modelLabel: "DeepSeek V4",
        messageCount: 1,
        toolCount: 1,
        payload: {
          model: "deepseek-v4",
          messages: [{ role: "user", content: "hello" }],
          tools: [{ type: "function" }]
        }
      })
    });
  });

  it("observes every persisted Run model request with its source metadata", async () => {
    let listener = null;
    const runStore = {
      subscribeEvents: vi.fn((next) => {
        listener = next;
        return { dispose: vi.fn() };
      }),
      get: vi.fn(async () => ({
        sessionId: "agent-task:review",
        model: { modelId: "deepseek-v4" },
        metadata: {
          source: "agent-task",
          panelId: "agents:review"
        }
      }))
    };
    const publish = vi.fn(async () => {});
    const subscription = observeRunModelRequests({ runStore, publish });

    await listener({
      eventId: "event-9",
      runId: "run-9",
      attemptId: "attempt-9",
      sequence: 4,
      type: "model.request",
      timestamp: 9000,
      data: {
        turn: 3,
        payload: {
          messages: [{ role: "user", content: "review" }]
        }
      }
    });

    expect(publish).toHaveBeenCalledWith({
      request: expect.objectContaining({
        turn: 3,
        payload: expect.any(Object)
      }),
      requestContext: {
        source: "agent-task",
        sessionId: "agent-task:review",
        runId: "run-9",
        panelId: "agents:review",
        stepIndex: 3
      },
      model: { modelId: "deepseek-v4" },
      observationId: "event-9",
      detailReference: {
        runId: "run-9",
        sequence: 4
      },
      timestamp: 9000
    });
    expect(subscription).toEqual(expect.objectContaining({
      dispose: expect.any(Function)
    }));
  });

  it("stores only a detail pointer for Run-backed requests", async () => {
    const eventStore = {
      appendEvent: vi.fn(() => ({ sequence: 43 }))
    };
    const publish = createModelRequestPublisher({ eventStore });

    await publish({
      observationId: "event-10",
      requestContext: {
        source: "interactive",
        sessionId: "session-1",
        runId: "run-10"
      },
      request: {
        modelId: "deepseek-v4",
        payload: {
          messages: [{ role: "user", content: "large payload" }]
        }
      },
      detailReference: {
        runId: "run-10",
        sequence: 5
      }
    });

    const eventPayload = eventStore.appendEvent.mock.calls[0][1].payload;
    expect(eventPayload).toMatchObject({
      id: "event-10",
      detailAvailable: true,
      rawRunId: "run-10",
      rawEventSequence: 5,
      messageCount: 1
    });
    expect(eventPayload).not.toHaveProperty("payload");
  });
});
