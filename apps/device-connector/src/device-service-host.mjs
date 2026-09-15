import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { formatByteSize, parseByteSize } from "../../../packages/node-protocol/src/index.mjs";
import { normalizeLocalToolsUrl } from "./device-setup.mjs";
import { PtyWebRtcHost } from "./pty-webrtc-host.mjs";

export const DEVICE_SERVICE_TOOL_NAME = "zion.internal.deviceService";

export const DEVICE_SERVICE_CAPABILITY = Object.freeze({
  name: DEVICE_SERVICE_TOOL_NAME,
  version: "1",
  risk: "execute",
  description: "Internal authenticated relay for Device-hosted UI services.",
  inputSchema: {
    type: "object",
    properties: {
      service: {
        type: "string",
        enum: ["local-tools", "plugin-service", "device-access"]
      },
      method: { type: "string" },
      path: { type: "string" },
      headers: { type: "object" },
      bodyBase64: { type: "string" }
    },
    required: ["service", "method", "path"],
    additionalProperties: false
  },
  hostKind: "device-service"
});

const LOCAL_TOOLS_ROUTES = Object.freeze([
  { methods: ["GET"], path: /^\/health$/ },
  { methods: ["GET", "POST"], path: /^\/sessions$/ },
  { methods: ["GET", "DELETE"], path: /^\/sessions\/[^/]+$/ },
  { methods: ["POST"], path: /^\/sessions\/[^/]+\/(?:activate|exec)$/ },
  { methods: ["GET"], path: /^\/machines$/ },
  { methods: ["GET", "PATCH"], path: /^\/machines\/[^/]+$/ },
  { methods: ["GET"], path: /^\/files\/(?:read|read-jsonl|entries|glob|grep)$/ },
  { methods: ["POST"], path: /^\/files\/(?:write|append-jsonl)$/ }
]);

const PLUGIN_SERVICE_ROUTES = Object.freeze([
  { methods: ["GET"], path: /^\/health$/ },
  { methods: ["GET"], path: /^\/plugins\/?$/ },
  { methods: ["GET"], path: /^\/plugins\/search$/ },
  { methods: ["GET", "DELETE"], path: /^\/plugins\/[^/]+$/ },
  { methods: ["GET"], path: /^\/plugins\/[^/]+\/download$/ },
  { methods: ["GET"], path: /^\/plugins\/dev\/list$/ },
  { methods: ["POST"], path: /^\/plugins\/dev\/(?:start|stop)$/ },
  { methods: ["GET"], path: /^\/plugins\/dev\/[^/]+\/.+$/ }
]);

const DEVICE_ACCESS_ROUTES = Object.freeze([
  { methods: ["GET", "PATCH"], path: /^\/policy$/ },
  { methods: ["POST"], path: /^\/refresh$/ },
  { methods: ["POST"], path: /^\/requests\/[^/]+\/(?:approve|reject)$/ }
]);

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "x-zion-dev-id",
  "x-zion-dev-mode"
]);

function serviceRoutes(service) {
  if (service === "local-tools") return LOCAL_TOOLS_ROUTES;
  if (service === "plugin-service") return PLUGIN_SERVICE_ROUTES;
  if (service === "device-access") return DEVICE_ACCESS_ROUTES;
  return null;
}

