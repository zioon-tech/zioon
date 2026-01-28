import { resolveAppImage } from "./img-db.js";

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
      const response = await fetch(url, options);

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
  runId,
  sessionId
}) {
  // 读取当前激活的模型（默认 deepseek:deepseek-chat）
  const active = window.zion.state.get("chat.activeModel") || { providerId: "deepseek", modelId: "deepseek-chat" };
  const provider = window.zion.models.getProvider(active.providerId);
  if (!provider) throw new Error(`Provider not found: ${active.providerId}`);
  const cfg = await provider.resolve(active.modelId);
  if (!cfg) throw new Error(`Model config not found: ${active.providerId}:${active.modelId}`);
  
  // 检查是否需要配置 API key
  if (cfg._requiresConfig && (!cfg.key || !cfg.key.trim())) {
    throw new Error(`模型 ${active.providerId}:${active.modelId} 需要配置 API key。${cfg._configHint || '请使用 modelsManage 工具配置 API key。'}`);
  }

  // 创建 AbortController 用于停止请求
  const controller = new AbortController();
  if (getController) getController(controller);

  try {
    const url = (() => {
      if (cfg.url) return cfg.url;
      if (!cfg.baseURL) return null;
      const base = String(cfg.baseURL);
      if (/\/chat\/completions\/?$/.test(base)) return base.replace(/\/+$/, "");
      try {
        const normalized = base.endsWith("/") ? base : `${base}/`;
        return new URL("chat/completions", normalized).toString();
      } catch {
        return null;
      }
    })();
    const apiKey = cfg.key || cfg.apiKey;
    if (!url || !apiKey) throw new Error("Invalid model config: missing url or key");

    // 构建消息体：统一为字符串内容，避免服务端要求 string 时出现 "sequence" 错误
    const toStringContent = (m) => {
      if (Array.isArray(m?.content)) {
        // 扁平化数组：保留文本，图片以占位符表示（避免非法类型）
        return m.content
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
      return typeof m?.content === "string" ? (m.content || "") : (m?.content ?? "");
    };

    // 当模型支持图片输入时，保留 content 为数组（OpenAI 兼容）；
    // 否则统一转为字符串以避免后端不支持 "content: array" 的错误。
    const formattedMessages = await Promise.all(messages.map(async (m) => {
      const useArray = !!cfg.supportsImage;

      const toArrayContent = async (mm) => {
        if (Array.isArray(mm?.content)) {
          const out = [];
          for (const c of mm.content) {
            if (c && typeof c === "object") {
              if (c.type === "text" && typeof c.text === "string") {
                out.push({ type: "text", text: c.text });
              } else if (c.type === "image_url" && c.image_url?.url) {
                let url = c.image_url.url;
                if (typeof url === "string" && url.startsWith("app://")) {
                  const dataUrl = await resolveAppImage(url);
                  if (dataUrl) {
                    out.push({ type: "image_url", image_url: { url: dataUrl } });
                  } else {
                    // 未能解析则降级为占位文本，避免服务端报错
                    out.push({ type: "text", text: `[image:${url}]` });
                  }
                } else {
                  out.push({ type: "image_url", image_url: { url } });
                }
              }
            } else if (typeof c === "string") {
              out.push({ type: "text", text: c });
            }
          }
          // 如果数组为空，回退为字符串
          return out.length > 0 ? out : [{ type: "text", text: toStringContent(mm) }];
        }
        // 原始为字符串/非数组，包装为 text
        const s = typeof mm?.content === "string" ? (mm.content || "") : toStringContent(mm);
        return [{ type: "text", text: s }];
      };

      if (m && m.role === "assistant" && m.tool_calls) {
        const content = useArray ? await toArrayContent(m) : toStringContent(m);
        const msg = { role: "assistant", tool_calls: m.tool_calls, content };
        // Support reasoning models: preserve reasoning_content if present
        if (m.reasoning_content != null) {
          msg.reasoning_content = m.reasoning_content;
        }
        return msg;
      }
      if (m && m.role === "tool" && m.tool_call_id) {
        const content = useArray ? await toArrayContent(m) : toStringContent(m);
        return { role: "tool", tool_call_id: m.tool_call_id, content };
      }
      const content = useArray ? await toArrayContent(m) : toStringContent(m);
      return { role: m.role, content };
    }));

    const body = {
      model: cfg.modelName || active.modelId,
      messages: formattedMessages,
      stream: cfg.stream !== false,
      temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0,
      max_tokens: cfg.max_tokens
    };

    // 添加 tools
    if (tools && Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    // 使用带自动重试的 fetch（针对速率限制错误）
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      },
      3,  // 最大重试 3 次
      2000  // 基础延迟 2 秒
    );

    // 流式 SSE
    if (cfg.stream !== false && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
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
          if (!s.startsWith("data:")) continue;

          const payload = s.slice(5).trim();
          if (payload === "[DONE]") {
            try {
              if (emittedReasoningStart) {
                window.zion?.events?.emit("chat/reasoningEnd", { runId, sessionId });
              }
            } catch {}
            onEnd();
            return;
          }

          try {
            const json = JSON.parse(payload);

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
              if (!emittedReasoningStart) {
                emittedReasoningStart = true;
                try { window.zion?.events?.emit("chat/reasoningStart", { runId, sessionId }); } catch {}
              }
              try { window.zion?.events?.emit("chat/reasoningToken", { runId, token: rTk, sessionId }); } catch {}
            }

            // 常规内容 token
            const tk =
              delta?.content ??
              json?.choices?.[0]?.message?.content ??
              json?.message?.content ??
              json?.content ??
              "";
            if (tk) onToken(tk);
          } catch {
            // 忽略无法解析的行
          }
        }
      }
      try {
        if (emittedReasoningStart) {
          window.zion?.events?.emit("chat/reasoningEnd", { runId, sessionId });
        }
      } catch {}
      onEnd();
    } else {
      // 非流式：一次性返回
      const j = await res.json().catch(() => ({}));

      // 处理非流式 tool_calls
      const toolCalls = j?.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          try {
            const args = typeof tc?.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : (tc?.function?.arguments || {});
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
      const rFull =
        j?.choices?.[0]?.message?.reasoning_content ??
        (j?.choices?.[0]?.message?.reasoning && j?.choices?.[0]?.message?.reasoning?.content) ??
        j?.reasoning_content ??
        "";
      if (rFull) {
        try {
          window.zion?.events?.emit("chat/reasoningStart", { runId, sessionId });
          window.zion?.events?.emit("chat/reasoningToken", { runId, token: rFull, sessionId });
          window.zion?.events?.emit("chat/reasoningEnd", { runId, sessionId });
        } catch {}
      }

      // 常规内容
      const content =
        j?.choices?.[0]?.message?.content ??
        j?.message?.content ??
        j?.content ??
        j?.output ??
        "";
      if (content) onToken(content);
      onEnd();
    }
  } catch (e) {
    if (e.name === "AbortError") {
      console.log("[langchain-chat] request aborted");
      return;
    }
    onError(e);
  }
}
