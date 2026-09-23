import { resolveAppImage } from "./img-db.js";
import {
  DEFAULT_REASONING_CONTENT_PLACEHOLDER,
  patchMessagesForReasoningContentToolCalls,
  resolveToolCallsReasoningContentMode,
  shouldForceReasoningContentWithToolCalls
} from "./reasoning-policy.js";
import {
  DEFAULT_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS,
  isClaudeAdaptiveThinkingModel,
  isClaudeManualThinkingModel,
  isDeepSeekThinkingConfig,
  isLikelyThinkingModelId,
  getSupportedThinkingEfforts,
  normalizeAutoContinueOnColonMaxAttempts,
  normalizeThinkingEffort,
  normalizeThinkingMode,
  usesGeminiThinkingLevel
} from "./model-config-fields.js";
import { proxyLLMRequest } from "./llm-proxy.ts";
import { repairToolCallMessageOrder } from "../../src/chat/message-order.ts";
import {
  registerLlmRequestPayload
} from "../../src/runtime/llm-request-observability.ts";
import {
  recordModelAvailabilityFailure,
  recordModelAvailabilitySuccess
} from "./model-health.js";

/**
 * 消息格式转换函数 - 将标准消息格式转换为特定 provider 所需的格式
 */
function transformMessagesForProvider(messages, providerType, cfg) {
  if (providerType === "gemini") {
    // Gemini 格式: contents[{ role: "user"|"model", parts: [{ text: string }] }]
    const contents = [];
    for (const m of messages) {
      if (m.role === "system") continue; // Gemini 不支持 system 消息，放到 systemInstruction 中
      const role = m.role === "assistant" ? "model" : m.role;
      let content = m.content;
      if (typeof content === "string") {
        contents.push({ role, parts: [{ text: content }] });
      } else if (Array.isArray(content)) {
        const parts = [];
        for (const c of content) {
          if (c.type === "text" && c.text) {
            parts.push({ text: c.text });
          } else if (c.type === "image_url" && c.image_url?.url) {
            // Gemini 支持 inline image 或 image URL
            parts.push({ inlineData: { mimeType: "image/jpeg", data: c.image_url.url } });
          }
        }
        if (parts.length > 0) {
          contents.push({ role, parts });
        }
      }
    }
    return contents;
  }
  // OpenAI/Claude 格式保持原样
  return null; // null 表示不需要转换
}

/**
 * 工具定义格式转换 - 将 OpenAI 格式转换为特定 provider 所需的格式
 */
function transformToolsForProvider(tools, providerType) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return tools;

  if (providerType === "claude") {
    // Claude 格式: tools[{ name, description, input_schema }]
    return tools.map(t => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || "",
        input_schema: fn.parameters || { type: "object", properties: {} }
      };
    });
  }

  if (providerType === "gemini") {
    // Gemini 格式: tools[{ functionDeclarations: [{ name, description, parameters }] }]
    const functionDeclarations = tools.map(t => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters || { type: "object", properties: {} }
      };
    });
    return [{ functionDeclarations }];
  }

  // OpenAI 格式保持原样
  return tools;
}

/**
 * 为特定 provider 构建完整的请求体
 */
