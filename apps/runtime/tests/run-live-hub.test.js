import { describe, expect, it } from "vitest";
import { createRunLiveHub } from "../src/run-live-hub.mjs";

function event(sequence, type, data = {}) {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    runId: "run-live",
    attemptId: "attempt-live",
    sequence,
    type,
    timestamp: sequence,
    data
  };
}

async function collect(iterable) {
  const result = [];
  for await (const item of iterable) result.push(item);
  return result;
}

describe("Run live event hub", () => {
  it("coalesces transient deltas and retains a bounded in-memory replay", async () => {
    const hub = createRunLiveHub({
      maxDelayMs: 1000,
      maxChunkChars: 32
    });
    hub.publish(event(1, "run.started"));
    hub.publish(event(2, "message.delta", {
      turn: 1,
      delta: "a".repeat(40)
    }));
    hub.publish(event(3, "message.delta", {
      turn: 1,
      delta: "b".repeat(40)
    }));
    hub.publish(event(4, "message.completed", {
      turn: 1,
      content: `${"a".repeat(40)}${"b".repeat(40)}`
    }));
    hub.close();

    expect(hub.status.replayEvents).toBe(4);
    const replay = await collect(hub.subscribe(0));
    expect(replay.map((item) => item.type)).toEqual([
      "run.started",
      "message.delta",
      "message.completed"
    ]);
    expect(replay[1]).toMatchObject({
      sequence: 3,
      data: {
        delta: `${"a".repeat(40)}${"b".repeat(40)}`,
        projection: {
          sourceSequenceStart: 2,
          sourceSequenceEnd: 3,
          sourceEventCount: 2,
          transient: true
        }
      }
    });
    expect(hub.eventsAfter(2).map((item) => item.sequence)).toEqual([3, 4]);
    expect(hub.status.replayBytes).toBeGreaterThan(0);
  });

  it("flushes live text on the configured timer and multicasts it", async () => {
    const hub = createRunLiveHub({
      maxDelayMs: 20,
      maxChunkChars: 256
    });
    const first = hub.subscribe(0)[Symbol.asyncIterator]();
    const second = hub.subscribe(0)[Symbol.asyncIterator]();
    hub.publish(event(1, "reasoning.delta", { turn: 1, delta: "inspect" }));

    const [left, right] = await Promise.all([first.next(), second.next()]);
    expect(left.value).toMatchObject({
      sequence: 1,
      type: "reasoning.delta",
      data: { delta: "inspect" }
    });
    expect(right.value).toEqual(left.value);

    hub.close();
    await expect(first.next()).resolves.toMatchObject({ done: true });
    await expect(second.next()).resolves.toMatchObject({ done: true });
  });

  it("releases an idle subscriber when its connection is aborted", async () => {
    const hub = createRunLiveHub();
    const controller = new AbortController();
    const iterator = hub.subscribe(0, {
      signal: controller.signal
    })[Symbol.asyncIterator]();
    const pending = iterator.next();

    controller.abort();

    await expect(pending).resolves.toMatchObject({ done: true });
    hub.close();
  });
});
