import { TextDecoder } from "node:util";

function responseHeaders(headers) {
  return Object.fromEntries(Array.from(headers.entries()));
}

export function createFetchModelTransport({ fetchImpl = globalThis.fetch } = {}) {
  return async (request, signal) => {
    const controller = new globalThis.AbortController();
    const cancellation = signal.onCancel(() => controller.abort());
    let response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal
      });
    } catch (error) {
      cancellation.dispose();
      throw error;
    }

    let consumed = false;
    const consumeOnce = () => {
      if (consumed) throw new Error("Model response body has already been consumed");
      consumed = true;
    };
    const finish = () => cancellation.dispose();

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers),
      body: response.body
        ? {
            async *[Symbol.asyncIterator]() {
              consumeOnce();
              const decoder = new TextDecoder();
              try {
                for await (const chunk of response.body) {
                  yield typeof chunk === "string"
                    ? chunk
                    : decoder.decode(chunk, { stream: true });
                }
                const trailing = decoder.decode();
                if (trailing) yield trailing;
              } finally {
                finish();
              }
            }
          }
        : null,
      async json() {
        consumeOnce();
        try {
          return await response.json();
        } finally {
          finish();
        }
      },
      async text() {
        consumeOnce();
        try {
          return await response.text();
        } finally {
          finish();
        }
      }
    };
  };
}
