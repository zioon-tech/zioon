import { URL } from "node:url";

const DEFAULT_ALLOWED_HOSTS = new Set([
  "api.anthropic.com",
  "api.deepseek.com",
  "api.kimi.com",
  "api.openai.com",
  "api.siliconflow.cn",
  "ark.cn-beijing.volces.com",
  "coding.dashscope.aliyuncs.com",
  "dashscope.aliyuncs.com",
  "generativelanguage.googleapis.com",
  "open.bigmodel.cn"
]);

const REQUEST_HEADER_DENYLIST = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "host",
  "origin",
  "referer",
  "transfer-encoding"
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "retry-after",
  "x-request-id",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests"
]);

function endpointAllows(target, endpoint) {
  try {
    const allowed = new URL(endpoint);
    if (target.origin !== allowed.origin) return false;
    const basePath = allowed.pathname.replace(/\/+$/, "");
    return target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

function resolveProfile(target, profiles) {
  return profiles.find((profile) => endpointAllows(target, profile.endpoint)) || null;
}

function assertAllowedTarget(target, profiles) {
  if (!["http:", "https:"].includes(target.protocol)) {
    const error = new Error("Model gateway target must use HTTP(S)");
    error.statusCode = 400;
    throw error;
  }
  const profile = resolveProfile(target, profiles);
  if (profile) return profile;
  if (target.protocol === "https:" && DEFAULT_ALLOWED_HOSTS.has(target.hostname)) {
    return null;
  }
  const error = new Error("Model gateway target is not registered");
  error.statusCode = 403;
  throw error;
}

function requestHeaders(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase();
    if (!REQUEST_HEADER_DENYLIST.has(normalized) && value != null) {
      headers[normalized] = value;
    }
  }
  return headers;
}

async function credentialHeaders(profile, credentials) {
  if (!profile?.credentialRef || !credentials?.acquire) return null;
  return credentials.acquire({ ref: profile.credentialRef });
}

export function createModelGatewayHttpHandler({
  profiles = () => [],
  credentials,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!fetchImpl) throw new Error("Model gateway requires fetch");

  return async (request, response, url) => {
    if (url.pathname !== "/v1/model-gateway/proxy") return false;
    if (!["POST", "PUT"].includes(String(request.method))) {
      response.writeHead(405, {
        allow: "POST, PUT",
        "cache-control": "no-store"
      });
      response.end();
      return true;
    }

    let target;
    try {
      target = new URL(String(url.searchParams.get("target") || ""));
    } catch {
      const error = new Error("Model gateway target is invalid");
      error.statusCode = 400;
      throw error;
    }
    const availableProfiles = typeof profiles === "function" ? profiles() : profiles;
    const profile = assertAllowedTarget(target, availableProfiles || []);
    const headers = requestHeaders(request);
    const lease = await credentialHeaders(profile, credentials);
    if (lease?.headers) {
      for (const name of ["authorization", "x-api-key", "api-key"]) {
        delete headers[name];
      }
      Object.assign(headers, lease.headers);
    }
    if (target.hostname === "api.kimi.com") {
      headers["user-agent"] = "KimiCLI/1.0.0";
    }

    const controller = new globalThis.AbortController();
    const abort = () => controller.abort();
    const abortOnResponseClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", abort);
    response.once("close", abortOnResponseClose);
    try {
      const upstream = await fetchImpl(target, {
        method: request.method,
        headers,
        body: request,
        duplex: "half",
        signal: controller.signal,
        redirect: "follow"
      });
      const responseHeaders = {
        "cache-control": "no-store"
      };
      for (const [name, value] of upstream.headers.entries()) {
        if (RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) {
          responseHeaders[name] = value;
        }
      }
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        for await (const chunk of upstream.body) response.write(chunk);
      }
      response.end();
      return true;
    } finally {
      request.off("aborted", abort);
      response.off("close", abortOnResponseClose);
      lease?.release?.();
    }
  };
}
