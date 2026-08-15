import { resolveAppImage } from "./img-db.js";
import {
  DEFAULT_REASONING_CONTENT_PLACEHOLDER,
  patchMessagesForReasoningContentToolCalls,
  resolveToolCallsReasoningContentMode,
  shouldForceReasoningContentWithToolCalls
} from "./reasoning-policy.js";
import { normalizeThinkingEffort, normalizeThinkingMode } from "./model-config-fields.js";
import { proxyLLMRequest } from "./llm-proxy.ts";

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
function buildProviderRequestBody(cfg, formattedMessages, tools, providerType) {
  const thinkingMode = normalizeThinkingMode(cfg.thinkingMode);
  const thinkingEffort = normalizeThinkingEffort(cfg.thinkingEffort);
  const wantsThinking = thinkingMode === "on" || thinkingEffort !== "auto";
  const effortBudget = { low: 1024, medium: 4096, high: 8192 }[thinkingEffort];
  const base = {
    model: cfg.modelName,
    messages: formattedMessages,
    stream: cfg.stream !== false,
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0
  };

  if (providerType === "claude") {
    // Claude 必需 max_tokens
    base.max_tokens = cfg.max_tokens || 4096;
    // Claude 不支持 tool_choice
    if (tools && tools.length > 0) {
      base.tools = transformToolsForProvider(tools, "claude");
    }
    if (wantsThinking) {
      base.thinking = { type: "enabled", budget_tokens: effortBudget || 4096 };
    }
    return base;
  }

  if (providerType === "gemini") {
    // Gemini 使用 contents 而不是 messages
    const contents = transformMessagesForProvider(formattedMessages, "gemini", cfg);
    const geminiBody = {
      contents,
      generationConfig: {
        temperature: base.temperature,
        maxOutputTokens: cfg.max_tokens || 8192
      }
    };
    if (thinkingMode === "off") {
      geminiBody.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    } else if (wantsThinking) {
      geminiBody.generationConfig.thinkingConfig = { thinkingBudget: effortBudget || -1 };
    }
    if (tools && tools.length > 0) {
      geminiBody.generationConfig.tools = transformToolsForProvider(tools, "gemini");
    }
    return geminiBody;
  }

  // OpenAI 格式
  base.max_tokens = cfg.max_tokens;
  if (base.stream) {
    base.stream_options = { include_usage: true };
  }
  if (wantsThinking && thinkingEffort !== "auto") {
    base.reasoning_effort = thinkingEffort;
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

  if (providerType === "claude") {
    // Claude 需要 anthropic-version 头部
    headers["x-api-key"] = cfg.key;
    headers["anthropic-version"] = cfg.anthropicVersion || "2023-06-01";
    return headers;
  }

  if (providerType === "gemini") {
    // Gemini 使用 URL 中的 key 参数
    return headers;
  }

  // OpenAI 格式
  headers["Authorization"] = `Bearer ${cfg.key}`;
  return headers;
}

/**
 * 构建特定 provider 的请求 URL
 */
function buildProviderURL(cfg, providerType) {
  if (providerType === "gemini") {
    // Gemini: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
    const base = cfg.url || "https://generativelanguage.googleapis.com/v1beta/models";
    const model = cfg.modelName;
    const key = cfg.key ? `?key=${cfg.key}` : "";
    return `${base}/${model}:generateContent${key}`;
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

function buildProviderError(json, providerType = "") {
  try {
    if (!json || typeof json !== "object") return "";
    const nestedMessage = typeof json?.error?.message === "string" ? json.error.message.trim() : "";
    const nestedType = typeof json?.error?.type === "string" ? json.error.type.trim() : "";
    const directMessage = typeof json?.message === "string" ? json.message.trim() : "";
    const directError = typeof json?.error === "string" ? json.error.trim() : "";
    if (nestedMessage) return nestedType ? `${nestedType}: ${nestedMessage}` : nestedMessage;
    if (directError) return directError;
    if (directMessage && (json.type === "error" || json.status === "error" || json.error_code || json.code)) {
      return directMessage;
    }
    if (providerType === "gemini") {
      const blockReason = String(json?.promptFeedback?.blockReason || "").trim();
      const blockReasonMessage = String(json?.promptFeedback?.blockReasonMessage || "").trim();
      if (blockReason || blockReasonMessage) {
        return `Gemini blocked: ${blockReasonMessage || blockReason}`;
      }
    }
    return "";
  } catch {
    return "";
  }
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
    const providerError = buildProviderError(json, "claude");
    if (eventType === "error" || json.type === "error" || providerError) {
      result.error = providerError || "Claude stream error";
      return result;
    }

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
    const providerError = buildProviderError(json, "gemini");
    if (providerError) {
      result.error = providerError;
      return result;
    }

    // Gemini 流式响应结构
    // candidates[0].content.parts[]
    const candidates = json?.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        // 文本内容
        if (part.text) {
          result.contentToken = part.text;
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

      // 思考内容 (如果模型支持)
      if (candidate?.groundingMetadata?.thought) {
        result.thinkingToken = candidate.groundingMetadata.thought;
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
 * 判断是否为速率限制错误
 */
function isRateLimitError(status, text) {
  if (status !== 429) return false;
  const lowerText = String(text).toLowerCase();
  const keywords = [
    'rate limit',
    'too many requests',
    '频率过高',
    '并发',
    '余额',
    'concurrent',
    'frequency',
    'quota',
    'rpm limit',
    '流量限制',
    '调用次数',
    '使用上限',
    'quota exceeded',
    '请降低'
  ];
  return keywords.some(keyword => lowerText.includes(keyword));
}

/**
 * 带自动重试的 fetch（针对速率限制）
 * @param {string} url - 请求 URL
 * @param {RequestInit} options - fetch 选项
 * @param {number} maxRetries - 最大重试次数
 * @param {number} baseDelay - 基础延迟（毫秒）
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, maxRetries = 3, baseDelay = 2000) {
  let lastError;
  let retryCount = 0;

  for (let i = 0; i < maxRetries; i++) {
    try {
      // 使用 LLM 代理（智能降级）
      const response = await proxyLLMRequest({
        url,
        method: options.method || "POST",
        headers: options.headers || {},
        body: options.body,
        signal: options.signal
      });

      // 如果响应成功，直接返回
      if (response.ok) {
        if (retryCount > 0) {
          console.log(`[RateLimit] 重试成功，第 ${retryCount} 次重试后恢复正常`);
        }
        return response;
      }

      // 检查是否为速率限制错误
      const text = await response.text().catch(() => "");
      if (response.status === 429 && isRateLimitError(429, text)) {
        retryCount++;
        // 指数退避：2s, 4s, 8s
        const delay = baseDelay * Math.pow(2, i);

        // 显示警告通知
        try {
          window.zion.notification.show(
            `⚠️ 请求速率过高，正在等待 ${delay/1000} 秒后重试 (${retryCount}/${maxRetries})...`,
            {
              type: 'warning',
              duration: 3000
            }
          );
        } catch {}

        console.warn(`[RateLimit] 检测到速率限制，第 ${retryCount} 次重试，等待 ${delay}ms...`);
        console.warn(`[RateLimit] 错误信息: ${text.slice(0, 200)}`);

        // 等待后继续重试
        await new Promise(resolve => setTimeout(resolve, delay));
        lastError = new Error(`请求速率过高: ${text.slice(0, 100)}`);
        continue;
      }

      // 非 429 错误，直接抛出
      if (response.status === 400) {
        const lowerText = String(text).toLowerCase();
        if (lowerText.includes("reasoning_content") && (lowerText.includes("missing") || lowerText.includes("passed back") || lowerText.includes("pass back"))) {
          const err = new Error(`HTTP ${response.status}: ${text.slice(0, 256)}`);
          err.code = "missing_reasoning_content";
          err.httpStatus = 400;
          err.responseText = text;
          throw err;
        }
      }
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 256)}`);

    } catch (error) {
      // 如果是最后一次循环，抛出错误
      if (i === maxRetries - 1) {
        // 显示错误通知
        try {
          window.zion.notification.show(
            `❌ 请求失败（已重试 ${maxRetries} 次）: ${error.message}`,
            {
              type: 'error',
              duration: 6000
            }
          );
        } catch {}
        throw error;
      }

      // 记录错误并继续
      lastError = error;
      console.error(`[RateLimit] 请求失败，准备重试:`, error.message);
    }
  }

  // 理论上不会执行到这里
  throw lastError || new Error('请求失败，已达到最大重试次数');
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
  beforeControlEvent,
  runId,
  sessionId,
  panelId,
  answerAnchorPos,
  answerHeadLine,
  requestSource,
  stepIndex,
  silentReasoning = false,
  activeModel = null
}) {
  // 读取当前激活的模型（默认 deepseek:deepseek-chat）
  const active = activeModel || window.zion.state.get("chat.activeModel") || { providerId: "deepseek", modelId: "deepseek-chat" };
  const reasoningSegmentId = stepIndex != null ? `${runId}:step:${stepIndex}` : runId;
  const controlEventBase = { runId, reasoningSegmentId, stepIndex, sessionId, panelId, answerAnchorPos, answerHeadLine, silentReasoning };
  const provider = window.zion.models.getProvider(active.providerId);
  if (!provider) throw new Error(`Provider not found: ${active.providerId}`);
  let cfg = await provider.resolve(active.modelId);
  if (!cfg) throw new Error(`Model config not found: ${active.providerId}:${active.modelId}`);
  const thinkingEffortOverride = normalizeThinkingEffort(active?.thinkingEffort);
  if (thinkingEffortOverride !== "auto") {
    cfg = {
      ...cfg,
      thinkingEffort: thinkingEffortOverride,
      thinkingMode: "on"
    };
  }
  
  // 检查是否需要配置 API key
  if (cfg._requiresConfig && (!cfg.key || !cfg.key.trim())) {
    throw new Error(`模型 ${active.providerId}:${active.modelId} 需要配置 API key。${cfg._configHint || '请使用 modelsManage 工具配置 API key。'}`);
  }

  // 创建 AbortController 用于停止请求
  const controller = new AbortController();
  if (getController) getController(controller);

  let reasoningBuf = "";
  try {
    // 获取 provider 类型
    const providerType = cfg.providerType || "openai";

    // 构建 provider 特定的 URL
    const url = buildProviderURL(cfg, providerType);
    const apiKey = cfg.key || cfg.apiKey;
    if (!url) throw new Error("Invalid model config: missing url");
    if (!apiKey && providerType !== "gemini") throw new Error("Invalid model config: missing api key");

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
      const patched = patchMessagesForReasoningContentToolCalls(messages, { force: !! (baseForceReasoning || forcedOnce) });

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
                  if (typeof url === "string" && url.startsWith("app://")) {
                    const dataUrl = await resolveAppImage(url);
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
      const body = buildProviderRequestBody(cfg, formattedMessages, tools, providerType);
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
          messageCount: formattedMessages.length,
          toolCount: tools ? (Array.isArray(tools) ? tools.length : Object.keys(tools || {}).length) : 0,
          debugSummary: summarizeDebugPayloadMessages(payloadMsgs),
          debugDiffFromPrevStep: diffDebugPayloadMessages(prevPayloadMsgs, payloadMsgs),
          payload: body
        };
        window.zion?.events?.emit?.("llm/requestPayload", requestPayload);
        if (typeof window.zion?.llmPayloads?.add === "function") {
          window.zion.llmPayloads.add(requestPayload);
        } else {
          const queue = window.zion.__llmPayloadQueue || (window.zion.__llmPayloadQueue = []);
          queue.push(requestPayload);
          while (queue.length > 80) queue.shift();
        }
      } catch {}

      return await fetchWithRetry(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        },
        3,
        2000
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

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;

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
                parseResult = { done: true };
              } else {
                try {
                  const json = JSON.parse(payload);
                  const providerError = buildProviderError(json, providerType);
                  if (providerError) {
                    parseResult.error = providerError;
                  }
                  if (json?.usage) usage = normalizeProviderUsage(json.usage, providerType);
                  // 解析 tool_calls（delta）
                  const delta = json?.choices?.[0]?.delta;
                  const toolCalls = delta?.tool_calls;
                  if (toolCalls && Array.isArray(toolCalls)) {
                    for (const tc of toolCalls) {
                      const idx = tc.index ?? 0;
                      while (toolCallsBuffer.length <= idx) toolCallsBuffer.push({ id: "", name: "", arguments: "" });
                      const bufItem = toolCallsBuffer[idx];

                      if (tc.id) bufItem.id = tc.id;
                      const fn = tc.function || tc?.fn;
                      if (fn?.name) bufItem.name = fn.name;
                      if (fn?.arguments) bufItem.arguments += fn.arguments;

                      // 尝试完整解析
                      if (bufItem.id && bufItem.name && bufItem.arguments) {
                        try {
                          const args = JSON.parse(bufItem.arguments);
                          try { beforeControlEvent?.("toolCall"); } catch {}
                          onToolCall && onToolCall({ id: bufItem.id, name: bufItem.name, args });
                          // 清空该 buffer 位置，避免重复触发
                          toolCallsBuffer[idx] = { id: "", name: "", arguments: "" };
                        } catch {
                          // 等待更多参数片段
                        }
                      }
                    }
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
            try {
              if (emittedReasoningStart) {
                try { beforeControlEvent?.("reasoningEnd"); } catch {}
                window.zion?.events?.emit("chat/reasoningEnd", controlEventBase);
              }
            } catch {}
            onEnd();
            return { reasoning_content: reasoningBuf, usage };
          }

            if (parseResult.error) {
              throw new Error(parseResult.error);
            }

          if (parseResult.thinkingStart) {
            emittedReasoningStart = true;
            try { beforeControlEvent?.("reasoningStart"); } catch {}
            try { window.zion?.events?.emit("chat/reasoningStart", controlEventBase); } catch {}
          }

          if (parseResult.thinkingToken) {
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
            onToken(parseResult.contentToken);
          }

          if (parseResult.functionCall) {
            const fc = parseResult.functionCall;
            // 生成一个唯一的 id
            const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            try { beforeControlEvent?.("toolCall"); } catch {}
            onToolCall && onToolCall({ id, name: fc.name, args: fc.args });
          }
        }
      }
      try {
        if (emittedReasoningStart) {
          try { beforeControlEvent?.("reasoningEnd"); } catch {}
          window.zion?.events?.emit("chat/reasoningEnd", controlEventBase);
        }
      } catch {}
      onEnd();
      return { reasoning_content: reasoningBuf, usage };
      } else {
        // 非流式：一次性返回
        const j = await res.json().catch(() => ({}));
        const providerError = buildProviderError(j, providerType);
        if (providerError) throw new Error(providerError);
        const usage = normalizeProviderUsage(j?.usage || j?.usageMetadata || j?.usage_metadata, providerType);

      let content = "";
      let reasoningContent = "";

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
              content += part.text;
            }
            if (part.functionCall) {
              const fc = part.functionCall;
              const args = fc.args || {};
              const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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

      if (reasoningContent) {
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
        onToken(content);
      }
      onEnd();
      return { reasoning_content: reasoningBuf, usage };
    }
  } catch (e) {
    if (e.name === "AbortError") {
      console.log("[langchain-chat] request aborted");
      return { reasoning_content: reasoningBuf };
    }
    onError(e);
    return { reasoning_content: reasoningBuf };
  }
}