function normalizeServicePath(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    throw new Error("Device service path must be origin-relative");
  }
  const parsed = new URL(raw, "http://device.invalid");
  if (parsed.origin !== "http://device.invalid") {
    throw new Error("Device service path must not contain an origin");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function assertAllowedRoute(service, method, path) {
  const routes = serviceRoutes(service);
  if (!routes) throw new Error(`Unsupported Device service: ${service}`);
  const pathname = new URL(path, "http://device.invalid").pathname;
  const allowed = routes.some((route) =>
    route.methods.includes(method) && route.path.test(pathname)
  );
  if (!allowed) {
    throw new Error(`Device service route is not allowed: ${method} ${pathname}`);
  }
}

function forwardedHeaders(value) {
  const headers = {};
  for (const [name, headerValue] of Object.entries(value || {})) {
    const key = String(name || "").trim().toLowerCase();
    if (!FORWARDED_REQUEST_HEADERS.has(key)) continue;
    headers[key] = String(headerValue || "");
  }
  return headers;
}

function serviceResponse(status, value = null, contentType = "application/json") {
  const body = value == null
    ? Buffer.alloc(0)
    : Buffer.isBuffer(value)
      ? value
      : Buffer.from(
          typeof value === "string" ? value : JSON.stringify(value),
          "utf8"
        );
  return {
    ok: true,
    content: JSON.stringify({
      status,
      headers: { "content-type": contentType },
      bodyBase64: body.toString("base64")
    })
  };
}

function parseJsonBody(body) {
  if (!body?.length) return {};
  try {
    const value = JSON.parse(body.toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function localFileInvocation(path, method, body, invocation = {}) {
  const url = new URL(path, "http://device.invalid");
  const toolByPath = {
    "/files/read": "read",
    "/files/read-jsonl": "read",
    "/files/entries": "tree",
    "/files/glob": "glob",
    "/files/grep": "grep",
    "/files/write": "write",
    "/files/append-jsonl": "write"
  };
  const toolName = toolByPath[url.pathname];
  if (!toolName) return null;
  const payload = ["GET", "HEAD"].includes(method)
    ? Object.fromEntries(url.searchParams.entries())
    : parseJsonBody(body);
  return {
    ...invocation,
    toolCall: {
      id: invocation.toolCall?.id || `device-service:${toolName}`,
      name: toolName,
      arguments: payload
    }
  };
}

function localSessionRoute(path) {
  const pathname = new URL(path, "http://device.invalid").pathname;
  const match = pathname.match(/^\/sessions\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function ptyRelayRoute(path) {
  const parsed = new URL(path, "http://device.invalid");
  const open = parsed.pathname.match(
    /^\/sessions\/([^/]+)\/pty\/relay\/open$/
  );
  if (open) {
    return {
      action: "open",
      sessionId: decodeURIComponent(open[1]),
      query: parsed.searchParams
    };
  }
  const channel = parsed.pathname.match(
    /^\/sessions\/([^/]+)\/pty\/relay\/([^/]+)(?:\/(input|events))?$/
  );
  if (!channel) return null;
  return {
    action: channel[3] || "close",
    sessionId: decodeURIComponent(channel[1]),
    channelId: decodeURIComponent(channel[2]),
    query: parsed.searchParams
  };
}

function ptyWebRtcRoute(path) {
  const parsed = new URL(path, "http://device.invalid");
  const offer = parsed.pathname.match(
    /^\/sessions\/([^/]+)\/pty\/webrtc\/offer$/
  );
  if (offer) {
    return {
      action: "offer",
      sessionId: decodeURIComponent(offer[1])
    };
  }
  const channel = parsed.pathname.match(
    /^\/sessions\/([^/]+)\/pty\/webrtc\/([^/]+)$/
  );
  if (!channel) return null;
  return {
    action: "close",
    sessionId: decodeURIComponent(channel[1]),
    channelId: decodeURIComponent(channel[2])
  };
}

export class DeviceServiceHost {
  constructor({
    localToolsUrl = "http://127.0.0.1:8765",
    pluginServiceUrl = "http://127.0.0.1:8767",
    fetchImpl = globalThis.fetch,
    webSocketFactory = (url) => new globalThis.WebSocket(url),
    requestTimeoutMs = 30_000,
    maxRequestBytes = 1024 * 1024,
    maxResponseBytes = 4 * 1024 * 1024,
    maxPtyChannels = 8,
    maxPtyQueueBytes = 1024 * 1024,
    ptyIdleTimeoutMs = 10 * 60_000,
    ptyWebRtcHost,
    deviceAccess = null,
    dataFiles = null
  } = {}) {
    this.serviceUrls = new Map([
      ["local-tools", normalizeLocalToolsUrl(localToolsUrl)],
      ["plugin-service", normalizeLocalToolsUrl(pluginServiceUrl)]
    ]);
    this.fetchImpl = fetchImpl;
    this.webSocketFactory = webSocketFactory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRequestBytes = parseByteSize(maxRequestBytes, {
      label: "Device service request body limit"
    });
    this.maxResponseBytes = maxResponseBytes;
    this.maxPtyChannels = maxPtyChannels;
    this.maxPtyQueueBytes = maxPtyQueueBytes;
    this.ptyIdleTimeoutMs = ptyIdleTimeoutMs;
    this.deviceAccess = deviceAccess;
    this.dataFiles = dataFiles;
    this.ptyChannels = new Map();
    this.ptyWebRtcHost = ptyWebRtcHost || new PtyWebRtcHost({
      localToolsUrl: this.serviceUrls.get("local-tools"),
      webSocketFactory,
      idleTimeoutMs: ptyIdleTimeoutMs,
      maxChannels: maxPtyChannels,
      maxBufferedBytes: maxPtyQueueBytes
    });
  }

  async invoke(input = {}, signal, invocation = {}) {
    const service = String(input.service || "").trim();
    const method = String(input.method || "GET").trim().toUpperCase();
    const path = normalizeServicePath(input.path);
    const body = input.bodyBase64
      ? Buffer.from(String(input.bodyBase64), "base64")
      : null;
    if (body && body.length > this.maxRequestBytes) {
      throw new Error(`Device service request exceeds ${formatByteSize(this.maxRequestBytes)}`);
    }
    if (service === "device-access") {
      assertAllowedRoute(service, method, path);
      if (!this.deviceAccess?.handleRequest) {
        return serviceResponse(503, {
          error: "Device access manager is unavailable"
        });
      }
      try {
        const result = await this.deviceAccess.handleRequest({
          method,
          path,
          body: parseJsonBody(body)
        });
        return serviceResponse(result?.status || 200, result?.body || {});
      } catch (error) {
        return serviceResponse(Number(error?.statusCode || 500), {
          error: error?.message || String(error)
        });
      }
    }
    if (service === "local-tools" && this.deviceAccess) {
      const fileInvocation = localFileInvocation(path, method, body, invocation);
      if (fileInvocation) {
        await this.deviceAccess.authorizeInvocation(fileInvocation);
      }
      const sessionId = localSessionRoute(path);
      if (sessionId) {
        await this.deviceAccess.authorizeInvocation({
          ...invocation,
          toolCall: {
            id: invocation.toolCall?.id || "device-service:terminal",
            name: "Bash",
            arguments: { command: "device-service", session_id: sessionId }
          }
        });
      }
    }
    const webRtc = service === "local-tools" ? ptyWebRtcRoute(path) : null;
    if (webRtc) return this.invokePtyWebRtc(webRtc, method, body, signal);
    const relay = service === "local-tools" ? ptyRelayRoute(path) : null;
    if (relay) return this.invokePtyRelay(relay, method, body, signal);
    assertAllowedRoute(service, method, path);

    if (service === "local-tools" && this.dataFiles && this.deviceAccess) {
      const file = localFileInvocation(path, method, body, invocation);
      if (file) {
        try {
          signal?.throwIfCancelled?.();
          const operation = new URL(path, "http://device.invalid").pathname.split("/").at(-1);
          const payload = await this.dataFiles.handle(operation, file.toolCall.arguments, { signal });
          if (payload) return serviceResponse(200, payload);
          if (new URL(path, "http://device.invalid").searchParams.get("plugin_data_version") === "1") {
            return serviceResponse(400, { error: "Path is outside configured plugin data storage" });
          }
        } catch (error) {
          return serviceResponse(error.statusCode || 500, { ok: false, error: error.message });
        }
      }
    }

    const controller = new globalThis.AbortController();
    const cancellation = signal?.onCancel?.(() => controller.abort())
      || { dispose() {} };
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const baseUrl = this.serviceUrls.get(service);
      const response = await this.fetchImpl(new URL(path, baseUrl), {
        method,
        headers: forwardedHeaders(input.headers),
        ...(body ? { body } : {}),
        signal: controller.signal
      });
      let responseBody = Buffer.from(await response.arrayBuffer());
      if (responseBody.length > this.maxResponseBytes) {
        throw new Error("Device service response exceeds the size limit");
      }
      if (
        service === "local-tools"
        && method === "GET"
        && new URL(path, "http://device.invalid").pathname === "/sessions"
        && this.deviceAccess
        && response.ok
      ) {
        const payload = parseJsonBody(responseBody);
        const state = await this.deviceAccess.state();
        const deviceAllowed = new Set(state.allowedTerminalSessionIds || []);
        const requested = Array.isArray(
          invocation.policy?.allowedTerminalSessionIds
        )
          ? invocation.policy.allowedTerminalSessionIds.map(String)
          : [];
        const allowed = requested.length
          ? new Set(requested.filter((id) => deviceAllowed.has(id)))
          : deviceAllowed;
        responseBody = Buffer.from(JSON.stringify({
          ...payload,
          sessions: (Array.isArray(payload?.sessions) ? payload.sessions : [])
            .filter((session) => allowed.has(String(
              session?.id || session?.session_id || ""
            )))
        }), "utf8");
      }
      return {
        ok: true,
        content: JSON.stringify({
          status: response.status,
          headers: {
            "content-type": response.headers.get("content-type") || "",
            "content-disposition":
              response.headers.get("content-disposition") || ""
          },
          bodyBase64: responseBody.toString("base64")
        })
      };
    } finally {
      clearTimeout(timer);
      cancellation.dispose();
    }
  }

  async invokePtyWebRtc(route, method, body, signal) {
    if (route.action === "offer") {
      if (method !== "POST") return serviceResponse(405, { error: "Method not allowed" });
      const result = await this.ptyWebRtcHost.acceptOffer(
        route.sessionId,
        randomUUID(),
        parseJsonBody(body),
        signal
      );
      return serviceResponse(201, result);
    }
    if (method !== "DELETE") return serviceResponse(405, { error: "Method not allowed" });
    this.ptyWebRtcHost.close(route.channelId);
    return serviceResponse(204);
  }

  async invokePtyRelay(route, method, body, signal) {
    this.prunePtyChannels();
    if (route.action === "open") {
      if (method !== "POST") return serviceResponse(405, { error: "Method not allowed" });
      return this.openPtyChannel(route.sessionId, parseJsonBody(body), signal);
    }
    const channel = this.ptyChannels.get(route.channelId);
    if (!channel || channel.sessionId !== route.sessionId) {
      return serviceResponse(404, { error: "PTY relay channel not found" });
    }
    channel.lastActivityAt = Date.now();
    if (route.action === "input") {
      if (method !== "POST") return serviceResponse(405, { error: "Method not allowed" });
      const input = parseJsonBody(body);
      if (channel.closed || channel.socket.readyState !== 1) {
        return serviceResponse(409, { error: "PTY relay channel is closed" });
      }
      if (input.type === "resize") {
        channel.socket.send(JSON.stringify({
          type: "resize",
          cols: Math.max(1, Number(input.cols) || 80),
          rows: Math.max(1, Number(input.rows) || 24)
        }));
      } else {
        channel.socket.send(String(input.data || ""));
      }
      return serviceResponse(204);
    }
    if (route.action === "events") {
      if (method !== "GET") return serviceResponse(405, { error: "Method not allowed" });
      const waitMs = Math.min(
        20_000,
        Math.max(0, Number(route.query.get("waitMs")) || 15_000)
      );
      if (!channel.events.length && !channel.closed && waitMs > 0) {
        await this.waitForPtyEvents(channel, waitMs, signal);
      }
      const events = channel.events.splice(0);
      channel.queuedBytes = 0;
      return serviceResponse(200, {
        events,
        closed: channel.closed
      });
    }
    if (method !== "DELETE") return serviceResponse(405, { error: "Method not allowed" });
    this.closePtyChannel(route.channelId);
    return serviceResponse(204);
  }

  async openPtyChannel(sessionId, input, signal) {
    if (this.ptyChannels.size >= this.maxPtyChannels) {
      return serviceResponse(429, { error: "Too many PTY relay channels" });
    }
    const baseUrl = this.serviceUrls.get("local-tools");
    const socketUrl = new URL(
      `/sessions/${encodeURIComponent(sessionId)}/pty/ws`,
      baseUrl
    );
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.webSocketFactory(socketUrl.toString());
    const channelId = randomUUID();
    const channel = {
      channelId,
      sessionId,
      socket,
      events: [],
      queuedBytes: 0,
      waiters: new Set(),
      closed: false,
      lastActivityAt: Date.now()
    };
    this.ptyChannels.set(channelId, channel);
    try {
      await this.waitForPtyOpen(channel, signal);
      socket.addEventListener("message", (event) => {
        void this.acceptPtyMessage(channel, event?.data);
      });
      socket.addEventListener("close", () => {
        channel.closed = true;
        this.pushPtyEvent(channel, { type: "close" });
      });
      socket.addEventListener("error", () => {
        this.pushPtyEvent(channel, {
          type: "error",
          message: "Local PTY WebSocket failed"
        });
      });
      socket.send(JSON.stringify({
        type: "resize",
        cols: Math.max(1, Number(input.cols) || 80),
        rows: Math.max(1, Number(input.rows) || 24)
      }));
      return serviceResponse(201, { channelId });
    } catch (error) {
      this.closePtyChannel(channelId);
      throw error;
    }
  }

  waitForPtyOpen(channel, signal) {
    if (channel.socket.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      let cancellation = { dispose() {} };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancellation.dispose();
        channel.socket.removeEventListener("open", onOpen);
        channel.socket.removeEventListener("error", onError);
        channel.socket.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = () => finish(new Error("Cannot open local PTY WebSocket"));
      const onClose = () => finish(new Error("Local PTY WebSocket closed"));
      timer = setTimeout(
        () => finish(new Error("Local PTY WebSocket timed out")),
        this.requestTimeoutMs
      );
      cancellation = signal?.onCancel?.(() =>
        finish(new Error("PTY relay open cancelled"))
      ) || { dispose() {} };
      channel.socket.addEventListener("open", onOpen, { once: true });
      channel.socket.addEventListener("error", onError, { once: true });
      channel.socket.addEventListener("close", onClose, { once: true });
    });
  }

  async acceptPtyMessage(channel, value) {
    let body;
    if (typeof value === "string") body = Buffer.from(value, "utf8");
    else if (value instanceof ArrayBuffer) body = Buffer.from(value);
    else if (ArrayBuffer.isView(value)) {
      body = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else if (value?.arrayBuffer) {
      body = Buffer.from(await value.arrayBuffer());
    } else {
      return;
    }
    this.pushPtyEvent(channel, {
      type: "data",
      dataBase64: body.toString("base64")
    }, body.length);
  }

  pushPtyEvent(channel, event, bytes = 0) {
    if (!this.ptyChannels.has(channel.channelId)) return;
    channel.events.push(event);
    channel.queuedBytes += bytes;
    if (channel.queuedBytes > this.maxPtyQueueBytes) {
      channel.events = [{
        type: "error",
        message: "PTY relay output queue exceeded the size limit"
      }];
      channel.queuedBytes = 0;
      channel.closed = true;
      try {
        channel.socket.close(1009, "PTY relay queue overflow");
      } catch {
        // The socket may already be closed.
      }
    }
    for (const waiter of [...channel.waiters]) waiter();
    channel.waiters.clear();
  }

  waitForPtyEvents(channel, waitMs, signal) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      let cancellation = { dispose() {} };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancellation.dispose();
        channel.waiters.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, waitMs);
      cancellation = signal?.onCancel?.(finish) || { dispose() {} };
      channel.waiters.add(finish);
    });
  }

  closePtyChannel(channelId) {
    const channel = this.ptyChannels.get(channelId);
    if (!channel) return;
    this.ptyChannels.delete(channelId);
    channel.closed = true;
    for (const waiter of [...channel.waiters]) waiter();
    channel.waiters.clear();
    try {
      channel.socket.close(1000, "PTY relay closed");
    } catch {
      // The socket may already be closed.
    }
  }

  prunePtyChannels(now = Date.now()) {
    for (const [channelId, channel] of this.ptyChannels) {
      if (
        channel.closed
        || now - channel.lastActivityAt > this.ptyIdleTimeoutMs
      ) {
        this.closePtyChannel(channelId);
      }
    }
  }

  close() {
    for (const channelId of [...this.ptyChannels.keys()]) {
      this.closePtyChannel(channelId);
    }
    this.ptyWebRtcHost.closeAll();
  }
}
