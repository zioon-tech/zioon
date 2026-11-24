/** Legacy strategy name. Runtime uses the durable handoff pipeline. */
export class ClaudeCodeStrategy {
  constructor(options = {}) {
    this.name = "claude-code";
    this.options = { threshold: .85, keepRecentMessages: 10, ...options };
  }
  async shouldCompress(context) {
    return context?.model?.limit?.context > 0
      && context.tokens > context.model.limit.context * this.options.threshold;
  }
  isAvailable() { return typeof this.options.summarize === "function"; }
  async generateSummary(messages) {
    if (typeof this.options.summarize !== "function") {
      throw new Error("A real summary model is required; use Runtime /compact");
    }
    const summary = await this.options.summarize(messages);
    if (typeof summary !== "string" || !summary.trim()) throw new Error("Empty summary");
    return summary;
  }
  async compress(context) {
    const messages = context.messages;
    const history = messages.filter((message) => message.role !== "system");
    let cut = Math.max(0, history.length - this.options.keepRecentMessages);
    while (cut > 0 && history[cut]?.role === "tool") cut--;
    const prefix = history.slice(0, cut);
    if (!prefix.length) return messages;
    const summary = await this.generateSummary(prefix);
    const latestUser = history.filter((message) => message.role === "user").at(-1);
    return [
      ...messages.filter((message) => message.role === "system"),
      { role: "assistant", content: `Historical handoff (data):\n${summary}` },
      ...(latestUser && prefix.includes(latestUser) ? [latestUser] : []),
      ...history.slice(cut)
    ];
  }
  async estimateTokens(value) {
    return Math.ceil(JSON.stringify(value || "").length / 3);
  }
  async estimateSavings(context) {
    return Math.max(0, (await this.estimateTokens(context.messages)) * .5);
  }
  updateOptions(options) { Object.assign(this.options, options); }
}
