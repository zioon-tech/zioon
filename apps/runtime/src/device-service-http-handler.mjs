import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { parseByteSize, requestBodyLimitError } from "../../../packages/node-protocol/src/index.mjs";
import { requirePluginDataCapability } from "./plugin-data-capability.mjs";

const DEVICE_SERVICE_TOOL_NAME = "zion.internal.deviceService";
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
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

function errorPayload(error) {
  const payload = { error: error?.message || String(error) };
  if (error?.code) payload.code = String(error.code);
  if (Number.isSafeInteger(error?.limitBytes)) payload.limitBytes = error.limitBytes;
  if (error?.limit) payload.limit = String(error.limit);
  if (Array.isArray(error?.hints)) payload.hints = error.hints.map(String);
  return payload;
}

async function readBody(request, maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      throw requestBodyLimitError("Device service request", maxRequestBytes);
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

function ptyWebSocketRoute(pathname) {
  const match = String(pathname || "").match(/^\/sessions\/([^/]+)\/pty\/ws$/);
  return match ? { sessionId: decodeURIComponent(match[1]) } : null;
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

function writeUpgradeError(socket, status, message) {
  const reason = message || "WebSocket upgrade failed";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + "Connection: close\r\n"
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(reason)}\r\n`
    + "\r\n"
    + reason
  );
  socket.destroy();
}

function normalizeServiceBaseUrls(serviceBaseUrls = {}) {
  return Object.fromEntries(
    Object.entries(serviceBaseUrls || {})
      .map(([service, value]) => [
        service,
        String(value || "").trim().replace(/\/+$/, "")
      ])
      .filter(([, value]) => value)
  );
}

export function createDeviceServiceWebSocketHandler({
  broker = null,
  authorize = null,
  serviceBaseUrls = {},
  webSocketFactory = (url, options) => new WebSocket(url, options)
} = {}) {
  if (broker?.invoke) return null;
  const directServiceUrls = normalizeServiceBaseUrls(serviceBaseUrls);
  const localToolsUrl = directServiceUrls["local-tools"];
  if (!localToolsUrl) return null;
  const webSocketServer = new WebSocketServer({ noServer: true });

  return async function handleDeviceServiceWebSocket(request, socket, head) {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "127.0.0.1"}`
    );
    const matched = route(url.pathname);
    if (matched?.service !== "local-tools") return false;
    const pty = ptyWebSocketRoute(matched.path);
    if (!pty) return false;

    try {
      await authorize?.(request, matched);
    } catch (error) {
      writeUpgradeError(socket, Number(error?.statusCode || 403), error?.message || "Forbidden");
      return true;
    }

    const upstreamUrl = new URL(
      `${matched.path}${url.search}`,
      `${localToolsUrl}/`
    );
    upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
    const upstream = webSocketFactory(upstreamUrl, {
      headers: requestHeaders(request)
    });
    let client = null;
    const pending = [];
    let upstreamOpen = false;
    let closed = false;
    const closeBoth = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      try { client?.close(code, reason); } catch {}
      try { upstream.close(code, reason); } catch {}
    };

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      client = webSocket;
      client.on("message", (data, isBinary) => {
        if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
          return;
        }
        pending.push({ data, isBinary });
      });
      client.on("close", () => closeBoth());
      client.on("error", () => closeBoth(1011, "Client WebSocket failed"));
      webSocketServer.emit("connection", client, request);
    });

    upstream.on("open", () => {
      upstreamOpen = true;
      while (pending.length && upstream.readyState === WebSocket.OPEN) {
        const item = pending.shift();
        upstream.send(item.data, { binary: item.isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (client?.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    upstream.on("close", (code, reason) => closeBoth(code, reason.toString()));
    upstream.on("error", (error) => {
      if (!client) writeUpgradeError(socket, 502, error?.message || "Local terminal WebSocket failed");
      else closeBoth(1011, error?.message || "Local terminal WebSocket failed");
    });
    return true;
  };
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

function localToolsFileDiscovery(matched, method, url) {
  if (matched.service !== "local-tools" || method !== "GET") return false;
  if (!["/files/read", "/files/entries"].includes(matched.path)) return false;
  return !!String(url.searchParams.get("path") || "").trim()
    && !url.searchParams.get("session_id");
}

function annotateNodePayload(payload, target) {
  let body;
  try {
    body = JSON.parse(responseBodyFromPayload(payload).toString("utf8"));
  } catch {
    return payload;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return payload;
  const registration = target.node.registration;
  return jsonPayload(payload.status, {
    ...body,
    node_id: registration.nodeId,
    node_label: registration.label || registration.nodeId
  });
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
  dataFiles = null,
  fetchImpl = globalThis.fetch,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES
} = {}) {
  const hasBroker = !!broker?.invoke;
  const requestBodyLimit = parseByteSize(maxRequestBytes, {
    label: "Device service request body limit"
  });
  const directServiceUrls = Object.fromEntries(
    Object.entries(normalizeServiceBaseUrls(serviceBaseUrls))
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
        : await readBody(request, requestBodyLimit);
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
        if (dataFiles && matched.service === "local-tools") {
          const payload = await dataFiles.handle(matched.path.replace(/^\/files\//, ""),
            body ? JSON.parse(body.toString("utf8")) : Object.fromEntries(url.searchParams),
            { signal: cancellation.signal });
          if (payload) {
            json(response, 200, payload);
            return true;
          }
          if (url.searchParams.get("plugin_data_version") === "1") {
            json(response, 400, { error: "Path is outside configured plugin data storage" });
            return true;
          }
        }
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
      if (url.searchParams.get("plugin_data_version") === "1") {
        requirePluginDataCapability(broker, runContext);
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
      const discoverFileNode = !runContext.target
        && localToolsFileDiscovery(matched, method, url);
      if (
        (fanoutKind || discoverFileNode)
        && typeof broker.availableTargets === "function"
      ) {
        const targets = broker.availableTargets(
          runContext.projectId,
          DEVICE_SERVICE_TOOL_NAME
        );
        if (targets.length) {
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
            if (!discoverFileNode && payload.status !== 404) break;
          }
          if (discoverFileNode) {
            if (payloads.length === 1) {
              writeDeviceServicePayload(
                response,
                method,
                annotateNodePayload(payloads[0].payload, payloads[0].target)
              );
              return true;
            }
            if (payloads.length > 1) {
              json(response, 409, {
                error: "The path exists on multiple Nodes; select its source Node once.",
                code: "ambiguous_file_node",
                nodes: payloads.map(({ target }) => ({
                  nodeId: target.node.registration.nodeId,
                  label: target.node.registration.label
                    || target.node.registration.nodeId
                }))
              });
              return true;
            }
            if (fallbackPayload) {
              writeDeviceServicePayload(response, method, fallbackPayload);
              return true;
            }
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
        json(response, status, errorPayload(error));
      } else {
        response.end();
      }
    }
    return true;
  };
}
