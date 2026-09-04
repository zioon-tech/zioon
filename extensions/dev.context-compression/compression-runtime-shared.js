export const COMPRESSION_RUNTIME_PLUGIN_ID = "dev.context-compression";
export const COMPRESSION_RUNTIME_STATE_NAMESPACE = "compression";
export const COMPRESSION_RUNTIME_SETTINGS_KEY = "settings";
export const COMPRESSION_RUNTIME_STATS_KEY = "stats";
export const COMPRESSION_RUNTIME_KV_KEY =
  `runtime.plugins.${COMPRESSION_RUNTIME_PLUGIN_ID}.${COMPRESSION_RUNTIME_STATE_NAMESPACE}.${COMPRESSION_RUNTIME_SETTINGS_KEY}`;

export const DEFAULT_COMPRESSION_SETTINGS = Object.freeze({
  autoCompression: true,
  debugLogging: false,
  defaultStrategy: "auto",
  threshold: 0.95,
  contextLimitTokens: 128000,
  outputTokens: 4096,
  charsPerToken: 4,
  pruneProtect: 40000,
  pruneMinimum: 20000,
  protectedTools: ["skill"],
  progressiveTokensProtect: 0,
  progressiveTokensCompact: 0,
  progressiveRecentProtectTokens: 20000,
  progressiveMaxRecordPromptChars: 100,
  progressiveKeepRecentTurns: 2,
  updatedAt: 0
});

const KNOWN_STRATEGIES = new Set([
  "auto",
  "opencode",
  "claude-code",
  "cursor",
  "manus",
  "focus-agent",
  "progressive"
]);
const RUNTIME_STRATEGIES = new Set(["auto", "opencode", "claude-code", "progressive"]);

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function stringList(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return Array.from(new Set(
    value.map((item) => String(item || "").trim()).filter(Boolean)
  )).slice(0, 32);
}

export function normalizeCompressionSettings(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const strategy = String(source.defaultStrategy || DEFAULT_COMPRESSION_SETTINGS.defaultStrategy);
  return {
    ...DEFAULT_COMPRESSION_SETTINGS,
    autoCompression: source.autoCompression !== false,
    debugLogging: source.debugLogging === true,
    defaultStrategy: KNOWN_STRATEGIES.has(strategy) ? strategy : "auto",
    threshold: boundedNumber(source.threshold, 0.95, 0.5, 1),
    contextLimitTokens: Math.floor(boundedNumber(
      source.contextLimitTokens,
      128000,
      1000,
      2_000_000
    )),
    outputTokens: Math.floor(boundedNumber(source.outputTokens, 4096, 1, 200_000)),
    charsPerToken: boundedNumber(source.charsPerToken, 4, 1, 16),
    pruneProtect: Math.floor(boundedNumber(source.pruneProtect, 40000, 0, 1_000_000)),
    pruneMinimum: Math.floor(boundedNumber(source.pruneMinimum, 20000, 0, 1_000_000)),
    protectedTools: stringList(source.protectedTools, ["skill"]),
    progressiveTokensProtect: Math.floor(boundedNumber(
      source.progressiveTokensProtect,
      0,
      0,
      1_000_000
    )),
    progressiveTokensCompact: Math.floor(boundedNumber(
      source.progressiveTokensCompact,
      0,
      0,
      1_000_000
    )),
    progressiveRecentProtectTokens: Math.floor(boundedNumber(
      source.progressiveRecentProtectTokens,
      20000,
      0,
      1_000_000
    )),
    progressiveMaxRecordPromptChars: Math.floor(boundedNumber(
      source.progressiveMaxRecordPromptChars,
      100,
      20,
      2000
    )),
    progressiveKeepRecentTurns: Math.floor(boundedNumber(
      source.progressiveKeepRecentTurns,
      2,
      0,
      20
    )),
    updatedAt: Math.max(0, Number(source.updatedAt) || 0)
  };
}

export function compressionSettingsRevision(value = {}) {
  return normalizeCompressionSettings(value).updatedAt;
}

