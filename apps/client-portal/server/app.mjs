import { createServer, request as httpRequest } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { pipeline } from "node:stream";
import { loopbackFetch } from "../../marketplace/server/app.mjs";

const random = () => randomBytes(32).toString("base64url");
const safePath = value => /^\/(?!\/)/.test(value || "") && !/[\\\x00-\x20\x7f]/.test(value) ? value : "/";
const commonCookies = headers => String(headers.cookie || "").split(";").map(x => x.trim())
  .filter(x => /^__Secure-zioon\.session_token=[^;\r\n]*$/.test(x)).join("; ");
const valueOf = (headers, name) => {
  const part = String(headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(name + "="));
  try { return part ? decodeURIComponent(part.slice(name.length + 1)) : ""; } catch { return ""; }
};
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".woff": "font/woff", ".woff2": "font/woff2" };
const error = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
const reply = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

/** Independent browser clients. Tokens only exist inside authenticated,
 * origin-bound encrypted HttpOnly cookies; Runtime remains the authority. */
export function createClientPortal({ app, origin, runtimeOrigin, runtimeTarget,
  key, dist, allowLoopbackHttp = false, now = Date.now }) {
  if (!["workbench", "mobile", "admin"].includes(app)) throw new Error("Invalid client app");
  const publicUrl = new URL(origin), runtime = new URL(runtimeOrigin), upstream = new URL(runtimeTarget);
  for (const url of [publicUrl, runtime]) {
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password
      || !(url.protocol === "https:" || (allowLoopbackHttp && url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("HTTPS origins required");
  }
  if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)
    || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) {
    throw new Error("Runtime target must be a loopback origin");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("32-byte session key required");
  const secure = publicUrl.protocol === "https:";
  const sessionName = `${secure ? "__Host-" : ""}zioon_${app}`;
  const flowName = state => `${sessionName}_login_${state}`;
  const cookie = (name, value, ttl, sameSite = "Strict") =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${ttl}${secure ? "; Secure" : ""}`;
  const seal = value => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(publicUrl.origin));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
  };
  const open = value => {
    try {
      const bytes = Buffer.from(value, "base64url");
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(publicUrl.origin));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const result = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]));
      return result.expiresAt > now() ? result : null;
    } catch { return null; }
  };
  const redirect = (res, location, cookies = []) => {
    res.writeHead(303, { location, "set-cookie": cookies, "cache-control": "no-store",
      "referrer-policy": "no-referrer" }); res.end();
  };
  const validate = (req, upgrade = false) => {
    if (req.headers.host !== publicUrl.host) throw error(403, "invalid_host");
    if ((upgrade || !["GET", "HEAD"].includes(req.method)) && req.headers.origin !== publicUrl.origin) {
      throw error(403, "invalid_origin");
    }
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) throw error(403, "invalid_origin");
    if (req.headers["sec-fetch-site"] === "cross-site") {
      if (upgrade || !["GET", "HEAD"].includes(req.method)) throw error(403, "invalid_origin");
    }
  };
  const headersFor = (req, session, upgrade = false) => {
    const headers = { host: runtime.host, origin: runtime.origin,
      cookie: [commonCookies(req.headers),
        session ? `${runtime.protocol === "https:" ? "__Host-zion_account" : "zion_account_local"}=${encodeURIComponent(session.token)}` : ""
      ].filter(Boolean).join("; ") };
    // Never accept caller Authorization, Host, or forwarding headers.
    for (const name of ["accept", "content-type", "content-length", "range", "if-none-match",
      "if-match", "last-event-id", "user-agent", ...(upgrade ? [
        "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"
      ] : [])]) if (req.headers[name]) headers[name] = req.headers[name];
    if (upgrade) Object.assign(headers, { connection: "Upgrade", upgrade: "websocket" });
    return headers;
  };
  const apiPath = path => path.startsWith("/v1/") || path.startsWith("/collaboration") || path === "/health";
  const allowed = path => apiPath(path) && !/^\/v1\/account\/(?:apps\/|callback|shared\/|token\/|device\/)/.test(path)
    && (app !== "admin" || /^\/v1\/(?:platform-admin\/|account\/(?:me|logout)$)/.test(path) || path === "/health");
  const stream = (req, res, url, session) => {
    const proxy = httpRequest(new URL(url.pathname + url.search, upstream), {
      method: req.method, headers: headersFor(req, session)
    });
    // Only bound connection establishment; long SSE/downloads are streamed.
    const timer = setTimeout(() => proxy.destroy(error(504, "runtime_timeout")), 15000);
    proxy.once("response", result => {
      clearTimeout(timer);
      if (result.statusCode >= 300 && result.statusCode < 400 && result.headers.location) {
        result.resume(); return reply(res, 502, { code: "unexpected_runtime_redirect" });
      }
      const headers = { "cache-control": "no-store", "x-accel-buffering": "no" };
      for (const name of ["content-type", "content-length", "content-disposition", "etag", "content-range",
        "accept-ranges", "content-encoding", "vary"]) if (result.headers[name]) headers[name] = result.headers[name];
      if (url.pathname.includes("/files/")) {
        headers["content-security-policy"] = "default-src 'none'; sandbox";
      }
      const cookies = [];
      if (result.statusCode === 401 || url.pathname.endsWith("/logout") && result.statusCode < 300) {
        cookies.push(cookie(sessionName, "", 0));
      }
      if (url.pathname.endsWith("/logout")) {
        cookies.push(...(result.headers["set-cookie"] || []).filter(x =>
          /^__Secure-zioon\./.test(x) && /;\s*Domain=\.?zioon\.tech(?:;|$)/i.test(x)));
      }
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(result.statusCode || 502, headers);
      pipeline(result, res, () => {});
    });
    proxy.once("error", err => {
      clearTimeout(timer);
      if (!res.headersSent) reply(res, err.statusCode || 503, { code: err.code || "runtime_unavailable" });
      else res.destroy();
    });
    res.once("close", () => { clearTimeout(timer); proxy.destroy(); });
    req.once("aborted", () => proxy.destroy());
    req.pipe(proxy);
  };
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
      validate(req);
      const url = new URL(req.url, publicUrl);
      const session = open(valueOf(req.headers, sessionName));
      if (url.pathname === "/readyz" && req.method === "GET") return reply(res, 200, { ok: true, app });
      if (["/api/auth/login", "/v1/account/login"].includes(url.pathname) && req.method === "GET") {
        const state = random(), verifier = random();
        const returnTo = safePath(url.searchParams.get("returnTo"));
        const target = new URL("/v1/account/apps/authorize", runtime);
        target.search = new URLSearchParams({ app, state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          returnTo: apiPath(returnTo.split("?")[0]) || returnTo.startsWith("/api/") ? "/" : returnTo });
        return redirect(res, target.href, [cookie(flowName(state),
          seal({ verifier, expiresAt: now() + 300000 }), 300, "Lax")]);
      }
      if (url.pathname === "/api/auth/callback" && req.method === "GET") {
        const state = url.searchParams.get("state");
        if (!/^[A-Za-z0-9_-]{43}$/.test(state || "")) throw error(400, "invalid_login_state");
        const flow = open(valueOf(req.headers, flowName(state)));
        if (!flow) return redirect(res, "/?loginError=expired", [cookie(flowName(state), "", 0, "Lax")]);
        const result = await loopbackFetch(new URL("/v1/account/apps/exchange", upstream), {
          method: "POST", headers: { host: runtime.host, origin: runtime.origin,
            "content-type": "application/json", cookie: commonCookies(req.headers) },
          body: JSON.stringify({ app, state, verifier: flow.verifier, code: url.searchParams.get("code") })
        });
        const value = await result.json().catch(() => ({}));
        if (!result.ok || !String(value.token).startsWith("zion_account_v1.")
          || !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) {
          return redirect(res, "/?loginError=unavailable", [cookie(flowName(state), "", 0, "Lax")]);
        }
        return redirect(res, safePath(value.returnTo), [cookie(flowName(state), "", 0, "Lax"),
          cookie(sessionName, seal({ token: value.token, expiresAt: value.expiresAt }),
            Math.min(7 * 86400, Math.floor((value.expiresAt - now()) / 1000)))]);
      }
      if (apiPath(url.pathname)) {
        if (!allowed(url.pathname)) return reply(res, 404, { code: "not_found" });
        if (!session && !["/health", "/v1/account/config", "/v1/marketplace/public"].includes(url.pathname)) {
          return reply(res, 401, { code: "authentication_required", error: "请登录 Zioon 账户" });
        }
        return stream(req, res, url, session);
      }
      if (url.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method)) return reply(res, 404, { code: "not_found" });
      const root = await realpath(dist);
      const path = decodeURIComponent(url.pathname);
      let file = resolve(root, "." + path);
      if (file !== root && !file.startsWith(root + sep)) return reply(res, 404, { code: "not_found" });
      if (path === "/" || !extname(path)) file = resolve(root, "index.html");
      const canonical = await realpath(file).catch(() => "");
      if (!canonical.startsWith(root + sep) || !(await stat(canonical)).isFile()) return reply(res, 404, { code: "not_found" });
      const bytes = await readFile(canonical);
      res.writeHead(200, { "content-type": mime[extname(canonical)] || "application/octet-stream",
        "content-length": bytes.length, "cache-control": canonical.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
        "content-security-policy": app === "workbench"
          ? "frame-ancestors 'self'; base-uri 'self'; object-src 'none'"
          : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch (err) {
      if (!res.headersSent) reply(res, err.statusCode || 503, { code: err.code || "portal_unavailable" });
      else res.destroy();
    }
  });
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    try {
      validate(req, true);
      const url = new URL(req.url, publicUrl), session = open(valueOf(req.headers, sessionName));
      if (!session || !allowed(url.pathname) || app === "admin") throw error(401, "authentication_required");
      const proxy = httpRequest(new URL(url.pathname + url.search, upstream), {
        headers: headersFor(req, session, true)
      });
      const timer = setTimeout(() => proxy.destroy(), 15000);
      proxy.once("upgrade", (result, remote, remoteHead) => {
        clearTimeout(timer);
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(result.headers)
          .filter(([name]) => !["set-cookie"].includes(name))
          .map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
        if (head.length) remote.write(head);
        if (remoteHead.length) socket.write(remoteHead);
        pipeline(socket, remote, () => {});
        pipeline(remote, socket, () => {});
      });
      proxy.once("response", result => {
        clearTimeout(timer); result.resume();
        socket.end(`HTTP/1.1 ${result.statusCode || 502} Rejected\r\nConnection: close\r\n\r\n`);
      });
      proxy.once("error", () => { clearTimeout(timer); socket.destroy(); });
      socket.once("close", () => { clearTimeout(timer); proxy.destroy(); });
      proxy.end();
    } catch (err) {
      socket.end(`HTTP/1.1 ${err.statusCode || 503} Rejected\r\nConnection: close\r\n\r\n`);
    }
  });
  return { server, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
