import { URL } from "node:url";

const BUILTIN_PROFILES = [{
  id: "deepseek-v4-flash",
  label: "DeepSeek V4 Flash",
  providerId: "deepseek",
  providerType: "openai",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  credentialRef: "model.deepseek",
  credentialRequired: true,
  temperature: 0,
  maxOutputTokens: 8192,
  requestBody: {
    thinking: { type: "enabled" },
    reasoning_effort: "high"
  },
  capabilities: {
    supportsImage: false,
    supportsThinking: true,
    preservedThinking: true,
    thinkingMode: "on",
    thinkingEffort: "high",
    interleavedThinking: false
  }
}, {
  id: "deepseek-v4-pro",
  label: "DeepSeek V4 Pro",
  providerId: "deepseek",
  providerType: "openai",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-pro",
  credentialRef: "model.deepseek",
  credentialRequired: true,
  temperature: 0,
  maxOutputTokens: 8192,
  requestBody: {
    thinking: { type: "enabled" },
    reasoning_effort: "high"
  },
  capabilities: {
    supportsImage: false,
    supportsThinking: true,
    preservedThinking: true,
    thinkingMode: "on",
    thinkingEffort: "high",
    interleavedThinking: false
  }
}];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function optionalFiniteNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid numeric model option: ${value}`);
  return number;
}

function normalizeProfile(value) {
  const profile = value && typeof value === "object" ? value : {};
  for (const forbidden of ["key", "apiKey", "api_key", "secret", "authorization"]) {
    if (Object.prototype.hasOwnProperty.call(profile, forbidden)) {
      throw new Error(
        `Model profile "${profile.id || "unknown"}" must use credentialRef, not ${forbidden}`
      );
    }
  }
  const id = String(profile.id || "").trim();
  const endpoint = String(profile.endpoint || profile.url || "").trim();
  const model = String(profile.model || profile.modelName || "").trim();
  const providerType = String(profile.providerType || "").trim();
  if (!id) throw new Error("Model profile id is required");
  if (providerType !== "openai") {
    throw new Error(`Unsupported model providerType for "${id}": ${providerType}`);
  }
  if (!endpoint) throw new Error(`Model profile endpoint is required: ${id}`);
  const parsedUrl = new URL(endpoint);
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error(`Model profile endpoint must use HTTP(S): ${id}`);
  }
  if (!model) throw new Error(`Model profile model is required: ${id}`);
  const maxOutputTokens = optionalFiniteNumber(
    profile.maxOutputTokens ?? profile.max_tokens
  );
  if (maxOutputTokens !== undefined && maxOutputTokens <= 0) {
    throw new Error(`Model profile maxOutputTokens must be positive: ${id}`);
  }
  const requestBody = profile.requestBody && typeof profile.requestBody === "object"
    && !Array.isArray(profile.requestBody)
    ? clone(profile.requestBody)
    : {};
  const metadata = profile.metadata && typeof profile.metadata === "object"
    && !Array.isArray(profile.metadata)
    ? clone(profile.metadata)
    : {};

  return Object.freeze({
    id,
    label: String(profile.label || id),
    providerId: String(profile.providerId || profile.id || "runtime"),
    sourceModelId: String(profile.sourceModelId || profile.model || ""),
    providerType,
    endpoint: parsedUrl.toString(),
    model,
    credentialRef: String(profile.credentialRef || `model.${id}`),
    credentialRequired: profile.credentialRequired !== false,
    temperature: optionalFiniteNumber(profile.temperature),
    maxOutputTokens,
    requestBody,
    capabilities: profile.capabilities && typeof profile.capabilities === "object"
      ? clone(profile.capabilities)
      : {},
    metadata
  });
}

export class ModelRegistry {
  constructor({ profiles = [], defaultProfileId = "" } = {}) {
    this.profiles = new Map();
    for (const input of profiles) {
      const profile = normalizeProfile(input);
      if (this.profiles.has(profile.id)) {
        throw new Error(`Duplicate model profile: ${profile.id}`);
      }
      this.profiles.set(profile.id, profile);
    }
    this.defaultProfileId = String(defaultProfileId || profiles[0]?.id || "");
    if (this.defaultProfileId && !this.profiles.has(this.defaultProfileId)) {
      throw new Error(`Default model profile not found: ${this.defaultProfileId}`);
    }
  }

  get(profileId = this.defaultProfileId) {
    const profile = this.profiles.get(String(profileId || ""));
    if (!profile) throw new Error(`Model profile not found: ${profileId}`);
    return clone(profile);
  }

  upsert(value) {
    const profile = normalizeProfile(value);
    this.profiles.set(profile.id, profile);
    if (!this.defaultProfileId) this.defaultProfileId = profile.id;
    return clone(profile);
  }

  delete(profileId) {
    const id = String(profileId || "").trim();
    if (!id) throw new Error("Model profile id is required");
    const existing = this.profiles.get(id);
    if (!existing) return null;
    this.profiles.delete(id);
    if (this.defaultProfileId === id) {
      this.defaultProfileId = this.profiles.keys().next().value || "";
    }
    return clone(existing);
  }

  resolveModelRef(modelRef = null) {
    if (!modelRef) return this.get();
    const profileId = String(modelRef.profileId || "").trim();
    if (profileId) return this.get(profileId);
    const providerId = String(modelRef.providerId || "").trim();
    const modelId = String(modelRef.modelId || "").trim();
    const matches = this.list().filter((profile) =>
      profile.model === modelId
      && (!providerId || profile.providerId === providerId)
    );
    if (matches.length !== 1) {
      throw new Error(
        `Runtime model profile not found: ${providerId || "unknown"}/${modelId || "unknown"}`
      );
    }
    return matches[0];
  }

  list() {
    return Array.from(this.profiles.values(), (profile) => clone(profile));
  }
}

export function createBuiltinModelRegistry(options = {}) {
  const { additionalProfiles = [], ...registryOptions } = options;
  const registry = new ModelRegistry({
    profiles: BUILTIN_PROFILES,
    defaultProfileId: "deepseek-v4-flash",
    ...registryOptions
  });
  for (const profile of additionalProfiles) registry.upsert(profile);
  return registry;
}
