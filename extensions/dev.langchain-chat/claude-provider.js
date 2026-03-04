export const claudeProvider = {
  id: "anthropic",
  async list() {
    // 从 localStorage 读取配置，如果有自定义标签则使用
    let label = "Claude";
    try {
      const configStr = localStorage.getItem("zion.claude.config");
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config.label && config.label.trim()) {
          label = config.label.trim();
        }
      }
    } catch (e) {
      console.warn("[claude-provider] Failed to read config from localStorage", e);
    }
    return [
      { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
      { id: "claude-3-opus-20240229", label: "Claude 3 Opus" },
      { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" }
    ];
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

    // 如果没有配置 API key，返回一个提示性的配置
    if (!apiKey) {
      return {
        id: modelId,
        url: "https://api.anthropic.com/v1/messages",
        key: "",
        modelName: modelId,
        providerType: "claude",
        anthropicVersion: "2023-06-01",
        temperature: config.temperature ?? 1.0,
        max_tokens: config.max_tokens ?? 4096,
        stream: config.stream !== false,
        supportsImage: true,
        _requiresConfig: true,
        _configHint: "请使用 modelsManage 工具配置 Claude API key，或设置 localStorage 键 'zion.claude.apiKey'"
      };
    }

    // Return Claude-specific fields
    return {
      id: modelId,
      url: "https://api.anthropic.com/v1/messages",
      key: apiKey,
      modelName: modelId,
      providerType: "claude",
      anthropicVersion: "2023-06-01",
      temperature: config.temperature ?? 1.0,
      max_tokens: config.max_tokens ?? 4096,
      stream: config.stream !== false,
      supportsImage: true
    };
  }
};
