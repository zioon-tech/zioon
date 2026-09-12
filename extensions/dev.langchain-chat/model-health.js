export const MODEL_AVAILABILITY_STATUSES = [
  "available",
  "degraded",
  "unavailable",
  "misconfigured",
  "unknown"
];

export const MODEL_HEALTH_STORAGE_KEY = "zion.models.health.v1";

const STATUS_SET = new Set(MODEL_AVAILABILITY_STATUSES);
const STATUS_TTL_MS = {
  available: 30 * 60_000,
  degraded: 5 * 60_000,
  unavailable: 15 * 60_000,
  unknown: 5 * 60_000
};

export function modelHealthKey(providerId, modelId) {
  return `${encodeURIComponent(String(providerId || ""))}::${encodeURIComponent(String(modelId || ""))}`;
}

function readLocalHealth() {
  try {
    const raw = localStorage.getItem(MODEL_HEALTH_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getModelHealthSnapshot() {
  try {
    const stateValue = window.zion?.state?.get?.("models.health");
    if (stateValue && typeof stateValue === "object" && !Array.isArray(stateValue)) {
      return stateValue;
    }
  } catch {}
  return readLocalHealth();
}

function publishHealth(next) {
  try {
    localStorage.setItem(MODEL_HEALTH_STORAGE_KEY, JSON.stringify(next));
  } catch {}
  try {
    window.zion?.state?.set?.("models.health", next);
  } catch {}
}

function defaultExpiry(status, checkedAt) {
  const ttl = STATUS_TTL_MS[status];
  return ttl ? checkedAt + ttl : null;
}

export function normalizeModelAvailability(value, now = Date.now()) {
  const source = value && typeof value === "object" ? value : {};
  const originalStatus = STATUS_SET.has(source.status) ? source.status : "unknown";
  const expiresAt = Number(source.expiresAt || 0);
  const expired = originalStatus !== "misconfigured" && expiresAt > 0 && expiresAt <= now;
  return {
    status: expired ? "unknown" : originalStatus,
    reason: expired ? "stale" : String(source.reason || (originalStatus === "unknown" ? "not_checked" : "")),
    source: String(source.source || "unknown"),
    checkedAt: Number(source.checkedAt || 0),
    expiresAt: expiresAt || null,
    stale: expired || !!source.stale,
    ...(Number.isFinite(Number(source.latencyMs)) ? { latencyMs: Number(source.latencyMs) } : {}),
    ...(Number.isFinite(Number(source.httpStatus)) && Number(source.httpStatus) > 0
      ? { httpStatus: Number(source.httpStatus) }
      : {}),
    ...(Number(source.lastSuccessAt || 0) > 0 ? { lastSuccessAt: Number(source.lastSuccessAt) } : {}),
    ...(Number(source.lastFailureAt || 0) > 0 ? { lastFailureAt: Number(source.lastFailureAt) } : {}),
    ...(Number(source.consecutiveFailures || 0) > 0
      ? { consecutiveFailures: Number(source.consecutiveFailures) }
      : {})
  };
}

export function getModelAvailability(providerId, modelId, now = Date.now()) {
  const health = getModelHealthSnapshot();
  return normalizeModelAvailability(health[modelHealthKey(providerId, modelId)], now);
}

export function isModelAvailabilityFresh(value, now = Date.now()) {
  const availability = normalizeModelAvailability(value, now);
  if (availability.status === "misconfigured") return true;
  return availability.status !== "unknown" && !availability.stale;
}

function createHealthRecord(providerId, modelId, patch, previous = {}, now = Date.now()) {
  const status = STATUS_SET.has(patch?.status) ? patch.status : "unknown";
  const checkedAt = Number(patch?.checkedAt || now);
  const isSuccess = status === "available";
  const isFailure = status === "degraded" || status === "unavailable" || status === "misconfigured";
  return {
    providerId: String(providerId || ""),
    modelId: String(modelId || ""),
    status,
    reason: String(patch?.reason || ""),
    source: String(patch?.source || "unknown"),
    checkedAt,
    expiresAt: patch?.expiresAt === null
      ? null
      : Number(patch?.expiresAt || defaultExpiry(status, checkedAt) || 0) || null,
    ...(Number.isFinite(Number(patch?.latencyMs)) ? { latencyMs: Number(patch.latencyMs) } : {}),
    ...(Number.isFinite(Number(patch?.httpStatus)) && Number(patch.httpStatus) > 0
      ? { httpStatus: Number(patch.httpStatus) }
      : {}),
    lastSuccessAt: isSuccess ? checkedAt : Number(previous.lastSuccessAt || 0) || undefined,
    lastFailureAt: isFailure ? checkedAt : Number(previous.lastFailureAt || 0) || undefined,
    consecutiveFailures: isSuccess
      ? 0
      : isFailure
        ? Number(previous.consecutiveFailures || 0) + 1
        : Number(previous.consecutiveFailures || 0)
  };
}

function patchCatalogAvailability(nextHealth) {
  try {
    const catalog = window.zion?.state?.get?.("models.catalog");
    if (!Array.isArray(catalog)) return;
    const nextCatalog = catalog.map((item) => applyModelAvailability(item, nextHealth));
    window.zion?.state?.set?.("models.catalog", nextCatalog);
  } catch {}
}

export function setModelAvailabilities(entries, now = Date.now()) {
  if (!Array.isArray(entries) || entries.length === 0) return getModelHealthSnapshot();
  const current = { ...getModelHealthSnapshot() };
  for (const entry of entries) {
    const providerId = String(entry?.providerId || "");
    const modelId = String(entry?.modelId || "");
    if (!providerId || !modelId) continue;
    const key = modelHealthKey(providerId, modelId);
    current[key] = createHealthRecord(providerId, modelId, entry, current[key], now);
  }
  publishHealth(current);
  patchCatalogAvailability(current);
  try {
    window.zion?.events?.emit?.("models/healthChanged", { entries });
  } catch {}
  return current;
}

export function setModelAvailability(providerId, modelId, availability, now = Date.now()) {
  const next = setModelAvailabilities([{ providerId, modelId, ...availability }], now);
  return normalizeModelAvailability(next[modelHealthKey(providerId, modelId)], now);
}

export function invalidateModelAvailability({ providerId, modelId } = {}) {
  const current = { ...getModelHealthSnapshot() };
  let changed = false;
  for (const [key, value] of Object.entries(current)) {
    if (providerId && String(value?.providerId || "") !== String(providerId)) continue;
    if (modelId && String(value?.modelId || "") !== String(modelId)) continue;
    delete current[key];
    changed = true;
  }
  if (changed) {
    publishHealth(current);
    patchCatalogAvailability(current);
  }
  return current;
}

export function applyModelAvailability(item, health = getModelHealthSnapshot(), now = Date.now()) {
  if (!item || typeof item !== "object") return item;
  if (item.credentialConfigured === true) {
    return {
      ...item,
      availability: {
        status: "available",
        reason: "runtime_credential_configured",
        source: "runtime-profile",
        checkedAt: now,
        expiresAt: null,
        stale: false
      }
    };
  }
  if (item.requiresConfig) {
    return {
      ...item,
      availability: {
        status: "misconfigured",
        reason: item.configReason || "missing_key",
        source: "config",
        checkedAt: now,
        expiresAt: null,
        stale: false
      }
    };
  }
  const stored = health[modelHealthKey(item.providerId, item.id)] || item.availability;
  return {
    ...item,
    availability: normalizeModelAvailability(stored, now)
  };
}

export function classifyModelAvailabilityHttpStatus(status) {
  const code = Number(status || 0);
  if (code === 401) return { status: "unavailable", reason: "invalid_credentials", scope: "provider" };
  if (code === 402) return { status: "unavailable", reason: "quota_exhausted", scope: "provider" };
  if (code === 403) return { status: "unavailable", reason: "permission_denied", scope: "model" };
  if (code === 404) return { status: "unavailable", reason: "model_not_found", scope: "model" };
  if (code === 408) return { status: "degraded", reason: "timeout", scope: "model" };
  if (code === 409 || code === 425 || code === 429) {
    return { status: "degraded", reason: code === 429 ? "rate_limited" : "provider_busy", scope: "provider" };
  }
  if (code >= 500) return { status: "degraded", reason: "provider_error", scope: "provider" };
  return { status: "unknown", reason: "request_rejected", scope: "model" };
}

export function classifyModelAvailabilityError(error) {
  const status = Number(error?.httpStatus || error?.status || 0);
  if (status) {
    const classified = classifyModelAvailabilityHttpStatus(status);
    if (classified.status !== "unknown") return classified;
  }

  const fingerprint = [
    error?.code,
    error?.type,
    error?.message,
    error?.responseText
  ].map((value) => String(value || "").toLowerCase()).join(" ");

  if (/missing (api )?key|missing url|requires? config|需要配置|missing credentials?/.test(fingerprint)) {
    return { status: "misconfigured", reason: "missing_key", scope: "provider" };
  }
  if (/invalid[_ -]?(api[_ -]?key|access[_ -]?token)|api[_ -]?key.*not valid|authentication|unauthorized/.test(fingerprint)) {
    return { status: "unavailable", reason: "invalid_credentials", scope: "provider" };
  }
  if (/forbidden|permission[_ -]?denied|does not have access/.test(fingerprint)) {
    return { status: "unavailable", reason: "permission_denied", scope: "model" };
  }
  if (/insufficient[_ -]?(quota|credits?)|quota[_ -]?exhausted|billing/.test(fingerprint)) {
    return { status: "unavailable", reason: "quota_exhausted", scope: "provider" };
  }
  if (/provider[_ -]?not[_ -]?found/.test(fingerprint)) {
    return { status: "unavailable", reason: "provider_not_found", scope: "model" };
  }
  if (/model.*(not[_ -]?found|does not exist|invalid)|unknown model/.test(fingerprint)) {
    return { status: "unavailable", reason: "model_not_found", scope: "model" };
  }
  if (/rate[_ -]?limit|too many requests/.test(fingerprint)) {
    return { status: "degraded", reason: "rate_limited", scope: "provider" };
  }
  if (/timeout|timed out/.test(fingerprint)) {
    return { status: "degraded", reason: "timeout", scope: "model" };
  }
  if (/network|connection|reset|eof|incomplete[_ -]?stream|temporar|unavailable|overloaded/.test(fingerprint)) {
    return { status: "degraded", reason: "network_error", scope: "model" };
  }
  if (error?.retryable === true) {
    return { status: "degraded", reason: "provider_error", scope: "model" };
  }
  return null;
}

export function recordModelAvailabilitySuccess(model, { latencyMs } = {}) {
  if (!model?.providerId || !model?.modelId) return null;
  return setModelAvailability(model.providerId, model.modelId, {
    status: "available",
    reason: "request_succeeded",
    source: "actual-run",
    latencyMs
  });
}

export function recordModelAvailabilityFailure(model, error) {
  if (!model?.providerId || !model?.modelId) return null;
  const classified = classifyModelAvailabilityError(error);
  if (!classified) return null;
  const base = {
    ...classified,
    source: "actual-run",
    httpStatus: Number(error?.httpStatus || error?.status || 0) || undefined
  };
  if (classified.scope !== "provider") {
    return setModelAvailability(model.providerId, model.modelId, base);
  }

  const refs = new Map();
  refs.set(modelHealthKey(model.providerId, model.modelId), {
    providerId: model.providerId,
    modelId: model.modelId
  });
  try {
    const catalog = window.zion?.state?.get?.("models.catalog");
    for (const item of Array.isArray(catalog) ? catalog : []) {
      if (item?.providerId !== model.providerId || !item?.id) continue;
      refs.set(modelHealthKey(item.providerId, item.id), {
        providerId: item.providerId,
        modelId: item.id
      });
    }
  } catch {}
  const health = setModelAvailabilities(
    Array.from(refs.values()).map((ref) => ({ ...ref, ...base }))
  );
  return normalizeModelAvailability(health[modelHealthKey(model.providerId, model.modelId)]);
}
