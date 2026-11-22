import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import { getBuiltinModelLimits, withResolvedModelLimits } from "./model-limits.js";
import { normalizeModelDescription } from "./model-config-fields.js";
import {
  buildDiscoveryAvailability,
  createProviderModelDiscovery
} from "./provider-model-discovery.js";

const MODEL_IDS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash"
];
const MODEL_LABELS = {
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro Preview",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash"
};
const discoverRemoteModels = createProviderModelDiscovery({
  buildRequest(apiKey) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`
    };
  },
  parseModels(payload) {
    const models = new Map();
    for (const item of payload?.models || []) {
      const modelId = String(item?.baseModelId || item?.name || "").replace(/^models\//, "");
      const maxInputTokens = Number(item?.inputTokenLimit || 0);
      const maxOutputTokens = Number(item?.outputTokenLimit || 0);
      if (!modelId) continue;
      models.set(modelId, {
        contextWindowTokens: maxInputTokens || undefined,
        maxInputTokens: maxInputTokens || undefined,
        maxOutputTokens: maxOutputTokens || undefined,
        source: "provider-api",
        updatedAt: Date.now()
      });
    }
    return models;
  }
});

export const geminiProvider = {
  id: "google",
  async list() {
    let config = {};
    try {
      config = JSON.parse(localStorage.getItem("zion.gemini.config") || "{}");
    } catch {}
    const apiKey = String(localStorage.getItem("zion.gemini.apiKey") || "").trim();
    const discovery = discoverRemoteModels.peek({ credential: apiKey })
      || { models: new Map() };
    return MODEL_IDS.map((id) => ({
      id,
      label: MODEL_LABELS[id] || id,
      description: normalizeModelDescription(config.modelDescriptions?.[id]),
      limits: discovery.models.get(id) || getBuiltinModelLimits("google", id)
    }));
  },
  async checkAvailability({ modelIds = MODEL_IDS, force = false } = {}) {
    const apiKey = String(localStorage.getItem("zion.gemini.apiKey") || "").trim();
    const result = await discoverRemoteModels({ credential: apiKey, force });
    return {
      ...result,
      source: "provider-list",
      models: buildDiscoveryAvailability(result, modelIds)
    };
  },
  async resolve(modelId) {
    // 从 localStorage 读取用户配置
    let apiKey = null;
    let config = {};
    try {
      const storedKey = localStorage.getItem("zion.gemini.apiKey");
      if (storedKey && storedKey.trim()) {
        apiKey = storedKey.trim();
      }

      const configStr = localStorage.getItem("zion.gemini.config");
      if (configStr) {
        config = JSON.parse(configStr);
      }
    } catch (e) {
      console.warn("[gemini-provider] Failed to read config from localStorage", e);
    }

    const discovery = discoverRemoteModels.peek({ credential: apiKey })
      || { models: new Map() };
    const common = withResolvedModelLimits({
      id: modelId,
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      modelName: modelId,
      description: normalizeModelDescription(config.modelDescriptions?.[modelId]),
      providerId: "google",
      providerType: "gemini",
      temperature: config.temperature,
      max_tokens: config.max_tokens ?? 32768,
      pricing: config.pricing,
      stream: config.stream !== false,
      supportsImage: config.supportsImage !== false,
      supportsThinking: config.supportsThinking ?? true,
      supportsThinkingEffort: config.supportsThinkingEffort ?? true,
      thinkingMode: config.thinkingMode || "auto",
      thinkingEffort: config.thinkingEffort || "auto",
      preservedThinking: !!config.preservedThinking,
      interleavedThinking: !!config.interleavedThinking
    }, {
      providerId: "google",
      modelId,
      descriptor: {
        limits: discovery.models.get(modelId) || getBuiltinModelLimits("google", modelId)
      },
      settings: config,
      defaultOutputTokens: 32_768
    });

    // 如果没有配置 API key，返回一个提示性的配置
    if (!apiKey) {
      return {
        ...common,
        key: "",
        _requiresConfig: true,
        _configHint: "请使用 modelsManage 工具配置 Gemini API key，或设置 localStorage 键 'zion.gemini.apiKey'"
      };
    }

    // Return Gemini-specific fields
    return {
      ...common,
      key: apiKey
    };
  }
};
