export const MODELS_MANAGE_TOOL_NAME = "modelsManage";
export const DYNAMIC_PROVIDER_ID = "user.dynamic";
export const DEFAULT_INTERACTIVE_PROFILE_ID = "interactive.default";

export const MODELS_MANAGE_ACTIONS = [
  "list",
  "check",
  "get",
  "add",
  "update",
  "delete",
  "set_active",
  "import",
  "export"
];

function safe(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function numberOrUndefined(value) {
  if (value === "" || value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function runtimeProfileIdForDynamicModel(modelId) {
  return `workbench.${safe(DYNAMIC_PROVIDER_ID)}.${safe(modelId)}`;
}

export function modelsManageToolDefinition() {
  return {
    name: MODELS_MANAGE_TOOL_NAME,
    description: "Manage Runtime model profiles and the default interactive model. Supports list/check/get/add/update/delete/set_active/import/export. Runtime writes are limited to user.dynamic OpenAI-compatible profiles and credentials are write-only.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: MODELS_MANAGE_ACTIONS,
          description: "Management action"
        },
        provider_id: {
          type: "string",
          description: "Provider id. Writable Runtime profiles use user.dynamic."
        },
        model_id: {
          type: "string",
          description: "Model id. For user.dynamic this maps to a Runtime profile id."
        },
        availability: {
          type: "string",
          enum: ["available", "degraded", "unavailable", "misconfigured", "unknown"],
          description: "Runtime check/list compatibility filter. Runtime reports credentialConfigured instead of browser health."
        },
        force: {
          type: "boolean",
          description: "set_active may use force to select profiles without configured credentials."
        },
        label: { type: "string" },
        description: { type: "string", maxLength: 500 },
        url: { type: "string", description: "OpenAI-compatible endpoint URL" },
        key: { type: "string", description: "Write-only API key" },
        stream: { type: "boolean" },
        temperature: { type: "number" },
        context_window_tokens: { type: "number" },
        max_input_tokens: { type: "number" },
        max_output_tokens: { type: "number" },
        max_tokens: { type: "number" },
        supportsImage: { type: "boolean" },
        supportsThinking: { type: "boolean" },
        supportsThinkingEffort: { type: "boolean" },
        thinkingMode: { type: "string", enum: ["auto", "off", "on"] },
        thinkingEffort: {
          type: "string",
          enum: ["auto", "minimal", "low", "medium", "high", "xhigh", "max"]
        },
        preservedThinking: { type: "boolean" },
        interleavedThinking: { type: "boolean" },
        model: {
          type: "string",
          description: "Backend model name. Defaults to model_id."
        },
        provider_type: {
          type: "string",
          enum: ["openai"],
          description: "Runtime currently supports OpenAI-compatible model profiles."
        },
        data: {
          type: ["object", "string"],
          description: "Import map: { modelId: config }"
        },
        merge: {
          type: "boolean",
          description: "Import compatibility flag. Runtime currently upserts provided entries."
        }
      },
      required: ["action"],
      additionalProperties: true
    }
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

export function dynamicConfigToRuntimeImport(modelId, config = {}) {
  const id = String(modelId || "").trim();
  const cfg = objectValue(config);
  const endpoint = String(cfg.url || cfg.endpoint || "").trim();
  const model = String(cfg.modelName || cfg.model || id).trim();
  const providerType = String(cfg.providerType || cfg.provider_type || "openai").toLowerCase();
  if (!id || !endpoint || !model || providerType !== "openai") return null;
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
      temperature: numberOrUndefined(cfg.temperature),
      maxOutputTokens: numberOrUndefined(cfg.maxOutputTokens ?? cfg.max_tokens),
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
        contextWindowTokens: numberOrUndefined(cfg.contextWindowTokens ?? cfg.context_window_tokens),
        maxInputTokens: numberOrUndefined(cfg.maxInputTokens ?? cfg.max_input_tokens),
        defaultOutputTokens: numberOrUndefined(cfg.max_tokens),
        stream: cfg.stream,
        pricing: cfg.pricing
      }
    },
    credential: String(cfg.key || cfg.apiKey || "").trim()
  };
}

export function dynamicConfigPatchFromArgs(args = {}) {
  const patch = {};
  const copy = (from, to = from, transform = (value) => value) => {
    if (args[from] !== undefined) patch[to] = transform(args[from]);
  };
  copy("label", "label", String);
  copy("description", "description", String);
  copy("url", "url", String);
  copy("key", "key", String);
  copy("stream", "stream", Boolean);
  copy("temperature", "temperature", Number);
  copy("max_tokens", "max_tokens", Number);
  copy("context_window_tokens", "contextWindowTokens", Number);
  copy("max_input_tokens", "maxInputTokens", Number);
  copy("max_output_tokens", "maxOutputTokens", Number);
  copy("supportsImage", "supportsImage", Boolean);
  copy("supportsThinking", "supportsThinking", Boolean);
  copy("supportsThinkingEffort", "supportsThinkingEffort", Boolean);
  copy("thinkingMode", "thinkingMode", String);
  copy("thinkingEffort", "thinkingEffort", String);
  copy("preservedThinking", "preservedThinking", Boolean);
  copy("interleavedThinking", "interleavedThinking", Boolean);
  copy("model", "model", String);
  copy("provider_type", "providerType", String);
  return patch;
}

export function summarizeRuntimeProfile(profile = {}) {
  const entry = runtimeProfileToDynamicEntry(profile);
  const availability = profile.credentialRequired === false || profile.credentialConfigured
    ? "available"
    : "misconfigured";
  return {
    providerId: profile.providerId || "runtime",
    id: entry?.id || profile.sourceModelId || profile.model || profile.id,
    profileId: profile.id,
    label: profile.label || profile.id,
    model: profile.model,
    endpoint: profile.endpoint,
    providerType: profile.providerType,
    credentialConfigured: profile.credentialConfigured === true,
    credentialRequired: profile.credentialRequired !== false,
    availability: { status: availability },
    capabilities: profile.capabilities || {},
    metadata: profile.metadata || {}
  };
}
