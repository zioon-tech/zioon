import { normalizeModelLimits } from "./model-limits.js";

export const CONTEXT_WARNING_THRESHOLD = 0.7;
export const CONTEXT_CRITICAL_THRESHOLD = 0.85;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;

const CONTEXT_WINDOW_KEYS = [
  "contextWindowTokens",
  "context_window_tokens",
  "contextWindow",
  "context_window",
  "contextLimitTokens",
  "context_limit_tokens",
  "maxContextTokens",
  "max_context_tokens",
  "maxInputTokens",
  "max_input_tokens"
];

function positiveInteger(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function normalizeThreshold(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

function firstPositive(values) {
  for (const value of values) {
    const n = positiveInteger(value);
    if (n) return n;
  }
  return 0;
}

function inferKnownContextWindow(model = {}, cfg = {}) {
  const provider = String(model?.providerId || cfg?.providerId || cfg?.providerType || "").toLowerCase();
  const name = String(cfg?.modelName || cfg?.model || model?.modelId || cfg?.id || "").toLowerCase();
  if (
    name.includes("claude-sonnet-5")
    || name.includes("claude-sonnet-4-6")
    || name.includes("claude-opus-4-8")
    || name.includes("claude-opus-4-7")
  ) return 1000000;
  if (provider.includes("anthropic") || provider.includes("claude") || name.includes("claude")) return 200000;
  if (provider.includes("google") || provider.includes("gemini") || name.includes("gemini")) return 1048576;
  if (name.includes("gpt-4.1")) return 1047576;
  if (name.includes("gpt-4o") || name.includes("gpt-4-turbo")) return 128000;
  if (name.includes("o3") || name.includes("o4")) return 200000;
  if (name.includes("deepseek-v4") || name.includes("deepseek v4")) return 1000000;
  if (provider.includes("deepseek") || name.includes("deepseek")) return 128000;
  if (name.includes("qwen")) return 128000;
  return 0;
}

export function resolveModelContextWindowTokens(cfg = {}, model = {}) {
  const configuredLimits = normalizeModelLimits(cfg);
  const modelLimits = normalizeModelLimits(model);
  const explicit = firstPositive([
    configuredLimits.maxInputTokens,
    configuredLimits.contextWindowTokens,
    modelLimits.maxInputTokens,
    modelLimits.contextWindowTokens,
    ...CONTEXT_WINDOW_KEYS.flatMap((key) => [cfg?.[key], model?.[key]])
  ]);
  if (explicit) return explicit;
  const known = inferKnownContextWindow(model, cfg);
  if (known) return known;
  return 0;
}

function estimateValueChars(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateValueChars(item), 0);
  if (typeof value === "object") {
    try { return JSON.stringify(value).length; } catch {}
  }
  return String(value || "").length;
}

function estimateMessageChars(message) {
  if (!message || typeof message !== "object") return estimateValueChars(message);
  let chars = estimateValueChars(message.role) + estimateValueChars(message.name) + estimateValueChars(message.content);
  chars += estimateValueChars(message.reasoning_content);
  chars += estimateValueChars(message.tool_calls);
  chars += estimateValueChars(message.tool_call_id);
  return chars;
}

export function estimateMessagesTokens(messages = [], opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const charsPerToken = positiveInteger(opts?.charsPerToken ?? opts?.cfg?.charsPerToken) || 4;
  const contentChars = list.reduce((sum, message) => sum + estimateMessageChars(message), 0);
  const protocolOverhead = list.length * 4 + 8;
  return Math.max(0, Math.ceil(contentChars / charsPerToken) + protocolOverhead);
}

function readCompressionCount(state) {
  try {
    const stats = state?.get?.("compression.stats");
    return positiveInteger(stats?.compressionCount);
  } catch {
    return 0;
  }
}

function readCharsPerToken(state, cfg) {
  try {
    return positiveInteger(state?.get?.("compression.settings")?.charsPerToken) || positiveInteger(cfg?.charsPerToken) || 4;
  } catch {
    return positiveInteger(cfg?.charsPerToken) || 4;
  }
}

export function buildContextWindowSnapshot({
  sessionId,
  messages,
  model,
  cfg,
  state,
  warningThreshold = CONTEXT_WARNING_THRESHOLD,
  criticalThreshold = CONTEXT_CRITICAL_THRESHOLD
} = {}) {
  const resolvedContextWindow = resolveModelContextWindowTokens(cfg, model);
  const contextWindowKnown = resolvedContextWindow > 0;
  const modelContextWindow = contextWindowKnown ? resolvedContextWindow : 0;
  const estimatedTokens = estimateMessagesTokens(messages, {
    cfg,
    charsPerToken: readCharsPerToken(state, cfg)
  });
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  const compressionCount = readCompressionCount(state);
  const normalizedWarning = normalizeThreshold(warningThreshold, CONTEXT_WARNING_THRESHOLD);
  const normalizedCritical = Math.max(
    normalizedWarning,
    normalizeThreshold(criticalThreshold, CONTEXT_CRITICAL_THRESHOLD)
  );
  const utilization = contextWindowKnown ? Math.min(1, estimatedTokens / modelContextWindow) : 0;
  const reasons = [];
  let severity = "ok";
  let recommendation = "continue";

  if (utilization >= normalizedCritical) {
    severity = "critical";
    recommendation = "new-session";
    reasons.push("context-window-critical");
  } else if (utilization >= normalizedWarning) {
    severity = "warning";
    recommendation = "compress";
    reasons.push("context-window-high");
  }
  if (!contextWindowKnown) reasons.push("context-window-unknown");

  if (messageCount >= 80 && recommendation === "continue") {
    severity = "warning";
    recommendation = "compress";
    reasons.push("many-messages");
  }

  if (compressionCount >= 3 && utilization >= 0.55) {
    severity = "critical";
    recommendation = "new-session";
    reasons.push("repeated-compression");
  }

  return {
    sessionId: sessionId ? String(sessionId) : undefined,
    estimatedTokens,
    modelContextWindow,
    contextWindowKnown,
    utilization,
    warningThreshold: normalizedWarning,
    criticalThreshold: normalizedCritical,
    messageCount,
    compressionCount,
    severity,
    recommendation,
    reasons
  };
}