export function runtimeCompressionStrategy(value) {
  const strategy = normalizeCompressionSettings(value).defaultStrategy;
  return RUNTIME_STRATEGIES.has(strategy) ? strategy : "progressive";
}

export function compressionSettingsSyncDirection(localSettings, runtimeSettings) {
  const local = normalizeCompressionSettings(localSettings);
  if (!runtimeSettings) return "upload";
  const runtime = normalizeCompressionSettings(runtimeSettings);
  if (runtime.updatedAt > local.updatedAt) return "restore";
  if (local.updatedAt > runtime.updatedAt) return "upload";
  const defaults = JSON.stringify(normalizeCompressionSettings());
  if (JSON.stringify(runtime) === defaults && JSON.stringify(local) !== defaults) {
    return "upload";
  }
  return "none";
}

export function configureCompressionEngine(engine, settings = {}) {
  const value = normalizeCompressionSettings(settings);
  engine.updateConfig({
    autoCompression: value.autoCompression,
    threshold: value.threshold,
    maxTokens: value.contextLimitTokens,
    outputTokens: value.outputTokens,
    charsPerToken: value.charsPerToken
  });
  engine.strategies.get("opencode")?.updateOptions?.({
    pruneProtect: value.pruneProtect,
    pruneMinimum: value.pruneMinimum,
    protectedTools: value.protectedTools,
    threshold: value.threshold,
    outputTokenMax: value.outputTokens
  });
  engine.strategies.get("progressive")?.updateOptions?.({
    threshold: value.threshold,
    keepRecentTurns: value.progressiveKeepRecentTurns,
    maxRecordPromptChars: value.progressiveMaxRecordPromptChars,
    tokensProtect: value.progressiveTokensProtect,
    tokensCompact: value.progressiveTokensCompact,
    recentProtectTokens: value.progressiveRecentProtectTokens
  });
  return value;
}

export function toCompressionMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    ...message,
    ...(Array.isArray(message.toolCalls) ? { tool_calls: message.toolCalls } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {})
  }));
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function runtimeContent(content) {
  if (!Array.isArray(content)) return textContent(content);
  const parts = content.flatMap((part) => {
    if (part?.type === "text" && typeof part.text === "string") {
      return [{ type: "text", text: part.text }];
    }
    if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
      return [{
        type: "image_url",
        image_url: {
          url: part.image_url.url,
          ...(part.image_url.detail ? { detail: part.image_url.detail } : {})
        }
      }];
    }
    return [];
  });
  return parts.length ? parts : textContent(content);
}

export function toRuntimeMessages(messages = [], original = []) {
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  const converted = (Array.isArray(messages) ? messages : []).flatMap((message) => {
    const role = String(message?.role || "");
    if (!allowedRoles.has(role)) return [];
    const content = role === "tool"
      ? textContent(message.content)
      : runtimeContent(message.content);
    if (role === "tool") {
      const toolCallId = String(message.toolCallId || message.tool_call_id || "");
      return toolCallId ? [{ role, content, toolCallId }] : [];
    }
    const toolCalls = Array.isArray(message.toolCalls)
      ? message.toolCalls
      : Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
    return [{
      role,
      content,
      ...(message.reasoningContent
        ? { reasoningContent: String(message.reasoningContent) }
        : {}),
      ...(role === "assistant" && toolCalls.length ? { toolCalls } : {})
    }];
  });
  const toolCallIds = new Set(converted.flatMap((message) =>
    Array.isArray(message.toolCalls)
      ? message.toolCalls.map((call) => String(call?.id || "")).filter(Boolean)
      : []
  ));
  const paired = converted.filter((message) =>
    message.role !== "tool" || toolCallIds.has(message.toolCallId)
  );
  const source = Array.isArray(original) ? original : [];
  const latest = source.at(-1);
  if (
    latest?.role === "user"
    && paired.at(-1)?.role !== "user"
  ) {
    paired.push({
      role: "user",
      content: runtimeContent(latest.content)
    });
  }
  return paired.length ? paired : source;
}
