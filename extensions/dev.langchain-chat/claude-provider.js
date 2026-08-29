import { getBuiltinModelLimits, withResolvedModelLimits } from "./model-limits.js";
import { normalizeModelDescription } from "./model-config-fields.js";
import {
  buildDiscoveryAvailability,
  createProviderModelDiscovery
} from "./provider-model-discovery.js";

const MODEL_IDS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001"
];
const MODEL_LABELS = {
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5"
};
const discoverRemoteModels = createProviderModelDiscovery({
  buildRequest(apiKey) {
    return {
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      }
    };
  },
  parseModels(payload) {
    const models = new Map();
    for (const item of payload?.data || []) {
      const modelId = String(item?.id || "");
      const maxInputTokens = Number(item?.max_input_tokens || 0);
      const maxOutputTokens = Number(item?.max_tokens || 0);
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

export const claudeProvider = {
  id: "anthropic",
  async list() {
    let config = {};
    try {
      config = JSON.parse(localStorage.getItem("zion.claude.config") || "{}");
    } catch {}
    const apiKey = String(localStorage.getItem("zion.claude.apiKey") || "").trim();
    const discovery = await discoverRemoteModels({ credential: apiKey });
    return MODEL_IDS.map((id) => ({
      id,
      label: MODEL_LABELS[id] || id,
      description: normalizeModelDescription(config.modelDescriptions?.[id]),
      limits: discovery.models.get(id) || getBuiltinModelLimits("anthropic", id)
    }));
  },
  async checkAvailability({ modelIds = MODEL_IDS, force = false } = {}) {
    const apiKey = String(localStorage.getItem("zion.claude.apiKey") || "").trim();
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
      const storedKey = localStorage.getItem("zion.claude.apiKey");
      if (storedKey && storedKey.trim()) {
        apiKey = storedKey.trim();
      }

      const configStr = localStorage.getItem("zion.claude.config");
      if (configStr) {
        config = JSON.parse(configStr);
      }
    } catch (e) {
      console.warn("[claude-provider] Failed to read config from localStorage", e);
    }

    const discovery = await discoverRemoteModels({ credential: apiKey });
    const common = withResolvedModelLimits({
      id: modelId,
      url: "https://api.anthropic.com/v1/messages",
      modelName: modelId,
      description: normalizeModelDescription(config.modelDescriptions?.[modelId]),
      providerId: "anthropic",
      providerType: "claude",
      anthropicVersion: "2023-06-01",
      temperature: config.temperature,
      max_tokens: config.max_tokens ?? 64000,
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
      providerId: "anthropic",
      modelId,
      descriptor: {
        limits: discovery.models.get(modelId) || getBuiltinModelLimits("anthropic", modelId)
      },
      settings: config,
      defaultOutputTokens: 64_000
    });

    // 如果没有配置 API key，返回一个提示性的配置
    if (!apiKey) {
      return {
        ...common,
        key: "",
        _requiresConfig: true,
        _configHint: "请使用 modelsManage 工具配置 Claude API key，或设置 localStorage 键 'zion.claude.apiKey'"
      };
    }

    // Return Claude-specific fields
    return {
      ...common,
      key: apiKey
    };
  }
};
