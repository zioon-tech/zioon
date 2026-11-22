/** Reuse the sharing client's abort linkage without requiring AbortSignal.any. */
export function createRequestSignal(signal, timeoutMs = 30000) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); } };
}
