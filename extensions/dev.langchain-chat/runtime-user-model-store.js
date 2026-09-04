import { createHttpRuntimeClient } from "../../src/runtime/http-runtime-client.ts";
import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";

export const DYNAMIC_MODELS_KEY = "zion.models.dynamic";
export const DYNAMIC_PROVIDER_ID = "user.dynamic";

function safe(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function runtimeProfileIdForDynamicModel(modelId) {
  return `workbench.${safe(DYNAMIC_PROVIDER_ID)}.${safe(modelId)}`;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function numberOrUndefined(value) {
  if (value === "" || value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function sanitizeModelConfig(config) {
  const cfg = objectValue(config);
  const next = {
    ...cfg,
    providerType: String(cfg.providerType || "openai")
  };
  if (next.max_tokens != null) next.max_tokens = numberOrUndefined(next.max_tokens);
  if (next.temperature != null) next.temperature = numberOrUndefined(next.temperature);
  if (next.contextWindowTokens != null) {
    next.contextWindowTokens = numberOrUndefined(next.contextWindowTokens);
  }
  if (next.maxInputTokens != null) {
    next.maxInputTokens = numberOrUndefined(next.maxInputTokens);
  }
  if (next.maxOutputTokens != null) {
    next.maxOutputTokens = numberOrUndefined(next.maxOutputTokens);
  }
  return next;
}

function runtimeProjectionConfig(modelId, config, profile) {
  const next = sanitizeModelConfig(config);
  delete next.key;
  delete next.apiKey;
  return {
    ...next,
    _runtimeBacked: true,
    _runtimeProfileId: profile?.id || runtimeProfileIdForDynamicModel(modelId),
    _credentialConfigured: profile?.credentialConfigured === true
  };
}

export function loadLocalDynamicModelStore({
  storage = globalThis.localStorage
} = {}) {
  try {
    const raw = storage?.getItem?.(DYNAMIC_MODELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return objectValue(parsed);
  } catch {
    return {};
  }
}

export function saveLocalDynamicModelStore(dict, {
  storage = globalThis.localStorage
} = {}) {
  try {
    storage?.setItem?.(DYNAMIC_MODELS_KEY, JSON.stringify(objectValue(dict)));
  } catch {}
}

export function dynamicConfigToRuntimeImport(modelId, config = {}) {
  const id = String(modelId || "").trim();
  const cfg = sanitizeModelConfig(config);
  const endpoint = String(cfg.url || cfg.endpoint || "").trim();
  const model = String(cfg.modelName || cfg.model || id).trim();
  if (!id || !endpoint || !model) return null;
  if (String(cfg.providerType || "openai").toLowerCase() !== "openai") return null;
  return {
    profile: {
      id: runtimeProfileIdForDynamicModel(id),
      label: String(cfg.label || id),
      providerId: DYNAMIC_PROVIDER_ID,
      sourceModelId: id,
      providerType: "openai",
      endpoint,
      model,
      credentialRequired: cfg.credentialRequired !== false,
      temperature: cfg.temperature,
      maxOutputTokens: cfg.maxOutputTokens ?? cfg.max_tokens,
      capabilities: {
        supportsImage: !!cfg.supportsImage,
        supportsThinking: !!cfg.supportsThinking,
        supportsThinkingEffort: !!cfg.supportsThinkingEffort,
        preservedThinking: !!cfg.preservedThinking,
        interleavedThinking: !!cfg.interleavedThinking,
        thinkingMode: cfg.thinkingMode,
        thinkingEffort: cfg.thinkingEffort
      },
      metadata: {
        description: cfg.description,
        contextWindowTokens: cfg.contextWindowTokens,
        maxInputTokens: cfg.maxInputTokens,
        defaultOutputTokens: cfg.max_tokens,
        stream: cfg.stream,
        pricing: cfg.pricing
      }
    },
    credential: String(cfg.key || cfg.apiKey || "").trim()
  };
}

export function runtimeProfileToDynamicEntry(profile) {
  const sourceModelId = String(profile?.sourceModelId || "").trim();
  if (!sourceModelId || String(profile?.providerId || "") !== DYNAMIC_PROVIDER_ID) {
    return null;
  }
  const metadata = objectValue(profile.metadata);
  const capabilities = objectValue(profile.capabilities);
  return {
    id: sourceModelId,
    config: {
      label: profile.label || sourceModelId,
      description: metadata.description,
      url: profile.endpoint,
      modelName: profile.model,
      model: profile.model,
      providerType: profile.providerType || "openai",
      stream: metadata.stream,
      temperature: profile.temperature,
      max_tokens: metadata.defaultOutputTokens ?? profile.maxOutputTokens,
      contextWindowTokens: metadata.contextWindowTokens,
      maxInputTokens: metadata.maxInputTokens,
      maxOutputTokens: profile.maxOutputTokens,
      pricing: metadata.pricing,
      supportsImage: capabilities.supportsImage,
      supportsThinking: capabilities.supportsThinking,
      supportsThinkingEffort: capabilities.supportsThinkingEffort,
      thinkingMode: capabilities.thinkingMode,
      thinkingEffort: capabilities.thinkingEffort,
      preservedThinking: capabilities.preservedThinking,
      interleavedThinking: capabilities.interleavedThinking,
      _runtimeBacked: true,
      _runtimeProfileId: profile.id,
      _credentialConfigured: profile.credentialConfigured === true
    }
  };
}

export function shouldUseRuntimeModelStore({
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage
} = {}) {
  const config = readWorkbenchRuntimeConfig({ state, storage });
  const backend = String(state?.get?.("runtime.connection")?.backend || "").trim();
  if (backend === "runtime") return config;
  return config.mode === "runtime" ? config : null;
}

export async function loadRuntimeDynamicModelStore({
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = shouldUseRuntimeModelStore({ state, storage });
  if (!config) return null;
  const client = createHttpRuntimeClient({
    baseUrl: config.baseUrl,
    fetchImpl
  });
  const catalog = await client.getModels();
  const dict = {};
  for (const profile of Array.isArray(catalog.profiles) ? catalog.profiles : []) {
    const entry = runtimeProfileToDynamicEntry(profile);
    if (entry) dict[entry.id] = entry.config;
  }
  return dict;
}

export async function loadDynamicModelStore({
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const local = loadLocalDynamicModelStore({ storage });
  try {
    const remote = await loadRuntimeDynamicModelStore({ state, storage, fetchImpl });
    if (!remote) return local;
    return { ...local, ...remote };
  } catch {
    return local;
  }
}

export async function upsertDynamicModel({
  modelId,
  config,
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const id = String(modelId || "").trim();
  if (!id) throw new Error("Model id is required");
  const nextConfig = sanitizeModelConfig(config);
  const runtimeConfig = shouldUseRuntimeModelStore({ state, storage });
  if (!runtimeConfig) {
    const local = loadLocalDynamicModelStore({ storage });
    local[id] = nextConfig;
    saveLocalDynamicModelStore(local, { storage });
    return { savedTo: "local", modelId: id, config: nextConfig };
  }
  const importable = dynamicConfigToRuntimeImport(id, nextConfig);
  if (!importable) {
    const local = loadLocalDynamicModelStore({ storage });
    local[id] = nextConfig;
    saveLocalDynamicModelStore(local, { storage });
    return { savedTo: "local", modelId: id, config: nextConfig };
  }
  try {
    const client = createHttpRuntimeClient({
      baseUrl: runtimeConfig.baseUrl,
      fetchImpl
    });
    const profile = await client.upsertModelProfile(importable.profile.id, {
      profile: importable.profile,
      ...(importable.credential ? { credential: importable.credential } : {})
    });
    const local = loadLocalDynamicModelStore({ storage });
    local[id] = runtimeProjectionConfig(id, nextConfig, profile);
    saveLocalDynamicModelStore(local, { storage });
    return { savedTo: "runtime", modelId: id, config: nextConfig, profile };
  } catch (error) {
    const local = loadLocalDynamicModelStore({ storage });
    local[id] = nextConfig;
    saveLocalDynamicModelStore(local, { storage });
    return {
      savedTo: "local",
      modelId: id,
      config: nextConfig,
      warning: error?.message || String(error)
    };
  }
}

export async function deleteDynamicModel({
  modelId,
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const id = String(modelId || "").trim();
  if (!id) throw new Error("Model id is required");
  const local = loadLocalDynamicModelStore({ storage });
  delete local[id];
  saveLocalDynamicModelStore(local, { storage });

  const runtimeConfig = shouldUseRuntimeModelStore({ state, storage });
  if (!runtimeConfig) return { deletedFrom: "local", modelId: id };
  try {
    const client = createHttpRuntimeClient({
      baseUrl: runtimeConfig.baseUrl,
      fetchImpl
    });
    const profile = await client.deleteModelProfile(
      runtimeProfileIdForDynamicModel(id)
    );
    return { deletedFrom: "runtime", modelId: id, profile };
  } catch (error) {
    return {
      deletedFrom: "local",
      modelId: id,
      warning: error?.message || String(error)
    };
  }
}
