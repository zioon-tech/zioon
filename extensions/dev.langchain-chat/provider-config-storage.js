import { normalizeModelDescription } from "./model-config-fields.js";

const CONFIG_FIELDS = [
  "label",
  "description",
  "model",
  "modelName",
  "provider_type",
  "providerType",
  "url",
  "baseURL",
  "anthropicVersion",
  "temperature",
  "max_tokens",
  "stream",
  "supportsImage",
  "supportsThinking",
  "supportsThinkingEffort",
  "thinkingMode",
  "thinkingEffort",
  "preservedThinking",
  "interleavedThinking",
  "autoContinueOnColonMaxAttempts"
];

const LIMIT_FIELDS = [
  "contextWindowTokens",
  "maxInputTokens",
  "maxOutputTokens",
  "defaultOutputTokens"
];

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function compactLimits(value) {
  const source = objectValue(value);
  const result = {};
  for (const key of LIMIT_FIELDS) {
    const number = Number(source[key]);
    if (Number.isFinite(number) && number > 0) result[key] = number;
  }
  return result;
}

export function compactProviderConfig(value) {
  const source = objectValue(value);
  const result = {};
  for (const key of CONFIG_FIELDS) {
    if (source[key] !== undefined) result[key] = source[key];
  }

  const pricing = objectValue(source.pricing);
  if (Object.keys(pricing).length) {
    result.pricing = {
      inputPerMTok: Number(pricing.inputPerMTok) || undefined,
      outputPerMTok: Number(pricing.outputPerMTok) || undefined,
      currency: String(pricing.currency || "USD")
    };
  }

  const modelLimits = Object.entries(objectValue(source.modelLimits))
    .slice(0, 100)
    .map(([modelId, limits]) => [String(modelId), compactLimits(limits)])
    .filter(([, limits]) => Object.keys(limits).length);
  if (modelLimits.length) result.modelLimits = Object.fromEntries(modelLimits);

  const modelDescriptions = Object.entries(objectValue(source.modelDescriptions))
    .slice(0, 100)
    .map(([modelId, description]) => [
      String(modelId),
      normalizeModelDescription(description)
    ])
    .filter(([, description]) => description);
  if (modelDescriptions.length) {
    result.modelDescriptions = Object.fromEntries(modelDescriptions);
  }
  return result;
}

export function loadProviderConfig(storageKey, {
  storage = globalThis.localStorage
} = {}) {
  try {
    const raw = storage?.getItem?.(storageKey);
    return compactProviderConfig(raw ? JSON.parse(raw) : {});
  } catch {
    return {};
  }
}

function quotaError(error) {
  return String(error?.name || "") === "QuotaExceededError"
    || /quota|storage.*full|exceeded/i.test(String(error?.message || error || ""));
}

export function saveProviderConfig(storageKey, value, {
  storage = globalThis.localStorage
} = {}) {
  const config = compactProviderConfig(value);
  const serialized = JSON.stringify(config);
  try {
    storage?.setItem?.(storageKey, serialized);
  } catch (error) {
    if (!quotaError(error)) throw error;
    // Availability is a disposable cache; reclaim it before retrying a user setting.
    try {
      storage?.removeItem?.("zion.models.health.v1");
    } catch {}
    storage?.setItem?.(storageKey, serialized);
  }
  return config;
}

export function saveProviderConfigPatch(storageKey, patch, options = {}) {
  const previous = loadProviderConfig(storageKey, options);
  return saveProviderConfig(storageKey, {
    ...previous,
    ...objectValue(patch)
  }, options);
}
