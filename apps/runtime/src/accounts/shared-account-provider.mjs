import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createAccountClient } from "../../../../packages/zioon-account/src/client.mjs";
import { accountPublicUrl, safeReturnTo } from "./oidc-provider.mjs";
import { accountError } from "./account-policy.mjs";
import { cookieValue, headerValue } from "../access-control.mjs";
import { identityStyles } from "./identity-ui.mjs";
import { measureRequestStage } from "../request-performance.mjs";

const random = () => randomBytes(32).toString("base64url");
const escape = (value) => String(value || "").replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export async function sharedAccountKey(path) {
  if (!path) throw new Error("Shared login requires ZIOON_ACCOUNT_SESSION_KEY_FILE");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const key = await readFile(path);
  if (key.length !== 32) throw new Error("Shared account session key must contain 32 bytes");
  return key;
}

function page(title, content, theme = "") {
  return `<!doctype html><html lang="zh-CN"${["light", "dark"].includes(theme) ? ` data-theme="${theme}"` : ""}>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Zion</title><style>
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif}
.product-bar{display:flex;align-items:center}.brand{display:flex;align-items:center;color:var(--text);text-decoration:none}
.auth-shell{display:grid}p{color:var(--muted)}form,label{display:grid}input{width:100%;background:var(--field);color:var(--text);border:1px solid}
button,.button{display:flex;align-items:center;justify-content:center;padding:0 18px;border:1px solid var(--accent);background:var(--accent);color:var(--bg);cursor:pointer}
a{color:var(--accent)}.error{color:var(--text);background:var(--accent-soft)}
.actions{display:flex}.divider{text-align:center;color:var(--faint)}code{display:block;font-size:24px;letter-spacing:3px;margin:24px 0}
${identityStyles}</style><header class="product-bar"><a class="brand" href="/"><strong>Zion</strong></a></header>
<main class="auth-shell"><section class="auth-panel">${content}</section></main></html>`;
}

