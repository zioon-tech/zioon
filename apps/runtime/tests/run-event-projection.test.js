import { describe, expect, it } from "vitest";
import {
  createRunEventProjector,
  normalizeRunProjectionOptions,
  projectRunEvents
} from "../src/run-event-projection.mjs";

function event(sequence, type, data = {}) {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    runId: "run-1",
    attemptId: "attempt-1",
    sequence,
    type,
    timestamp: 1_000 + sequence,
    data
  };
}

describe("Run event projection", () => {
  it("coalesces consecutive deltas and preserves the raw sequence cursor", () => {
    const projected = projectRunEvents([
      event(1, "run.started"),
      event(2, "reasoning.delta", { turn: 1, delta: "think " }),
      event(3, "reasoning.delta", { turn: 1, delta: "more" }),
      event(4, "reasoning.completed", { turn: 1 }),
      event(5, "message.delta", { turn: 1, delta: "hel" }),
      event(6, "message.delta", { turn: 1, delta: "lo" }),
      event(7, "message.completed", { turn: 1, content: "hello" }),
      event(8, "run.completed", { output: "hello" })
    ]);

    expect(projected.map((item) => item.type)).toEqual([
      "run.started",
      "reasoning.delta",
      "reasoning.completed",
      "message.delta",
      "message.completed",
      "run.completed"
    ]);
    expect(projected[1]).toMatchObject({
      sequence: 3,
      data: {
        delta: "think more",
        projection: {
          sourceSequenceStart: 2,
          sourceSequenceEnd: 3,
          sourceEventCount: 2,
          characterCount: 10
        }
      }
    });
    expect(projected[3]).toMatchObject({
      sequence: 6,
      data: {
        delta: "hello",
        projection: {
          sourceSequenceStart: 5,
          sourceSequenceEnd: 6,
          sourceEventCount: 2
        }
      }
    });
  });

  it("flushes a live batch on size or elapsed time", () => {
    const projector = createRunEventProjector({
      maxDelayMs: 100,
      maxChunkChars: 64
    });

    expect(projector.push(
      event(1, "message.delta", { delta: "abc" }),
      1_000
    )).toEqual([]);
    expect(projector.flushDue(1_050)).toEqual([]);
    expect(projector.push(
      event(2, "message.delta", { delta: "d".repeat(61) }),
      1_060
    )).toEqual([
      expect.objectContaining({
        sequence: 2,
        data: expect.objectContaining({ delta: `abc${"d".repeat(61)}` })
      })
    ]);

    expect(projector.push(
      event(3, "message.delta", { delta: "i" }),
      2_000
    )).toEqual([]);
    expect(projector.flushDue(2_100)).toEqual([
      expect.objectContaining({
        sequence: 3,
        data: expect.objectContaining({ delta: "i" })
      })
    ]);
  });

  it("supports clients that hide reasoning without losing cursor progress", () => {
    const projected = projectRunEvents([
      event(1, "reasoning.delta", { turn: 1, delta: "private" }),
      event(2, "reasoning.delta", { turn: 1, delta: " thought" }),
      event(3, "run.completed", { output: "done" })
    ], {
      reasoningMode: "none"
    });

    expect(projected).toEqual([
      expect.objectContaining({
        sequence: 2,
        type: "projection.cursor",
        data: {
          sourceType: "reasoning.delta",
          projection: expect.objectContaining({
            sourceSequenceStart: 1,
            sourceSequenceEnd: 2,
            sourceEventCount: 2
          })
        }
      }),
      expect.objectContaining({
        sequence: 3,
        type: "run.completed"
      })
    ]);
  });

  it("bounds a large reasoning stream without losing content or cursor", () => {
    const source = Array.from({ length: 10_000 }, (_, index) =>
      event(index + 1, "reasoning.delta", {
        turn: 1,
        delta: "abc"
      })
    );
    source.push(event(10_001, "reasoning.completed", { turn: 1 }));

    const projected = projectRunEvents(source, {
      maxChunkChars: 1_024
    });
    const deltas = projected.filter((item) =>
      item.type === "reasoning.delta"
    );

    expect(deltas.length).toBeLessThan(40);
    expect(deltas.map((item) => item.data.delta).join(""))
      .toBe("abc".repeat(10_000));
    expect(projected.at(-1)).toMatchObject({
      sequence: 10_001,
      type: "reasoning.completed"
    });
  });

  it("replaces large diagnostic payloads with lazy detail references", () => {
    const projected = projectRunEvents([
      event(1, "model.request", {
        modelId: "model",
        payload: {
          messages: [{ role: "user", content: "x".repeat(20_000) }],
          tools: [{ name: "read" }]
        }
      }),
      event(2, "tool.completed", {
        callId: "call-1",
        name: "read",
        result: "y".repeat(20_000)
      })
    ]);

    expect(projected[0]).toMatchObject({
      type: "model.request",
      data: {
        messageCount: 1,
        toolCount: 1,
        detailAvailable: true,
        rawEventSequence: 1
      }
    });
    expect(projected[0].data.payload).toBeUndefined();
    expect(projected[1]).toMatchObject({
      type: "tool.completed",
      data: {
        resultPreview: "y".repeat(4_096),
        resultSize: 20_000,
        resultTruncated: true,
        detailAvailable: true,
        rawEventSequence: 2
      }
    });
    expect(projected[1].data.result).toBeUndefined();
  });

  it("clamps projection policy to safe bounds", () => {
    expect(normalizeRunProjectionOptions({
      reasoningMode: "unknown",
      maxDelayMs: 1,
      maxChunkChars: 1_000_000
    })).toEqual({
      reasoningMode: "stream",
      maxDelayMs: 50,
      maxChunkChars: 16_384
    });
  });
});
