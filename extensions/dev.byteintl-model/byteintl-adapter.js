import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8771;
const DEFAULT_MODEL = "gpt-6-astra";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_UPSTREAM_URL =
  "https://aidp.byteintl.net/api/modelhub/online/v2/crawl";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return number;
}

function adapterPort(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_PORT;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 65_535) {
    throw new Error(`Invalid ByteIntl adapter port: ${value}`);
  }
  return number;
}

function normalizeUpstreamUrl(value) {
  const url = new URL(String(value || DEFAULT_UPSTREAM_URL));
  if (url.protocol !== "https:") {
    throw new Error("ByteIntl upstream URL must use HTTPS");
  }
  if (url.username || url.password || url.searchParams.has("ak")) {
    throw new Error(
      "ByteIntl upstream URL must not contain credentials; use the model profile API Key"
    );
  }
  url.hash = "";
  return url.toString();
}

function normalizeHost(value) {
  const host = String(value || DEFAULT_HOST).trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("ByteIntl adapter must listen on a loopback host");
  }
  return host;
}

export function normalizeByteIntlAdapterConfig(source = {}) {
  const model = String(source.model || DEFAULT_MODEL).trim();
  if (!model) throw new Error("ByteIntl model is required");
  return Object.freeze({
    upstreamUrl: normalizeUpstreamUrl(source.upstreamUrl),
    model,
    host: normalizeHost(source.host),
    port: adapterPort(source.port),
    timeoutMs: positiveInteger(
      source.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      30 * 60 * 1000
    ),
    maxRequestBytes: positiveInteger(
      source.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      16 * 1024 * 1024
    ),
    maxResponseBytes: positiveInteger(
      source.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      64 * 1024 * 1024
    ),
    defaultMaxTokens: positiveInteger(
      source.defaultMaxTokens,
      500,
      1024 * 1024
    )
  });
}

export function byteIntlAdapterConfigFromEnvironment(
  environment = globalThis.process?.env || {}
) {
  return normalizeByteIntlAdapterConfig({
    upstreamUrl: environment.ZION_BYTEINTL_UPSTREAM_URL,
    model: environment.ZION_BYTEINTL_MODEL,
    host: environment.ZION_BYTEINTL_ADAPTER_HOST,
    port: environment.ZION_BYTEINTL_ADAPTER_PORT,
    timeoutMs: environment.ZION_BYTEINTL_TIMEOUT_MS,
    maxRequestBytes: environment.ZION_BYTEINTL_MAX_REQUEST_BYTES,
    maxResponseBytes: environment.ZION_BYTEINTL_MAX_RESPONSE_BYTES,
    defaultMaxTokens: environment.ZION_BYTEINTL_DEFAULT_MAX_TOKENS
  });
}

function writeJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers
  });
  response.end(body);
}

async function readRequestJson(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body exceeds the configured size limit");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

async function readResponseText(response, maxBytes) {
  if (!response.body) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      await response.body.cancel?.().catch?.(() => {});
      const error = new Error("ByteIntl response exceeds the configured size limit");
      error.statusCode = 502;
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function textParts(content) {
  if (typeof content !== "string") return content;
  return [{ type: "text", text: content }];
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  if (message.role === "tool" || typeof message.content !== "string") {
    return { ...message };
  }
  return {
    ...message,
    content: textParts(message.content)
  };
}

export function buildByteIntlRequestPayload(input, config) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("Request body must be a JSON object");
    error.statusCode = 400;
    throw error;
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    const error = new Error("Request messages are required");
    error.statusCode = 400;
    throw error;
  }
  const payload = {
    ...input,
    model: config.model,
    messages: input.messages.map(normalizeMessage),
    stream: false
  };
  delete payload.stream_options;
  if (!Number.isFinite(Number(payload.max_tokens))) {
    payload.max_tokens = config.defaultMaxTokens;
  }
  return payload;
}

function traceId() {
  return randomUUID().replaceAll("-", "");
}

