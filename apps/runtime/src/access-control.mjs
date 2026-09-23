import { Buffer } from "node:buffer";
import { URL } from "node:url";

export const RUNTIME_SESSION_COOKIE = "__Host-zion_session";
export { bearerToken, cookieValue, headerValue, readJson, json, publicDevice };

const MAX_REQUEST_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]"
]);

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function mapMaybePromise(value, mapper) {
  return value && typeof value.then === "function"
    ? value.then(mapper)
    : mapper(value);
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return String(headers.get(name) || "");
  }
  const value = headers[String(name).toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function bearerToken(headers) {
  const value = headerValue(headers, "authorization");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function cookieValue(headers, name) {
  const cookie = headerValue(headers, "cookie");
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function normalizedOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function isLoopbackOrigin(value) {
  try {
    const origin = new URL(String(value || ""));
    return ["http:", "https:"].includes(origin.protocol)
      && LOOPBACK_HOSTS.has(origin.hostname);
  } catch {
    return false;
  }
}

function normalizeOrigins(values) {
  const origins = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      throw new Error(`Invalid Runtime Browser Origin: ${value}`);
    }
    if (
      !["http:", "https:"].includes(url.protocol)
      || (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname))
    ) {
      throw new Error(
        `Remote Runtime Browser Origin must use HTTPS: ${url.origin}`
      );
    }
    origins.add(url.origin);
  }
  return origins;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw statusError(413, "Request body exceeds 64 KiB");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw statusError(400, "Request body must be valid JSON");
  }
}

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers
  });
  response.end(body);
}

function publicDevice(device) {
  return {
    deviceId: device.deviceId,
    kind: device.kind,
    label: device.label,
    platform: device.platform,
    scopes: [...device.scopes],
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt
  };
}

function cookieHeader(credential, expiresAt) {
  const maxAge = Math.max(
    0,
    Math.floor((Number(expiresAt) - Date.now()) / 1000)
  );
  return [
    `${RUNTIME_SESSION_COOKIE}=${encodeURIComponent(credential)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAge}`
  ].join("; ");
}

