import {
  normalizeAutoContinueOnColonMaxAttempts,
  normalizeModelDescription
} from "./model-config-fields.js";
import { getBuiltinModelLimits, withResolvedModelLimits } from "./model-limits.js";
import {
  buildDiscoveryAvailability,
  createProviderModelDiscovery
} from "./provider-model-discovery.js";

const MODEL_IDS = ["deepseek-v4-flash", "deepseek-v4-pro"];

const discoverRemoteModels = createProviderModelDiscovery({
  buildRequest(apiKey) {
    return {
      url: "https://api.deepseek.com/models",
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    };
  },
  parseModels(payload) {
    const models = new Map();
    for (const item of payload?.data || payload?.models || []) {
      const modelId = String(item?.id || item?.name || "");
      if (modelId) models.set(modelId, item);
    }
    return models;
  }
});

function resolveRemoteModelName(modelId, configuredModelName = "") {
  return configuredModelName === "deepseek-chat" || configuredModelName === "deepseek-reasoner"
    ? (modelId.startsWith("deepseek-v4-") ? modelId : "deepseek-v4-flash")
    : configuredModelName ||
      (modelId === "deepseek-chat" || modelId === "deepseek-reasoner" ? "deepseek-v4-flash" : modelId);
}

export const deepseekProvider = {
  id: "deepseek",
  async list() {
    // 从 localStorage 读取配置，如果有自定义标签则使用
    let label = "DeepSeek Chat";
    let config = {};
    try {
      const configStr = localStorage.getItem("zion.deepseek.config");
      if (configStr) {
        config = JSON.parse(configStr);
        if (config.label && config.label.trim()) {
          label = config.label.trim();
        }
      }
    } catch (e) {
      console.warn("[deepseek-provider] Failed to read config from localStorage", e);
    }
    return [
      {
        id: "deepseek-v4-flash",
        label: label === "DeepSeek Chat" ? "DeepSeek V4 Flash" : label,
        description: normalizeModelDescription(config.modelDescriptions?.["deepseek-v4-flash"]),
        limits: getBuiltinModelLimits("deepseek", "deepseek-v4-flash")
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        description: normalizeModelDescription(config.modelDescriptions?.["deepseek-v4-pro"]),
        limits: getBuiltinModelLimits("deepseek", "deepseek-v4-pro")
      }
    ];
  },
  async checkAvailability({ modelIds = MODEL_IDS, force = false } = {}) {
    const apiKey = String(localStorage.getItem("zion.deepseek.apiKey") || "").trim();
    let config = {};
    try {
      config = JSON.parse(localStorage.getItem("zion.deepseek.config") || "{}");
    } catch {}
    const result = await discoverRemoteModels({ credential: apiKey, force });
    return {
      ...result,
      source: "provider-list",
      models: buildDiscoveryAvailability(
        result,
        modelIds,
        (modelId) => resolveRemoteModelName(modelId, String(config.modelName || "").trim())
      )
    };
  },
  async resolve(modelId) {
    const supportedIds = new Set(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"]);
    if (!supportedIds.has(modelId)) return null;
    
    // 从 localStorage 读取用户配置
    let apiKey = null;
    let config = {};
    try {
      const storedKey = localStorage.getItem("zion.deepseek.apiKey");
      if (storedKey && storedKey.trim()) {
        apiKey = storedKey.trim();
      }
      
      const configStr = localStorage.getItem("zion.deepseek.config");
      if (configStr) {
        config = JSON.parse(configStr);
      }
    } catch (e) {
      console.warn("[deepseek-provider] Failed to read config from localStorage", e);
    }
    
    const configuredModelName = String(config.modelName || "").trim();
    const resolvedModelName = resolveRemoteModelName(modelId, configuredModelName);
    const common = withResolvedModelLimits({
      id: modelId,
      url: "https://api.deepseek.com/chat/completions",
      modelName: resolvedModelName,
      description: normalizeModelDescription(config.modelDescriptions?.[modelId]),
      providerId: "deepseek",
      providerType: "openai",
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      pricing: config.pricing,
      stream: config.stream !== false,
      supportsImage: !!config.supportsImage,
      supportsThinking: config.supportsThinking ?? true,
      supportsThinkingEffort: config.supportsThinkingEffort ?? true,
      thinkingMode: config.thinkingMode || "auto",
      thinkingEffort: config.thinkingEffort || "auto",
      preservedThinking: config.preservedThinking !== false,
      interleavedThinking: config.interleavedThinking !== false,
      autoContinueOnColonMaxAttempts: normalizeAutoContinueOnColonMaxAttempts(
        config.autoContinueOnColonMaxAttempts
      )
    }, {
      providerId: "deepseek",
      modelId,
      descriptor: { limits: getBuiltinModelLimits("deepseek", modelId) },
      settings: config
    });

    // 如果没有配置 API key，返回一个提示性的配置，让用户知道需要配置
    if (!apiKey) {
      return {
        ...common,
        key: "", // 空 key，用户需要自己配置
        _requiresConfig: true,
        _configHint: "请使用 modelsManage 工具配置 DeepSeek API key，或设置 localStorage 键 'zion.deepseek.apiKey'"
      };
    }
    
    // Return OpenAI-compatible fields (url + key) so chat-service uses the generic fetch path (B)
    // instead of the LangChain path (A) which is not suitable for running in browser.
    return {
      ...common,
      key: apiKey
    };
  }
};
