/**
 * Zion LangChain Chat Plugin - Chat Service
 * Handles streaming chat interactions with LLM models
 */

import { resolveAppImage } from '../utils/img-db';

export interface ChatServiceOptions {
  messages: any[];
  tools?: any[];
  onToken?: (token: string) => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
  getController?: (controller: AbortController) => void;
  onToolCall?: (toolCall: any) => void;
  runId?: string;
  sessionId?: string;
}

/**
 * Unified streaming chat handler supporting:
 * - Tool calling (OpenAI compatible)
 * - Multi-modal messages (content arrays)
 * - Assistant messages with tool_calls and tool role messages
 */
export async function runStream(options: ChatServiceOptions) {
  const {
    messages,
    tools = null,
    onToken,
    onEnd,
    onError,
    getController,
    onToolCall,
    runId,
    sessionId
  } = options;

  // Read active model configuration
  const active = (window as any).zion.state.get("chat.activeModel") || {
    providerId: "deepseek",
    modelId: "deepseek-chat"
  };
  const provider = (window as any).zion.models.getProvider(active.providerId);
  if (!provider) throw new Error(`Provider not found: ${active.providerId}`);

  const cfg = await provider.resolve(active.modelId);
  if (!cfg) throw new Error(`Model config not found: ${active.providerId}:${active.modelId}`);

  // Check if API key is required
  if (cfg._requiresConfig && (!cfg.key || !cfg.key.trim())) {
    throw new Error(
      `模型 ${active.providerId}:${active.modelId} 需要配置 API key。${
        cfg._configHint || '请使用 modelsManage 工具配置 API key。'
      }`
    );
  }

  // Create AbortController for request cancellation
  const controller = new AbortController();
  if (getController) getController(controller);

  try {
    // Determine if we have tool context in messages
    const hasToolContext =
      Array.isArray(messages) &&
      messages.some((m: any) => (m && m.role === "assistant" && m.tool_calls) || (m && m.role === "tool"));

    // Path A: LangChain + OpenAI compatible (baseURL + apiKey + modelName)
    if (
      !hasToolContext &&
      cfg.baseURL &&
      (cfg.apiKey || cfg.key) &&
      (cfg.modelName || active.modelId)
    ) {
      // Import LangChain dynamically (may not be available in all environments)
      try {
        const { ChatOpenAI } = await import("@langchain/openai");

        const chat = new ChatOpenAI({
          openAIApiKey: cfg.apiKey || cfg.key,
          configuration: {
            baseURL: cfg.baseURL,
            fetch: (url: any, options: any) =>
              fetch(url, { ...options, signal: controller.signal })
          },
          modelName: cfg.modelName || active.modelId,
          streaming: true,
          temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0
        });

        // LangChain input format: [role, content]
        const langchainMessages = messages.map((msg: any) => [
          msg.role,
          msg.content ?? ""
        ]);

        // Bind tools if provided
        const chatWithTools = tools ? chat.bindTools(tools) : chat;
        const stream = await chatWithTools.stream(langchainMessages);

        for await (const chunk of stream) {
          if (controller.signal.aborted) break;

          // Handle tool calls (LangChain's AIMessageChunk)
          const tc = chunk?.tool_call_chunks;
          if (tc && Array.isArray(tc)) {
            for (const t of tc) {
              try {
                const args =
                  typeof t.args === "string" ? JSON.parse(t.args) : t.args;
                onToolCall && onToolCall({ id: t.id, name: t.name, args });
              } catch {
                // Wait for more parameter fragments
              }
            }
          }

          const token = chunk?.content ?? "";
          if (token) onToken && onToken(token);
        }

        onEnd && onEnd();
        return;
      } catch (langchainError) {
        console.warn("[chat-service] LangChain path failed, falling back to fetch:", langchainError);
        // Fall through to Path B
      }
    }

    // Path B: Generic OpenAI compatible interface (direct fetch)
    const url = cfg.url;
    const apiKey = cfg.key || cfg.apiKey;
    if (!url || !apiKey) throw new Error("Invalid model config: missing url or key");

    // Convert content to string if needed (for services that don't support arrays)
    const toStringContent = (m: any) => {
      if (Array.isArray(m?.content)) {
        return m.content
          .map((c: any) => {
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

    // Format messages: keep array for image support, otherwise convert to string
    const formattedMessages = await Promise.all(
      messages.map(async (m: any) => {
        const useArray = !!cfg.supportsImage;

        const toArrayContent = async (mm: any) => {
          if (Array.isArray(mm?.content)) {
            const out: any[] = [];
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
                      // Fallback to placeholder if resolution fails
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
            return out.length > 0 ? out : [{ type: "text", text: toStringContent(mm) }];
          }
          const s =
            typeof mm?.content === "string" ? (mm.content || "") : toStringContent(mm);
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
      })
    );

    const body: any = {
      model: cfg.modelName || active.modelId,
      messages: formattedMessages,
      stream: cfg.stream !== false,
      temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0,
      max_tokens: cfg.max_tokens
    };

    // Add tools if provided
    if (tools && Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 256)}`);
    }

    // Handle streaming SSE
    if (cfg.stream !== false && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const toolCallsBuffer: any[] = [];
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
                (window as any).zion?.events?.emit("chat/reasoningEnd", { runId, sessionId });
              }
            } catch {}
            onEnd && onEnd();
            return;
          }

          try {
            const json = JSON.parse(payload);

            // Parse tool_calls (delta)
            const delta = json?.choices?.[0]?.delta;
            const toolCalls = delta?.tool_calls;
            if (toolCalls && Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                const idx = tc.index ?? 0;
                while (toolCallsBuffer.length <= idx) {
                  toolCallsBuffer.push({ id: "", name: "", arguments: "" });
                }
                const bufItem = toolCallsBuffer[idx];

                if (tc.id) bufItem.id = tc.id;
                const fn = tc.function || tc?.fn;
                if (fn?.name) bufItem.name = fn.name;
                if (fn?.arguments) bufItem.arguments += fn.arguments;

                // Try to parse complete arguments
                if (bufItem.id && bufItem.name && bufItem.arguments) {
                  try {
                    const args = JSON.parse(bufItem.arguments);
                    onToolCall && onToolCall({ id: bufItem.id, name: bufItem.name, args });
                    // Clear buffer to avoid duplicate triggers
                    toolCallsBuffer[idx] = { id: "", name: "", arguments: "" };
                  } catch {
                    // Wait for more argument fragments
                  }
                }
              }
            }

            // Reasoning/thinking tokens
            const rTk =
              delta?.reasoning_content ??
              (delta?.reasoning && typeof delta.reasoning === "object"
                ? delta.reasoning.content
                : undefined) ??
              delta?.thinking ??
              undefined;
            if (rTk) {
              if (!emittedReasoningStart) {
                emittedReasoningStart = true;
                try {
                  (window as any).zion?.events?.emit("chat/reasoningStart", { runId, sessionId });
                } catch {}
              }
              try {
                (window as any).zion?.events?.emit("chat/reasoningToken", { runId, token: rTk, sessionId });
              } catch {}
            }

            // Regular content tokens
            const tk =
              delta?.content ??
              json?.choices?.[0]?.message?.content ??
              json?.message?.content ??
              json?.content ??
              "";
            if (tk) onToken && onToken(tk);
          } catch {
            // Ignore unparseable lines
          }
        }
      }

      try {
        if (emittedReasoningStart) {
          (window as any).zion?.events?.emit("chat/reasoningEnd", { runId, sessionId });
        }
      } catch {}
      onEnd && onEnd();
    } else {
      // Non-streaming: return all at once
      const j = await res.json().catch(() => ({}));

      // Handle non-streaming tool_calls
      const toolCalls = j?.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          try {
            const args =
              typeof tc?.function?.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc?.function?.arguments || {};
            onToolCall && onToolCall({
              id: tc.id,
              name: tc?.function?.name,
              args
            });
          } catch {
            // Ignore parse errors
          }
        }
      }

      // Non-streaming reasoning content (e.g., o3/deepseek-reasoner)
      const rFull =
        j?.choices?.[0]?.message?.reasoning_content ??
        (j?.choices?.[0]?.message?.reasoning && j?.choices?.[0]?.message?.reasoning?.content) ??
        j?.reasoning_content ??
        "";
      if (rFull) {
        try {
          (window as any).zion?.events?.emit("chat/reasoningStart", { runId, sessionId });
          (window as any).zion?.events?.emit("chat/reasoningToken", { runId, token: rFull, sessionId });
          (window as any).zion?.events?.emit("chat/reasoningEnd", { runId, sessionId });
        } catch {}
      }

      // Regular content
      const content =
        j?.choices?.[0]?.message?.content ??
        j?.message?.content ??
        j?.content ??
        j?.output ??
        "";
      if (content) onToken && onToken(content);
      onEnd && onEnd();
    }
  } catch (e: any) {
    if (e.name === "AbortError") {
      console.log("[chat-service] request aborted");
      return;
    }
    onError && onError(e);
  }
}