export function buildProviderRequestBody(cfg, formattedMessages, tools, providerType, providerId = "") {
  const thinkingMode = normalizeThinkingMode(cfg.thinkingMode);
  const modelName = String(cfg.modelName || cfg.id || "");
  const thinkingInfo = { providerId, providerType, modelName, cfg };
  const requestedThinkingEffort = normalizeThinkingEffort(cfg.thinkingEffort);
  const supportedThinkingEfforts = getSupportedThinkingEfforts(thinkingInfo);
  const thinkingEffort = supportedThinkingEfforts.includes(requestedThinkingEffort)
    ? requestedThinkingEffort
    : requestedThinkingEffort === "minimal" && supportedThinkingEfforts.includes("low")
      ? "low"
      : (requestedThinkingEffort === "xhigh" || requestedThinkingEffort === "max") && supportedThinkingEfforts.includes("max")
        ? "max"
        : supportedThinkingEfforts.includes("high")
          ? "high"
          : "auto";
  const wantsThinking = thinkingMode !== "off" && (thinkingMode === "on" || thinkingEffort !== "auto");
  const isDeepSeek = isDeepSeekThinkingConfig(thinkingInfo);
  const systemText = formattedMessages
    .filter((message) => message?.role === "system")
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content
        .map((part) => typeof part?.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  const base = {
    model: cfg.modelName,
    messages: formattedMessages,
    stream: cfg.stream !== false
  };
  if (typeof cfg.temperature === "number" && Number.isFinite(cfg.temperature)) {
    base.temperature = cfg.temperature;
  }

  if (isDeepSeek) {
    if (typeof cfg.max_tokens === "number" && Number.isFinite(cfg.max_tokens)) {
      base.max_tokens = cfg.max_tokens;
    }
    if (base.stream) {
      base.stream_options = { include_usage: true };
    }
    if (thinkingMode === "off") {
      base.thinking = { type: "disabled" };
    } else if (wantsThinking) {
      base.thinking = { type: "enabled" };
      delete base.temperature;
    }
    if (thinkingMode !== "off" && thinkingEffort !== "auto") {
      base.reasoning_effort = thinkingEffort === "max" || thinkingEffort === "xhigh" ? "max" : "high";
    }
    if (tools && tools.length > 0) {
      base.tools = tools;
      base.tool_choice = "auto";
    }
    return base;
  }

  if (providerType === "claude") {
    const claudeMessages = formattedMessages.filter((message) => message?.role !== "system");
    base.messages = claudeMessages;
    if (systemText) base.system = systemText;
    base.max_tokens = Math.max(2048, cfg.max_tokens || 16384);
    // Claude 不支持 tool_choice
    if (tools && tools.length > 0) {
      base.tools = transformToolsForProvider(tools, "claude");
    }
    if (thinkingMode === "off") {
      base.thinking = { type: "disabled" };
    } else if (wantsThinking && isClaudeAdaptiveThinkingModel(modelName)) {
      base.thinking = { type: "adaptive", display: "summarized" };
      if (thinkingEffort !== "auto") {
        base.output_config = {
          effort: thinkingEffort === "minimal" ? "low" : thinkingEffort
        };
      }
      delete base.temperature;
    } else if (wantsThinking && (isClaudeManualThinkingModel(modelName) || cfg.supportsThinking === true)) {
      const targetBudget = {
        minimal: 1024,
        low: 4096,
        medium: 8192,
        high: 16384,
        xhigh: 32768,
        max: 65536
      }[thinkingEffort === "auto" ? "high" : thinkingEffort] || 16384;
      const budgetTokens = Math.max(1024, Math.min(targetBudget, base.max_tokens - 1024));
      base.thinking = { type: "enabled", budget_tokens: budgetTokens };
      delete base.temperature;
    }
    return base;
  }

  if (providerType === "gemini") {
    // Gemini 使用 contents 而不是 messages
    const contents = transformMessagesForProvider(formattedMessages, "gemini", cfg);
    const geminiBody = {
      contents,
      generationConfig: {}
    };
    if (systemText) {
      geminiBody.systemInstruction = { parts: [{ text: systemText }] };
    }
    if (typeof cfg.temperature === "number" && Number.isFinite(cfg.temperature)) {
      geminiBody.generationConfig.temperature = cfg.temperature;
    }
    if (typeof cfg.max_tokens === "number" && Number.isFinite(cfg.max_tokens)) {
      geminiBody.generationConfig.maxOutputTokens = cfg.max_tokens;
    }
    if (usesGeminiThinkingLevel(modelName)) {
      const level =
        thinkingMode === "off"
          ? (modelName.includes("flash") && !modelName.includes("pro") ? "minimal" : "low")
          : thinkingEffort === "auto"
            ? null
            : thinkingEffort === "minimal"
              ? "minimal"
              : thinkingEffort === "max" || thinkingEffort === "xhigh"
                ? "high"
                : thinkingEffort;
      if (thinkingMode === "off" || wantsThinking) {
        geminiBody.generationConfig.thinkingConfig = {
          includeThoughts: thinkingMode !== "off",
          ...(level ? { thinkingLevel: level.toUpperCase() } : {})
        };
      }
    } else if (thinkingMode === "off" || wantsThinking) {
      const isGeminiPro = modelName.toLowerCase().includes("pro");
      const budget = {
        minimal: 512,
        low: 1024,
        medium: 8192,
        high: 24576,
        xhigh: 32768,
        max: 32768
      }[thinkingEffort];
      geminiBody.generationConfig.thinkingConfig = {
        thinkingBudget: thinkingMode === "off" ? (isGeminiPro ? 128 : 0) : budget || -1,
        includeThoughts: thinkingMode !== "off"
      };
    }
    if (tools && tools.length > 0) {
      geminiBody.tools = transformToolsForProvider(tools, "gemini");
    }
    return geminiBody;
  }

  // OpenAI 格式
  const isOfficialOpenAIReasoningModel =
    String(cfg.url || "").toLowerCase().includes("api.openai.com") &&
    isLikelyThinkingModelId(modelName);
  if (typeof cfg.max_tokens === "number" && Number.isFinite(cfg.max_tokens)) {
    if (isOfficialOpenAIReasoningModel) base.max_completion_tokens = cfg.max_tokens;
    else base.max_tokens = cfg.max_tokens;
  }
  if (base.stream) {
    base.stream_options = { include_usage: true };
  }
  if (thinkingMode !== "off" && thinkingEffort !== "auto") {
    base.reasoning_effort = thinkingEffort;
    if (isOfficialOpenAIReasoningModel) delete base.temperature;
  }
  if (tools && tools.length > 0) {
    base.tools = tools;
    base.tool_choice = "auto";
  }
  return base;
}

/**
 * 获取特定 provider 的请求 headers
 */
function getProviderHeaders(cfg, providerType) {
  const headers = {
    "Content-Type": "application/json"
  };
  const apiKey = String(cfg.key || cfg.apiKey || "").trim();

  if (providerType === "claude") {
    // Claude 需要 anthropic-version 头部
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = cfg.anthropicVersion || "2023-06-01";
    return headers;
  }

  if (providerType === "gemini") {
    // Gemini 使用 URL 中的 key 参数
    return headers;
  }

  // OpenAI 格式
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function hasRuntimeManagedCredential(cfg) {
  return cfg?._credentialConfigured === true || cfg?.credentialConfigured === true;
}

/**
 * 构建特定 provider 的请求 URL
 */
export function buildProviderURL(cfg, providerType) {
  if (providerType === "gemini") {
    const base = String(cfg.url || "https://generativelanguage.googleapis.com/v1beta/models").replace(/\/+$/, "");
    const model = cfg.modelName;
    const method = cfg.stream !== false ? "streamGenerateContent" : "generateContent";
    const params = [];
    if (cfg.stream !== false) params.push("alt=sse");
    if (cfg.key) params.push(`key=${encodeURIComponent(cfg.key)}`);
    const query = params.join("&");
    return `${base}/${model}:${method}${query ? `?${query}` : ""}`;
  }

  // OpenAI/Claude 使用原来的 URL
  return cfg.url;
}

function redactRequestUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(key|api_key|apikey|token|access_token|authorization)$/i.test(key)) {
        parsed.searchParams.set(key, "<redacted>");
      }
    }
    return parsed.toString();
  } catch {
    return String(url || "").replace(/([?&](?:key|api_key|apikey|token|access_token|authorization)=)[^&]+/gi, "$1<redacted>");
  }
}

function summarizeDebugPayloadMessages(list) {
  return Array.isArray(list) ? list.map((m, i) => ({
    i,
    role: m?.role || "",
    contentType: Array.isArray(m?.content) ? "array" : typeof m?.content,
    contentLen: typeof m?.content === "string" ? m.content.length : (Array.isArray(m?.content) ? m.content.length : 0),
    contentPreview: typeof m?.content === "string" ? String(m.content).slice(0, 120) : "",
    hasReasoning: typeof m?.reasoning_content === "string",
    reasoningLen: typeof m?.reasoning_content === "string" ? m.reasoning_content.length : 0,
    reasoningPreview: typeof m?.reasoning_content === "string" ? String(m.reasoning_content).slice(0, 120) : "",
    toolCalls: Array.isArray(m?.tool_calls) ? m.tool_calls.length : 0,
    toolCallIds: Array.isArray(m?.tool_calls) ? m.tool_calls.map((tc) => tc?.id || "") : [],
    toolCallId: m?.tool_call_id || ""
  })) : [];
}

function diffDebugPayloadMessages(prev, next) {
  const before = Array.isArray(prev) ? prev : [];
  const after = Array.isArray(next) ? next : [];
  const max = Math.min(before.length, after.length);
  let samePrefix = 0;
  while (samePrefix < max) {
    try {
      if (JSON.stringify(before[samePrefix] || null) !== JSON.stringify(after[samePrefix] || null)) break;
    } catch {
      break;
    }
    samePrefix += 1;
  }
  return {
    prevCount: before.length,
    nextCount: after.length,
    samePrefix,
    appended: summarizeDebugPayloadMessages(after.slice(samePrefix))
  };
}

function normalizeProviderUsage(raw, providerType) {
  if (!raw || typeof raw !== "object") return null;
  if (providerType === "gemini") {
    const meta = raw.usageMetadata || raw.usage_metadata || raw;
    return {
      input: meta.promptTokenCount,
      output: meta.candidatesTokenCount,
      total: meta.totalTokenCount,
      cacheRead: meta.cachedContentTokenCount,
      reasoning: meta.thoughtsTokenCount
    };
  }
  return {
    input: raw.prompt_tokens ?? raw.input_tokens,
    output: raw.completion_tokens ?? raw.output_tokens,
    total: raw.total_tokens,
    cacheRead: raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? raw.cached_tokens,
    cacheWrite: raw.cache_creation_input_tokens ?? raw.cache_creation?.input_tokens,
    reasoning: raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens
  };
}

