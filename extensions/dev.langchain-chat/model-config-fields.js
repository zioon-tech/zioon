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
  }
];

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

export function getThinkingEffortOptions() {
  return THINKING_EFFORT_OPTIONS.map((option) => ({ ...option, label: localized(option), description: localized(option, "description") }));
}

export function normalizeThinkingMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "on" || mode === "enabled" || mode === "true" || mode === "1") return "on";
  if (mode === "off" || mode === "disabled" || mode === "false" || mode === "0") return "off";
  return "auto";
}

export function normalizeThinkingEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
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
    s.includes("deepseek-flash") ||
    s.includes("r1") ||
    s.includes("o1") ||
    s.includes("o3") ||
    s.includes("o4")
  );
}

export function inferThinkingCapability({ providerId, providerType, modelId, modelName, cfg } = {}) {
  if (cfg?.supportsThinking === true) return "supported";
  if (cfg?.supportsThinking === false) return "unsupported";
  const provider = String(providerType || providerId || "").toLowerCase();
  if (provider === "claude" || provider === "anthropic") return "supported";
  if (provider === "gemini" || provider === "google") {
    return isLikelyThinkingModelId(modelName || modelId) ? "supported" : "unknown";
  }
  return isLikelyThinkingModelId(modelName || modelId) ? "supported" : "unknown";
}

export function inferThinkingEffortCapability({ providerId, providerType, modelId, modelName, cfg } = {}) {
  if (cfg?.supportsThinkingEffort === true) return true;
  if (cfg?.supportsThinkingEffort === false) return false;
  const provider = String(providerType || providerId || "").toLowerCase();
  const model = String(modelName || modelId || "").toLowerCase();
  if (provider === "openai" && (model.includes("o1") || model.includes("o3") || model.includes("o4"))) return true;
  if (model.includes("deepseek-flash")) return true;
  return false;
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
