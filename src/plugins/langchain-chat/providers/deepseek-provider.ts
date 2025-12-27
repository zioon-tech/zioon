/**
 * Zion LangChain Chat Plugin - DeepSeek Provider
 * Model provider for DeepSeek API
 */

export const deepseekProvider = {
  id: "deepseek",
  async list() {
    // Read configuration from localStorage
    let label = "DeepSeek Chat";
    try {
      const configStr = localStorage.getItem("zion.deepseek.config");
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config.label && config.label.trim()) {
          label = config.label.trim();
        }
      }
    } catch (e) {
      console.warn("[deepseek-provider] Failed to read config from localStorage", e);
    }
    return [{ id: "deepseek-chat", label }];
  },

  async resolve(modelId: string) {
    if (modelId !== "deepseek-chat") return null;

    // Read user configuration from localStorage
    let apiKey: string | null = null;
    let config: any = {};
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

    // If no API key is configured, return a hint
    if (!apiKey) {
      return {
        id: modelId,
        url: "https://api.deepseek.com/chat/completions",
        key: "", // Empty key, user needs to configure
        modelName: config.modelName || "deepseek-chat",
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        stream: config.stream !== false,
        supportsImage: !!config.supportsImage,
        _requiresConfig: true,
        _configHint:
          "请使用 modelsManage 工具配置 DeepSeek API key，或设置 localStorage 键 'zion.deepseek.apiKey'"
      };
    }

    // Return OpenAI-compatible fields
    return {
      id: modelId,
      url: "https://api.deepseek.com/chat/completions",
      key: apiKey,
      modelName: config.modelName || "deepseek-chat",
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      stream: config.stream !== false,
      supportsImage: !!config.supportsImage
    };
  }
};
