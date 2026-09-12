import {
  classifyModelAvailabilityError,
  classifyModelAvailabilityHttpStatus
} from "./model-health.js";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_RETRY_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 4_000;

function emptyResult(status, reason, checkedAt, expiresAt, extra = {}) {
  return {
    status,
    reason,
    checkedAt,
    expiresAt,
    models: new Map(),
    ...extra
  };
}

export function createProviderModelDiscovery({
  buildRequest,
  parseModels,
  ttlMs = DEFAULT_TTL_MS,
  retryMs = DEFAULT_RETRY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  let cache = null;

  const discoverModels = async ({ credential = "", force = false } = {}) => {
    const checkedAt = Date.now();
    const credentialKey = String(credential || "").trim();
    if (!credentialKey) {
      return emptyResult("misconfigured", "missing_key", checkedAt, null);
    }
    if (!force && cache?.credential === credentialKey && cache.result?.expiresAt > checkedAt) {
      return cache.result;
    }
    if (typeof fetch !== "function") {
      return emptyResult("unknown", "fetch_unavailable", checkedAt, checkedAt + retryMs);
    }

    const startedAt = Date.now();
    try {
      const request = buildRequest(credentialKey);
      if (!request?.url) {
        return emptyResult("unknown", "probe_unsupported", checkedAt, checkedAt + retryMs);
      }
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller
        ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
        : null;
      let response;
      try {
        response = await fetch(request.url, {
          method: request.method || "GET",
          headers: request.headers,
          ...(controller ? { signal: controller.signal } : {})
        });
      } finally {
        if (timer) clearTimeout(timer);
      }

      const latencyMs = Math.max(0, Date.now() - startedAt);
      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        const failure = classifyModelAvailabilityError({
          status: response.status,
          responseText
        }) || classifyModelAvailabilityHttpStatus(response.status);
        const result = emptyResult(
          failure.status,
          failure.reason,
          checkedAt,
          checkedAt + retryMs,
          { httpStatus: response.status, latencyMs }
        );
        cache = { credential: credentialKey, result };
        return result;
      }

      const payload = await response.json();
      const parsed = parseModels(payload);
      const models = parsed instanceof Map
        ? parsed
        : new Map(Object.entries(parsed && typeof parsed === "object" ? parsed : {}));
      const result = {
        status: "available",
        reason: "provider_list",
        checkedAt,
        expiresAt: checkedAt + ttlMs,
        latencyMs,
        models
      };
      cache = { credential: credentialKey, result };
      return result;
    } catch (error) {
      const reason = error?.name === "AbortError" ? "timeout" : "network_error";
      const result = emptyResult(
        "degraded",
        reason,
        checkedAt,
        checkedAt + retryMs,
        { latencyMs: Math.max(0, Date.now() - startedAt) }
      );
      cache = { credential: credentialKey, result };
      return result;
    }
  };
  discoverModels.peek = ({ credential = "" } = {}) => {
    const credentialKey = String(credential || "").trim();
    if (
      credentialKey
      && cache?.credential === credentialKey
      && cache.result?.expiresAt > Date.now()
    ) {
      return cache.result;
    }
    return null;
  };
  return discoverModels;
}

export function buildDiscoveryAvailability(result, modelIds, resolveRemoteId = (id) => id) {
  const output = {};
  for (const modelId of modelIds || []) {
    if (result.status !== "available") {
      output[modelId] = {
        status: result.status,
        reason: result.reason,
        source: "provider-list",
        checkedAt: result.checkedAt,
        expiresAt: result.expiresAt,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus
      };
      continue;
    }
    const remoteId = String(resolveRemoteId(modelId) || modelId);
    const exists = result.models.has(remoteId);
    output[modelId] = {
      status: exists ? "available" : "unavailable",
      reason: exists ? "provider_list" : "model_not_found",
      source: "provider-list",
      checkedAt: result.checkedAt,
      expiresAt: result.expiresAt,
      latencyMs: result.latencyMs
    };
  }
  return output;
}
