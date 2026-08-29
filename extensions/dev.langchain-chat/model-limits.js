const BUILTIN_MODEL_LIMITS = {
  deepseek: {
    "deepseek-v4-flash": {
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 384_000
    },
    "deepseek-v4-pro": {
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 384_000
    },
    "deepseek-chat": {
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 384_000
    },
    "deepseek-reasoner": {
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 384_000
    }
  },
  anthropic: {
    "claude-opus-4-8": {
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000
    },
    "claude-opus-4-7": {
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000
    },
    "claude-sonnet-5": {
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000
    },
    "claude-sonnet-4-6": {
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000
    },
    "claude-haiku-4-5-20251001": {
      contextWindowTokens: 200_000,
      maxInputTokens: 200_000,
      maxOutputTokens: 64_000
    }
  },
  google: {
    "gemini-3.6-flash": {
      contextWindowTokens: 1_048_576,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536
    },
    "gemini-3.5-flash": {
      contextWindowTokens: 1_048_576,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536
    },
    "gemini-3.5-flash-lite": {
      contextWindowTokens: 1_048_576,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536
    },
    "gemini-3.1-pro-preview": {
      contextWindowTokens: 1_048_576,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536
    },
    "gemini-2.5-pro": {
      contextWindowTokens: 1_048_576,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536
    },
    "gemini-2.5-flash": {
      contextWindowTokens: 1_048_576,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536
    }
  }
};

const CAPABILITY_LIMIT_KEYS = [
  "contextWindowTokens",
  "maxInputTokens",
  "maxOutputTokens"
];

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

function firstPositive(...values) {
  for (const value of values) {
    const normalized = positiveInteger(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function compactLimits(limits) {
  return Object.fromEntries(
    Object.entries(limits).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

export function normalizeModelLimits(input = {}) {
  const nested = input?.limits && typeof input.limits === "object" ? input.limits : input;
  return compactLimits({
    contextWindowTokens: firstPositive(
      nested?.contextWindowTokens,
      nested?.context_window_tokens,
      nested?.contextWindow,
      nested?.context_window,
      nested?.contextLimitTokens,
      nested?.context_limit_tokens
    ),
    maxInputTokens: firstPositive(
      nested?.maxInputTokens,
      nested?.max_input_tokens,
      nested?.inputTokenLimit
    ),
    maxOutputTokens: firstPositive(
      nested?.maxOutputTokens,
      nested?.max_output_tokens,
      nested?.outputTokenLimit
    ),
    defaultOutputTokens: firstPositive(
      nested?.defaultOutputTokens,
      nested?.outputBudgetTokens,
      input?.defaultOutputTokens,
      input?.max_tokens
    ),
    source: nested?.source || input?.limitsSource,
    updatedAt: nested?.updatedAt || input?.limitsUpdatedAt
  });
}

export function getBuiltinModelLimits(providerId, modelId) {
  const limits = BUILTIN_MODEL_LIMITS[String(providerId || "")]?.[String(modelId || "")];
  if (!limits) return {};
  return {
    ...limits,
    source: "builtin",
    updatedAt: 1_787_328_000_000
  };
}

export function getModelLimitOverrides(config, modelId) {
  const value = config?.modelLimits?.[String(modelId || "")];
  return value && typeof value === "object" ? value : {};
}

export function hasCapabilityLimitOverride(config, modelId) {
  const overrides = getModelLimitOverrides(config, modelId);
  return CAPABILITY_LIMIT_KEYS.some((key) => positiveInteger(overrides[key]));
}

export function resolveModelLimits({
  providerId,
  modelId,
  descriptor = {},
  config = {},
  defaultOutputTokens
} = {}) {
  const builtin = getBuiltinModelLimits(providerId, modelId);
  const listed = normalizeModelLimits(descriptor);
  const configured = normalizeModelLimits(config);
  const modelOverrides = normalizeModelLimits(getModelLimitOverrides(config, modelId));
  const merged = {
    ...builtin,
    ...listed,
    ...configured,
    ...modelOverrides
  };

  merged.defaultOutputTokens = firstPositive(
    modelOverrides.defaultOutputTokens,
    configured.defaultOutputTokens,
    defaultOutputTokens,
    merged.defaultOutputTokens
  );

  const capabilityOverride = hasCapabilityLimitOverride(config, modelId)
    || CAPABILITY_LIMIT_KEYS.some((key) => positiveInteger(config?.[key]));
  merged.source = capabilityOverride
    ? "user"
    : listed.source || builtin.source || "unknown";

  if (merged.defaultOutputTokens && merged.maxOutputTokens) {
    merged.defaultOutputTokens = Math.min(merged.defaultOutputTokens, merged.maxOutputTokens);
  }
  return compactLimits(merged);
}

export function withResolvedModelLimits(config, options = {}) {
  const limits = resolveModelLimits({
    ...options,
    config: options.settings || config
  });
  return {
    ...config,
    limits,
    contextWindowTokens: limits.contextWindowTokens,
    maxInputTokens: limits.maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
    max_tokens: limits.defaultOutputTokens
  };
}
