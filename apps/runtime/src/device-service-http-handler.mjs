import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

const DEVICE_SERVICE_TOOL_NAME = "zion.internal.deviceService";
const MAX_REQUEST_BYTES = 1024 * 1024;
const FORWARDED_HEADERS = [
  "accept",
  "content-type",
  "x-zion-dev-id",
  "x-zion-dev-mode"
];

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Device service request exceeds 1 MiB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

function createCancellation(request, response) {
  const listeners = new Set();
  let reason;
  const cancel = (nextReason) => {
    if (reason) return;
    reason = nextReason;
    for (const listener of [...listeners]) listener(reason);
    listeners.clear();
  };
  request.once("aborted", () => cancel("browser-request-aborted"));
  response.once("close", () => {
    if (!response.writableEnded) cancel("browser-response-closed");
  });
  return {
    signal: {
      get cancelled() {
        return !!reason;
      },
      get reason() {
        return reason;
      },
      throwIfCancelled() {
        if (reason) throw new Error(`Device service request cancelled: ${reason}`);
      },
      onCancel(listener) {
        if (reason) {
          listener(reason);
          return { dispose() {} };
        }
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    }
  };
}

function route(pathname) {
  const match = String(pathname || "").match(
    /^\/v1\/device-services\/(local-tools|plugin-service|device-access)(\/.*)?$/
  );
  return match
    ? { service: match[1], path: match[2] || "/" }
    : null;
}

function requestHeaders(request) {
  const headers = {};
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers?.[name];
    if (value == null) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return headers;
}

function responsePayload(result) {
  if (!result?.ok) {
    const error = new Error(result?.error || "Device service request failed");
    error.statusCode = 502;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(String(result.content || ""));
  } catch {
    const error = new Error("Device service returned an invalid response");
    error.statusCode = 502;
    throw error;
  }
  const status = Number(payload?.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    const error = new Error("Device service returned an invalid status");
    error.statusCode = 502;
    throw error;
  }
  return { ...payload, status };
}

function responseBodyFromPayload(payload) {
  return payload.bodyBase64
    ? Buffer.from(String(payload.bodyBase64), "base64")
    : Buffer.alloc(0);
}

function writeDeviceServicePayload(response, method, payload) {
  const responseBody = responseBodyFromPayload(payload);
  const headers = {
    "content-type": String(
      payload.headers?.["content-type"] || "application/octet-stream"
    ),
    "content-length": responseBody.length,
    "cache-control": "no-store"
  };
  const disposition = String(
    payload.headers?.["content-disposition"] || ""
  ).trim();
  if (disposition) headers["content-disposition"] = disposition;
  response.writeHead(payload.status, headers);
  if (method === "HEAD") response.end();
  else response.end(responseBody);
}

function jsonPayload(status, value) {
  const body = JSON.stringify(value);
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyBase64: Buffer.from(body).toString("base64")
  };
}

function pluginServiceFanoutKind(matched, method) {
  if (matched.service !== "plugin-service") return "";
  if (method !== "GET") return "";
  if (matched.path === "/plugins" || matched.path === "/plugins/search") {
    return "list";
  }
  if (matched.path === "/plugins/dev/list") return "dev-list";
  if (/^\/plugins\/[^/]+\/download$/.test(matched.path)) return "download";
  return "";
}

