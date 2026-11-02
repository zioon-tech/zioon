import { createParser } from "eventsource-parser";

export async function* parseEventSourceResponse(response, {
  signal,
  maxBufferSize = 1024 * 1024
} = {}) {
  if (!response?.ok) {
    const body = await response?.text?.().catch(() => "");
    const error = new Error(body || `Event stream HTTP ${response?.status || 0}`);
    error.statusCode = Number(response?.status || 0);
    throw error;
  }
  if (!response.body) throw new Error("Event stream response has no body");

  const queue = [];
  let parseError = null;
  const parser = createParser({
    maxBufferSize,
    onEvent(event) {
      queue.push({
        id: String(event.id || ""),
        event: String(event.event || "message"),
        data: String(event.data || "")
      });
    },
    onError(error) {
      parseError = error;
    }
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      parser.feed(decoder.decode(value || new Uint8Array(), { stream: !done }));
      if (parseError) throw parseError;
      while (queue.length) yield queue.shift();
      if (done) break;
    }
    parser.reset({ consume: true });
    if (parseError) throw parseError;
    while (queue.length) yield queue.shift();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The remote peer may already have closed the stream.
    }
  }
}

export async function* subscribeEventSource(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  lastEventId = "",
  signal,
  maxBufferSize
} = {}) {
  if (!fetchImpl) throw new Error("fetch implementation is required");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      ...(lastEventId ? { "last-event-id": String(lastEventId) } : {}),
      ...headers
    },
    signal
  });
  yield* parseEventSourceResponse(response, { signal, maxBufferSize });
}
