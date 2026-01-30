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
  return false;
}

export function resolveToolCallsReasoningContentMode({ cfg, stateMode }) {
  const fromCfg =
    cfg?.toolCallsReasoningContentMode ??
    cfg?.tool_calls_reasoning_content_mode ??
    cfg?.reasoningContentWithToolCalls;

  if (fromCfg != null) return normalizeToolCallsReasoningContentMode(fromCfg);
  return normalizeToolCallsReasoningContentMode(stateMode);
}

export function shouldForceReasoningContentWithToolCalls({ mode, modelId, modelName }) {
  const m = normalizeToolCallsReasoningContentMode(mode);
  if (m === "always") return true;
  if (m === "never") return false;
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
