import { createHttpRuntimeClient } from "../../src/runtime/http-runtime-client.ts";
import { currentAccountSession } from "../../packages/account-ui/src/client.ts";
import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";

export const DYNAMIC_MODELS_KEY = "zion.models.dynamic";
export const DYNAMIC_PROVIDER_ID = "user.dynamic";
const RUNTIME_MODEL_CACHE_TTL_MS = 60_000;

let runtimeModelCache = null;

export function invalidateRuntimeDynamicModelCache() {
  runtimeModelCache = null;
}

function safe(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function runtimeProfileIdForDynamicModel(modelId) {
  return `workbench.${safe(DYNAMIC_PROVIDER_ID)}.${safe(modelId)}`;
}

export function findRuntimeModelProfile(profiles, selectedModel) {
  const list = Array.isArray(profiles) ? profiles : [];
  const profileId = String(selectedModel?.profileId || "").trim();
  if (profileId) {
    const exact = list.find((profile) => String(profile?.id || "") === profileId);
    if (exact) return exact;
  }

  const providerId = String(selectedModel?.providerId || "").trim();
  const modelId = String(selectedModel?.modelId || "").trim();
  const importedId = providerId && modelId
    ? `workbench.${safe(providerId)}.${safe(modelId)}`
    : "";
  if (importedId) {
    const imported = list.find((profile) => String(profile?.id || "") === importedId);
    if (imported) return imported;
  }

  const matches = list.filter((profile) => (
    (!providerId || String(profile?.providerId || "") === providerId)
    && [
      profile?.id,
      profile?.sourceModelId,
      profile?.model
    ].some((value) => String(value || "") === modelId)
  ));
  return matches.find((profile) => profile?.credentialConfigured === true)
    || matches[0]
    || null;
}

export function mergeRuntimeModelProfileConfig(config, profile) {
  const base = objectValue(config);
  if (!profile || typeof profile !== "object") return base;
  const capabilities = objectValue(profile.capabilities);
  const metadata = objectValue(profile.metadata);
  const next = {
    ...base,
    providerId: String(profile.providerId || base.providerId || ""),
    providerType: String(profile.providerType || base.providerType || "openai"),
    modelName: String(profile.model || base.modelName || base.model || ""),
    url: String(profile.endpoint || base.url || base.baseURL || ""),
    _runtimeBacked: true,
    _runtimeProfileId: String(profile.id || base._runtimeProfileId || ""),
    _credentialConfigured: profile.credentialConfigured === true
  };
  const copyDefined = (source, key, targetKey = key) => {
    if (source[key] !== undefined) next[targetKey] = source[key];
  };
  copyDefined(profile, "temperature");
  copyDefined(profile, "maxOutputTokens", "max_tokens");
  copyDefined(capabilities, "supportsImage");
  copyDefined(capabilities, "supportsThinking");
  copyDefined(capabilities, "supportsThinkingEffort");
  copyDefined(capabilities, "thinkingMode");
  copyDefined(capabilities, "thinkingEffort");
  copyDefined(capabilities, "preservedThinking");
  copyDefined(capabilities, "interleavedThinking");
  copyDefined(metadata, "stream");
  copyDefined(metadata, "contextWindowTokens");
  copyDefined(metadata, "maxInputTokens");
  copyDefined(metadata, "defaultOutputTokens", "max_tokens");
  copyDefined(metadata, "pricing");
  return next;
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

async function loadRuntimeModelCatalog({
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
  force = false
} = {}) {
  const config = shouldUseRuntimeModelStore({ state, storage });
  if (!config) return null;
  if (state?.get?.("workbench.accessChanged")) {
    invalidateRuntimeDynamicModelCache();
    throw new Error("账户或访问权限已变化，请重新进入工作台");
  }
  const account = currentAccountSession();
  const cacheKey = JSON.stringify([
    config.baseUrl, account?.user?.id, account?.space?.id,
    account?.sessionId, account?.membership, account?.scopes
  ]);
  const now = Date.now();
  const previous = runtimeModelCache?.key === cacheKey
    && runtimeModelCache.fetchImpl === fetchImpl ? runtimeModelCache : null;
  if (
    !force
    && runtimeModelCache?.key === cacheKey
    && runtimeModelCache.fetchImpl === fetchImpl
  ) {
    if (runtimeModelCache.value && runtimeModelCache.expiresAt > now) {
      return runtimeModelCache.value;
    }
    if (runtimeModelCache.promise) return runtimeModelCache.value || runtimeModelCache.promise;
  }
  const promise = (async () => {
    const client = createHttpRuntimeClient({
      baseUrl: config.baseUrl,
      fetchImpl
    });
    const catalog = await client.getModels();
    // A response started before account/config invalidation cannot repopulate
    // the cache or replace a newer forced refresh.
    if (runtimeModelCache?.promise === promise) {
      runtimeModelCache = {
        key: cacheKey, fetchImpl, value: catalog,
        expiresAt: Date.now() + RUNTIME_MODEL_CACHE_TTL_MS, promise: null
      };
    }
    return catalog;
  })();
  runtimeModelCache = {
    key: cacheKey,
    fetchImpl,
    value: previous?.value || null,
    expiresAt: previous?.expiresAt || 0,
    promise
  };
  // Sending reuses the already selected account's catalog. Refresh it in the
  // background instead of making every expired TTL a network barrier.
  if (!force && previous?.value) {
    void promise.catch(() => {
      if (runtimeModelCache?.promise === promise) {
        runtimeModelCache = { ...previous, expiresAt: Date.now() + 5_000, promise: null };
      }
    });
    return previous.value;
  }
  try {
    return await promise;
  } catch (error) {
    if (runtimeModelCache?.promise === promise) runtimeModelCache = null;
    throw error;
  }
}

export async function loadRuntimeModelProfiles(options = {}) {
  const catalog = await loadRuntimeModelCatalog(options);
  return catalog == null
    ? null
    : (Array.isArray(catalog.profiles) ? catalog.profiles : []);
}

export async function loadRuntimeDynamicModelStore(options = {}) {
  const profiles = await loadRuntimeModelProfiles(options);
  if (profiles == null) return null;
  const dict = {};
  for (const profile of profiles) {
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
    invalidateRuntimeDynamicModelCache();
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
    invalidateRuntimeDynamicModelCache();
    return { deletedFrom: "runtime", modelId: id, profile };
  } catch (error) {
    return {
      deletedFrom: "local",
      modelId: id,
      warning: error?.message || String(error)
    };
  }
}
