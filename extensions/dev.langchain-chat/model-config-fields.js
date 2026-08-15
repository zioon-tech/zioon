export const THINKING_MODE_FIELDS = [
  {
    key: "preservedThinking",
    label: "保留思维链",
    labelEn: "Preserve Thinking",
    shortLabel: "保留思维",
    shortLabelEn: "Preserve",
    badge: "think",
    description: "保留模型返回的 reasoning/thinking 内容。",
    descriptionEn: "Preserve reasoning/thinking content returned by the model."
  },
  {
    key: "interleavedThinking",
    label: "交错思维链",
    labelEn: "Interleaved Thinking",
    shortLabel: "交错思维",
    shortLabelEn: "Interleaved",
    badge: "iThink",
    description: "允许思考内容与正文交错返回。",
    descriptionEn: "Allow thinking content to be interleaved with the final response."
  }
];

export const DEFAULT_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS = 3;
export const MAX_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS = 20;

export function normalizeAutoContinueOnColonMaxAttempts(
  value,
  fallback = DEFAULT_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS
) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(MAX_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS, Math.floor(parsed)));
}

export const THINKING_MODE_OPTIONS = [
  {
    value: "auto",
    label: "自动",
    labelEn: "Auto",
    description: "按模型能力和模型名自动判断。",
    descriptionEn: "Infer from model capability and model name."
  },
  {
    value: "off",
    label: "关闭",
    labelEn: "Off",
    description: "请求时尽量不启用思考。",
    descriptionEn: "Try not to enable thinking for requests."
  },
  {
    value: "on",
    label: "开启",
    labelEn: "On",
    description: "请求时启用思考；仅对支持的模型生效。",
    descriptionEn: "Enable thinking for requests; only effective for supported models."
  }
];

export const THINKING_EFFORT_OPTIONS = [
  {
    value: "auto",
    label: "自动",
    labelEn: "Auto",
    description: "使用服务商默认强度。",
    descriptionEn: "Use the provider default effort."
  },
  {
    value: "minimal",
    label: "极低",
    labelEn: "Minimal",
    description: "仅使用最少推理；只对支持该档位的模型生效。",
    descriptionEn: "Use minimal reasoning; only available on models that support it."
  },
  {
    value: "low",
    label: "低",
    labelEn: "Low",
    description: "更快、更省 token。",
    descriptionEn: "Faster and uses fewer tokens."
  },
  {
    value: "medium",
    label: "中",
    labelEn: "Medium",
    description: "平衡速度和质量。",
    descriptionEn: "Balance speed and quality."
  },
  {
    value: "high",
    label: "高",
    labelEn: "High",
    description: "更充分推理，可能更慢、更耗 token。",
    descriptionEn: "More thorough reasoning; may be slower and use more tokens."
  },
  {
    value: "xhigh",
    label: "超高",
    labelEn: "Extra High",
    description: "用于长时间、高复杂度的 Agent 和编码任务。",
    descriptionEn: "For long-running, highly complex agentic and coding tasks."
  },
  {
    value: "max",
    label: "最大",
    labelEn: "Max",
    description: "使用模型允许的最高推理强度。",
    descriptionEn: "Use the highest reasoning effort supported by the model."
  }
];

const THINKING_EFFORT_VALUES = new Set(THINKING_EFFORT_OPTIONS.map((option) => option.value));

function isEnglishLocale() {
  try {
    return String(window.zion?.i18n?.getLocale?.() || window.zion?.state?.get?.("ui.locale") || "").startsWith("en");
  } catch {
    return false;
  }
}

function localized(option, key = "label") {
  if (!option) return "";
  return isEnglishLocale() ? option[`${key}En`] || option[key] : option[key];
}

export function getThinkingModeOptions() {
  return THINKING_MODE_OPTIONS.map((option) => ({ ...option, label: localized(option), description: localized(option, "description") }));
}

export function getThinkingEffortOptions(modelInfo) {
  const supported = modelInfo ? new Set(getSupportedThinkingEfforts(modelInfo)) : null;
  return THINKING_EFFORT_OPTIONS
    .filter((option) => !supported || supported.has(option.value))
    .map((option) => ({ ...option, label: localized(option), description: localized(option, "description") }));
}

export function normalizeThinkingMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "on" || mode === "enabled" || mode === "true" || mode === "1") return "on";
  if (mode === "off" || mode === "disabled" || mode === "false" || mode === "0") return "off";
  return "auto";
}

export function normalizeThinkingEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (THINKING_EFFORT_VALUES.has(effort)) return effort;
  return "auto";
}

export function getThinkingModeOptionLabel(value) {
  const mode = normalizeThinkingMode(value);
  return localized(THINKING_MODE_OPTIONS.find((option) => option.value === mode)) || mode;
}

export function getThinkingEffortOptionLabel(value) {
  const effort = normalizeThinkingEffort(value);
  return localized(THINKING_EFFORT_OPTIONS.find((option) => option.value === effort)) || effort;
}

export function isLikelyThinkingModelId(modelIdOrName) {
  const s = String(modelIdOrName || "").toLowerCase();
  if (!s) return false;
  return (
    s.includes("reasoner") ||
    s.includes("thinking") ||
    s.includes("deepseek-r1") ||
    s.includes("deepseek-v4") ||
    s.includes("gemini-2.5") ||
    /^gemini-3(?:[.-]|$)/.test(s) ||
    /^claude-(?:3-7|opus-4|sonnet-4|haiku-4|fable-5|mythos)/.test(s) ||
    /(?:^|[-_/])gpt-5(?:[.-]|$)/.test(s) ||
    /(?:^|[-_/])o(?:1|3|4)(?:[-_.]|$)/.test(s)
  );
}

