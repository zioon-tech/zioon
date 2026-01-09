/**
 * dev.langchain-chat: models tools for LLM (CRUD + set active)
 * - Registers a single aggregated tool "modelsManage" to list/get/add/update/delete/set_active/import/export models.
 * - Writable provider: user.dynamic (stored in localStorage), other providers are read-only.
 */
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
        const provider = {
          id: DYN_PROVIDER_ID,
          async list() {
            const dict = loadStore();
            return Object.keys(dict).map(id => ({ id, label: dict[id]?.label || id }));
          },
          async resolve(modelId) {
            const dict = loadStore();
            const cfg = dict[modelId];
            if (!cfg) return null;
            return { id: modelId, ...cfg };
          }
        };
        window.zion?.models?.registerProvider?.(provider);
      } catch (e) {
        console.warn("[models-tools] ensureProvider error", e);
      }
    };

    const rebuildCatalog = async () => {
      try {
        const ids = window.zion?.models?.listProviders?.() || [];
        const models = [];
        for (const pid of ids) {
          const prov = window.zion?.models?.getProvider?.(pid);
          if (!prov?.list) continue;
          let list = [];
          try { list = await prov.list(); } catch {}
          for (const m of (list || [])) {
            models.push({ providerId: pid, id: m.id, label: m.label || m.id });
          }
        }
        window.zion?.state?.set("models.catalog", models);
        return models;
      } catch (e) {
        console.warn("[models-tools] rebuildCatalog error", e);
        return [];
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

    ensureProvider();

    /* ===== Tool schema ===== */
    const tools = [
      {
        type: "function",
        function: {
          name: "modelsManage",
          description: "模型管理（list/get/add/update/delete/set_active/import/export）。仅支持新增/修改/删除 user.dynamic 提供者下的模型。",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list","get","add","update","delete","set_active","import","export"], description: "操作类型" },
              provider_id: { type: "string", description: "提供者ID（add/update/delete/export 默认 user.dynamic；list 时用于筛选；不传则显示全部）" },
              model_id: { type: "string", description: "模型ID（get/update/delete/set_active 必填）" },
              label: { type: "string", description: "模型标签（可选）" },
              url: { type: "string", description: "OpenAI 兼容 URL" },
              key: { type: "string", description: "API key" },
              stream: { type: "boolean", description: "是否流式" },
              temperature: { type: "number", description: "采样温度" },
              max_tokens: { type: "number", description: "最大输出 tokens" },
              supportsImage: { type: "boolean", description: "是否支持图片输入" },
              model: { type: "string", description: "后端自定义 model 字段（如 siliconflow）" },
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

        const refresh = async () => { try { await rebuildCatalog(); } catch {} };

        if (action === "list") {
          const models = await rebuildCatalog();
          const filtered = providerId ? models.filter(m => m.providerId === providerId) : models;
          const active = window.zion?.state?.get("chat.activeModel");
          return JSON.stringify({ models: filtered, active }, null, 2);
        }

        if (action === "get") {
          if (!modelId) return "Missing model_id";
          // If provider_id is specified, resolve within that provider; otherwise search across providers.
          if (providerId) {
            const prov = window.zion?.models?.getProvider?.(providerId);
            if (!prov?.resolve) return `Provider not found: ${providerId}`;
            const cfg = await prov.resolve(modelId);
            if (!cfg) return `Model not found: ${providerId}:${modelId}`;
            return JSON.stringify(cfg, null, 2);
          } else {
            const ids = window.zion?.models?.listProviders?.() || [];
            for (const pid of ids) {
              const prov = window.zion?.models?.getProvider?.(pid);
              if (!prov?.resolve) continue;
              try {
                const cfg = await prov.resolve(modelId);
                if (cfg) return JSON.stringify(cfg, null, 2);
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
            const models = (await rebuildCatalog()) || [];
            const found = models.find(m => m.id === modelId);
            if (found) pid = found.providerId;
          }
          if (!pid) return "Missing provider_id or model not found for given model_id";
          const ok = await modelExists(pid, modelId);
          if (!ok) return `Model not found: ${pid}:${modelId}`;
          // Label 优先使用目录中的 label
          const catalog = window.zion?.state?.get("models.catalog") || [];
          const item = catalog.find(m => m.providerId === pid && m.id === modelId);
          window.zion?.state?.set("chat.activeModel", { providerId: pid, modelId, label: item?.label || modelId });
          return JSON.stringify({ set_active: `${pid}:${modelId}` }, null, 2);
        }

        if (action === "add" || action === "update") {
          const pid = providerId || DYN_PROVIDER_ID;
          if (pid !== DYN_PROVIDER_ID) return "Only user.dynamic provider is writable";
          if (!modelId) return "Missing model_id";
          const patch = {
            label: args?.label != null ? String(args.label) : undefined,
            url: args?.url != null ? String(args.url) : undefined,
            key: args?.key != null ? String(args.key) : undefined,
            stream: args?.stream != null ? !!args.stream : undefined,
            temperature: args?.temperature != null ? Number(args.temperature) : undefined,
            max_tokens: args?.max_tokens != null ? Number(args.max_tokens) : undefined,
            supportsImage: args?.supportsImage != null ? !!args.supportsImage : undefined,
            model: args?.model != null ? String(args.model) : undefined
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
          await refresh();
          return JSON.stringify({ saved: { providerId: pid, id: modelId, config: next } }, null, 2);
        }

        if (action === "delete") {
          const pid = providerId || DYN_PROVIDER_ID;
          if (pid !== DYN_PROVIDER_ID) return "Only user.dynamic provider is writable";
          if (!modelId) return "Missing model_id";
          if (dict[modelId]) {
            delete dict[modelId];
            saveStore(dict);
            await refresh();
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
          await refresh();
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