const DEEPSEEK_COLON_CONTINUATION_PROMPT =
  "上一条回答在冒号后意外中断。请从冒号后直接继续回答，不要重复已经输出的内容，也不要解释中断原因。";
const DEEPSEEK_REASONING_ONLY_CONTINUATION_PROMPT =
  "上一轮只返回了推理内容，没有给出正式回答或工具调用。请继续完成当前任务：直接输出正式内容；如果需要工具，请正常发起工具调用。不要复述推理过程，也不要解释中断原因。";

function isDeepSeekModel(active, cfg) {
  return [
    active?.providerId,
    active?.modelId,
    cfg?.providerId,
    cfg?.modelName,
    cfg?.id
  ].some((value) => String(value || "").toLowerCase().includes("deepseek"));
}

export function getDeepSeekAutoContinuationReason({
  active,
  cfg,
  finishReason,
  content,
  reasoningContent,
  hasToolCalls = false,
  attempt = 0,
  maxAttempts = DEFAULT_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS
}) {
  const limit = normalizeAutoContinueOnColonMaxAttempts(maxAttempts);
  if (attempt >= limit || hasToolCalls || finishReason !== "stop") return null;
  if (!isDeepSeekModel(active, cfg)) return null;
  const finalContent = String(content || "").trimEnd();
  if (/[:：]$/.test(finalContent)) return "colon-stop";
  if (!finalContent && String(reasoningContent || "").trim()) return "reasoning-only-stop";
  return null;
}

export function shouldAutoContinueDeepSeek(options) {
  return !!getDeepSeekAutoContinuationReason(options);
}

export function buildDeepSeekContinuationMessages(messages, content, reason = "colon-stop") {
  const next = [...(Array.isArray(messages) ? messages : [])];
  if (String(content || "").trim()) {
    next.push({ role: "assistant", content: String(content) });
  }
  next.push({
    role: "user",
    content:
      reason === "reasoning-only-stop"
        ? DEEPSEEK_REASONING_ONLY_CONTINUATION_PROMPT
        : DEEPSEEK_COLON_CONTINUATION_PROMPT
  });
  return next;
}

function mergeProviderUsage(first, second) {
  if (!first) return second || null;
  if (!second) return first;
  const merged = {};
  for (const key of ["input", "output", "total", "cacheRead", "cacheWrite", "reasoning"]) {
    const firstValue = Number(first?.[key]);
    const secondValue = Number(second?.[key]);
    if (Number.isFinite(firstValue) || Number.isFinite(secondValue)) {
      merged[key] =
        (Number.isFinite(firstValue) ? firstValue : 0) +
        (Number.isFinite(secondValue) ? secondValue : 0);
    }
  }
  return merged;
}

function joinReasoningContent(first, second) {
  return [first, second]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 解析 Claude 流式响应
 * Claude SSE 格式:
 * - event: content_block_start, data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"..."}}
 * - event: content_block_delta, data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}
 * - event: message_delta, data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":123}}
 */
function parseClaudeStreamLine(line, { toolCallsBuffer, emittedReasoningStart, onToken, onToolCall, runId, sessionId }) {
  let eventType = "message";
  let dataStr = line;

  // 解析 event: 格式
  if (line.startsWith("event:")) {
    const parts = line.split("\n");
    for (const part of parts) {
      if (part.startsWith("event:")) {
        eventType = part.slice(6).trim();
      } else if (part.startsWith("data:")) {
        dataStr = part;
      }
    }
  }

  // 提取 data
  const dataMatch = dataStr.match(/^data:\s*(.*)$/);
  if (!dataMatch) return {};
  const payload = dataMatch[1].trim();
  if (!payload) return {};

  if (payload === "[DONE]") {
    return { done: true };
  }

  try {
    const json = JSON.parse(payload);
    const result = {};

    // 处理 content_block_start (thinking 开始)
    if (eventType === "content_block_start" || json.type === "content_block_start") {
      const block = json.content_block || json.delta;
      if (block?.type === "thinking") {
        result.thinkingStart = true;
      }
    }

    // 处理 content_block_delta (thinking 或 content 增量)
    if (eventType === "content_block_delta" || json.type === "content_block_delta") {
      const delta = json.delta || {};

      // Thinking 内容
      if (delta.type === "thinking_delta" || delta.thinking) {
        const thinking = delta.thinking || "";
        if (thinking) {
          result.thinkingToken = thinking;
          if (!emittedReasoningStart) {
            result.thinkingStart = true;
          }
        }
      }

      // 常规文本内容
      if (delta.type === "text_delta" || delta.text) {
        result.contentToken = delta.text || delta;
      }
    }

    // 处理 tool_use 块
    if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
      const idx = json.index ?? 0;
      while (toolCallsBuffer.length <= idx) toolCallsBuffer.push({ id: "", name: "", arguments: "" });
      toolCallsBuffer[idx].id = json.content_block.id;
    }

    if (json.type === "content_block_delta" && json.delta?.type === "input_json_delta") {
      const idx = json.index ?? 0;
      if (toolCallsBuffer[idx]) {
        toolCallsBuffer[idx].arguments += json.delta.partial_json || "";
      }
    }

    // 处理 message_delta (结束信号)
    if (eventType === "message_delta" || json.type === "message_delta") {
      if (json.usage) {
        result.usage = {
          input: json.usage.input_tokens,
          output: json.usage.output_tokens,
          total: Number(json.usage.input_tokens || 0) + Number(json.usage.output_tokens || 0),
          cacheRead: json.usage.cache_read_input_tokens,
          cacheWrite: json.usage.cache_creation_input_tokens
        };
      }
      const delta = json.delta || {};
      if (delta.stop_reason) {
        result.done = true;
      }
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * 解析 Gemini 流式响应
 * Gemini 使用 server-sent events 格式，但结构不同
 */
function parseGeminiStreamLine(line, { toolCallsBuffer, reasoningBuf, onToken, onToolCall }) {
  // 提取 data: 格式
  const dataMatch = line.match(/^data:\s*(.*)$/);
  if (!dataMatch) return {};
  const payload = dataMatch[1].trim();
  if (!payload) return {};

  try {
    const json = JSON.parse(payload);
    const result = {};

    // Gemini 流式响应结构
    // candidates[0].content.parts[]
    const candidates = json?.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          if (part.thought === true) {
            result.thinkingToken = `${result.thinkingToken || ""}${part.text}`;
          } else {
            result.contentToken = `${result.contentToken || ""}${part.text}`;
          }
        }

        // 函数调用
        if (part.functionCall) {
          const fc = part.functionCall;
          result.functionCall = {
            name: fc.name,
            args: fc.args || {}
          };
        }
      }

      // 兼容旧版 Gemini groundingMetadata 思考字段。
      if (candidate?.groundingMetadata?.thought) {
        result.thinkingToken = `${result.thinkingToken || ""}${candidate.groundingMetadata.thought}`;
      }
    }

    // 检查是否完成
    if (json?.candidates?.[0]?.finishReason) {
      result.done = true;
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * 带自动重试的 fetch（针对网络错误、限流与服务端瞬时错误）
 * @param {string} url - 请求 URL
 * @param {RequestInit} options - fetch 选项
 * @param {number} maxRetries - 首次请求失败后的最大重试次数
 * @param {number} baseDelay - 基础延迟（毫秒）
 * @returns {Promise<Response>}
 */
function createAbortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function getErrorMessage(error, fallback = "未知错误") {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error?.message) return String(error.message);
  if (error && typeof error === "object") {
    try {
      const text = JSON.stringify(error);
      if (text && text !== "{}") return text;
    } catch {}
  }
  return fallback;
}

function parseRetryAfterMs(response) {
  try {
    const raw = response?.headers?.get?.("retry-after");
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  } catch {}
  return null;
}

function createHttpError(response, text) {
  const status = Number(response?.status || 0);
  const detail = String(text || "").trim();
  const error = new Error(
    `HTTP ${status || "请求失败"}${detail ? `: ${detail.slice(0, 512)}` : ""}`
  );
  error.httpStatus = status || null;
  error.responseText = detail;
  error.retryAfterMs = parseRetryAfterMs(response);
  error.retryable =
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500;
  if (
    status === 400 &&
    detail.toLowerCase().includes("reasoning_content") &&
    ["missing", "passed back", "pass back"].some((part) => detail.toLowerCase().includes(part))
  ) {
    error.code = "missing_reasoning_content";
    error.retryable = false;
  }
  return error;
}

function isPermanentRequestFingerprint(fingerprint) {
  return /invalid[_ -]?(api[_ -]?key|access[_ -]?token|request|parameter|model)|authentication|unauthorized|forbidden|permission|insufficient[_ -]?quota|context[_ -]?(length|window)|maximum context|content policy|not found|unsupported|malformed|validation/.test(
    String(fingerprint || "").toLowerCase()
  );
}

function createProviderStreamError(payload) {
  if (!payload || typeof payload !== "object") return null;
  const rawError = payload.error ?? (payload.type === "error" ? payload : null);
  if (rawError == null) {
    // Gemini 可能以 200 返回 promptFeedback.blockReason（无 error 字段）
    const promptFeedback = payload.promptFeedback;
    if (promptFeedback && typeof promptFeedback === "object") {
      const blockReason = String(promptFeedback.blockReason || "").trim();
      const blockReasonMessage = String(promptFeedback.blockReasonMessage || "").trim();
      if (blockReason || blockReasonMessage) {
        const error = new Error(`Gemini blocked: ${blockReasonMessage || blockReason}`);
        error.code = "gemini_prompt_blocked";
        error.retryable = false;
        return error;
      }
    }
    return null;
  }

  const detail = typeof rawError === "object" && rawError
    ? rawError
    : { message: rawError };
  const message = getErrorMessage(
    detail,
    getErrorMessage(payload, "大模型流式响应返回错误")
  );
  const error = new Error(message);
  const status = Number(
    detail.status ??
    detail.status_code ??
    detail.http_status ??
    payload.status ??
    payload.status_code ??
    0
  );
  const code = String(detail.code ?? payload.code ?? "stream_error");
  const fingerprint = [
    code,
    detail.type,
    payload.type,
    message
  ].map((value) => String(value || "").toLowerCase()).join(" ");

  error.code = code;
  error.httpStatus = status || null;
  if (status) {
    error.retryable =
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500;
  } else if (isPermanentRequestFingerprint(fingerprint)) {
    error.retryable = false;
  } else if (/rate[_ -]?limit|too many requests|overloaded|timeout|timed out|connection|network|temporar|unavailable|reset|eof/.test(fingerprint)) {
    error.retryable = true;
  } else {
    // zion-local-tools cannot preserve the upstream status after StreamingResponse
    // has started. Unknown in-stream proxy failures are treated as transient.
    error.retryable = true;
  }
  return error;
}

function extractProviderStreamError(line) {
  const match = String(line || "").match(/^data:\s*(.*)$/);
  if (!match) return null;
  const payload = match[1].trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return createProviderStreamError(JSON.parse(payload));
  } catch {
    return null;
  }
}

