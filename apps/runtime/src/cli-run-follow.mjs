import { setTimeout as delay } from "node:timers/promises";
import { subscribeRunStream } from "../../../packages/runtime-client/src/run-stream.mjs";

// Observation ends when the current attempt yields; waiting is still an active Run.
export const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "interrupted", "waiting"]);

export function boundedFetch(fetchImpl, headers = {}, timeoutMs = 30_000) {
  return (url, options = {}) => fetchImpl(url, {
    ...options,
    redirect: "error",
    headers: { ...headers, ...options.headers },
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
  });
}

export async function cliJson(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(typeof body?.error === "string" ? body.error : `Runtime HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  if (!body || typeof body !== "object") throw new Error("Runtime returned an invalid JSON response");
  return body;
}

// Cursor always uses the source sequence, shared by projection and raw events.
// Mutations are never retried; only read-side observation may reconnect.
export async function followCliRun({
  baseUrl, runId, fetchImpl, headers = {}, onEvent = () => {},
  signal, mode = "projection", reasoningMode = "none", afterSequence = 0,
  pollIntervalMs = 750, onConnection = () => {}, streamTimeoutMs = 45_000
}) {
  const url = String(baseUrl).replace(/\/+$/, "");
  const root = `${url}/v1/runs/${encodeURIComponent(runId)}`;
  const request = boundedFetch(fetchImpl, headers);
  let cursor = Math.max(0, Number(afterSequence) || 0);
  let terminalEvent = false;
  const emit = (event) => {
    const sequence = Number(event.sequence) || 0;
    if (sequence <= cursor) return;
    cursor = sequence;
    onEvent(event);
    if (TERMINAL_STATUSES.has(event.type?.replace(/^run\./, ""))) terminalEvent = true;
  };
  let failures = 0;
  let useStream = true;
  while (true) {
    signal?.throwIfAborted();
    if (useStream) {
      try {
        for await (const event of subscribeRunStream(url, runId, {
          fetchImpl: request, headers, mode, reasoningMode, afterSequence: cursor,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(streamTimeoutMs)])
            : AbortSignal.timeout(streamTimeoutMs)
        })) {
          emit(event);
          if (terminalEvent) break;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if ([401, 403].includes(error.statusCode)) throw error;
        if ([404, 405, 501].includes(error.statusCode)) {
          useStream = false;
          // Older Runtimes may not implement projection at all.
          mode = "raw";
        }
        onConnection(useStream ? "Reconnecting" : "Polling");
      }
    }
    try {
      // Read status before the drain: terminal state guarantees all final events
      // are already durable, even when completion raced the broken stream.
      const { run } = await cliJson(await request(root, { signal }));
      if (!run?.status) throw new Error("Runtime response is missing Run status");
      const suffix = mode === "raw" ? "events" : "projection";
      let response = await request(`${root}/${suffix}?after=${cursor}&reasoning=${reasoningMode}`, { signal });
      if (mode === "projection" && [404, 405, 501].includes(response.status)) {
        mode = "raw";
        response = await request(`${root}/events?after=${cursor}`, { signal });
      }
      const body = await cliJson(response);
      if (!Array.isArray(body.events)) throw new Error("Runtime response is missing Run events");
      for (const event of body.events) emit(event);
      if (TERMINAL_STATUSES.has(run.status)) return run;
      failures = 0;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.statusCode && error.statusCode < 500) throw error;
      if (++failures >= 3) throw error;
      onConnection("Reconnecting");
    }
    await delay(Math.max(25, pollIntervalMs) * Math.max(1, failures), undefined, { signal });
  }
}
