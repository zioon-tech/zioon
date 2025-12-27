import { resolveAppImage } from "./img-db.js";

/**
 * 统一的流式调用器，支持：
 * - tools：function calling（OpenAI 兼容）
 * - onToolCall：流式/非流式下接收工具调用并回调
 * - 多模态消息（content 数组）
 * - assistant 消息中的 tool_calls 与 role:"tool" 消息
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
        return { role: "assistant", tool_calls: m.tool_calls, content };
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

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 256)}`);
    }

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