function isRetryableRequestError(error) {
  if (!error || error.name === "AbortError") return false;
  if (typeof error.retryable === "boolean") return error.retryable;
  const status = Number(error.httpStatus || error.status || 0);
  if (status) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  const fingerprint = `${error.code || ""} ${getErrorMessage(error, "")}`.toLowerCase();
  if (isPermanentRequestFingerprint(fingerprint) || fingerprint.includes("missing_reasoning_content")) {
    return false;
  }
  return true;
}

function getRetryDelay(error, retryNumber, baseDelay) {
  const retryAfterMs = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;
  const base = Math.max(0, Number(baseDelay) || 0);
  return base * Math.pow(2, Math.max(0, retryNumber - 1));
}

function notifyRequestRetry(error, retryNumber, maxRetries, delay) {
  const seconds = Math.max(0, delay) / 1000;
  const delayText = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
  const message = `请求失败，${delayText} 秒后自动重试 (${retryNumber}/${maxRetries}): ${getErrorMessage(error)}`;
  try {
    window.zion?.notification?.show?.(message, {
      type: "warning",
      duration: Math.max(3000, Math.min(8000, delay + 1500))
    });
  } catch {}
  console.warn(`[LLM] ${message}`);
}

function waitForRetryDelay(delay, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(createAbortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function fetchWithRetry(url, options, maxRetries = 3, baseDelay = 2000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) throw createAbortError();
    try {
      const response = await proxyLLMRequest({
        url,
        method: options.method || "POST",
        headers: options.headers || {},
        body: options.body,
        signal: options.signal,
        modelProfileId: options.modelProfileId
      });

      if (response.ok) {
        if (attempt > 0) {
          console.log(`[LLM] 请求在第 ${attempt} 次重试后恢复`);
        }
        return response;
      }

      const text = await response.text().catch(() => "");
      throw createHttpError(response, text);
    } catch (error) {
      if (error?.name === "AbortError" || options.signal?.aborted) {
        throw error?.name === "AbortError" ? error : createAbortError();
      }
      const retryable = isRetryableRequestError(error);
      if (!retryable || attempt >= maxRetries) {
        if (retryable && error && typeof error === "object") {
          error.retriesExhausted = true;
        }
        throw error;
      }
      const retryNumber = attempt + 1;
      const delay = getRetryDelay(error, retryNumber, baseDelay);
      notifyRequestRetry(error, retryNumber, maxRetries, delay);
      await waitForRetryDelay(delay, options.signal);
    }
  }
  throw new Error("请求失败，已达到最大重试次数");
}

function findToolDefinition(tools, name) {
  if (!Array.isArray(tools) || !name) return null;
  return tools.find((tool) => String(tool?.function?.name || tool?.name || "") === String(name)) || null;
}

function validateToolCallArgs(name, args, tools) {
  const def = findToolDefinition(tools, name);
  const params = def?.function?.parameters || def?.parameters || null;
  const required = Array.isArray(params?.required) ? params.required.map(String).filter(Boolean) : [];
  if (!required.length) return "";
  for (const key of required) {
    const value = args?.[key];
    if (value == null) return `missing required argument "${key}"`;
    if (typeof value === "string" && !value.trim()) return `missing required argument "${key}"`;
  }
  return "";
}

