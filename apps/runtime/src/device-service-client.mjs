import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { CancellationController } from "../../../packages/runtime/dist/index.js";

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

      if (nodeBroker?.invoke) {
        const invocationId = `${serviceName}:${randomUUID()}`;
        const result = await nodeBroker.invoke({
          invocationId,
          runId: runContext.runId || invocationId,
          attemptId: runContext.attemptId || invocationId,
          sessionId: runContext.sessionId || "",
          projectId: runContext.projectId || "",
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
          throw new Error(
            result?.error
            || result?.content
            || `${serviceName} request failed`
          );
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
