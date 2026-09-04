import { subscribeEventSource } from "./sse.mjs";

const STREAM_MODES = new Set(["raw", "projection"]);
const REASONING_MODES = new Set(["stream", "summary", "none"]);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : fallback;
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value || "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Runtime URL is required");
  return baseUrl;
}

export function normalizeRunStreamOptions(input = {}) {
  return {
    mode: STREAM_MODES.has(String(input.mode || ""))
      ? String(input.mode)
      : "projection",
    reasoningMode: REASONING_MODES.has(String(input.reasoningMode || ""))
      ? String(input.reasoningMode)
      : "stream",
    afterSequence: Math.max(0, Number(input.afterSequence) || 0),
    maxDelayMs: Math.max(
      50,
      Math.min(2_000, positiveInteger(input.maxDelayMs, 100))
    ),
    maxChunkChars: Math.max(
      64,
      Math.min(16_384, positiveInteger(input.maxChunkChars, 512))
    )
  };
}

export function runStreamUrl(baseUrl, runId, input = {}) {
  const options = normalizeRunStreamOptions(input);
  const suffix = options.mode === "raw"
    ? "events/stream"
    : "projection/stream";
  const query = new URLSearchParams({
    after: String(options.afterSequence)
  });
  if (options.mode === "projection") {
    query.set("reasoning", options.reasoningMode);
    query.set("max_delay_ms", String(options.maxDelayMs));
    query.set("max_chunk_chars", String(options.maxChunkChars));
  }
  return `${normalizeBaseUrl(baseUrl)}/v1/runs/${encodeURIComponent(runId)}/${suffix}?${query}`;
}

export async function* subscribeRunStream(baseUrl, runId, {
  fetchImpl = globalThis.fetch,
  headers = {},
  signal,
  ...input
} = {}) {
  const options = normalizeRunStreamOptions(input);
  for await (const frame of subscribeEventSource(
    runStreamUrl(baseUrl, runId, options),
    {
      fetchImpl,
      headers,
      lastEventId: options.afterSequence,
      signal
    }
  )) {
    let event;
    try {
      event = frame.data ? JSON.parse(frame.data) : null;
    } catch {
      throw new Error("Runtime returned invalid Run stream JSON");
    }
    if (frame.event === "error") {
      throw new Error(event?.error || "Runtime Run stream failed");
    }
    if (event) yield event;
  }
}

export async function getRunProjectionEvents(baseUrl, runId, {
  fetchImpl = globalThis.fetch,
  headers = {},
  ...input
} = {}) {
  if (!fetchImpl) throw new Error("fetch implementation is required");
  const options = normalizeRunStreamOptions({
    ...input,
    mode: "projection"
  });
  const streamUrl = new URL(runStreamUrl(baseUrl, runId, options));
  streamUrl.pathname = streamUrl.pathname.replace(
    /\/projection\/stream$/,
    "/projection"
  );
  const response = await fetchImpl(streamUrl.toString(), {
    headers: {
      accept: "application/json",
      ...headers
    }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime HTTP ${response.status}`);
  }
  if (!Array.isArray(body?.events)) {
    throw new Error("Runtime response is missing projected events");
  }
  return body;
}