export function emitCompletedOpenAIToolCallBuffer(bufItem, callbacks = {}) {
  if (!bufItem?.id || !bufItem?.name) return false;
  let args;
  try {
    const raw = String(bufItem.arguments || "").trim();
    args = raw ? JSON.parse(raw) : {};
  } catch {
    return false;
  }
  const validationError = validateToolCallArgs(bufItem.name, args, callbacks.tools);
  if (validationError) {
    callbacks.onInvalidToolCall?.({ id: bufItem.id, name: bufItem.name, args, error: validationError });
    bufItem.id = "";
    bufItem.name = "";
    bufItem.arguments = "";
    return true;
  }
  try { callbacks.beforeControlEvent?.("toolCall"); } catch {}
  callbacks.onToolCall?.({ id: bufItem.id, name: bufItem.name, args });
  bufItem.id = "";
  bufItem.name = "";
  bufItem.arguments = "";
  return true;
}

export function ingestOpenAIToolCallDeltas(toolCallsBuffer, toolCalls, callbacks = {}) {
  if (!Array.isArray(toolCalls)) return 0;
  let emitted = 0;
  for (const tc of toolCalls) {
    const idx = tc.index ?? 0;
    while (toolCallsBuffer.length <= idx) toolCallsBuffer.push({ id: "", name: "", arguments: "" });
    const bufItem = toolCallsBuffer[idx];

    if (tc.id) bufItem.id = tc.id;
    const fn = tc.function || tc?.fn;
    if (fn?.name) bufItem.name = fn.name;
    if (fn?.arguments) bufItem.arguments += fn.arguments;

  }
  return emitted;
}

export function flushCompletedOpenAIToolCalls(toolCallsBuffer, callbacks = {}) {
  if (!Array.isArray(toolCallsBuffer)) return 0;
  let emitted = 0;
  for (const bufItem of toolCallsBuffer) {
    if (emitCompletedOpenAIToolCallBuffer(bufItem, callbacks)) emitted += 1;
  }
  return emitted;
}

/**
 * 统一的流式调用器，支持：
 * - tools：function calling（OpenAI 兼容）
 * - onToolCall：流式/非流式下接收工具调用并回调
 * - 多模态消息（content 数组）
 * - assistant 消息中的 tool_calls 与 role:"tool" 消息
 * - 自动重试速率限制错误
 */