function getThinkingModelInfo({ providerId, providerType, modelId, modelName, cfg } = {}) {
  const provider = String(providerId || cfg?.providerId || providerType || cfg?.providerType || "").toLowerCase();
  const model = String(modelName || cfg?.modelName || modelId || cfg?.id || "").toLowerCase();
  const url = String(cfg?.url || cfg?.baseURL || "").toLowerCase();
  return { provider, model, url };
}

export function isDeepSeekThinkingConfig(info = {}) {
  const { provider, model, url } = getThinkingModelInfo(info);
  return provider.includes("deepseek") || model.includes("deepseek") || url.includes("api.deepseek.com");
}

export function isClaudeAdaptiveThinkingModel(modelIdOrName) {
  const model = String(modelIdOrName || "").toLowerCase();
  return (
    model.includes("claude-opus-4-6") ||
    model.includes("claude-opus-4-7") ||
    model.includes("claude-opus-4-8") ||
    model.includes("claude-sonnet-4-6") ||
    model.includes("claude-sonnet-5") ||
    model.includes("claude-fable-5") ||
    model.includes("claude-mythos")
  );
}

export function isClaudeManualThinkingModel(modelIdOrName) {
  const model = String(modelIdOrName || "").toLowerCase();
  if (!model || isClaudeAdaptiveThinkingModel(model)) return false;
  return (
    model.includes("claude-3-7-sonnet") ||
    model.includes("claude-opus-4") ||
    model.includes("claude-sonnet-4") ||
    model.includes("claude-haiku-4-5")
  );
}

export function usesGeminiThinkingLevel(modelIdOrName) {
  const model = String(modelIdOrName || "").toLowerCase();
  return /^gemini-3(?:[.-]|$)/.test(model);
}

export function getSupportedThinkingEfforts(info = {}) {
  if (info.cfg?.supportsThinkingEffort === false) return ["auto"];
  const { provider, model } = getThinkingModelInfo(info);

  if (isDeepSeekThinkingConfig(info)) return ["auto", "high", "max"];

  if (provider === "claude" || provider === "anthropic") {
    if (isClaudeAdaptiveThinkingModel(model)) {
      const supportsXHigh =
        model.includes("claude-opus-4-7") ||
        model.includes("claude-opus-4-8") ||
        model.includes("claude-sonnet-5") ||
        model.includes("claude-fable-5") ||
        model.includes("claude-mythos");
      return supportsXHigh
        ? ["auto", "low", "medium", "high", "xhigh", "max"]
        : ["auto", "low", "medium", "high", "max"];
    }
    if (isClaudeManualThinkingModel(model)) return ["auto", "low", "medium", "high", "max"];
    return info.cfg?.supportsThinkingEffort === true ? ["auto", "low", "medium", "high"] : ["auto"];
  }

  if (provider === "gemini" || provider === "google") {
    if (model.includes("gemini-3.1-flash-lite-image")) return ["auto", "minimal", "high"];
    if (model.includes("gemini-3-pro")) return ["auto", "low", "high"];
    if (model.includes("gemini-3.1-pro")) return ["auto", "low", "medium", "high"];
    if (usesGeminiThinkingLevel(model)) return ["auto", "minimal", "low", "medium", "high"];
    if (model.includes("gemini-2.5")) return ["auto", "low", "medium", "high"];
    return info.cfg?.supportsThinkingEffort === true ? ["auto", "low", "medium", "high"] : ["auto"];
  }

  if (
    provider === "openai" ||
    /(?:^|[-_/])gpt-5(?:[.-]|$)/.test(model) ||
    /(?:^|[-_/])o(?:1|3|4)(?:[-_.]|$)/.test(model)
  ) {
    return ["auto", "minimal", "low", "medium", "high", "xhigh", "max"];
  }

  return info.cfg?.supportsThinkingEffort === true
    ? ["auto", "minimal", "low", "medium", "high", "xhigh", "max"]
    : ["auto"];
}

export function inferThinkingCapability({ providerId, providerType, modelId, modelName, cfg } = {}) {
  if (cfg?.supportsThinking === true) return "supported";
  if (cfg?.supportsThinking === false) return "unsupported";
  const provider = String(providerType || providerId || "").toLowerCase();
  const model = String(modelName || modelId || "").toLowerCase();
  if (isDeepSeekThinkingConfig({ providerId, providerType, modelId, modelName, cfg })) return "supported";
  if (provider === "claude" || provider === "anthropic") {
    return isClaudeAdaptiveThinkingModel(model) || isClaudeManualThinkingModel(model) ? "supported" : "unsupported";
  }
  if (provider === "gemini" || provider === "google") {
    return isLikelyThinkingModelId(model) ? "supported" : "unknown";
  }
  return isLikelyThinkingModelId(model) ? "supported" : "unknown";
}

export function inferThinkingEffortCapability(info = {}) {
  const { cfg } = info;
  if (cfg?.supportsThinkingEffort === true) return true;
  if (cfg?.supportsThinkingEffort === false) return false;
  return getSupportedThinkingEfforts(info).length > 1;
}

export function getThinkingModeLabel(key) {
  return localized(THINKING_MODE_FIELDS.find((field) => field.key === key)) || key;
}

export function getThinkingModeShortLabel(key) {
  const field = THINKING_MODE_FIELDS.find((item) => item.key === key);
  return localized(field, "shortLabel") || getThinkingModeLabel(key);
}

export function getThinkingModeBadge(key) {
  return THINKING_MODE_FIELDS.find((field) => field.key === key)?.badge || key;
}
