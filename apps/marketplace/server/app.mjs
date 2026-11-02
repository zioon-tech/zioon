import { createServer, request as httpRequest } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const random = () => randomBytes(32).toString("base64url");
const cookieName = "__Host-zioon_marketplace";
const flowName = "__Host-zioon_marketplace_login";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const safePath = (value) => /^\/(?!\/)/.test(value || "") && !/[\\\x00-\x20\x7f]/.test(value) ? value : "/";
const cookieValue = (headers, name) => {
  const part = String(headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(name + "="));
  if (!part) return "";
  try { return decodeURIComponent(part.slice(name.length + 1)); } catch { return ""; }
};
const commonCookies = (headers) => String(headers.cookie || "").split(";").map((part) => part.trim())
  .filter((part) => /^__Secure-zioon\.session_token=[^;\r\n]*$/.test(part)).join("; ");
const sharedLogoutCookies = (headers) => headers.getSetCookie()
  .filter((value) => /^__Secure-zioon\./.test(value)
    && /;\s*Domain=\.?zioon\.tech(?:;|$)/i.test(value));
const allowedApi = (method, path) => (
  (method === "GET" && /^\/v1\/(?:marketplace\/(?:snapshot|connections|jobs|review|releases\/[^/]+\/[^/]+\/(?:artifact|files\/.+)|contributions\/[^/]+)|account\/me|runs\/[^/]+|models)$/.test(path))
  || (["POST", "PUT", "PATCH", "DELETE"].includes(method)
    && /^\/v1\/marketplace\/(?:private-releases|contributions(?:\/[^/]+\/submit)?|review|installations\/[^/]+(?:\/config)?)$/.test(path))
  || (method === "POST" && path === "/v1/runs")
  || (method === "PUT" && path === "/v1/models/selection")
);

