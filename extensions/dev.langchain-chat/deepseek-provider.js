export const deepseekProvider = {
  id: "deepseek",
  async list() {
    return [{ id: "deepseek-chat", label: "DeepSeek Chat" }];
  },
  async resolve(modelId) {
    if (modelId !== "deepseek-chat") return null;
    // Return OpenAI-compatible fields (url + key) so chat-service uses the generic fetch path (B)
    // instead of the LangChain path (A) which is not suitable for running in browser.
    return {
      id: modelId,
      url: "https://api.deepseek.com/chat/completions",
      key: "sk-0ab2de3a2a4844acb579c1d1cf6580ce", // 后续可挪到配置面板或 .env
      modelName: "deepseek-chat"
    };
  }
};