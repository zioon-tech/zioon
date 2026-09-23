import { describe, expect, it, vi } from "vitest";
import {
  createModelRequestPublisher,
  observeRunModelRequests
} from "../src/model-request-observability.mjs";

describe("model request observability", () => {
  it("publishes a content-free request summary through the Workbench event feed", async () => {
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
          tools: [{ type: "function", function: { name: "read" } }]
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
        summaryVersion: 1,
        messageCount: 1,
        toolCount: 1,
        toolNames: ["read"],
        payloadBytes: expect.any(Number),
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        messagesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        toolsHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    });
    expect(JSON.stringify(eventStore.appendEvent.mock.calls[0][1]))
      .not.toContain("hello");
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
        summaryVersion: 1,
        messageCount: 1,
        toolCount: 0,
        toolNames: ["read"],
        payloadBytes: 128,
        payloadHash: "a".repeat(64),
        messagesHash: "b".repeat(64),
        toolsHash: "c".repeat(64),
        config: {}
      }
    });

    expect(publish).toHaveBeenCalledWith({
      request: expect.objectContaining({
        turn: 3,
        summaryVersion: 1,
        messageCount: 1
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
      timestamp: 9000
    });
    expect(subscription).toEqual(expect.objectContaining({
      dispose: expect.any(Function)
    }));
  });

  it("publishes the Run-backed detail pointer with a request summary", async () => {
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
        summaryVersion: 1,
        messageCount: 1,
        toolCount: 0,
        toolNames: ["read"],
        payloadBytes: 1024,
        payloadHash: "a".repeat(64),
        messagesHash: "b".repeat(64),
        toolsHash: "c".repeat(64),
        config: {}
      },
      detailReference: {
        runId: "run-10",
        sequence: 5
      }
    });

    const eventPayload = eventStore.appendEvent.mock.calls[0][1].payload;
    expect(eventPayload).toMatchObject({
      id: "event-10",
      summaryVersion: 1,
      messageCount: 1,
      toolNames: ["read"],
      payloadBytes: 1024,
      payloadHash: "a".repeat(64),
      detailAvailable: true,
      rawRunId: "run-10",
      rawEventSequence: 5
    });
    expect(eventPayload).not.toHaveProperty("payload");
  });
});