function mergePluginPayloads(items, kind = "list") {
  const merged = [];
  const seen = new Set();
  for (const item of items) {
    if (item.payload.status < 200 || item.payload.status >= 300) continue;
    let body;
    try {
      body = JSON.parse(responseBodyFromPayload(item.payload).toString("utf8"));
    } catch {
      continue;
    }
    const data = kind === "dev-list"
      ? body?.data?.sessions
      : body?.data;
    if (body?.success === false || !Array.isArray(data)) continue;
    for (const plugin of data) {
      const id = String(plugin?.id || "");
      const version = String(
        plugin?.metadata?.version
        || plugin?.version
        || plugin?.devId
        || ""
      );
      const hash = String(plugin?.file_hash || "");
      const key = `${id}\0${version}\0${hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        ...plugin,
        node_id: item.target.node.registration.nodeId
      });
    }
  }
  if (kind === "dev-list") {
    return jsonPayload(200, {
      success: true,
      data: { sessions: merged }
    });
  }
  return jsonPayload(200, {
    success: true,
    data: merged,
    total: merged.length
  });
}

export function createDeviceServiceHttpHandler({
  broker = null,
  authorize = null,
  terminalService = null,
  serviceBaseUrls = {},
  fetchImpl = globalThis.fetch
} = {}) {
  const hasBroker = !!broker?.invoke;
  const directServiceUrls = Object.fromEntries(
    Object.entries(serviceBaseUrls || {})
      .map(([service, value]) => [
        service,
        String(value || "").trim().replace(/\/+$/, "")
      ])
      .filter(([, value]) => value)
  );
  if (!hasBroker && !terminalService && !Object.keys(directServiceUrls).length) {
    throw new Error("Device service HTTP handler requires a Broker or local service");
  }

  return async function handleDeviceService(request, response, url) {
    const matched = route(url.pathname);
    if (!matched) return false;

    try {
      await authorize?.(request, matched);
      const method = String(request.method || "GET").toUpperCase();
      const body = ["GET", "HEAD"].includes(method)
        ? null
        : await readBody(request);
      const cancellation = createCancellation(request, response);
      const runContext = {
        projectId: url.searchParams.get("project_id") || "",
        signal: cancellation.signal,
        ...(url.searchParams.get("node_id") ? {
          target: { nodeId: url.searchParams.get("node_id") }
        } : {})
      };
      if (
        terminalService
        && matched.service === "local-tools"
        && method === "GET"
        && ["/sessions", "/machines"].includes(matched.path)
      ) {
        const inventory = await terminalService.listInventory({ runContext });
        json(response, 200, matched.path === "/sessions"
          ? { sessions: inventory.sessions, nodes: inventory.nodes }
          : { machines: inventory.machines, nodes: inventory.nodes });
        return true;
      }
      if (
        terminalService
        && matched.service === "local-tools"
        && method === "POST"
        && matched.path === "/sessions"
      ) {
        const payload = body?.length ? JSON.parse(body.toString("utf8")) : {};
        const session = await terminalService.createSession({ payload, runContext });
        json(response, 200, { session });
        return true;
      }
      if (!hasBroker) {
        const baseUrl = directServiceUrls[matched.service];
        if (!baseUrl) {
          const error = new Error(
            `${matched.service} is unavailable in local Runtime mode`
          );
          error.statusCode = 503;
          throw error;
        }
        const controller = new AbortController();
        const cancellationRegistration = cancellation.signal.onCancel(
          (reason) => controller.abort(reason)
        );
        try {
          const upstream = await fetchImpl(
            new URL(
              `${matched.path.replace(/^\/+/, "")}${url.search}`,
              `${baseUrl}/`
            ),
            {
              method,
              headers: requestHeaders(request),
              signal: controller.signal,
              ...(
                body && !["GET", "HEAD"].includes(method)
                  ? { body }
                  : {}
              )
            }
          );
          const responseBody = Buffer.from(await upstream.arrayBuffer());
          const headers = {
            "content-type": String(
              upstream.headers.get("content-type")
              || "application/octet-stream"
            ),
            "content-length": responseBody.length,
            "cache-control": "no-store"
          };
          const disposition = String(
            upstream.headers.get("content-disposition") || ""
          ).trim();
          if (disposition) headers["content-disposition"] = disposition;
          response.writeHead(upstream.status, headers);
          if (method === "HEAD") response.end();
          else response.end(responseBody);
        } finally {
          cancellationRegistration.dispose();
        }
        return true;
      }
      const invokeBroker = async (target = runContext.target) => {
        const invocationId = `device-service:${randomUUID()}`;
        const result = await broker.invoke({
          invocationId,
          runId: invocationId,
          attemptId: invocationId,
          projectId: runContext.projectId,
          ...(target ? { target } : {}),
          policy: {
            preset: "trusted-automation",
            allowedTools: [DEVICE_SERVICE_TOOL_NAME]
          },
          toolCall: {
            id: invocationId,
            name: DEVICE_SERVICE_TOOL_NAME,
            arguments: {
              service: matched.service,
              method,
              path: `${matched.path}${url.search}`,
              headers: requestHeaders(request),
              ...(body ? { bodyBase64: body.toString("base64") } : {})
            }
          }
        }, cancellation.signal);
        return responsePayload(result);
      };
      const fanoutKind = !runContext.target
        ? pluginServiceFanoutKind(matched, method)
        : "";
      if (fanoutKind && typeof broker.availableTargets === "function") {
        const targets = broker.availableTargets(
          runContext.projectId,
          DEVICE_SERVICE_TOOL_NAME
        );
        if (targets.length > 1) {
          const payloads = [];
          let fallbackPayload = null;
          for (const target of targets) {
            const payload = await invokeBroker({
              nodeId: target.node.registration.nodeId,
              resourceId: target.resource?.resourceId
            });
            if (payload.status >= 200 && payload.status < 300) {
              if (fanoutKind === "download") {
                writeDeviceServicePayload(response, method, payload);
                return true;
              }
              payloads.push({ target, payload });
              continue;
            }
            fallbackPayload = fallbackPayload || payload;
            if (payload.status !== 404) break;
          }
          const payload = payloads.length
            ? mergePluginPayloads(payloads, fanoutKind)
            : fallbackPayload;
          if (payload) {
            writeDeviceServicePayload(response, method, payload);
            return true;
          }
        }
      }
      const payload = await invokeBroker();
      writeDeviceServicePayload(response, method, payload);
    } catch (error) {
      if (!response.headersSent) {
        const status = Number(
          error?.statusCode
          || (/No online Node/.test(String(error?.message || "")) ? 503 : 500)
        );
        json(response, status, { error: error?.message || String(error) });
      } else {
        response.end();
      }
    }
    return true;
  };
}