export async function runStream({
  messages,
  tools = null,
  onToken,
  onEnd,
  onError,
  getController,
  onToolCall,
  onInvalidToolCall,
  beforeControlEvent,
  runId,
  sessionId,
  panelId,
  assistantBlockId,
  answerAnchorPos,
  answerHeadLine,
  requestSource,
  stepIndex,
  silentReasoning = false,
  activeModel = null,
  _deepSeekAutoContinuationAttempt = 0,
  _streamRetryAttempt = 0,
  _retryBaseDelay = 2000
}) {
  // 读取当前激活的模型（默认 DeepSeek V4 Flash）
  const active = activeModel || window.zion.state.get("chat.activeModel") || { providerId: "deepseek", modelId: "deepseek-v4-flash" };
  const availabilityStartedAt = Date.now();
  const reasoningSegmentId = stepIndex != null ? `${runId}:step:${stepIndex}` : runId;
  const controlEventBase = {
    runId,
    reasoningSegmentId,
    stepIndex,
    sessionId,
    panelId,
    assistantBlockId,
    answerAnchorPos,
    answerHeadLine,
    silentReasoning
  };
  const provider = window.zion.models.getProvider(active.providerId);
  if (!provider) {
    const error = new Error(`Provider not found: ${active.providerId}`);
    error.code = "provider_not_found";
    recordModelAvailabilityFailure(active, error);
    throw error;
  }
  let cfg;
  try {
    cfg = await provider.resolve(active.modelId);
  } catch (error) {
    recordModelAvailabilityFailure(active, error);
    throw error;
  }
  if (!cfg) {
    const error = new Error(`Model config not found: ${active.providerId}:${active.modelId}`);
    error.code = "model_not_found";
    recordModelAvailabilityFailure(active, error);
    throw error;
  }
  const thinkingEffortOverride = normalizeThinkingEffort(active?.thinkingEffort);
  if (thinkingEffortOverride !== "auto") {
    cfg = {
      ...cfg,
      thinkingEffort: thinkingEffortOverride,
      thinkingMode: "on"
    };
  }
  
  // 检查是否需要配置 API key
  const resolvedApiKey = String(cfg.key || cfg.apiKey || "").trim();
  const runtimeManagedCredential = hasRuntimeManagedCredential(cfg);
  if (cfg._requiresConfig && !resolvedApiKey && !runtimeManagedCredential) {
    const error = new Error(`模型 ${active.providerId}:${active.modelId} 需要配置 API key。${cfg._configHint || '请使用 modelsManage 工具配置 API key。'}`);
    error.code = "missing_api_key";
    recordModelAvailabilityFailure(active, error);
    throw error;
  }

  // 创建 AbortController 用于停止请求
  const controller = new AbortController();
  if (getController) getController(controller);

  let reasoningBuf = "";
  let hasResponseProgress = false;
  const maybeAutoContinueDeepSeek = async ({ content, finishReason, hasToolCalls, usage }) => {
    const continuationReason = getDeepSeekAutoContinuationReason({
      active,
      cfg,
      finishReason,
      content,
      reasoningContent: reasoningBuf,
      hasToolCalls,
      attempt: _deepSeekAutoContinuationAttempt,
      maxAttempts: cfg.autoContinueOnColonMaxAttempts
    });
    if (!continuationReason) return null;

    const nextAttempt = _deepSeekAutoContinuationAttempt + 1;
    try {
      window.zion?.events?.emit?.("chat/deepSeekAutoContinue", {
        ...controlEventBase,
        attempt: nextAttempt,
        finishReason,
        reason: continuationReason
      });
    } catch {}

    const continued = await runStream({
      messages: buildDeepSeekContinuationMessages(messages, content, continuationReason),
      tools,
      onToken,
      onEnd,
      onError,
      getController,
      onToolCall,
      onInvalidToolCall,
      beforeControlEvent,
      runId,
      sessionId,
      panelId,
      assistantBlockId,
      answerAnchorPos,
      answerHeadLine,
      requestSource,
      stepIndex,
      silentReasoning,
      activeModel: active,
      _deepSeekAutoContinuationAttempt: nextAttempt,
      _retryBaseDelay
    });

    return {
      ...continued,
      reasoning_content: joinReasoningContent(reasoningBuf, continued?.reasoning_content),
      usage: mergeProviderUsage(usage, continued?.usage),
      deepSeekAutoContinued: true
    };
  };

  try {
    if (controller.signal.aborted) {
      return { reasoning_content: reasoningBuf, aborted: true };
    }
    // 获取 provider 类型
    const providerType = cfg.providerType || "openai";

    // 构建 provider 特定的 URL
    const url = buildProviderURL(cfg, providerType);
    const apiKey = resolvedApiKey;
    if (!url) throw new Error("Invalid model config: missing url");
    if (!apiKey && providerType !== "gemini" && !runtimeManagedCredential) {
      throw new Error("Invalid model config: missing api key");
    }

    const stateMode = window.zion?.state?.get?.("chat.toolCallsReasoningContentMode");
    const mode = resolveToolCallsReasoningContentMode({ cfg, stateMode });
    const baseForceReasoning = shouldForceReasoningContentWithToolCalls({
      mode,
      modelId: active?.modelId,
      modelName: cfg?.modelName,
      providerId: active?.providerId,
      providerType,
      cfg
    });

    // 将 providerType 提升到外层，以便在流式处理中使用
    let forcedOnce = false;
    const doFetch = async () => {
      // 先构建标准消息格式
      const orderedMessages = repairToolCallMessageOrder(messages);
      const patched = patchMessagesForReasoningContentToolCalls(orderedMessages, { force: !! (baseForceReasoning || forcedOnce) });

      const formattedMessages = await Promise.all(patched.map(async (m) => {
        const useArray = !!cfg.supportsImage;

        const isEmptyContent = (c) => {
          if (c == null) return true;
          if (typeof c === "string") return String(c).trim().length === 0;
          if (Array.isArray(c)) {
            for (const it of c) {
              if (!it || typeof it !== "object") continue;
              if (it.type === "image_url" && it.image_url?.url) return false;
              if (it.type === "text" && typeof it.text === "string" && it.text.trim().length > 0) return false;
            }
            return true;
          }
          return String(c).trim().length === 0;
        };

        const toStringContent = (mm) => {
          if (Array.isArray(mm?.content)) {
            return mm.content
              .map((c) => {
                if (c && typeof c === "object") {
                  if (c.type === "text" && typeof c.text === "string") return c.text;
                  if (c.type === "image_url" && c.image_url?.url) return `[image:${c.image_url.url}]`;
                  if (typeof c.text === "string") return c.text;
                  return "";
                }
                if (typeof c === "string") return c;
                return "";
              })
              .filter(Boolean)
              .join("\n");
          }
          return typeof mm?.content === "string" ? (mm.content || "") : (mm?.content ?? "");
        };

        const toArrayContent = async (mm) => {
          if (Array.isArray(mm?.content)) {
            const out = [];
            for (const c of mm.content) {
              if (c && typeof c === "object") {
                if (c.type === "text" && typeof c.text === "string") {
                  if (c.text.trim().length > 0) out.push({ type: "text", text: c.text });
                } else if (c.type === "image_url" && c.image_url?.url) {
                  let url = c.image_url.url;
                  const managedImage = typeof url === "string"
                    && (
                      url.startsWith("app://")
                      || window.zion?.media?.isImageAssetUri?.(url)
                    );
                  if (managedImage) {
                    const dataUrl = url.startsWith("app://")
                      ? await resolveAppImage(url)
                      : await window.zion?.media?.readImageDataUrl?.(url);
                    if (dataUrl) {
                      out.push({ type: "image_url", image_url: { url: dataUrl } });
                    } else {
                      out.push({ type: "text", text: `[image:${url}]` });
                    }
                  } else {
                    out.push({ type: "image_url", image_url: { url } });
                  }
                }
              } else if (typeof c === "string") {
                if (c.trim().length > 0) out.push({ type: "text", text: c });
              }
            }
            if (out.length > 0) return out;
            const fallback = String(toStringContent(mm) || "");
            return fallback.trim().length > 0 ? [{ type: "text", text: fallback }] : [];
          }
          const s = typeof mm?.content === "string" ? (mm.content || "") : toStringContent(mm);
          return String(s || "").trim().length > 0 ? [{ type: "text", text: String(s) }] : [];
        };

        if (m && m.role === "assistant" && m.tool_calls) {
          const content = useArray ? await toArrayContent(m) : toStringContent(m);
          const msg = { role: "assistant", tool_calls: m.tool_calls };
          if (!isEmptyContent(content)) {
            msg.content = content;
          }
          if (m.reasoning_content != null) {
            msg.reasoning_content = m.reasoning_content;
          } else if (baseForceReasoning || forcedOnce) {
            msg.reasoning_content = DEFAULT_REASONING_CONTENT_PLACEHOLDER;
          }
          return msg;
        }
        if (m && m.role === "tool" && m.tool_call_id) {
          let content = useArray ? await toArrayContent(m) : toStringContent(m);
          if (isEmptyContent(content)) {
            content = useArray ? [{ type: "text", text: " " }] : " ";
          }
          return { role: "tool", tool_call_id: m.tool_call_id, content };
        }
        const content = useArray ? await toArrayContent(m) : toStringContent(m);
        const msg = isEmptyContent(content)
          ? { role: m.role, content: useArray ? [{ type: "text", text: " " }] : " " }
          : { role: m.role, content };
        if (m && m.role === "assistant" && m.reasoning_content != null) {
          msg.reasoning_content = m.reasoning_content;
        }
        return msg;
      }));

      // 根据 provider 类型构建请求体
      const body = buildProviderRequestBody(cfg, formattedMessages, tools, providerType, active.providerId);
      const headers = getProviderHeaders(cfg, providerType);
      try {
        const payloadMsgs = Array.isArray(body?.messages) ? body.messages : (Array.isArray(body?.contents) ? body.contents : []);
        const prevPayloadMsgs = Array.isArray(window.zion?.__debugLastProviderPayloadMessages?.[runId]) ? window.zion.__debugLastProviderPayloadMessages[runId] : null;
        try {
          if (!window.zion.__debugLastProviderPayloadMessages) window.zion.__debugLastProviderPayloadMessages = {};
          window.zion.__debugLastProviderPayloadMessages[runId] = Array.isArray(payloadMsgs) ? JSON.parse(JSON.stringify(payloadMsgs)) : [];
        } catch {}
        const requestPayload = {
          id: `llm_payload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          runId,
          sessionId,
          panelId,
          source: requestSource,
          stepIndex,
          providerId: active.providerId,
          modelId: active.modelId,
          modelLabel: active.label || cfg.label || cfg.modelName || active.modelId,
          providerType,
          url: redactRequestUrl(url),
          stream: cfg.stream !== false,
          retryWithReasoningContent: !!forcedOnce,
          deepSeekAutoContinuationAttempt: _deepSeekAutoContinuationAttempt,
          messageCount: formattedMessages.length,
          toolCount: tools ? (Array.isArray(tools) ? tools.length : Object.keys(tools || {}).length) : 0,
          debugSummary: summarizeDebugPayloadMessages(payloadMsgs),
          debugDiffFromPrevStep: diffDebugPayloadMessages(prevPayloadMsgs, payloadMsgs),
          payload: body
        };
        registerLlmRequestPayload(window.zion, requestPayload);
      } catch {}

      return await fetchWithRetry(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
          modelProfileId: cfg._runtimeProfileId
        },
        3,
          _retryBaseDelay
      );
    };
    let res;
    try {
      res = await doFetch();
    } catch (e) {
      if (e?.code === "missing_reasoning_content") {
        forcedOnce = true;
        res = await doFetch();
      } else {
        throw e;
      }
    }

    // 流式 SSE
    if (cfg.stream !== false && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let usage = null;
      // tool calls 按 index 聚合（OpenAI 流式会分片）
      const toolCallsBuffer = [];
      // reasoning/think 流式起止标志
      let emittedReasoningStart = false;
      let contentBuf = "";
      let finishReason = "";
      let sawToolCalls = false;
        let sawCompletionSignal = false;

      while (true) {
        if (controller.signal.aborted) {
          try { await reader.cancel(); } catch {}
          return { reasoning_content: reasoningBuf, usage, aborted: true };
        }
        const { value, done } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) {
          try { await reader.cancel(); } catch {}
          return { reasoning_content: reasoningBuf, usage, aborted: true };
        }

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (controller.signal.aborted) {
            try { await reader.cancel(); } catch {}
            return { reasoning_content: reasoningBuf, usage, aborted: true };
          }
          const s = line.trim();
          if (!s) continue;
            const providerStreamError = extractProviderStreamError(s);
            if (providerStreamError) {
              try { await reader.cancel(); } catch {}
              throw providerStreamError;
            }

          let parseResult = {};

          if (providerType === "claude") {
            // 使用 Claude 解析器
            parseResult = parseClaudeStreamLine(s, {
              toolCallsBuffer,
              emittedReasoningStart,
              reasoningBuf,
              onToken,
              onToolCall,
              runId,
              sessionId
            });
          } else if (providerType === "gemini") {
            // 使用 Gemini 解析器
            parseResult = parseGeminiStreamLine(s, {
              toolCallsBuffer,
              reasoningBuf,
              onToken,
              onToolCall
            });
          } else {
            // OpenAI 解析器（默认）
            if (!s.startsWith("data:")) continue;
            const payload = s.slice(5).trim();
            if (payload === "[DONE]") {
                sawCompletionSignal = true;
                if (sawToolCalls) hasResponseProgress = true;
              flushCompletedOpenAIToolCalls(toolCallsBuffer, { beforeControlEvent, onToolCall, onInvalidToolCall, tools });
              parseResult = { done: true };
            } else {
              try {
                const json = JSON.parse(payload);
                  if (json?.usage) usage = normalizeProviderUsage(json.usage, providerType);
                // 解析 tool_calls（delta）
                const delta = json?.choices?.[0]?.delta;
                const toolCalls = delta?.tool_calls;
                if (Array.isArray(toolCalls) && toolCalls.length > 0) sawToolCalls = true;
                ingestOpenAIToolCallDeltas(toolCallsBuffer, toolCalls);
                const nextFinishReason = json?.choices?.[0]?.finish_reason;
                  if (nextFinishReason) {
                    finishReason = String(nextFinishReason);
                    sawCompletionSignal = true;
                  }
                if (nextFinishReason === "tool_calls") {
                    hasResponseProgress = true;
                  flushCompletedOpenAIToolCalls(toolCallsBuffer, { beforeControlEvent, onToolCall, onInvalidToolCall, tools });
                }

                // 思考内容（reasoning） token
                const rTk =
                  delta?.reasoning_content ??
                  (delta?.reasoning && typeof delta.reasoning === "object" ? delta.reasoning.content : undefined) ??
                  delta?.thinking ??
                  undefined;
                if (rTk) {
                  parseResult.thinkingToken = rTk;
                }

                // 常规内容 token
                const tk =
                  delta?.content ??
                  json?.choices?.[0]?.message?.content ??
                  json?.message?.content ??
                  json?.content ??
                  "";
                if (tk) {
                  parseResult.contentToken = tk;
                }
              } catch {
                // 忽略无法解析的行
              }
            }
          }

          // 处理解析结果
          if (parseResult.usage) usage = normalizeProviderUsage(parseResult.usage, providerType);

          if (parseResult.done) {
              sawCompletionSignal = true;
            try {
              if (emittedReasoningStart) {
                try { beforeControlEvent?.("reasoningEnd"); } catch {}
                window.zion?.events?.emit("chat/reasoningEnd", controlEventBase);
              }
            } catch {}
            const continued = await maybeAutoContinueDeepSeek({
              content: contentBuf,
              finishReason,
              hasToolCalls: sawToolCalls,
              usage
            });
            if (continued) return continued;
            recordModelAvailabilitySuccess(active, {
              latencyMs: Math.max(0, Date.now() - availabilityStartedAt)
            });
            onEnd();
            return { reasoning_content: reasoningBuf, usage };
          }

          if (parseResult.thinkingStart) {
            emittedReasoningStart = true;
            try { beforeControlEvent?.("reasoningStart"); } catch {}
            try { window.zion?.events?.emit("chat/reasoningStart", controlEventBase); } catch {}
          }

          if (parseResult.thinkingToken) {
              hasResponseProgress = true;
            if (!emittedReasoningStart) {
              emittedReasoningStart = true;
              try { beforeControlEvent?.("reasoningStart"); } catch {}
              try { window.zion?.events?.emit("chat/reasoningStart", controlEventBase); } catch {}
            }
            reasoningBuf += parseResult.thinkingToken;
            try { beforeControlEvent?.("reasoningToken"); } catch {}
            try { window.zion?.events?.emit("chat/reasoningToken", { ...controlEventBase, token: parseResult.thinkingToken }); } catch {}
          }

          if (parseResult.contentToken) {
              hasResponseProgress = true;
            contentBuf += String(parseResult.contentToken);
            onToken(parseResult.contentToken);
          }

          if (parseResult.functionCall) {
              hasResponseProgress = true;
            const fc = parseResult.functionCall;
            // 生成一个唯一的 id
            const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            try { beforeControlEvent?.("toolCall"); } catch {}
            onToolCall && onToolCall({ id, name: fc.name, args: fc.args });
          }
        }
      }
      if (controller.signal.aborted) {
        return { reasoning_content: reasoningBuf, usage, aborted: true };
      }
        buf += decoder.decode();
        const trailingLine = buf.trim();
        const trailingError = extractProviderStreamError(trailingLine);
        if (trailingError) throw trailingError;
        if (trailingLine === "data: [DONE]") {
          sawCompletionSignal = true;
        } else if (trailingLine.startsWith("data:")) {
          try {
            const trailingPayload = JSON.parse(trailingLine.slice(5).trim());
            if (
              trailingPayload?.choices?.[0]?.finish_reason ||
              trailingPayload?.candidates?.[0]?.finishReason ||
              trailingPayload?.delta?.stop_reason
            ) {
              sawCompletionSignal = true;
            }
          } catch {}
        }
        if (!sawCompletionSignal) {
          const error = new Error(
            hasResponseProgress
              ? "大模型响应流意外中断，已保留已收到的内容"
              : "大模型响应流在返回任何内容前中断"
          );
          error.code = "incomplete_stream";
          error.retryable = !hasResponseProgress;
          throw error;
        }
        if (sawToolCalls) hasResponseProgress = true;
      flushCompletedOpenAIToolCalls(toolCallsBuffer, { beforeControlEvent, onToolCall, onInvalidToolCall, tools });
      try {
        if (emittedReasoningStart) {
          try { beforeControlEvent?.("reasoningEnd"); } catch {}
          window.zion?.events?.emit("chat/reasoningEnd", controlEventBase);
        }
      } catch {}
      const continued = await maybeAutoContinueDeepSeek({
        content: contentBuf,
        finishReason,
        hasToolCalls: sawToolCalls,
        usage
      });
      if (continued) return continued;
      recordModelAvailabilitySuccess(active, {
        latencyMs: Math.max(0, Date.now() - availabilityStartedAt)
      });
      onEnd();
      return { reasoning_content: reasoningBuf, usage };
    } else {
      // 非流式：一次性返回
        let j;
        try {
          j = await res.json();
        } catch (parseError) {
          const error = new Error(`大模型响应不是有效 JSON: ${getErrorMessage(parseError)}`);
          error.code = "invalid_response_json";
          error.retryable = true;
          throw error;
        }
      if (controller.signal.aborted) {
        return { reasoning_content: reasoningBuf, aborted: true };
      }
        const providerResponseError = createProviderStreamError(j);
        if (providerResponseError) throw providerResponseError;
      const usage = normalizeProviderUsage(j?.usage || j?.usageMetadata || j?.usage_metadata, providerType);

      let content = "";
      let reasoningContent = "";
        let hasToolCalls = false;

      if (providerType === "claude") {
        // Claude 响应格式: { content: [{ type: "text", text: "..." }, { type: "thinking", thinking: "..." }] }
        const blocks = j?.content || [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            content += block.text;
          }
          if (block.type === "thinking" && block.thinking) {
            reasoningContent += block.thinking;
          }
        }
        // 处理 tool_use
        const toolUses = blocks.filter(b => b.type === "tool_use");
        for (const tc of toolUses) {
          try {
            const args = typeof tc.input === "string" ? JSON.parse(tc.input) : (tc.input || {});
              hasToolCalls = true;
              hasResponseProgress = true;
            try { beforeControlEvent?.("toolCall"); } catch {}
            onToolCall && onToolCall({ id: tc.id, name: tc.name, args });
          } catch {
            // 忽略解析错误
          }
        }
      } else if (providerType === "gemini") {
        // Gemini 响应格式: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
        const candidates = j?.candidates || [];
        for (const candidate of candidates) {
          const parts = candidate?.content?.parts || [];
          for (const part of parts) {
            if (part.text) {
              if (part.thought === true) reasoningContent += part.text;
              else content += part.text;
            }
            if (part.functionCall) {
              const fc = part.functionCall;
              const args = fc.args || {};
              const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
                hasToolCalls = true;
                hasResponseProgress = true;
              try { beforeControlEvent?.("toolCall"); } catch {}
              onToolCall && onToolCall({ id, name: fc.name, args });
            }
          }
        }
      } else {
        // OpenAI 响应格式
        // 处理非流式 tool_calls
        const toolCalls = j?.choices?.[0]?.message?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            try {
              const args = typeof tc?.function?.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : (tc?.function?.arguments || {});
                hasToolCalls = true;
                hasResponseProgress = true;
              try { beforeControlEvent?.("toolCall"); } catch {}
              onToolCall && onToolCall({
                id: tc.id,
                name: tc?.function?.name,
                args
              });
            } catch {
              // 忽略解析错误
            }
          }
        }

        // 非流式思考内容（如 o3/deepseek-reasoner）
        reasoningContent =
          j?.choices?.[0]?.message?.reasoning_content ??
          (j?.choices?.[0]?.message?.reasoning && j?.choices?.[0]?.message?.reasoning?.content) ??
          j?.reasoning_content ??
          "";

        // 常规内容
        content =
          j?.choices?.[0]?.message?.content ??
          j?.message?.content ??
          j?.content ??
          j?.output ??
          "";
      }

        if (!content && !reasoningContent && !hasToolCalls) {
          const error = new Error("大模型返回了空响应");
          error.code = "empty_response";
          error.retryable = true;
          throw error;
        }

      if (reasoningContent) {
          hasResponseProgress = true;
        reasoningBuf += String(reasoningContent);
        try {
          try { beforeControlEvent?.("reasoningStart"); } catch {}
          window.zion?.events?.emit("chat/reasoningStart", controlEventBase);
          try { beforeControlEvent?.("reasoningToken"); } catch {}
          window.zion?.events?.emit("chat/reasoningToken", { ...controlEventBase, token: reasoningContent });
          try { beforeControlEvent?.("reasoningEnd"); } catch {}
          window.zion?.events?.emit("chat/reasoningEnd", controlEventBase);
        } catch {}
      }

      if (content) {
          hasResponseProgress = true;
        onToken(content);
      }
      const continued = await maybeAutoContinueDeepSeek({
        content: String(content || ""),
        finishReason: String(j?.choices?.[0]?.finish_reason || ""),
        hasToolCalls: Array.isArray(j?.choices?.[0]?.message?.tool_calls) && j.choices[0].message.tool_calls.length > 0,
        usage
      });
      if (continued) return continued;
      recordModelAvailabilitySuccess(active, {
        latencyMs: Math.max(0, Date.now() - availabilityStartedAt)
      });
      onEnd();
      return { reasoning_content: reasoningBuf, usage };
    }
  } catch (e) {
    if (e?.name === "AbortError" || controller.signal.aborted) {
      console.log("[langchain-chat] request aborted");
      return { reasoning_content: reasoningBuf, aborted: true };
    }
      const maxStreamRetries = 3;
      const shouldRetryStream =
        !hasResponseProgress &&
        !e?.retriesExhausted &&
        isRetryableRequestError(e) &&
        _streamRetryAttempt < maxStreamRetries;
      if (shouldRetryStream) {
        const retryNumber = _streamRetryAttempt + 1;
        const delay = getRetryDelay(e, retryNumber, _retryBaseDelay);
        notifyRequestRetry(e, retryNumber, maxStreamRetries, delay);
        try {
          await waitForRetryDelay(delay, controller.signal);
        } catch (waitError) {
          if (waitError?.name === "AbortError" || controller.signal.aborted) {
            return { reasoning_content: reasoningBuf, aborted: true };
          }
          throw waitError;
        }
        return runStream({
          messages,
          tools,
          onToken,
          onEnd,
          onError,
          getController,
          onToolCall,
          onInvalidToolCall,
          beforeControlEvent,
          runId,
          sessionId,
          panelId,
          assistantBlockId,
          answerAnchorPos,
          answerHeadLine,
          requestSource,
          stepIndex,
          silentReasoning,
          activeModel: active,
          _deepSeekAutoContinuationAttempt,
          _streamRetryAttempt: retryNumber,
          _retryBaseDelay
        });
      }
      recordModelAvailabilityFailure(active, e);
      onError?.(e);
      return { reasoning_content: reasoningBuf, error: e };
  }
}
