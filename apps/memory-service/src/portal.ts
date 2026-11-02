import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createAccountClient } from "../../../packages/zioon-account/src/client.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const json = (value, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" }
});
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const ROOT = "/memory/dev.identity";
const security = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://copilot-cn.bytedance.net; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
};

export function createMemoryPortal({ db, gateway, secret, publicOrigin, issuer, adcOrigin,
  assetsDir = resolve(import.meta.dir, "../web"), fetchImpl = fetch }) {
  const origin = new URL(publicOrigin).origin;
  const accountOrigin = issuer ? new URL(issuer).origin : "";
  const portalSecurity = { ...security, "content-security-policy":
    security["content-security-policy"].replace("script-src 'self'", `script-src 'self' ${accountOrigin}`)
      .replace("connect-src 'self'", `connect-src 'self' ${accountOrigin}`) };
  if (!origin.startsWith("https:") && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) {
    throw new Error("Memory website requires HTTPS");
  }
  const secure = origin.startsWith("https:");
  const cookieName = secure ? "__Host-memory_session" : "memory_session_local";
  const loginName = secure ? "__Host-memory_login" : "memory_login_local";
  const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const cookieValue = (request, name) => String(request.headers.get("cookie") || "")
    .split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || "";
  const key = createHash("sha256").update(`memory-portal:${secret}`).digest();
  function seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(),
      cipher.getAuthTag()]).toString("base64url");
  }
  function open(value) {
    const bytes = Buffer.from(value, "base64url");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString());
  }
  const sql = db.$client;
  sql.exec(`CREATE TABLE IF NOT EXISTS memory_web_sessions (
    hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS memory_web_logins (
    hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS memory_cli_logins (
    hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`);
  const client = issuer ? createAccountClient({ issuer, adcOrigin, clientId: "zioon-memory",
    callbackUrl: `${origin}/account/callback`, scope: "openid profile email memory.read memory.write", fetchImpl }) : null;
  const files = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]], ["/console", ["console.html", "text/html; charset=utf-8"]],
    ["/docs", ["docs.html", "text/html; charset=utf-8"]], ["/assets/site.css", ["site.css", "text/css"]],
    ["/assets/tokens.css", ["tokens.css", "text/css"]],
    ["/account/login", ["login.html", "text/html; charset=utf-8"]],
    ["/account/verify", ["device.html", "text/html; charset=utf-8"]],
    ["/assets/login.js", ["login.js", "text/javascript"]], ["/assets/device.js", ["device.js", "text/javascript"]],
    ["/assets/site.js", ["site.js", "text/javascript"]], ["/assets/console.js", ["console.js", "text/javascript"]],
    ["/favicon.svg", ["favicon.svg", "image/svg+xml"]], ["/assets/forest.webp", ["forest.webp", "image/webp"]]
  ]);
  const cache = new Map([...files].map(([path, [file, mime]]) => [path, {
    body: readFileSync(resolve(assetsDir, file)), mime
  }]));
  if (accountOrigin) {
    const console = cache.get("/console");
    console.body = Buffer.from(console.body.toString()
      .replace("/assets/console.js?v=20261024", "/assets/console.js?v=sso20261024")
      .replace("</head>",
      `<script defer src="${accountOrigin}/session-client.js" data-product="memory"></script></head>`));
  }
  for (const file of ["agentfs-login.mjs", "install-agentfs-login.mjs"]) {
    cache.set(`/downloads/${file}`, {
      body: readFileSync(resolve(import.meta.dir, "../../../scripts", file)), mime: "text/javascript"
    });
  }
  const redirect = (path, cookies = []) => new Response(null, { status: 303, headers: [
    ["location", path], ["cache-control", "no-store"], ...cookies.map((value) => ["set-cookie", value])
  ] });
  function loginDestination(url) {
    const userCode = url.searchParams.get("user_code");
    if (userCode && !/^[A-F0-9]{12}$/.test(userCode)) fail("invalid_login_transaction");
    return userCode ? `/account/verify?user_code=${userCode}` : "/console";
  }
  function beginLogin(request, returnTo) {
    const { transaction } = client.begin();
    const token = random(), csrf = random();
    const previous = cookieValue(request, loginName);
    if (previous) sql.query("DELETE FROM memory_web_logins WHERE hash=?").run(hash(previous));
    sql.query("DELETE FROM memory_web_logins WHERE expires_at<=?").run(Date.now());
    sql.query("INSERT INTO memory_web_logins VALUES (?,?,?)").run(hash(token),
      seal({ transaction, csrf, returnTo }), Date.now() + 600_000);
    return { csrf, hostedLoginUrl: client.hostedLoginUrl(transaction), cookie: cookie(loginName, token, 600) };
  }
  function loginRecovery(status = 401) {
    const asset = cache.get("/account/login");
    return new Response(asset.body, { status, headers: {
      "content-type": asset.mime, "cache-control": "no-store"
    } });
  }
  function pendingLogin(request) {
    const browser = cookieValue(request, loginName);
    const row = browser && sql.query("SELECT * FROM memory_web_logins WHERE hash=? AND expires_at>?")
      .get(hash(browser), Date.now());
    if (!row) fail("invalid_login_transaction", 401);
    return { ...open(row.payload), hash: hash(browser) };
  }
  function completeLogin(result, pending) {
    const consumed = sql.query("DELETE FROM memory_web_logins WHERE hash=? AND expires_at>? RETURNING hash")
      .get(pending.hash, Date.now());
    if (!consumed) fail("invalid_login_transaction", 401);
    const token = random();
    sql.query("DELETE FROM memory_web_sessions WHERE expires_at<=?").run(Date.now());
    sql.query("INSERT INTO memory_web_sessions VALUES (?,?,?)").run(hash(token),
      seal({ token: result.token, subject: result.identity.sub, csrf: random() }), result.expiresAt);
    return { token, returnTo: pending.returnTo || "/console", cookies: [
      cookie(loginName, "", 0), cookie(cookieName, token, Math.floor((result.expiresAt - Date.now()) / 1000))
    ] };
  }
  async function session(request) {
    const token = cookieValue(request, cookieName);
    const row = token && sql.query("SELECT * FROM memory_web_sessions WHERE hash=? AND expires_at>?").get(hash(token), Date.now());
    if (!row) fail("authentication_required", 401);
    const data = open(row.payload);
    const identity = await client.userinfo(data.token, request.headers.get("cookie") || "");
    if (identity.sub !== data.subject) fail("account_changed", 401);
    return { ...data, identity, sessionHash: hash(token) };
  }
  async function upstream(path, token, body) {
    const response = await gateway.fetch(new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    const value = await response.json();
    if (!response.ok) fail(value.error || value.message || "memory_request_failed", response.status);
    return value;
  }
  async function dispatch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/account/login" && ["GET", "HEAD"].includes(request.method)) {
      if (!client) return loginRecovery(503);
      if (url.host !== new URL(origin).host) fail("invalid_host", 403);
      const returnTo = loginDestination(url);
      if (url.searchParams.has("error")) return loginRecovery();
      const login = beginLogin(request, returnTo);
      return redirect(login.hostedLoginUrl, [login.cookie]);
    }
    const asset = cache.get(url.pathname);
    if (asset && ["GET", "HEAD"].includes(request.method)) return new Response(request.method === "HEAD" ? null : asset.body, {
      headers: { "content-type": asset.mime, "cache-control": asset.mime.startsWith("text/html") ? "no-cache" : "public,max-age=3600" }
    });
    if (!url.pathname.startsWith("/account/") && !url.pathname.startsWith("/console/api/")
      && !url.pathname.startsWith("/v1/account/")) return null;
    if (!client) return json({ error: "account_service_not_configured" }, 503);
    if (new URL(request.url).host !== new URL(origin).host) fail("invalid_host", 403);
    if (url.pathname.startsWith("/v1/account/")) {
      if (request.headers.get("origin") && request.headers.get("origin") !== origin) fail("invalid_origin", 403);
      if (url.pathname === "/v1/account/config" && request.method === "GET") return json({ deviceLogin: true });
      if (url.pathname === "/v1/account/device/start" && request.method === "POST") {
        sql.query("DELETE FROM memory_cli_logins WHERE expires_at<=?").run(Date.now());
        if (sql.query("SELECT count(*) AS count FROM memory_cli_logins").get().count >= 100) fail("too_many_login_flows", 429);
        const flow = await client.deviceStart();
        const flowToken = random(), expiresAt = Date.now() + flow.expires_in * 1000;
        sql.query("INSERT INTO memory_cli_logins VALUES (?,?,?)").run(hash(flowToken), seal(flow), expiresAt);
        return json({ flowToken, userCode: flow.user_code, expiresAt, interval: flow.interval,
          verificationUri: `${origin}/account/verify`,
          verificationUriComplete: `${origin}/account/verify?user_code=${encodeURIComponent(flow.user_code)}` });
      }
      if (url.pathname === "/v1/account/device/poll" && request.method === "POST") {
        const input = await request.json();
        const row = typeof input.flowToken === "string"
          && sql.query("SELECT * FROM memory_cli_logins WHERE hash=? AND expires_at>?").get(hash(input.flowToken), Date.now());
        if (!row) fail("device_login_expired", 400);
        try {
          const tokens = await client.devicePoll(open(row.payload).device_code);
          sql.query("DELETE FROM memory_cli_logins WHERE hash=?").run(row.hash);
          return json({ token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
        } catch (error) {
          if (["authorization_pending", "slow_down"].includes(error.message)) return json({ pending: true });
          fail("device_login_failed", error.statusCode || 503);
        }
      }
      if (url.pathname === "/v1/account/logout" && request.method === "POST") {
        const token = String(request.headers.get("authorization") || "").replace(/^Bearer /, "");
        if (!token.startsWith("zioon_at_")) fail("authentication_required", 401);
        await client.revoke(token);
        return json({ loggedOut: true });
      }
      return json({ error: "not_found" }, 404);
    }
    if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== origin) fail("invalid_origin", 403);
    if (url.pathname === "/account/config" && request.method === "GET") {
      const login = beginLogin(request, loginDestination(url));
      const response = json({ csrf: login.csrf, hostedLoginUrl: login.hostedLoginUrl,
        githubEnabled: false, registrationEnabled: false });
      response.headers.set("set-cookie", login.cookie);
      return response;
    }
    if (["/account/email", "/account/social"].includes(url.pathname) && request.method === "POST") {
      const pending = pendingLogin(request);
      if (request.headers.get("x-csrf-token") !== pending.csrf) fail("invalid_csrf", 403);
      const hostedLoginUrl = client.hostedLoginUrl(pending.transaction);
      // Cached native forms also enter the shared account UI.
      return json({ url: hostedLoginUrl, returnTo: hostedLoginUrl });
    }
    if (url.pathname === "/account/callback" && request.method === "GET") {
      const pending = pendingLogin(request);
      if (url.searchParams.get("error") === "access_denied"
        && url.searchParams.get("state") === pending.transaction.state
        && url.searchParams.get("iss") === client.issuer) {
        sql.query("DELETE FROM memory_web_logins WHERE hash=?").run(pending.hash);
        return redirect("/", [cookie(loginName, "", 0)]);
      }
      const result = await client.callback(url.searchParams, pending.transaction);
      const completed = completeLogin(result, pending);
      return redirect(completed.returnTo, completed.cookies);
    }
    const data = await session(request);
    if (!["GET", "HEAD"].includes(request.method) && request.headers.get("x-csrf-token") !== data.csrf) fail("invalid_csrf", 403);
    if (url.pathname === "/account/device-info" && request.method === "GET") {
      return json(await client.deviceInfo(url.searchParams.get("user_code")));
    }
    if (url.pathname === "/account/device-approve" && request.method === "POST") {
      const input = await request.json();
      return json(await client.deviceApprove(input.user_code, data.token, input.decision));
    }
    if (url.pathname === "/account/logout" && request.method === "POST") {
      const commonCookies = await client.browserLogout(request.headers.get("cookie"), data.token);
      await client.revoke(data.token);
      sql.query("DELETE FROM memory_web_sessions WHERE hash=?").run(data.sessionHash);
      return new Response(JSON.stringify({ loggedOut: true }), {
        headers: [["content-type", "application/json"], ["cache-control", "no-store"],
          ["set-cookie", cookie(cookieName, "", 0)], ...commonCookies.map(value => ["set-cookie", value])]
      });
    }
    if (url.pathname === "/console/api/me" && request.method === "GET") return json({
      accountSubject: data.identity.sub,
      user: { name: data.identity.name || "Zioon 用户", email: data.identity.email || "" },
      csrf: data.csrf, canWrite: String(data.identity.scope).split(" ").includes("memory.write")
    });
    const path = url.searchParams.get("path") || ROOT;
    if (!(path === ROOT || path.startsWith(`${ROOT}/`))
      || /[\\\x00-\x1f]/.test(path) || path.slice(1).split("/").some((part) => !part || part === "." || part === "..")) {
      fail("invalid_memory_path");
    }
    if (url.pathname === "/console/api/entries" && request.method === "GET") {
      return json(await upstream(`/zion/files/entries?path=${encodeURIComponent(path)}`, data.token));
    }
    if (url.pathname === "/console/api/file" && request.method === "GET") {
      return json(await upstream(`/zion/files/read?path=${encodeURIComponent(path)}`, data.token));
    }
    if (url.pathname === "/console/api/file" && request.method === "POST") {
      const input = await request.json();
      if (!Object.hasOwn(input, "expected_hash") || typeof input.content !== "string") fail("expected_hash_required");
      return json(await upstream("/zion/files/write", data.token, { path,
        content: input.content, expected_hash: input.expected_hash }));
    }
    if (url.pathname === "/console/api/history" && request.method === "GET") {
      const me = await upstream("/auth/me", data.token);
      return json(await upstream(`/orgs/${encodeURIComponent(me.defaultOrgId)}/ops`, data.token, { op: "log", path, limit: 50 }));
    }
    if (url.pathname === "/console/api/search" && request.method === "GET") {
      const query = url.searchParams.get("q")?.trim() || "";
      if (!query || query.length > 120) fail("invalid_search");
      const me = await upstream("/auth/me", data.token);
      // Literal search avoids user-controlled regular expressions and runs on
      // the existing drive-scoped text index, without fetching every file.
      const matches = sql.query(`SELECT path, substr(content, max(1,instr(lower(content),lower(?))-80),240) AS snippet
        FROM files_fts_docs WHERE drive_id=? AND path LIKE '/memory/dev.identity/%'
        AND instr(lower(content),lower(?))>0 ORDER BY path LIMIT 50`).all(query, me.defaultDriveId, query);
      return json({ matches });
    }
    return json({ error: "not_found" }, 404);
  }
  return {
    async fetch(request) {
      try {
        const response = await dispatch(request);
        if (response) for (const [name, value] of Object.entries(portalSecurity)) response.headers.set(name, value);
        return response;
      } catch (error) {
        const url = new URL(request.url);
        let response;
        if (request.method === "GET" && url.pathname === "/account/callback") {
          const recovery = new URL("/account/login?error=login_incomplete", origin);
          try {
            const pending = pendingLogin(request);
            const code = new URL(pending.returnTo, origin).searchParams.get("user_code");
            if (/^[A-F0-9]{12}$/.test(code || "")) recovery.searchParams.set("user_code", code);
          } catch {}
          response = redirect(recovery.pathname + recovery.search, [cookie(loginName, "", 0)]);
        } else if (request.method === "GET" && url.pathname === "/account/login") {
          response = loginRecovery(error.statusCode || 503);
        } else {
          response = json({ error: error.statusCode ? error.message : "portal_unavailable" }, error.statusCode || 503);
        }
        for (const [name, value] of Object.entries(portalSecurity)) response.headers.set(name, value);
        return response;
      }
    }
  };
}
