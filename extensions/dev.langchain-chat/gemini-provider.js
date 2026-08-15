export const geminiProvider = {
  id: "google",
  async list() {
    // 从 localStorage 读取配置，如果有自定义标签则使用
    let label = "Gemini";
    try {
      const configStr = localStorage.getItem("zion.gemini.config");
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config.label && config.label.trim()) {
          label = config.label.trim();
        }
      }
    } catch (e) {
      console.warn("[gemini-provider] Failed to read config from localStorage", e);
    }
    return [
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }
    ];
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

    const common = {
      id: modelId,
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      modelName: modelId,
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
    };

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
