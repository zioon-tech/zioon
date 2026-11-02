export function normalizeToolCallsReasoningContentMode(mode) {
  if (mode === true) return "always";
  if (mode === false) return "never";
  const m = String(mode || "").trim().toLowerCase();
  if (m === "always" || m === "on" || m === "true" || m === "1") return "always";
  if (m === "never" || m === "off" || m === "false" || m === "0") return "never";
  return "auto";
}

export const DEFAULT_REASONING_CONTENT_PLACEHOLDER = "[reasoning omitted]";

export function isLikelyReasoningModelId(modelIdOrName) {
  const s = String(modelIdOrName || "").toLowerCase();
  if (!s) return false;
  if (s.includes("reasoner")) return true;
  if (s.includes("deepseek-r1")) return true;
  if (s.includes("r1")) return true;
  if (s.includes("thinking")) return true;
  if (s.includes("kimi") || s.includes("moonshot")) return true;
  if (s.includes("k2.5") || s.includes("k2")) return true;
  if (s.includes("o1") || s.includes("o3")) return true;
  if (isClaudeThinkingModel(modelIdOrName)) return true;
  if (isGeminiThinkingModel(modelIdOrName)) return true;
  return false;
}

/**
 * 检测是否为 Claude 思考模型
 * Claude 3.5 Sonnet 和 Opus 支持 thinking 扩展
 */
export function isClaudeThinkingModel(modelIdOrName) {
  const s = String(modelIdOrName || "").toLowerCase();
  if (!s) return false;
  return (
    s.includes("claude-3-7-sonnet") ||
    s.includes("claude-opus-4") ||
    s.includes("claude-sonnet-4") ||
    s.includes("claude-sonnet-5") ||
    s.includes("claude-haiku-4-5") ||
    s.includes("claude-fable-5") ||
    s.includes("claude-mythos")
  );
}

/**
 * 检测是否为 Gemini 思考模型
 * Gemini 2.0 Flash Thinking 等支持 thinking
 */
export function isGeminiThinkingModel(modelIdOrName) {
  const s = String(modelIdOrName || "").toLowerCase();
  if (!s) return false;
  return s.includes("thinking") || s.includes("gemini-2.5") || /^gemini-3(?:[.-]|$)/.test(s);
}

export function resolveToolCallsReasoningContentMode({ cfg, stateMode }) {
  const fromCfg =
    cfg?.toolCallsReasoningContentMode ??
    cfg?.tool_calls_reasoning_content_mode ??
    cfg?.reasoningContentWithToolCalls;

  if (fromCfg != null) return normalizeToolCallsReasoningContentMode(fromCfg);
  return normalizeToolCallsReasoningContentMode(stateMode);
}

export function shouldForceReasoningContentWithToolCalls({ mode, modelId, modelName, providerId, providerType, cfg } = {}) {
  const m = normalizeToolCallsReasoningContentMode(mode);
  if (m === "always") return true;
  if (m === "never") return false;
  const provider = String(providerId || providerType || cfg?.providerId || cfg?.providerType || "").toLowerCase();
  const name = String(modelName || modelId || cfg?.modelName || cfg?.id || "").toLowerCase();
  const thinkingMode = String(cfg?.thinkingMode || cfg?.thinking_mode || "").toLowerCase();
  if (provider.includes("claude") || provider.includes("anthropic") || provider.includes("gemini") || provider.includes("google")) {
    return false;
  }
  if ((provider.includes("deepseek") || name.includes("deepseek")) && thinkingMode !== "off" && thinkingMode !== "disabled") {
    return true;
  }
  return isLikelyReasoningModelId(modelName) || isLikelyReasoningModelId(modelId);
}

export function patchMessagesForReasoningContentToolCalls(messages, { force = false } = {}) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!m || m.role !== "assistant" || !m.tool_calls) return m;
    if (m.reasoning_content != null) return m;
    if (!force) return m;
    changed = true;
    return { ...m, reasoning_content: DEFAULT_REASONING_CONTENT_PLACEHOLDER };
  });
  return changed ? out : messages;
}
