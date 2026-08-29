/**
 * dev.langchain-chat: models tools for LLM (CRUD + set active)
 * - Registers a single aggregated tool "modelsManage" to list/check/get/add/update/delete/set_active/import/export models.
 * - Writable provider: user.dynamic (stored in localStorage), other providers are read-only.
 */
import {
  normalizeAutoContinueOnColonMaxAttempts,
  normalizeModelDescription
} from "./model-config-fields.js";
import { refreshModelCatalog } from "./model-catalog.js";
import { invalidateModelAvailability } from "./model-health.js";
import { userModelsProvider } from "./user-models-provider.js";

export function registerModelsTools() {
  try {
    /* ===== Local storage + dynamic provider ===== */
    const DYN_KEY = "zion.models.dynamic";
    const DYN_PROVIDER_ID = "user.dynamic";

    const loadStore = () => {
      try {
        const raw = localStorage.getItem(DYN_KEY);
        if (!raw) return {};
        const j = JSON.parse(raw);
        return j && typeof j === "object" ? j : {};
      } catch {
        return {};
      }
    };
    const saveStore = (dict) => {
      try { localStorage.setItem(DYN_KEY, JSON.stringify(dict)); } catch {}
    };

    const ensureProvider = () => {
      try {
        const ids = window.zion?.models?.listProviders?.() || [];
        if (ids.includes(DYN_PROVIDER_ID)) return;
        window.zion?.models?.registerProvider?.(userModelsProvider);
      } catch (e) {
        console.warn("[models-tools] ensureProvider error", e);
      }
    };

    const modelExists = async (providerId, modelId) => {
      try {
        const prov = window.zion?.models?.getProvider?.(providerId);
        if (!prov?.resolve) return false;
        const cfg = await prov.resolve(modelId);
        return !!cfg;
      } catch { return false; }
    };

    const validateLimitArgs = (args) => {
      const fields = [
        ["context_window_tokens", args?.context_window_tokens],
        ["max_input_tokens", args?.max_input_tokens],
        ["max_output_tokens", args?.max_output_tokens],
        ["max_tokens", args?.max_tokens]
      ];
      for (const [name, value] of fields) {
        if (value == null) continue;
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) return `${name} must be a positive number`;
      }
      if (
        args?.context_window_tokens != null
        && args?.max_input_tokens != null
        && Number(args.max_input_tokens) > Number(args.context_window_tokens)
      ) {
        return "max_input_tokens cannot exceed context_window_tokens";
      }
      if (
        args?.context_window_tokens != null
        && args?.max_output_tokens != null
        && Number(args.max_output_tokens) > Number(args.context_window_tokens)
      ) {
        return "max_output_tokens cannot exceed context_window_tokens";
      }
      if (
        args?.max_output_tokens != null
        && args?.max_tokens != null
        && Number(args.max_tokens) > Number(args.max_output_tokens)
      ) {
        return "max_tokens cannot exceed max_output_tokens";
      }
      return "";
    };

    ensureProvider();

    /* ===== Tool schema ===== */
    const tools = [
      {
        type: "function",
        function: {
          name: "modelsManage",
          description: "模型目录与健康管理（list/check/get/add/update/delete/set_active/import/export）。list 会返回实时可用性；仅支持新增/修改/删除 user.dynamic 提供者下的模型。",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list","check","get","add","update","delete","set_active","import","export"], description: "操作类型" },
              provider_id: { type: "string", description: "提供者ID（add/update/delete/export 默认 user.dynamic；list 时用于筛选；不传则显示全部）" },
              model_id: { type: "string", description: "模型ID（get/update/delete/set_active 必填）" },
              availability: {
                type: "string",
                enum: ["available", "degraded", "unavailable", "misconfigured", "unknown"],
                description: "list/check 时按当前可用性筛选"
              },
              refresh_health: { type: "boolean", description: "list 时是否刷新已过期健康状态，默认 true" },
              force: { type: "boolean", description: "check 时忽略缓存强制检查；set_active 时允许显式选择不可用模型" },
              label: { type: "string", description: "模型标签（可选）" },
              description: { type: "string", maxLength: 500, description: "模型描述（可选）" },
              url: { type: "string", description: "OpenAI 兼容 URL" },
              key: { type: "string", description: "API key" },
              stream: { type: "boolean", description: "是否流式" },
              temperature: { type: "number", description: "采样温度" },
              context_window_tokens: { type: "number", description: "模型上下文窗口 tokens" },
              max_input_tokens: { type: "number", description: "模型最大输入 tokens" },
              max_output_tokens: { type: "number", description: "模型能力允许的最大输出 tokens" },
              max_tokens: { type: "number", description: "Zion 单次请求默认输出 tokens" },
              supportsImage: { type: "boolean", description: "是否支持图片输入" },
              supportsThinking: { type: "boolean", description: "模型是否支持思考" },
              supportsThinkingEffort: { type: "boolean", description: "模型是否支持思考强度控制" },
              thinkingMode: { type: "string", enum: ["auto", "off", "on"], description: "思考模式" },
              thinkingEffort: {
                type: "string",
                enum: ["auto", "minimal", "low", "medium", "high", "xhigh", "max"],
                description: "思考强度；实际可用档位取决于模型"
              },
              preservedThinking: { type: "boolean", description: "是否支持回传/保留思考（将思考作为 reasoning_content 输入给模型）" },
              interleavedThinking: { type: "boolean", description: "是否支持交错思考（thinking 与 tool_calls 交错输出/处理）" },
              autoContinueOnColonMaxAttempts: {
                type: "integer",
                minimum: 0,
                maximum: 20,
                description: "DeepSeek 异常 stop（冒号中断或只有推理、没有正式输出）时的最大自动续写次数；0 表示关闭，默认 3"
              },
              model: { type: "string", description: "后端自定义 model 字段（如 siliconflow）" },
              provider_type: { type: "string", enum: ["openai", "claude", "gemini"], description: "模型提供者类型 (openai/claude/gemini)" },
              anthropicVersion: { type: "string", description: "Claude API 版本 (默认 2023-06-01)" },
              data: { type: "object", description: "导入的模型字典（或 JSON 字符串），仅用于 import" },
              merge: { type: "boolean", description: "导入时是否合并（默认 true）" }
            },
            required: ["action"],
            additionalProperties: true
          }
        }
      }
    ];

    // Merge tools into chat.tools
    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    for (const t of tools) {
      const nm = t?.function?.name;
      if (nm && !existNames.has(nm)) merged.push(t);
    }
    window.zion?.state?.set("chat.tools", merged);

    /* ===== Handlers ===== */
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };

    handlers.modelsManage = async (args) => {
      try {
        const action = String(args?.action || "").trim();
        const providerIdRaw = typeof args?.provider_id === "string" ? String(args.provider_id).trim() : undefined;
        const providerId = providerIdRaw && providerIdRaw.length ? providerIdRaw : undefined;
        const modelId = String(args?.model_id || "").trim();
        const dict = loadStore();

        const refresh = async ({
          checkHealth = false,
          force = false,
          pid = providerId,
          mid = modelId || undefined,
          invalidate = false
        } = {}) => {
          try {
            if (invalidate) invalidateModelAvailability({ providerId: pid, modelId: mid });
            return await refreshModelCatalog({
              checkHealth,
              force,
              providerId: pid,
              modelId: mid
            });
          } catch {
            return [];
          }
        };

        if (action === "list") {
          const models = await refresh({
            checkHealth: args?.refresh_health !== false,
            pid: providerId,
            mid: modelId || undefined
          });
          const availability = String(args?.availability || "").trim();
          const filtered = models.filter((model) => {
            if (providerId && model.providerId !== providerId) return false;
            if (modelId && model.id !== modelId) return false;
            if (availability && model.availability?.status !== availability) return false;
            return true;
          });
          const active = window.zion?.state?.get("chat.activeModel");
          const summary = {};
          for (const model of models) {
            const status = model.availability?.status || "unknown";
            summary[status] = (summary[status] || 0) + 1;
          }
          return JSON.stringify({ models: filtered, active, summary }, null, 2);
        }

        if (action === "check") {
          const models = await refresh({
            checkHealth: true,
            force: args?.force !== false,
            pid: providerId,
            mid: modelId || undefined
          });
          const availability = String(args?.availability || "").trim();
          const filtered = models.filter((model) => {
            if (providerId && model.providerId !== providerId) return false;
            if (modelId && model.id !== modelId) return false;
            if (availability && model.availability?.status !== availability) return false;
            return true;
          });
          return JSON.stringify({ checked: filtered }, null, 2);
        }

        if (action === "get") {
          if (!modelId) return "Missing model_id";
          // If provider_id is specified, resolve within that provider; otherwise search across providers.
          if (providerId) {
            const prov = window.zion?.models?.getProvider?.(providerId);
            if (!prov?.resolve) return `Provider not found: ${providerId}`;
            const cfg = await prov.resolve(modelId);
            if (!cfg) return `Model not found: ${providerId}:${modelId}`;
            const catalog = await refresh({ checkHealth: true, pid: providerId, mid: modelId });
            const item = catalog.find((model) => model.providerId === providerId && model.id === modelId);
            return JSON.stringify({ ...cfg, availability: item?.availability }, null, 2);
          } else {
            const ids = window.zion?.models?.listProviders?.() || [];
            for (const pid of ids) {
              const prov = window.zion?.models?.getProvider?.(pid);
              if (!prov?.resolve) continue;
              try {
                const cfg = await prov.resolve(modelId);
                if (cfg) {
                  const catalog = await refresh({ checkHealth: true, pid, mid: modelId });
                  const item = catalog.find((model) => model.providerId === pid && model.id === modelId);
                  return JSON.stringify({ ...cfg, availability: item?.availability }, null, 2);
                }
              } catch {}
            }
            return `Model not found: ${modelId}`;
          }
        }

        if (action === "set_active") {
          if (!modelId) return "Missing model_id";
          let pid = providerId;
          // If provider_id is missing, search catalog to locate the model across providers.
          if (!pid) {
            const models = await refresh({ checkHealth: true, pid: undefined, mid: modelId });
            const found = models.find(m => m.id === modelId);
            if (found) pid = found.providerId;
          }
          if (!pid) return "Missing provider_id or model not found for given model_id";
          const ok = await modelExists(pid, modelId);
          if (!ok) return `Model not found: ${pid}:${modelId}`;
          // Label 优先使用目录中的 label
          const catalog = await refresh({ checkHealth: true, pid, mid: modelId });
          const item = catalog.find(m => m.providerId === pid && m.id === modelId);
          if (
            !args?.force
            && (item?.availability?.status === "unavailable" || item?.availability?.status === "misconfigured")
          ) {
            return JSON.stringify({
              error: "Model is not currently usable",
              model: `${pid}:${modelId}`,
              availability: item.availability
            }, null, 2);
          }
          window.zion?.state?.set("chat.activeModel", { providerId: pid, modelId, label: item?.label || modelId });
          return JSON.stringify({
            set_active: `${pid}:${modelId}`,
            availability: item?.availability || { status: "unknown" }
          }, null, 2);
        }

        if (action === "add" || action === "update") {
          const pid = providerId || DYN_PROVIDER_ID;
          const limitError = validateLimitArgs(args);
          if (limitError) return limitError;
          if (
            pid !== DYN_PROVIDER_ID
            && !modelId
            && [args?.description, args?.context_window_tokens, args?.max_input_tokens, args?.max_output_tokens]
              .some((value) => value != null)
          ) {
            return "Missing model_id for model limits";
          }
          const updateBuiltinProviderConfig = (storageKey, { allowLabel = false, allowModel = false } = {}) => {
            const configStr = localStorage.getItem(storageKey) || "{}";
            const config = JSON.parse(configStr);
            if (args?.temperature != null) config.temperature = Number(args.temperature);
            if (args?.stream != null) config.stream = !!args.stream;
            if (args?.supportsImage != null) config.supportsImage = !!args.supportsImage;
            if (args?.supportsThinking != null) config.supportsThinking = !!args.supportsThinking;
            if (args?.supportsThinkingEffort != null) config.supportsThinkingEffort = !!args.supportsThinkingEffort;
            if (args?.thinkingMode != null) config.thinkingMode = String(args.thinkingMode);
            if (args?.thinkingEffort != null) config.thinkingEffort = String(args.thinkingEffort);
            if (args?.preservedThinking != null) config.preservedThinking = !!args.preservedThinking;
            if (args?.interleavedThinking != null) config.interleavedThinking = !!args.interleavedThinking;
            if (args?.autoContinueOnColonMaxAttempts != null) {
              config.autoContinueOnColonMaxAttempts = normalizeAutoContinueOnColonMaxAttempts(
                args.autoContinueOnColonMaxAttempts
              );
            }
            if (allowLabel && args?.label != null) config.label = String(args.label);
            if (allowModel && args?.model != null) config.modelName = String(args.model);
            if (modelId && args?.description != null) {
              const modelDescriptions = { ...(config.modelDescriptions || {}) };
              const description = normalizeModelDescription(args.description);
              if (description) modelDescriptions[modelId] = description;
              else delete modelDescriptions[modelId];
              if (Object.keys(modelDescriptions).length) config.modelDescriptions = modelDescriptions;
              else delete config.modelDescriptions;
            }
            if (modelId && [
              args?.context_window_tokens,
              args?.max_input_tokens,
              args?.max_output_tokens,
              args?.max_tokens
            ].some((value) => value != null)) {
              const modelLimits = { ...(config.modelLimits || {}) };
              const limits = { ...(modelLimits[modelId] || {}) };
              if (args?.context_window_tokens != null) limits.contextWindowTokens = Number(args.context_window_tokens);
              if (args?.max_input_tokens != null) limits.maxInputTokens = Number(args.max_input_tokens);
              if (args?.max_output_tokens != null) limits.maxOutputTokens = Number(args.max_output_tokens);
              if (args?.max_tokens != null) limits.defaultOutputTokens = Number(args.max_tokens);
              modelLimits[modelId] = limits;
              config.modelLimits = modelLimits;
            } else if (args?.max_tokens != null) {
              config.max_tokens = Number(args.max_tokens);
            }
            localStorage.setItem(storageKey, JSON.stringify(config));
          };

          // 特殊处理：配置预定义 provider 的 API key
          if (pid === "anthropic") {
            // 配置 Claude API key
            if (args?.key) {
              localStorage.setItem("zion.claude.apiKey", String(args.key));
            }
            updateBuiltinProviderConfig("zion.claude.config");
            await refresh({ checkHealth: true, force: true, pid, mid: modelId || undefined, invalidate: true });
            return JSON.stringify({ saved: { providerId: pid, id: modelId, message: "Claude API key configured" } }, null, 2);
          }

          if (pid === "google") {
            // 配置 Gemini API key
            if (args?.key) {
              localStorage.setItem("zion.gemini.apiKey", String(args.key));
            }
            updateBuiltinProviderConfig("zion.gemini.config");
            await refresh({ checkHealth: true, force: true, pid, mid: modelId || undefined, invalidate: true });
            return JSON.stringify({ saved: { providerId: pid, id: modelId, message: "Gemini API key configured" } }, null, 2);
          }

          if (pid === "deepseek") {
            // 配置 DeepSeek API key
            if (args?.key) {
              localStorage.setItem("zion.deepseek.apiKey", String(args.key));
            }
            updateBuiltinProviderConfig("zion.deepseek.config", { allowLabel: true, allowModel: true });
            await refresh({ checkHealth: true, force: true, pid, mid: modelId || undefined, invalidate: true });
            return JSON.stringify({ saved: { providerId: pid, id: modelId, message: "DeepSeek API key configured" } }, null, 2);
          }

          // user.dynamic provider 的处理
          if (pid !== DYN_PROVIDER_ID) return "Only user.dynamic, anthropic, google, deepseek providers are supported for configuration";
          if (!modelId) return "Missing model_id";
          const patch = {
            label: args?.label != null ? String(args.label) : undefined,
            description: args?.description != null
              ? normalizeModelDescription(args.description)
              : undefined,
            url: args?.url != null ? String(args.url) : undefined,
            key: args?.key != null ? String(args.key) : undefined,
            stream: args?.stream != null ? !!args.stream : undefined,
            temperature: args?.temperature != null ? Number(args.temperature) : undefined,
            max_tokens: args?.max_tokens != null ? Number(args.max_tokens) : undefined,
            contextWindowTokens: args?.context_window_tokens != null ? Number(args.context_window_tokens) : undefined,
            maxInputTokens: args?.max_input_tokens != null ? Number(args.max_input_tokens) : undefined,
            maxOutputTokens: args?.max_output_tokens != null ? Number(args.max_output_tokens) : undefined,
            supportsImage: args?.supportsImage != null ? !!args.supportsImage : undefined,
            supportsThinking: args?.supportsThinking != null ? !!args.supportsThinking : undefined,
            supportsThinkingEffort: args?.supportsThinkingEffort != null ? !!args.supportsThinkingEffort : undefined,
            thinkingMode: args?.thinkingMode != null ? String(args.thinkingMode) : undefined,
            thinkingEffort: args?.thinkingEffort != null ? String(args.thinkingEffort) : undefined,
            preservedThinking: args?.preservedThinking != null ? !!args.preservedThinking : undefined,
            interleavedThinking: args?.interleavedThinking != null ? !!args.interleavedThinking : undefined,
            autoContinueOnColonMaxAttempts:
              args?.autoContinueOnColonMaxAttempts != null
                ? normalizeAutoContinueOnColonMaxAttempts(args.autoContinueOnColonMaxAttempts)
                : undefined,
            model: args?.model != null ? String(args.model) : undefined,
            providerType: args?.provider_type != null ? String(args.provider_type) : undefined,
            anthropicVersion: args?.anthropicVersion != null ? String(args.anthropicVersion) : undefined
          };
          const cur = dict[modelId] || {};
          const next = { ...cur };
          Object.keys(patch).forEach(k => {
            const v = patch[k];
            if (v !== undefined) next[k] = v;
          });
          dict[modelId] = next;
          saveStore(dict);
          ensureProvider();
          await refresh({ checkHealth: true, force: true, pid, mid: modelId, invalidate: true });
          return JSON.stringify({ saved: { providerId: pid, id: modelId, config: next } }, null, 2);
        }

        if (action === "delete") {
          const pid = providerId || DYN_PROVIDER_ID;
          if (pid !== DYN_PROVIDER_ID) return "Only user.dynamic provider is writable";
          if (!modelId) return "Missing model_id";
          if (dict[modelId]) {
            delete dict[modelId];
            saveStore(dict);
            invalidateModelAvailability({ providerId: pid, modelId });
            await refresh({ pid, mid: undefined });
            // If active model was deleted, pick a fallback
            const active = window.zion?.state?.get("chat.activeModel");
            if (active?.providerId === pid && active?.modelId === modelId) {
              const catalog = window.zion?.state?.get("models.catalog") || [];
              const next = catalog[0] || null;
              window.zion?.state?.set("chat.activeModel", next ? { providerId: next.providerId, modelId: next.id, label: next.label } : null);
            }
            return JSON.stringify({ deleted: `${pid}:${modelId}` }, null, 2);
          }
          return `Model not found in ${pid}: ${modelId}`;
        }

        if (action === "import") {
          const merge = args?.merge !== false;
          let data = args?.data;
          if (typeof data === "string") {
            try { data = JSON.parse(data); } catch { return "Invalid data: not JSON"; }
          }
          if (!data || typeof data !== "object") return "Invalid data: expect object map { id: config }";
          const pid = providerId || DYN_PROVIDER_ID;
          if (pid !== DYN_PROVIDER_ID) return "Only user.dynamic provider is writable";
          const src = data;
          const cur = dict;
          const next = merge ? { ...cur, ...src } : { ...src };
          saveStore(next);
          invalidateModelAvailability({ providerId: pid });
          await refresh({ pid, mid: undefined });
          return JSON.stringify({ imported: Object.keys(src).length, total: Object.keys(next).length }, null, 2);
        }

        if (action === "export") {
          const pid = providerId || DYN_PROVIDER_ID;
          const out = pid === DYN_PROVIDER_ID ? dict : {};
          return JSON.stringify(out, null, 2);
        }

        return "Unknown action";
      } catch (e) {
        return `modelsManage error: ${e?.message || String(e)}`;
      }
    };

    window.zion?.state?.set("chat.toolHandlers", handlers);

    // enable list sync (include by default)
    try {
      const names = (window.zion?.state?.get("chat.tools") || []).map(t => t?.function?.name).filter(Boolean);
      window.zion?.state?.set("chat.toolsKnownNames", names);
      let enabled = window.zion?.state?.get("chat.enabledTools");
      if (!Array.isArray(enabled) || enabled.length === 0) {
        window.zion?.state?.set("chat.enabledTools", names);
      } else if (!enabled.includes("modelsManage")) {
        window.zion?.state?.set("chat.enabledTools", [...enabled, "modelsManage"]);
      }
    } catch {}
  } catch (e) {
    console.warn("[models-tools] register failed", e);
  }
}
