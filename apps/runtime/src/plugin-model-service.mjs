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
      requestContext = {},
      signal = null,
      modelOptions = undefined,
      maxOutputTokens = undefined,
      maxOutputChars = 1000000,
      onUsage = null
    } = {}) {
      const controller = new CancellationController();
      const timeout = timeoutSignal(controller, timeoutMs);
      const parentCancellation = signal?.onCancel?.((reason) => controller.cancel(reason));
      if (signal?.cancelled) controller.cancel(signal.reason || "parent");
      let text = "";
      try {
        controller.signal.throwIfCancelled();
        await authorizeRequest?.(runContext);
        const requestedModel = typeof resolveModel === "function"
          ? await resolveModel(model || runContext.request?.model || runContext.model || null,
            runContext.principal || runContext.request?.principal)
          : model;
        for await (const event of engine.streamTurn({
          runId: runContext.runId,
          attemptId: runContext.attemptId,
          principal: runContext.principal || runContext.request?.principal,
          messages: normalizeMessages(messages),
          tools: [],
          model: requestedModel,
          modelOptions,
          maxOutputTokens,
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
          if (event?.type === "model.usage") onUsage?.(event.usage);
          if (event?.type === "message.delta") {
            text += String(event.delta || "");
            if (text.length > maxOutputChars) {
              controller.cancel("output-budget");
              throw new Error("Plugin model output exceeded its budget");
            }
          }
        }
        return text;
      } finally {
        timeout.dispose();
        parentCancellation?.dispose();
      }
    }
  });
}
