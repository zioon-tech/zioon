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
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { id: "gemini-2.0-flash-thinking-exp-01-21", label: "Gemini 2.0 Flash Thinking" },
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" }
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

    // 如果没有配置 API key，返回一个提示性的配置
    if (!apiKey) {
      return {
        id: modelId,
        url: "https://generativelanguage.googleapis.com/v1beta/models",
        key: "",
        modelName: modelId,
        providerType: "gemini",
        temperature: config.temperature ?? 0.9,
        max_tokens: config.max_tokens ?? 8192,
        stream: config.stream !== false,
        supportsImage: true,
        _requiresConfig: true,
        _configHint: "请使用 modelsManage 工具配置 Gemini API key，或设置 localStorage 键 'zion.gemini.apiKey'"
      };
    }

    // Return Gemini-specific fields
    return {
      id: modelId,
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      key: apiKey,
      modelName: modelId,
      providerType: "gemini",
      temperature: config.temperature ?? 0.9,
      max_tokens: config.max_tokens ?? 8192,
      stream: config.stream !== false,
      supportsImage: true
    };
  }
};
