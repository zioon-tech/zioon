export const deepseekProvider = {
  id: "deepseek",
  async list() {
    // 从 localStorage 读取配置，如果有自定义标签则使用
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
  async resolve(modelId) {
    if (modelId !== "deepseek-chat") return null;
    
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
    
    // 如果没有配置 API key，返回一个提示性的配置，让用户知道需要配置
    if (!apiKey) {
      return {
        id: modelId,
        url: "https://api.deepseek.com/chat/completions",
        key: "", // 空 key，用户需要自己配置
        modelName: config.modelName || "deepseek-chat",
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        pricing: config.pricing,
        stream: config.stream !== false,
        supportsImage: !!config.supportsImage,
        supportsThinking: config.supportsThinking,
        supportsThinkingEffort: config.supportsThinkingEffort,
        thinkingMode: config.thinkingMode || "auto",
        thinkingEffort: config.thinkingEffort || "auto",
        preservedThinking: !!config.preservedThinking,
        interleavedThinking: !!config.interleavedThinking,
        _requiresConfig: true,
        _configHint: "请使用 modelsManage 工具配置 DeepSeek API key，或设置 localStorage 键 'zion.deepseek.apiKey'"
      };
    }
    
    // Return OpenAI-compatible fields (url + key) so chat-service uses the generic fetch path (B)
    // instead of the LangChain path (A) which is not suitable for running in browser.
    return {
      id: modelId,
      url: "https://api.deepseek.com/chat/completions",
      key: apiKey,
      modelName: config.modelName || "deepseek-chat",
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      pricing: config.pricing,
      stream: config.stream !== false,
      supportsImage: !!config.supportsImage,
      supportsThinking: config.supportsThinking,
      supportsThinkingEffort: config.supportsThinkingEffort,
      thinkingMode: config.thinkingMode || "auto",
      thinkingEffort: config.thinkingEffort || "auto",
      preservedThinking: !!config.preservedThinking,
      interleavedThinking: !!config.interleavedThinking
    };
  }
};
