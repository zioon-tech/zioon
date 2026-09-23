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
  defaultTimeoutMs = 30000,
  authorizeRequest = null,
  onRequest = null,
  onRequestError = null
} = {}) {
  if (!engine?.streamTurn) {
    throw new Error("Plugin model service requires an Agent engine");
  }
  return Object.freeze({
    async generateText({
      messages = [],
      model = null,
      timeoutMs = defaultTimeoutMs,
      runContext = {},
      requestContext = {}
    } = {}) {
      const controller = new CancellationController();
      const timeout = timeoutSignal(controller, timeoutMs);
      let text = "";
      try {
        await authorizeRequest?.(runContext);
        const requestedModel = typeof resolveModel === "function"
          ? resolveModel(model || null)
          : model;
        for await (const event of engine.streamTurn({
          runId: runContext.runId,
          attemptId: runContext.attemptId,
          principal: runContext.principal,
          messages: normalizeMessages(messages),
          tools: [],
          model: requestedModel,
          signal: controller.signal
        })) {
          controller.signal.throwIfCancelled();
          await authorizeRequest?.(runContext);
          if (event?.type === "model.request" && typeof onRequest === "function") {
            try {
              await onRequest({
                request: event.request && typeof event.request === "object"
                  ? event.request
                  : {},
                requestContext: requestContext && typeof requestContext === "object"
                  ? { ...requestContext }
                  : {},
                model: requestedModel || null,
                timestamp: Date.now()
              });
            } catch (error) {
              try {
                onRequestError?.(error, {
                  requestContext,
                  model: requestedModel || null
                });
              } catch {
                // Request observation must not affect the plugin model call.
              }
            }
          }
          if (event?.type === "message.delta") text += String(event.delta || "");
        }
        return text;
      } finally {
        timeout.dispose();
      }
    }
  });
}