function clearCookieHeader() {
  return [
    `${RUNTIME_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0"
  ].join("; ");
}

function pairingPath(pathname) {
  const match = pathname.match(/^\/v1\/access\/devices\/([^/]+)\/revoke$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export class RuntimeAccessControl {
  constructor({
    store,
    allowedOrigins = [],
    publicBaseUrl = "",
    pairingRateLimit = 20,
    pairingRateWindowMs = 60_000,
    now = () => Date.now()
  } = {}) {
    if (!store?.authenticate || !store?.exchangePairing) {
      throw new Error("Runtime Access Control requires an Access Store");
    }
    this.store = store;
    this.allowedOrigins = normalizeOrigins(allowedOrigins);
    this.publicBaseUrl = String(publicBaseUrl || "").replace(/\/+$/, "");
    if (this.publicBaseUrl) {
      const [publicOrigin] = normalizeOrigins([this.publicBaseUrl]);
      this.allowedOrigins.add(publicOrigin);
    }
    this.pairingRateLimit = pairingRateLimit;
    this.pairingRateWindowMs = pairingRateWindowMs;
    this.now = now;
    this.pairingAttempts = new Map();
  }

  originAllowed(value) {
    const origin = normalizedOrigin(value);
    if (!origin) return false;
    return isLoopbackOrigin(origin) || this.allowedOrigins.has(origin);
  }

  applyCors(request, response) {
    const origin = headerValue(request.headers, "origin").trim();
    if (!origin) return true;
    if (!this.originAllowed(origin)) return false;
    response.setHeader("access-control-allow-origin", normalizedOrigin(origin));
    response.setHeader(
      "access-control-allow-methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    response.setHeader(
      "access-control-allow-headers",
      "content-type, authorization, last-event-id, x-zion-client, "
      + "x-zion-file-name, x-zion-workbench-protocol"
    );
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "Origin");
    return true;
  }

  authenticateHeaders(headers, token = "") {
    const bearer = String(token || "").trim() || bearerToken(headers);
    const cookie = cookieValue(headers, RUNTIME_SESSION_COOKIE);
    const credential = bearer || cookie;
    if (!credential) return null;
    return mapMaybePromise(this.store.authenticate(credential), (authenticated) =>
      authenticated ? {
        ...authenticated,
        source: bearer ? "bearer" : "cookie"
      } : null
    );
  }

  authenticateRequest(request) {
    return this.authenticateHeaders(request?.headers);
  }

  hasScope(principal, scope) {
    return principal?.device?.scopes?.includes(scope) === true;
  }

  requireScope(principal, scope) {
    if (!principal) throw statusError(401, "Authentication required");
    if (!this.hasScope(principal, scope)) {
      throw statusError(403, `Credential lacks required scope: ${scope}`);
    }
    return principal;
  }

  authorizeRuntimeRequest(request) {
    return mapMaybePromise(this.authenticateRequest(request), (principal) => {
      const method = String(request?.method || "GET").toUpperCase();
      const scope = ["GET", "HEAD"].includes(method)
        ? "runtime.read"
        : "runtime.write";
      this.requireScope(principal, scope);
      if (
        principal.source === "cookie"
        && !["GET", "HEAD", "OPTIONS"].includes(method)
        && !this.originAllowed(headerValue(request.headers, "origin"))
      ) {
        throw statusError(403, "Authenticated browser request has an invalid Origin");
      }
      return principal;
    });
  }

  authorizeDeviceService(request, route = {}) {
    if (route.service === "device-access") {
      return this.reauthorize(request?.zionPrincipal, "device.manage");
    }
    const method = String(request?.method || "GET").toUpperCase();
    const scope = ["GET", "HEAD"].includes(method)
      ? "runtime.read"
      : "runtime.write";
    return this.reauthorize(request?.zionPrincipal, scope);
  }

  authenticateCollaboration({ headers, token }) {
    return mapMaybePromise(this.authenticateHeaders(headers, token), (principal) => {
      this.requireScope(principal, "collaboration.write");
      return { principal };
    });
  }

  reauthorize(principal, scope) {
    this.requireScope(principal, scope);
    return mapMaybePromise(
      this.store.isCredentialActive?.(
        principal.credentialId,
        principal.device.deviceId
      ),
      (active) => {
        if (!active) throw statusError(401, "Credential is no longer active");
        return principal;
      }
    );
  }

  authorizeNode({ request, nodeId = "", operation = "connect" }) {
    return mapMaybePromise(
      this.authenticateHeaders(request?.headers),
      (principal) => {
        if (
          operation === "inspect"
          && this.hasScope(principal, "device.manage")
        ) {
          return principal;
        }
        this.requireScope(principal, "node.connect");
        if (
          principal.device.kind !== "resource"
          || principal.device.deviceId !== String(nodeId || "")
        ) {
          throw statusError(403, "Resource credential is not bound to this Node");
        }
        return principal;
      }
    );
  }

  checkPairingRate(request) {
    const address = String(
      request?.socket?.remoteAddress
      || request?.headers?.["x-real-ip"]
      || "unknown"
    );
    const now = this.now();
    const current = this.pairingAttempts.get(address);
    if (!current || current.resetAt <= now) {
      this.pairingAttempts.set(address, {
        count: 1,
        resetAt: now + this.pairingRateWindowMs
      });
      return;
    }
    current.count += 1;
    if (current.count > this.pairingRateLimit) {
      throw statusError(429, "Too many pairing attempts");
    }
  }

  pairingUrl(pairing) {
    if (!this.publicBaseUrl) return "";
    const url = new URL(this.publicBaseUrl);
    url.hash = new URLSearchParams({
      pairing_id: pairing.pairingId,
      pairing_secret: pairing.secret
    }).toString();
    return url.toString();
  }

  async handleHttp(request, response, url) {
    if (!url.pathname.startsWith("/v1/access/")) return false;
    try {
      if (request.method === "POST" && url.pathname === "/v1/access/pair") {
        this.checkPairingRate(request);
        const body = await readJson(request);
        const result = await this.store.exchangePairing({
          pairingId: body.pairingId,
          secret: body.secret,
          userCode: body.userCode,
          deviceId: body.device?.deviceId,
          label: body.device?.label,
          platform: body.device?.platform
        });
        const payload = {
          paired: true,
          expiresAt: result.expiresAt,
          device: publicDevice(result.device),
          ...(result.delivery === "bearer"
            ? {
                credential: result.credential,
                credentialId: result.credentialId
              }
            : {})
        };
        json(response, 200, payload, result.delivery === "cookie"
          ? { "set-cookie": cookieHeader(result.credential, result.expiresAt) }
          : {});
        return true;
      }

      if (request.method === "GET" && url.pathname === "/v1/access/session") {
        const principal = await this.authenticateRequest(request);
        this.requireScope(principal, "runtime.read");
        json(response, 200, {
          authenticated: true,
          expiresAt: principal.expiresAt,
          device: publicDevice(principal.device)
        });
        return true;
      }

      if (request.method === "GET" && url.pathname === "/v1/access/authorize/observability") {
        const principal = await this.authenticateRequest(request);
        this.requireScope(principal, "device.manage");
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return true;
      }

      if (request.method === "POST" && url.pathname === "/v1/access/logout") {
        const principal = await this.authenticateRequest(request);
        if (principal?.source === "cookie") {
          const origin = headerValue(request.headers, "origin");
          if (!this.originAllowed(origin)) {
            throw statusError(403, "Authenticated browser request has an invalid Origin");
          }
        }
        if (principal) await this.store.revokeDevice(principal.device.deviceId);
        json(response, 200, { loggedOut: true }, {
          "set-cookie": clearCookieHeader()
        });
        return true;
      }

      if (request.method === "POST" && url.pathname === "/v1/access/pairings") {
        const principal = await this.authenticateRequest(request);
        this.requireScope(principal, "pairing.manage");
        if (
          principal.source === "cookie"
          && !this.originAllowed(headerValue(request.headers, "origin"))
        ) {
          throw statusError(403, "Authenticated browser request has an invalid Origin");
        }
        const body = await readJson(request);
        const pairing = await this.store.createPairing(body);
        json(response, 201, {
          pairingId: pairing.pairingId,
          secret: pairing.secret,
          userCode: pairing.userCode,
          pairingUrl: this.pairingUrl(pairing),
          kind: pairing.kind,
          delivery: pairing.delivery,
          scopes: pairing.scopes,
          expiresAt: pairing.expiresAt
        });
        return true;
      }

      if (request.method === "GET" && url.pathname === "/v1/access/devices") {
        const principal = await this.authenticateRequest(request);
        this.requireScope(principal, "device.manage");
        json(response, 200, {
          devices: (await this.store.listDevices()).map(publicDevice)
        });
        return true;
      }

      const revokeDeviceId = pairingPath(url.pathname);
      if (request.method === "POST" && revokeDeviceId) {
        const principal = await this.authenticateRequest(request);
        this.requireScope(principal, "device.manage");
        if (
          principal.source === "cookie"
          && !this.originAllowed(headerValue(request.headers, "origin"))
        ) {
          throw statusError(403, "Authenticated browser request has an invalid Origin");
        }
        const revoked = await this.store.revokeDevice(revokeDeviceId);
        if (!revoked) throw statusError(404, "Device not found");
        json(response, 200, { revoked: true, deviceId: revokeDeviceId });
        return true;
      }

      json(response, 404, { error: "Access endpoint not found" });
      return true;
    } catch (error) {
      if (!response.headersSent) {
        json(response, Number(error?.statusCode || 500), {
          error: error?.message || String(error)
        });
      } else {
        response.end();
      }
      return true;
    }
  }
}
