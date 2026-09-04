import { CancellationController } from "../../../packages/runtime/dist/index.js";

function timeoutSignal(controller, timeoutMs) {
  const ms = Math.max(1, Number(timeoutMs || 30000));
  const timer = setTimeout(() => controller.cancel("timeout"), ms);
  return {
    dispose() {
      clearTimeout(timer);
    }
  };
}

function normalizeMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: String(message?.role || ""),
      content: String(message?.content || "")
    }))
    .filter((message) =>
      ["system", "user", "assistant", "tool"].includes(message.role)
      && message.content.trim()
    );
}

export function createPluginModelService({
  engine,
  resolveModel = null,
  defaultTimeoutMs = 30000
} = {}) {
  if (!engine?.streamTurn) {
    throw new Error("Plugin model service requires an Agent engine");
  }
  return Object.freeze({
    async generateText({
      messages = [],
      model = null,
      timeoutMs = defaultTimeoutMs
    } = {}) {
      const controller = new CancellationController();
      const timeout = timeoutSignal(controller, timeoutMs);
      let text = "";
      try {
        const requestedModel = typeof resolveModel === "function"
          ? resolveModel(model || null)
          : model;
        for await (const event of engine.streamTurn({
          messages: normalizeMessages(messages),
          tools: [],
          model: requestedModel,
          signal: controller.signal
        })) {
          controller.signal.throwIfCancelled();
          if (event?.type === "message.delta") text += String(event.delta || "");
        }
        return text;
      } finally {
        timeout.dispose();
      }
    }
  });
}
