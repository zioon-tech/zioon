import { describe, expect, it } from "vitest";
import {
  parseEventSourceResponse
} from "../../../packages/runtime-client/src/sse.mjs";

describe("shared SSE client", () => {
  it("parses fragmented event frames and preserves ids", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("id: 4\nevent: session."));
        controller.enqueue(encoder.encode(
          "updated\ndata: {\"sequence\":4,\"type\":\"session.updated\"}\n\n"
        ));
        controller.close();
      }
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
    const events = [];

    for await (const event of parseEventSourceResponse(response)) {
      events.push(event);
    }

    expect(events).toEqual([{
      id: "4",
      event: "session.updated",
      data: "{\"sequence\":4,\"type\":\"session.updated\"}"
    }]);
  });

  it("rejects an unsuccessful event response", async () => {
    const response = new Response("denied", { status: 403 });
    await expect(async () => {
      for await (const _event of parseEventSourceResponse(response)) {
        // No events are expected.
      }
    }).rejects.toThrow("denied");
  });
});