async function form(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > 16_384) throw accountError(413, "login_request_too_large");
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** Shared account login with Runtime-owned transactions, memberships and sessions. */
export async function createSharedAccountProvider({
  issuer, adcOrigin, clientId, publicBaseUrl, allowLoopbackHttp = false,
  activeSpaceId = "", store, key, now = Date.now, client: suppliedClient,
  onSessionCreated = null
}) {
  const origin = accountPublicUrl(publicBaseUrl, allowLoopbackHttp).origin;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Missing shared session encryption key");
  const client = suppliedClient || createAccountClient({
    issuer, adcOrigin, clientId, callbackUrl: `${origin}/v1/account/callback`,
    scope: "openid profile email zion.api"
  });
  const validationFlights = new Map();
  await store.pool.query(`CREATE TABLE IF NOT EXISTS account_shared_grants (
    session_id TEXT PRIMARY KEY REFERENCES account_sessions(id) ON DELETE CASCADE,
    issuer TEXT NOT NULL, client_id TEXT NOT NULL, payload TEXT NOT NULL, expires_at BIGINT NOT NULL
  )`);
  function seal(sessionId, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${sessionId}|${client.issuer}|${clientId}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }
  function unseal(sessionId, value) {
    const bytes = Buffer.from(value, "base64url");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`${sessionId}|${client.issuer}|${clientId}`));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  }
  async function grantFor(sessionId) {
    const result = await store.pool.query(`SELECT payload,expires_at FROM account_shared_grants
      WHERE session_id=$1 AND issuer=$2 AND client_id=$3`, [sessionId, client.issuer, clientId]);
    const row = result.rows[0];
    if (!row) return null;
    if (Number(row.expires_at) <= now()) throw accountError(401, "authentication_required");
    return unseal(sessionId, row.payload);
  }
  function checkIdentity(identity) {
    if (!identity?.sub || identity.iss !== client.issuer || identity.aud !== clientId
      || !String(identity.scope || "").split(" ").includes("zion.api")) {
      throw accountError(401, "invalid_account_identity");
    }
  }
  async function sessionFromGrant(grant) {
    checkIdentity(grant.identity);
    const user = await store.resolveIdentity({
      issuer: grant.identity.iss, subject: grant.identity.sub,
      name: grant.identity.name, email: grant.identity.email,
      emailVerified: grant.identity.email_verified === true
    });
    const membership = activeSpaceId ? await store.membership(user.id, activeSpaceId) : null;
    const session = await store.createSession(user.id, {
      ttlMs: Math.min(7 * 86_400_000, Math.floor(grant.expiresAt - now())),
      ...(membership?.status === "active" ? { activeSpaceId } : {})
    });
    try {
      await store.pool.query(`INSERT INTO account_shared_grants
        (session_id,issuer,client_id,payload,expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [session.sessionId, client.issuer, clientId, seal(session.sessionId, grant), grant.expiresAt]);
      await onSessionCreated?.(user, session);
    } catch (error) { await store.revokeSession(user.id, session.sessionId); throw error; }
    return session;
  }
  const html = (response, status, body) => {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      // Native form POSTs use Origin:null with no-referrer and fail CSRF checks.
      "referrer-policy": "same-origin",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    }); response.end(body);
  };
  const provider = {
    issuer: client.issuer, callbackUrl: `${origin}/v1/account/callback`,
    keepLoginCookie: true,
    loginBindingCookie(name, state) {
      return /^[A-Za-z0-9_-]{43}$/.test(state || "") ? `${name}_${state}` : "";
    },
    secureCookies: origin.startsWith("https:"), settingsUrl: `${client.issuer}/account`,
    async begin(returnTo, { uiTheme = "", browser: existingBrowser = "" } = {}) {
      const { transaction } = client.begin();
      // A pending tab must not replace the binding used by another tab.
      // This cookie has no session authority; state and PKCE remain per request.
      const browser = /^[A-Za-z0-9_-]{43}$/.test(existingBrowser) ? existingBrowser : random();
      let destination = safeReturnTo(returnTo);
      try {
        const pathname = decodeURIComponent(new URL(destination, origin).pathname);
        if (/^\/(?:account\/login|v1\/account\/(?:login|callback|shared\/(?:login|email|social)))(?:\/|$)/.test(pathname)) {
          destination = "/";
        }
      } catch { destination = "/"; }
      await store.saveLoginTransaction(transaction.state, browser, {
        ...transaction, csrf: random(), returnTo: destination, theme: uiTheme
      });
      return { browser, state: transaction.state, url: client.hostedLoginUrl(transaction) };
    },
    async callback(query, browser) {
      let transaction;
      let stage = "transaction";
      try {
        transaction = await store.consumeLoginTransaction(query.get("state"), browser);
        if (query.get("error") === "access_denied" && query.get("iss") === client.issuer) {
          throw accountError(400, "login_cancelled");
        }
        stage = "grant";
        const grant = await client.callback(query, transaction);
        // Reject an invalid provider identity before entering account/workspace
        // provisioning, so its failure is reported as a login error.
        checkIdentity(grant.identity);
        stage = "session";
        return { ...await sessionFromGrant(grant), returnTo: transaction.returnTo };
      } catch (error) {
        // Only a consumed browser-bound transaction may restore a destination.
        const code = error.code === "login_cancelled" ? "login_cancelled"
          : error.code === "account_disabled" ? "account_disabled"
          : stage === "transaction" ? error.code === "invalid_login_transaction"
            ? "invalid_login_transaction" : "account_service_unavailable"
          : stage === "session" ? "workspace_unavailable"
          : Number(error.statusCode) >= 500 || !error.statusCode
            ? "account_service_unavailable" : "invalid_login_transaction";
        throw Object.assign(accountError(
          ["account_service_unavailable", "workspace_unavailable"].includes(code) ? 503
            : code === "account_disabled" ? 403 : 400, code), {
          loginReturnTo: transaction?.returnTo || "/", loginTheme: transaction?.theme || ""
        });
      }
    },
    loginFailure(access, response, error) {
      const known = ["login_cancelled", "account_disabled", "workspace_unavailable",
        "account_service_unavailable", "invalid_login_transaction", "login_rate_limited"];
      const destination = new URL("/login", client.issuer);
      destination.search = new URLSearchParams({
        error: known.includes(error.code) ? error.code : "account_service_unavailable",
        return_to: `/api/v1/zioon/restart?${new URLSearchParams({ client_id: clientId })}`
      }).toString();
      response.writeHead(303, { location: destination.href, "cache-control": "no-store" });
      response.end();
    },
    async exchangeAccessToken(token) {
      // Opaque provider grants must be bound to this client and its API scope.
      const identity = await client.userinfo(token);
      checkIdentity(identity);
      throw accountError(404, "access_token_exchange_disabled");
    },
    async beginDevice() {
      const device = await client.deviceStart();
      const flowToken = random();
      const expiresAt = now() + Math.min(device.expires_in, 600) * 1000;
      await store.saveLoginTransaction(flowToken, flowToken, { deviceCode: device.device_code }, expiresAt - now());
      return { flowToken, userCode: device.user_code, expiresAt, interval: device.interval,
        verificationUri: `${origin}/v1/account/shared/device`,
        verificationUriComplete: `${origin}/v1/account/shared/device?user_code=${device.user_code}` };
    },
    async pollDevice(flowToken) {
      const flow = await store.readLoginTransaction(flowToken, flowToken);
      let tokens;
      try { tokens = await client.devicePoll(flow.deviceCode); }
      catch (error) {
        if (["authorization_pending", "slow_down"].includes(error.message)) return { pending: true };
        throw accountError(401, "device_login_failed");
      }
      await store.consumeLoginTransaction(flowToken, flowToken);
      return sessionFromGrant({ identity: await client.userinfo(tokens.access_token),
        token: tokens.access_token, expiresAt: now() + tokens.expires_in * 1000 });
    },
    async validateSession(principal, { browser = false, cookies = "" } = {}) {
      // Share only overlapping validations. Each later request still checks the
      // authority, and browser proofs never share results with bearer requests
      // or a different browser cookie. Local permissions are rechecked separately.
      const key = createHash("sha256").update(JSON.stringify([
        principal.sessionId, principal.user.id, browser, browser ? cookies : ""
      ])).digest("hex");
      const existing = validationFlights.get(key);
      if (existing) return measureRequestStage("auth-identity-shared", () => existing);
      const pending = (async () => {
        const grant = await measureRequestStage("auth-grant", () => grantFor(principal.sessionId));
        if (!grant) {
          if (browser) throw accountError(401, "authentication_required");
          return true;
        }
        const identity = await measureRequestStage("auth-userinfo", () =>
          client.userinfo(grant.token, browser ? cookies : undefined));
        checkIdentity(identity);
        const linked = await measureRequestStage("auth-link", () =>
          store.identityForUser(principal.user.id, client.issuer));
        if (linked?.subject !== identity.sub) throw accountError(401, "authentication_required");
        return true;
      })().finally(() => {
        if (validationFlights.get(key) === pending) validationFlights.delete(key);
      });
      validationFlights.set(key, pending);
      return pending;
    },
    async revokeSession(sessionId) {
      const grant = await grantFor(sessionId).catch(() => null);
      // Local revocation is already durable; remove the browser's scoped grant too.
      if (grant) await client.revoke(grant.token);
      await store.pool.query("DELETE FROM account_shared_grants WHERE session_id=$1", [sessionId]);
    },
    async logoutBrowser(sessionId, cookies) {
      const grant = await grantFor(sessionId).catch(() => null);
      return client.browserLogout(cookies, grant?.token);
    },
    async handleHttp(access, request, response, url) {
      const path = url.pathname;
      if (path !== "/account/login" && !path.startsWith("/v1/account/shared/")) return false;
      const host = headerValue(request.headers, "host");
      if (host && host !== new URL(origin).host) throw accountError(403, "invalid_origin");
      if (path === "/account/login" && request.method === "GET") {
        response.writeHead(303, {
          location: `/v1/account/shared/login${url.search}`, "cache-control": "no-store"
        });
        response.end(); return true;
      }
      if (path === "/v1/account/shared/login" && request.method === "GET") {
        access.checkLoginRate(request, "page");
        const state = url.searchParams.get("state");
        if (!state) {
          const login = await provider.begin(url.searchParams.get("returnTo"), {
            uiTheme: url.searchParams.get("uiTheme"),
            browser: cookieValue(request.headers, access.loginCookie)
          });
          const bindingCookie = provider.loginBindingCookie(access.loginCookie, login.state);
          response.writeHead(303, { location: login.url, "cache-control": "no-store",
            "set-cookie": [
              access.cookie(access.loginCookie, login.browser, { sameSite: "Lax" }),
              ...(bindingCookie ? [access.cookie(bindingCookie, login.browser, { sameSite: "Lax" })] : [])
            ] });
          response.end(); return true;
        }
        const transaction = await store.readLoginTransaction(state,
          cookieValue(request.headers, provider.loginBindingCookie(access.loginCookie, state))
            || cookieValue(request.headers, access.loginCookie));
        response.writeHead(303, { location: client.hostedLoginUrl(transaction), "cache-control": "no-store" });
        response.end();
        return true;
      }
      if (request.method === "POST" && ["/v1/account/shared/email", "/v1/account/shared/social"].includes(path)) {
        if (headerValue(request.headers, "origin") !== origin) throw accountError(403, "invalid_origin");
        access.checkLoginRate(request);
        const input = await form(request);
        const browser = cookieValue(request.headers, provider.loginBindingCookie(access.loginCookie, input.state))
          || cookieValue(request.headers, access.loginCookie);
        const transaction = await store.readLoginTransaction(input.state, browser, { attempt: true });
        if (!input.csrf || input.csrf !== transaction.csrf) throw accountError(403, "invalid_csrf");
        // Cached native forms move into the shared UI after the existing checks.
        response.writeHead(303, { location: client.hostedLoginUrl(transaction), "cache-control": "no-store" });
        response.end();
        return true;
      }
      if (path === "/v1/account/shared/device") {
        const principal = await access.requireLogin(request, { csrf: false }).catch(() => null);
        if (!principal || !await grantFor(principal.sessionId)) {
          response.writeHead(303, { location: `/v1/account/login?returnTo=${encodeURIComponent(path + url.search)}` });
          response.end(); return true;
        }
        if (request.method === "GET") {
          const code = url.searchParams.get("user_code") || "";
          if (code) await client.deviceInfo(code);
          const csrf = random();
          htmlWithCookie(response, access.cookie("zion_device_confirm", csrf),
            page("设备登录", `<h1>确认设备登录</h1><p>当前账号：${escape(principal.user.email)}。请核对设备上的验证码。</p>
            <form method="post"><label>验证码<input name="user_code" value="${escape(code)}" required maxlength="12"></label>
            <input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="approve">确认登录</button>
            <button class="social" name="decision" value="deny">取消</button></form>`));
          return true;
        }
        if (request.method === "POST") {
          if (headerValue(request.headers, "origin") !== origin) throw accountError(403, "invalid_origin");
          access.checkLoginRate(request, "device-approve");
          const input = await form(request);
          if (!input.csrf || input.csrf !== cookieValue(request.headers, "zion_device_confirm")) {
            throw accountError(403, "invalid_csrf");
          }
          const grant = await grantFor(principal.sessionId);
          await client.deviceApprove(input.user_code, grant.token, input.decision);
          html(response, 200, page("设备登录", "<h1>请求已处理</h1><p>可以关闭此页，回到发起登录的设备。</p>"));
          return true;
        }
      }
      throw accountError(404, "account_endpoint_not_found");
    },
    close() {}
  };
  function htmlWithCookie(response, cookie, body) {
    response.setHeader("set-cookie", cookie);
    html(response, 200, body);
  }
  return provider;
}
