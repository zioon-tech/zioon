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
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }
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

    const common = {
      id: modelId,
      url: "https://api.anthropic.com/v1/messages",
      modelName: modelId,
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
    };

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
