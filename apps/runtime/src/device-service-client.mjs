import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { CancellationController } from "../../../packages/runtime/dist/index.js";
import { requirePluginDataCapability } from "./plugin-data-capability.mjs";

const DEVICE_SERVICE_TOOL_NAME = "zion.internal.deviceService";

function responseError(service, status, payload) {
  const message = String(
    payload?.message
    || payload?.detail
    || payload?.error
    || `${service} HTTP ${status}`
  );
  const error = new Error(message);
  error.statusCode = status;
  if (payload?.failureCode) error.failureCode = String(payload.failureCode);
  if (typeof payload?.retryable === "boolean") error.retryable = payload.retryable;
  return error;
}

function decodeJsonBody(service, body, status) {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`${service} returned an invalid HTTP status`);
  }
  if (!body?.length) {
    if (status < 200 || status >= 300) throw responseError(service, status);
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw responseError(service, status, {
      error: `${service} returned invalid JSON`
    });
  }
  if (status < 200 || status >= 300 || payload?.success === false) {
    throw responseError(service, status, payload);
  }
  return payload;
}

function cancellationSignal(runContext) {
  if (runContext?.signal) return runContext.signal;
  return new CancellationController().signal;
}

export function createDeviceServiceClient({
  service,
  baseUrl,
  nodeBroker = null,
  dataFiles = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const serviceName = String(service || "").trim();
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  if (!serviceName) throw new Error("Device service name is required");
  if (!nodeBroker?.invoke && !normalizedBaseUrl) {
    throw new Error(`${serviceName} requires a base URL or Node Broker`);
  }

  return Object.freeze({
    async request(path, {
      method = "GET",
      body = null,
      runContext = {}
    } = {}) {
      const requestMethod = String(method || "GET").toUpperCase();
      const requestBody = body == null
        ? null
        : Buffer.from(JSON.stringify(body), "utf8");
      const pluginDataRequest = new URL(path, "http://device.invalid").searchParams.get("plugin_data_version") === "1";

      if (dataFiles && serviceName === "local-tools" && (pluginDataRequest || !nodeBroker)) {
        cancellationSignal(runContext).throwIfCancelled();
        const url = new URL(path, "http://device.invalid");
        const payload = await dataFiles.handle(url.pathname.replace(/^\/files\//, ""),
          body || Object.fromEntries(url.searchParams), { signal: cancellationSignal(runContext) });
        if (payload) return payload;
        if (pluginDataRequest || !nodeBroker) {
          throw new Error("Path is outside configured plugin data storage");
        }
      }

      if (nodeBroker?.invoke) {
        if (pluginDataRequest) requirePluginDataCapability(nodeBroker, runContext);
        const invocationId = `${serviceName}:${randomUUID()}`;
        const result = await nodeBroker.invoke({
          invocationId,
          runId: runContext.runId || invocationId,
          attemptId: runContext.attemptId || invocationId,
          sessionId: runContext.sessionId || "",
          projectId: runContext.projectId || "",
          ...(runContext.principal ? { principal: runContext.principal } : {}),
          ...(runContext.target ? { target: runContext.target } : {}),
          policy: {
            preset: "trusted-automation",
            ...(runContext.policy || {}),
            allowedTools: [DEVICE_SERVICE_TOOL_NAME],
            ...(Array.isArray(runContext.policy?.allowedTerminalSessionIds)
              ? {
                  allowedTerminalSessionIds:
                    runContext.policy.allowedTerminalSessionIds.map(String)
                }
              : {})
          },
          toolCall: {
            id: invocationId,
            name: DEVICE_SERVICE_TOOL_NAME,
            arguments: {
              service: serviceName,
              method: requestMethod,
              path,
              headers: {
                accept: "application/json",
                ...(requestBody ? { "content-type": "application/json" } : {})
              },
              ...(requestBody
                ? { bodyBase64: requestBody.toString("base64") }
                : {})
            }
          }
        }, cancellationSignal(runContext));
        if (!result?.ok) {
          const error = new Error(
            result?.error
            || result?.content
            || `${serviceName} request failed`
          );
          error.statusCode = result?.failureCode === "stale_terminal_reference" ? 409 : 502;
          if (result?.failureCode) error.failureCode = result.failureCode;
          if (typeof result?.retryable === "boolean") error.retryable = result.retryable;
          throw error;
        }
        let envelope;
        try {
          envelope = JSON.parse(String(result.content || ""));
        } catch {
          throw new Error(`Device ${serviceName} returned an invalid response`);
        }
        const status = Number(envelope?.status);
        const responseBody = envelope?.bodyBase64
          ? Buffer.from(String(envelope.bodyBase64), "base64")
          : Buffer.alloc(0);
        return decodeJsonBody(serviceName, responseBody, status);
      }

      const signal = cancellationSignal(runContext);
      signal.throwIfCancelled();
      const controller = new AbortController();
      const cancellation = signal.onCancel(() => controller.abort());
      try {
        const response = await fetchImpl(new URL(path, `${normalizedBaseUrl}/`), {
          method: requestMethod,
          headers: {
            accept: "application/json",
            ...(requestBody ? { "content-type": "application/json" } : {})
          },
          signal: controller.signal,
          ...(requestBody ? { body: requestBody } : {})
        });
        const responseBody = Buffer.from(await response.arrayBuffer());
        return decodeJsonBody(serviceName, responseBody, response.status);
      } finally {
        cancellation.dispose();
      }
    }
  });
}
