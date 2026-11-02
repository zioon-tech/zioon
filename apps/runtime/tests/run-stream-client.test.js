import { describe, expect, it, vi } from "vitest";
import {
  getRunProjectionEvents,
  normalizeRunStreamOptions,
  runStreamUrl,
  subscribeRunStream
} from "../../../packages/runtime-client/src/run-stream.mjs";

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("shared Runtime Run stream client", () => {
  it("builds a bounded projection stream URL", () => {
    expect(runStreamUrl("http://runtime.test/", "run 1", {
      afterSequence: 12,
      reasoningMode: "none",
      maxDelayMs: 10,
      maxChunkChars: 100_000
    })).toBe(
      "http://runtime.test/v1/runs/run%201/projection/stream"
      + "?after=12&reasoning=none&max_delay_ms=50&max_chunk_chars=16384"
    );
    expect(normalizeRunStreamOptions({ mode: "invalid" }).mode)
      .toBe("projection");
  });

  it("parses projected SSE events", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      "id: 9\n"
      + "event: message.delta\n"
      + "data: {\"runId\":\"run-1\",\"sequence\":9,\"type\":\"message.delta\",\"data\":{\"delta\":\"hello\"}}\n\n",
      {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }
    ));

    await expect(collect(subscribeRunStream(
      "http://runtime.test",
      "run-1",
      {
        fetchImpl,
        afterSequence: 4,
        reasoningMode: "summary"
      }
    ))).resolves.toEqual([
      expect.objectContaining({
        runId: "run-1",
        sequence: 9,
        type: "message.delta",
        data: { delta: "hello" }
      })
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://runtime.test/v1/runs/run-1/projection/stream"
      + "?after=4&reasoning=summary&max_delay_ms=100&max_chunk_chars=512",
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "text/event-stream",
          "last-event-id": "4"
        })
      })
    );
  });

  it("fetches projected catch-up events", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      runId: "run-1",
      sourceCursor: 10,
      events: [{
        runId: "run-1",
        sequence: 10,
        type: "run.completed",
        data: { output: "done" }
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await expect(getRunProjectionEvents(
      "http://runtime.test",
      "run-1",
      {
        fetchImpl,
        afterSequence: 8,
        reasoningMode: "none"
      }
    )).resolves.toMatchObject({
      sourceCursor: 10,
      events: [expect.objectContaining({ sequence: 10 })]
    });
  });
});
