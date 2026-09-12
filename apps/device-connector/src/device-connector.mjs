import { setTimeout as delay } from "node:timers/promises";
import { URL, URLSearchParams } from "node:url";
import {
  normalizeNodeRegistration,
  normalizeToolResult,
  validateDeviceCommand
} from "../../../packages/node-protocol/src/index.mjs";
import { DEVICE_SERVICE_TOOL_NAME } from "./device-service-host.mjs";

class ConnectorCancellationController {
  constructor() {
    const listeners = new Set();
    this.signal = {
      cancelled: false,
      reason: undefined,
      throwIfCancelled() {
        if (this.cancelled) {
          throw new Error(`Tool invocation cancelled: ${this.reason}`);
        }
      },
      onCancel(listener) {
        if (this.cancelled) {
          listener(this.reason);
          return { dispose() {} };
        }
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    };
    this.cancel = (reason = "cancelled") => {
      if (this.signal.cancelled) return;
      this.signal.cancelled = true;
      this.signal.reason = reason;
      for (const listener of [...listeners]) listener(reason);
      listeners.clear();
    };
  }
}

async function responsePayload(response) {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRuntimeUrl(value) {
  const url = new URL(String(value || ""));
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    url.hostname
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "Remote Device Connector URLs must use HTTPS"
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export async function exchangeDevicePairing({
  runtimeUrl,
  pairingId = "",
  secret = "",
  userCode = "",
  device,
  fetchImpl = globalThis.fetch
}) {
  const baseUrl = normalizeRuntimeUrl(runtimeUrl);
  const response = await fetchImpl(new URL("/v1/access/pair", baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      ...(pairingId && secret ? { pairingId, secret } : {}),
      ...(userCode ? { userCode } : {}),
      device
    })
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    const error = new Error(String(
      payload?.error || payload || `HTTP ${response.status}`
    ));
    error.statusCode = response.status;
    throw error;
  }
  if (!String(payload?.credential || "")) {
    throw new Error("Runtime pairing response has no Device credential");
  }
  return payload;
}

export class DeviceConnector {
  constructor({
    runtimeUrl,
    token,
    registration,
    toolHost,
    serviceHost = null,
    fetchImpl = globalThis.fetch,
    pollWaitMs = 1_000,
    retryDelayMs = 250,
    now = () => Date.now(),
    logger = () => {}
  }) {
    if (!String(runtimeUrl || "").trim()) {
      throw new Error("Runtime URL is required");
    }
    if (!String(token || "")) {
      throw new Error("Device node token is required");
    }
    if (!toolHost?.invoke) {
      throw new Error("Device Connector requires a Tool Host");
    }

    this.runtimeUrl = normalizeRuntimeUrl(runtimeUrl);
    this.token = String(token);
    this.registration = normalizeNodeRegistration(registration);
    this.toolHost = toolHost;
    this.serviceHost = serviceHost;
    this.fetchImpl = fetchImpl;
    this.pollWaitMs = pollWaitMs;
    this.retryDelayMs = retryDelayMs;
    this.now = now;
    this.logger = logger;
    this.state = "idle";
    this.pollController = null;
    this.loopPromise = null;
    this.active = new Map();
    this.receipts = new Map();
  }

  async start() {
    if (this.state !== "idle") {
      throw new Error(`Device Connector cannot start from ${this.state}`);
    }
    this.state = "starting";
    await this.register();
    this.state = "running";
    this.loopPromise = this.runLoop();
    return this.snapshot();
  }

  async stop() {
    if (this.state === "stopped") return;
    if (this.state === "idle") {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    this.pollController?.abort();
    for (const active of this.active.values()) {
      active.controller.cancel("connector-shutdown");
    }
    this.serviceHost?.close?.();
    await Promise.allSettled([
      this.loopPromise,
      ...[...this.active.values()].map((active) => active.task)
    ].filter(Boolean));
    this.state = "stopped";
  }

  snapshot() {
    return {
      state: this.state,
      nodeId: this.registration.nodeId,
      instanceId: this.registration.instanceId,
      activeInvocations: this.active.size,
      receiptCount: this.receipts.size
    };
  }

  async register() {
    await this.request("/v1/device-nodes/register", {
      method: "POST",
      body: this.registration
    });
  }

  async runLoop() {
    while (this.state === "running") {
      try {
        this.pollController = new globalThis.AbortController();
        const query = new URLSearchParams({
          instanceId: this.registration.instanceId,
          waitMs: String(this.pollWaitMs)
        });
        const response = await this.request(
          `/v1/device-nodes/${encodeURIComponent(
            this.registration.nodeId
          )}/invocations/next?${query}`,
          {
            method: "GET",
            signal: this.pollController.signal,
            allowNoContent: true
          }
        );
        this.pollController = null;
        if (response?.command) this.acceptCommand(response.command);
      } catch (error) {
        this.pollController = null;
        if (this.state !== "running") break;
        if ([401, 403].includes(Number(error?.statusCode))) {
          this.rejectCredential(error);
          break;
        }
        if (error?.statusCode === 409) {
          this.state = "stale";
          this.serviceHost?.close?.();
          for (const active of this.active.values()) {
            active.controller.cancel("connector-replaced");
          }
          this.logger({
            level: "error",
            nodeId: this.registration.nodeId,
            message: `connector replaced: ${errorMessage(error)}`
          });
          break;
        }
        this.logger({
          level: "warn",
          nodeId: this.registration.nodeId,
          message: `poll failed: ${errorMessage(error)}`
        });
        await delay(this.retryDelayMs);
        try {
          await this.register();
        } catch (registrationError) {
          if ([401, 403].includes(Number(registrationError?.statusCode))) {
            this.rejectCredential(registrationError);
            break;
          }
          this.logger({
            level: "warn",
            nodeId: this.registration.nodeId,
            message: `registration failed: ${errorMessage(registrationError)}`
          });
          await delay(this.retryDelayMs);
        }
      }
    }
  }

  rejectCredential(error) {
    this.state = "unauthorized";
    this.serviceHost?.close?.();
    for (const active of this.active.values()) {
      active.controller.cancel("credential-rejected");
    }
    this.logger({
      level: "error",
      nodeId: this.registration.nodeId,
      message: `credential rejected; pair this Device again: ${
        errorMessage(error)
      }`
    });
  }

  acceptCommand(input) {
    const command = validateDeviceCommand(input);
    if (command.type === "tool.cancel") {
      this.active.get(command.invocationId)?.controller.cancel(command.reason);
      return;
    }

    const receipt = this.receipts.get(command.invocationId);
    if (receipt) {
      void this.postResultUntilAccepted(command.invocationId, receipt);
      return;
    }
    if (this.active.has(command.invocationId)) return;

    const controller = new ConnectorCancellationController();
    const active = { controller, task: null };
    active.task = this.executeInvocation(command, controller)
      .finally(() => {
        this.active.delete(command.invocationId);
      });
    this.active.set(command.invocationId, active);
  }

  async executeInvocation(command, controller) {
    let result;
    try {
      if (command.leaseExpiresAt <= this.now()) {
        throw new Error(
          `Tool invocation lease expired before Device execution: ${
            command.invocationId
          }`
        );
      }
      const toolName = String(command.invocation?.toolCall?.name || "");
      const output = toolName === DEVICE_SERVICE_TOOL_NAME
        ? await this.serviceHost?.invoke?.(
            command.invocation.toolCall.arguments,
            controller.signal,
            command.invocation
          )
        : await this.toolHost.invoke(
            command.invocation,
            controller.signal,
            { resourceId: command.resourceId }
          );
      if (!output) {
        throw new Error(`Device service is unavailable: ${toolName}`);
      }
      result = normalizeToolResult(output);
    } catch (error) {
      result = {
        ok: false,
        content: `Device tool failed: ${errorMessage(error)}`,
        error: errorMessage(error)
      };
    }

    if (controller.signal.cancelled || this.state === "stopping") return;
    this.receipts.set(command.invocationId, result);
    await this.postResultUntilAccepted(command.invocationId, result);
  }

  async postResultUntilAccepted(invocationId, result) {
    while (this.state === "running") {
      try {
        await this.request(
          `/v1/device-nodes/${encodeURIComponent(
            this.registration.nodeId
          )}/invocations/${encodeURIComponent(invocationId)}/result`,
          {
            method: "POST",
            body: {
              instanceId: this.registration.instanceId,
              result
            }
          }
        );
        return;
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 409) return;
        if (this.state !== "running") return;
        this.logger({
          level: "warn",
          nodeId: this.registration.nodeId,
          message: `result delivery failed: ${errorMessage(error)}`
        });
        await delay(this.retryDelayMs);
      }
    }
  }

  async request(path, {
    method,
    body,
    signal,
    allowNoContent = false
  }) {
    const response = await this.fetchImpl(new URL(path, this.runtimeUrl), {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal
    });
    if (response.status === 204 && allowNoContent) return null;

    const payload = await responsePayload(response);
    if (!response.ok) {
      const error = new Error(String(
        payload?.error || payload || `HTTP ${response.status}`
      ));
      error.statusCode = response.status;
      throw error;
    }
    return payload;
  }
}