// Native fetch rewrites Host to the loopback URL. The trusted local bridge
// must retain the Runtime's canonical Host for its login origin checks.
export function loopbackFetch(url, options = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest(url, {
      method: options.method || "GET", headers: {
        ...options.headers,
        ...(options.body ? { "content-length": Buffer.byteLength(options.body) } : {})
      }, signal: options.signal
    }, (res) => {
      const blocks = [];
      let size = 0;
      res.on("data", (block) => {
        size += block.length;
        if (size > 10 * 1024 * 1024) req.destroy(new Error("Runtime response too large"));
        else blocks.push(block);
      });
      res.once("error", reject);
      res.once("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        const status = res.statusCode || 502;
        resolveResponse(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(blocks), { status, headers }));
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("Runtime request timeout")));
    req.once("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export function createMarketplaceServer({ origin, runtimeOrigin, runtimeTarget,
  accountOrigin = "https://auth.zioon.tech", accountFetchImpl = fetch,
  key, dist, fetchImpl = loopbackFetch, now = Date.now, allowLoopbackHttp = false }) {
  const publicUrl = new URL(origin), runtime = new URL(runtimeOrigin), upstream = new URL(runtimeTarget);
  const authority = new URL(accountOrigin);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Invalid marketplace session key");
  for (const url of [publicUrl, runtime, authority]) {
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password
      || (url.protocol !== "https:" && !(allowLoopbackHttp && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
      throw new Error("Application URLs must be HTTPS origins");
    }
  }
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname)) {
    throw new Error("Runtime target must be loopback");
  }
  const secure = publicUrl.protocol === "https:";
  const sessionCookie = secure ? cookieName : "zioon_marketplace_local";
  const flowCookie = secure ? flowName : "zioon_marketplace_login_local";
  const seal = (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(publicUrl.origin));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
  };
  const open = (value) => {
    try {
      const bytes = Buffer.from(value, "base64url"), iv = bytes.subarray(0, 12);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(publicUrl.origin));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const result = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
      return result.expiresAt > now() ? result : null;
    } catch { return null; }
  };
  const cookie = (name, value, maxAge, sameSite = "Strict") =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const json = (response, status, value) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const redirect = (response, location, cookies = []) => {
    response.writeHead(303, { location, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": cookies });
    response.end();
  };
  const readBody = async (request) => {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 256000) throw Object.assign(new Error("提交内容超过 256KB"), { statusCode: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const runtimeFetch = (path, { method = "GET", token, cookies = "", body } = {}) => fetchImpl(
    new URL(path, upstream), {
      method, redirect: "manual", signal: AbortSignal.timeout(20000),
      headers: { host: runtime.host, origin: runtime.origin, accept: "application/json",
        // Preserve browser semantics: Runtime checks the scoped grant against
        // the current unified account, including logout and account changes.
        ...(token || cookies ? { cookie: [cookies,
          token ? `${runtime.protocol === "https:" ? "__Host-zion_account" : "zion_account_local"}=${encodeURIComponent(token)}` : ""
        ].filter(Boolean).join("; ") } : {}),
        ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body } : {})
    });
  const accountFetch = (path, cookies, body) => accountFetchImpl(new URL(path, authority), {
    method: body === undefined ? "GET" : "POST", redirect: "error",
    signal: AbortSignal.timeout(10000), headers: {
      accept: "application/json", cookie: cookies,
      ...(body === undefined ? {} : { origin: authority.origin, "content-type": "application/json" })
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const unsignedSession = async (response, cookies) => {
    if (!cookies) return json(response, 200, { authenticated: false });
    const result = await accountFetch("/api/v1/zioon/session/status", cookies);
    const value = await result.json().catch(() => ({}));
    if (!result.ok || typeof value.authenticated !== "boolean") {
      return json(response, 503, { error: "账户服务暂时不可用" });
    }
    return json(response, 200, { authenticated: false,
      sharedAuthenticated: value.authenticated,
      ...(value.authenticated ? { generation: value.generation } : {})
    });
  };
  const server = createServer(async (request, response) => {
    try {
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "strict-origin-when-cross-origin");
      const url = new URL(request.url || "/", publicUrl.origin);
      if (request.headers.host && request.headers.host !== publicUrl.host
        && !["127.0.0.1", "localhost"].includes(request.headers.host.split(":")[0])) {
        return json(response, 403, { error: "请求来源无效" });
      }
      if (!["GET", "HEAD"].includes(request.method) && request.headers.origin !== publicUrl.origin) {
        return json(response, 403, { error: "请求来源无效", code: "invalid_origin" });
      }
      const session = open(cookieValue(request.headers, sessionCookie));
      const cookies = commonCookies(request.headers);
      if (url.pathname === "/health" && request.method === "GET") {
        return json(response, 200, { ok: true, service: "zioon-marketplace" });
      }
      if (url.pathname === "/api/auth/login" && request.method === "GET") {
        const state = random(), verifier = random();
        const returnTo = safePath(url.searchParams.get("returnTo"));
        const authUrl = new URL("/v1/account/apps/authorize", runtime.origin);
        authUrl.search = new URLSearchParams({
          state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          returnTo: returnTo.startsWith("/api/") ? "/" : returnTo
        }).toString();
        return redirect(response, authUrl.href, [cookie(flowCookie,
          seal({ state, verifier, expiresAt: now() + 5 * 60000 }), 300, "Lax")]);
      }
      if (url.pathname === "/api/auth/callback" && request.method === "GET") {
        const flow = open(cookieValue(request.headers, flowCookie));
        if (!flow || flow.state !== url.searchParams.get("state")) {
          return redirect(response, "/?loginError=expired", [cookie(flowCookie, "", 0, "Lax")]);
        }
        const accepted = await runtimeFetch("/v1/account/apps/exchange", {
          method: "POST", cookies,
          body: JSON.stringify({ state: flow.state, verifier: flow.verifier, code: url.searchParams.get("code") })
        });
        const value = await accepted.json().catch(() => ({}));
        if (!accepted.ok || typeof value.token !== "string" || !value.token.startsWith("zion_account_v1.")
          || !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) {
          return redirect(response, "/?loginError=unavailable", [cookie(flowCookie, "", 0, "Lax")]);
        }
        return redirect(response, safePath(value.returnTo), [
          cookie(flowCookie, "", 0, "Lax"),
          cookie(sessionCookie, seal({ token: value.token, expiresAt: value.expiresAt }),
            Math.min(7 * 86400, Math.floor((value.expiresAt - now()) / 1000)))
        ]);
      }
      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        if (!session) return unsignedSession(response, cookies);
        const result = await runtimeFetch("/v1/account/me", { token: session.token, cookies });
        const value = await result.json().catch(() => ({}));
        if (result.status === 401) {
          response.setHeader("set-cookie", cookie(sessionCookie, "", 0));
          return unsignedSession(response, cookies);
        }
        if (!result.ok) return json(response, 503, { error: "账户服务暂时不可用" });
        return json(response, 200, value);
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        let result = session && await runtimeFetch("/v1/account/logout", {
          method: "POST", token: session.token, cookies, body: "{}"
        });
        // The parent may already have ended, or this product may not yet have
        // a scoped session. Unified sign-out remains available in both cases.
        if (!result || result.status === 401) {
          result = cookies && await accountFetch("/api/v1/zioon/session/logout", cookies, {});
        }
        if (result && !result.ok) return json(response, 503, { error: "退出未完成，请重试" });
        response.setHeader("set-cookie", [
          ...(result ? sharedLogoutCookies(result.headers) : []),
          cookie(sessionCookie, "", 0), cookie(flowCookie, "", 0, "Lax")
        ]);
        return json(response, 200, { loggedOut: true });
      }
      if (url.pathname === "/api/catalog" && request.method === "GET") {
        const result = await runtimeFetch("/v1/marketplace/public");
        if (!result.ok) return json(response, 503, { error: "插件目录暂时不可用" });
        return json(response, 200, await result.json());
      }
      if (url.pathname.startsWith("/api/runtime/")) {
        if (!session) return json(response, 401, { error: "请先登录 Zioon 账户", code: "authentication_required" });
        const path = "/" + url.pathname.slice("/api/runtime/".length);
        if (!allowedApi(request.method, path)) return json(response, 404, { error: "接口不存在" });
        const body = ["GET", "HEAD"].includes(request.method) ? undefined : await readBody(request);
        const result = await runtimeFetch(path + url.search, { method: request.method, token: session.token, cookies, body });
        if (result.status === 401) response.setHeader("set-cookie", cookie(sessionCookie, "", 0));
        if (result.status >= 300 && result.status < 400) return json(response, 502, { error: "接口返回了无效跳转" });
        response.writeHead(result.status, {
          "content-type": result.headers.get("content-type") || "application/json",
          "cache-control": "no-store",
          ...(path.includes("/files/") ? { "content-security-policy": "default-src 'none'; sandbox" } : {})
        });
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(request.method)) {
        return json(response, 404, { error: "页面不存在" });
      }
      const distRoot = await realpath(dist);
      let target = resolve(distRoot, "." + decodeURIComponent(url.pathname));
      if (target !== distRoot && !target.startsWith(distRoot + sep)) return json(response, 404, { error: "页面不存在" });
      if (url.pathname === "/" || /^\/(?:plugins\/[^/]+|installed|developer)\/?$/.test(url.pathname)) {
        target = resolve(distRoot, "index.html");
      }
      const canonical = await realpath(target).catch(() => "");
      if (!canonical.startsWith(distRoot + sep) || !(await stat(canonical)).isFile()) return json(response, 404, { error: "页面不存在" });
      const bytes = await readFile(canonical);
      response.writeHead(200, {
        "content-type": mime[extname(canonical)] || "application/octet-stream",
        "content-length": bytes.length,
        "cache-control": canonical.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if (!response.headersSent) json(response, error.statusCode || 503, {
        error: error.statusCode ? error.message : "服务暂时不可用，请稍后重试"
      });
      else response.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