function bearerCredential(request) {
  const authorization = String(request.headers.authorization || "");
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function redacted(value, secrets = []) {
  let text = String(value || "");
  for (const secret of secrets.filter(Boolean)) {
    text = text.replaceAll(secret, "[REDACTED]");
    text = text.replaceAll(encodeURIComponent(secret), "[REDACTED]");
  }
  return text;
}

function safeUpstreamDescription(value) {
  const url = new URL(value);
  url.search = "";
  return `${url.origin}${url.pathname}`;
}

export function createByteIntlAdapter({
  config: inputConfig,
  fetchImpl = globalThis.fetch,
  logger = () => {}
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("ByteIntl adapter requires fetch");
  }
  const config = normalizeByteIntlAdapterConfig(inputConfig);
  let server = null;
  let address = null;

  const handle = async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://adapter.invalid");
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        service: "zion-byteintl-model-adapter",
        model: config.model,
        upstream: safeUpstreamDescription(config.upstreamUrl)
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
      writeJson(response, 200, {
        object: "list",
        data: [{
          id: config.model,
          object: "model",
          owned_by: "byteintl"
        }]
      });
      return;
    }
    if (
      request.method !== "POST"
      || requestUrl.pathname !== "/v1/chat/completions"
    ) {
      writeJson(response, 404, { error: { message: "Not found" } });
      return;
    }
    const apiKey = bearerCredential(request);
    if (!apiKey) {
      writeJson(response, 401, {
        error: { message: "ByteIntl adapter credential is required" }
      });
      return;
    }

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    const abortOnClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    request.once("aborted", abort);
    response.once("close", abortOnClose);
    try {
      const input = await readRequestJson(request, config.maxRequestBytes);
      const payload = buildByteIntlRequestPayload(input, config);
      const upstreamUrl = new URL(config.upstreamUrl);
      upstreamUrl.searchParams.set("ak", apiKey);
      const logId = traceId();
      const upstream = await fetchImpl(upstreamUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-tt-logid": logId
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal
      });
      const body = redacted(
        await readResponseText(upstream, config.maxResponseBytes),
        [apiKey]
      );
      const upstreamLogId = upstream.headers.get("x-tt-logid");
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type")
          || "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        ...(upstreamLogId ? { "x-tt-logid": upstreamLogId } : {})
      });
      response.end(body);
    } catch (error) {
      if (response.writableEnded) return;
      const status = Number(error?.statusCode)
        || (timedOut ? 504 : error?.name === "AbortError" ? 499 : 502);
      const message = status < 500
        ? redacted(error?.message || "Request failed", [apiKey])
        : timedOut
          ? "ByteIntl upstream request timed out"
          : "ByteIntl upstream request failed";
      logger({
        level: status >= 500 ? "warn" : "info",
        message,
        status
      });
      writeJson(response, status, { error: { message } });
    } finally {
      clearTimeout(timer);
      request.off("aborted", abort);
      response.off("close", abortOnClose);
    }
  };

  return Object.freeze({
    async start() {
      if (server) throw new Error("ByteIntl adapter is already started");
      server = createServer((request, response) => {
        void handle(request, response).catch(() => {
          if (!response.writableEnded) {
            writeJson(response, 500, {
              error: { message: "ByteIntl adapter request failed" }
            });
          }
        });
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server?.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(config.port, config.host);
      });
      const listening = server.address();
      const port = typeof listening === "object" && listening
        ? listening.port
        : config.port;
      address = `http://${config.host}:${port}`;
      return { url: address, model: config.model };
    },

    async stop() {
      if (!server) return;
      const active = server;
      server = null;
      address = null;
      await new Promise((resolve, reject) => {
        active.close((error) => error ? reject(error) : resolve());
        active.closeIdleConnections?.();
      });
    },

    snapshot() {
      return {
        running: !!server,
        url: address,
        model: config.model,
        upstream: safeUpstreamDescription(config.upstreamUrl)
      };
    }
  });
}
