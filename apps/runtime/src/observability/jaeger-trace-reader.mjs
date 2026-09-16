import { Buffer } from "node:buffer";

const TRACE_ID_PATTERN = /^[a-f0-9]{32}$/i;
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeBaseUrl(value) {
  const url = new globalThis.URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Jaeger query URL must use HTTP(S)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Jaeger query URL must not contain credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function requestUrl(baseUrl, path) {
  const url = new globalThis.URL(baseUrl.href);
  url.pathname = `${baseUrl.pathname}${path}`.replace(/\/{2,}/g, "/");
  return url;
}

async function boundedJson(response, maxResponseBytes) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxResponseBytes) {
    throw new Error("Jaeger response exceeds the configured limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxResponseBytes) {
    throw new Error("Jaeger response exceeds the configured limit");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Jaeger returned invalid JSON");
  }
}

export class JaegerTraceReader {
  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
  } = {}) {
    if (!fetchImpl) throw new Error("Jaeger Trace Reader requires fetch");
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.headers = Object.freeze({
      accept: "application/json",
      ...Object.fromEntries(
        Object.entries(headers || {})
          .map(([key, value]) => [String(key), String(value)])
          .filter(([key, value]) => key && value)
      )
    });
    this.timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = positiveInteger(
      maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES
    );
  }

  async request(path, signal) {
    const controller = new globalThis.AbortController();
    const abort = () => controller.abort();
    const cancellation = signal?.onCancel?.(abort);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener?.("abort", abort, { once: true });
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(requestUrl(this.baseUrl, path), {
        method: "GET",
        headers: this.headers,
        signal: controller.signal
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        const error = new Error(`Jaeger query HTTP ${response.status}`);
        error.code = "backend_http_error";
        error.statusCode = response.status;
        throw error;
      }
      return await boundedJson(response, this.maxResponseBytes);
    } catch (error) {
      if (error?.code === "backend_http_error") throw error;
      const wrapped = new Error(
        controller.signal.aborted
          ? "Jaeger query timed out or was cancelled"
          : "Jaeger query failed"
      );
      wrapped.code = controller.signal.aborted
        ? "backend_timeout"
        : "backend_unavailable";
      throw wrapped;
    } finally {
      globalThis.clearTimeout(timer);
      cancellation?.dispose?.();
      signal?.removeEventListener?.("abort", abort);
    }
  }

  async getTrace(traceId, signal) {
    const id = String(traceId || "").trim();
    if (!TRACE_ID_PATTERN.test(id)) throw new Error("Trace ID is invalid");
    const payload = await this.request(`/api/traces/${encodeURIComponent(id)}`, signal);
    const traces = Array.isArray(payload?.data) ? payload.data : [];
    return traces[0] && typeof traces[0] === "object" ? traces[0] : null;
  }

  async health(signal) {
    const payload = await this.request("/api/services", signal);
    return {
      available: !!payload,
      serviceCount: Array.isArray(payload?.data) ? payload.data.length : 0
    };
  }
}

export function createJaegerTraceReader(options) {
  return new JaegerTraceReader(options);
}
