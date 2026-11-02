import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createMarketplaceServer, loopbackFetch } from "../server/app.mjs";
import { createAccountAppHandoff } from "../../runtime/src/accounts/account-app-handoff.mjs";
import { AccountAccessControl } from "../../runtime/src/accounts/account-access-control.mjs";

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const shutdown = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const cookie = (response, name) => response.headers.getSetCookie().find((value) => value.startsWith(name + "=")).split(";")[0];

test("a signed-out browser follows the real account guard to unified login with its return path", async () => {
  let handoff, access;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (await handoff(req, res, url)) return;
    if (await access.handleHttp(req, res, url)) return;
    res.writeHead(404); res.end();
  });
  const origin = await listen(server);
  const loginReturnPaths = [];
  access = new AccountAccessControl({
    accounts: { authenticate: async () => null },
    store: { authenticate: async () => null, exchangePairing: async () => null }, publicBaseUrl: origin,
    oidc: {
      secureCookies: false,
      async begin(returnTo) {
        loginReturnPaths.push(returnTo);
        return { browser: randomBytes(32).toString("base64url"), url: "https://auth.zioon.tech/login" };
      }
    }
  });
  handoff = createAccountAppHandoff({ access, key: randomBytes(32), appOrigin: "https://marketplace.zioon.tech" });
  try {
    const path = "/v1/account/apps/authorize?" + new URLSearchParams({
      state: randomBytes(32).toString("base64url"),
      code_challenge: randomBytes(32).toString("base64url"), returnTo: "/installed"
    });
    const first = await fetch(origin + path, { redirect: "manual" });
    assert.equal(first.status, 303);
    const intermediate = new URL(first.headers.get("location"));
    assert.equal(intermediate.pathname, "/v1/account/login");
    assert.equal(intermediate.searchParams.get("returnTo"), path);
    const unified = await fetch(intermediate, { redirect: "manual" });
    assert.equal(unified.status, 302);
    assert.equal(unified.headers.get("location"), "https://auth.zioon.tech/login");
    assert.deepEqual(loginReturnPaths, [path]);
  } finally { await shutdown(server); }
});

test("shared account login, private installation, durable PKCE and cross-origin isolation", async () => {
  const token = "zion_account_v1." + randomBytes(32).toString("base64url");
  const common = "__Secure-zioon.session_token=unified-browser";
  const clearedCommon = "__Secure-zioon.session_token=; Domain=zioon.tech; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  let active = true, handler;
  const transactions = new Map(), observed = [];
  const principal = { kind: "account", sessionId: "session-fixture", expiresAt: Date.now() + 600000, user: { id: "user-fixture" } };
  const runtime = createServer(async (req, res) => {
    const url = new URL(req.url, runtimeOrigin);
    if (await handler(req, res, url)) return;
    let body = "";
    for await (const block of req) body += block;
    observed.push({ url: url.pathname, method: req.method, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/marketplace/public") {
      res.end(JSON.stringify({ entries: [{ id: "official", name: "Official" }], categories: ["开发"] })); return;
    }
    if (!active || !String(req.headers.cookie).includes("zion_account_local=" + token)
      || !String(req.headers.cookie).includes(common)) {
      res.writeHead(401); res.end(JSON.stringify({ error: "authentication_required" })); return;
    }
    if (url.pathname === "/v1/account/me") res.end(JSON.stringify({ authenticated: true, user: { id: "user-fixture", name: "User" } }));
    else if (url.pathname === "/v1/account/logout") {
      active = false;
      res.setHeader("set-cookie", [clearedCommon, "zion_account_local=; Path=/; Max-Age=0"]);
      res.end(JSON.stringify({ loggedOut: true }));
    }
    else if (url.pathname === "/v1/marketplace/installations/official") res.end(JSON.stringify({ installed: true }));
    else res.end(JSON.stringify({ entries: [{ id: "private", visibility: "private" }] }));
  });
  const runtimeOrigin = await listen(runtime);
  const marketplace = createMarketplaceServer({
    origin: "https://marketplace.test", runtimeOrigin, runtimeTarget: runtimeOrigin,
    key: randomBytes(32), dist: fileURLToPath(new URL("../dist", import.meta.url)), allowLoopbackHttp: true,
    accountFetchImpl: async (_url, options) => {
      if (!String(options.headers.cookie).includes(common)) return Response.json({ authenticated: false });
      return Response.json({ authenticated: active, generation: "generation-fixture" });
    }
  });
  const appOrigin = await listen(marketplace);
  const marketPublicOrigin = "https://marketplace.test";
  const access = {
    publicBaseUrl: runtimeOrigin, sessionCookie: "zion_account_local", checkLoginRate() {},
    requireLogin: async (request) => {
      if (!active || !String(request.headers.cookie).includes("zion_account_local=" + token)
        || !String(request.headers.cookie).includes(common)) {
        throw Object.assign(new Error("authentication_required"), { statusCode: 401 });
      }
      return principal;
    },
    authenticateHeaders: async (headers) => active && String(headers.cookie).includes("zion_account_local=" + token)
      && String(headers.cookie).includes(common) ? principal : null,
    accounts: {
      saveLoginTransaction: async (code, challenge, payload) => transactions.set(code, { challenge, payload }),
      consumeLoginTransaction: async (code, challenge) => {
        const row = transactions.get(code);
        if (!row || row.challenge !== challenge) throw Object.assign(new Error("invalid_login_transaction"), { statusCode: 401 });
        transactions.delete(code); return row.payload;
      }
    }
  };
  handler = createAccountAppHandoff({ access, key: randomBytes(32), appOrigin: marketPublicOrigin });
  try {
    const publicCatalog = await fetch(appOrigin + "/api/catalog");
    assert.equal(publicCatalog.status, 200);
    assert.equal((await publicCatalog.json()).entries[0].id, "official");
    const initial = await fetch(appOrigin + "/api/auth/session");
    assert.equal((await initial.json()).authenticated, false);
    const bootstrap = await fetch(appOrigin + "/api/auth/session", { headers: { cookie: common + "; unrelated=never-forward" } });
    assert.deepEqual(await bootstrap.json(), { authenticated: false, sharedAuthenticated: true, generation: "generation-fixture" });
    assert.equal((await fetch(appOrigin + "/api/runtime/v1/marketplace/snapshot")).status, 401);

    const login = await fetch(appOrigin + "/api/auth/login?returnTo=%2Finstalled", { redirect: "manual" });
    const flowCookie = cookie(login, "__Host-zioon_marketplace_login");
    assert.match(flowCookie, /^__Host-zioon_marketplace_login=/);
    const authorize = new URL(login.headers.get("location"));
    assert.equal(authorize.origin, runtimeOrigin);
    const notLoggedIn = await fetch(authorize, { redirect: "manual" });
    assert.equal(notLoggedIn.status, 303);
    assert.match(notLoggedIn.headers.get("location"), /\/v1\/account\/login\?/);
    const authorized = await fetch(authorize, { redirect: "manual", headers: { cookie: "zion_account_local=" + token + "; " + common } });
    const callback = new URL(authorized.headers.get("location"));
    assert.equal(callback.origin, marketPublicOrigin);
    assert.equal(callback.searchParams.has("token"), false);
    const stored = transactions.get(callback.searchParams.get("code")).payload;
    assert.notEqual(stored.token, token);
    assert.equal(JSON.stringify(stored).includes(token), false);
    const wrongVerifier = await fetch(runtimeOrigin + "/v1/account/apps/exchange", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: callback.searchParams.get("code"), state: callback.searchParams.get("state"), verifier: randomBytes(32).toString("base64url") })
    });
    assert.equal(wrongVerifier.status, 401);
    assert.equal(transactions.size, 1);
    const accepted = await fetch(appOrigin + callback.pathname + callback.search, { redirect: "manual", headers: { cookie: flowCookie + "; " + common } });
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get("location"), "/installed");
    const sessionCookie = cookie(accepted, "__Host-zioon_marketplace") + "; " + common;
    assert.equal(sessionCookie.includes(token), false);
    assert.equal(transactions.size, 0);
    const replay = await fetch(appOrigin + callback.pathname + callback.search, { redirect: "manual", headers: { cookie: flowCookie } });
    assert.match(replay.headers.get("location"), /loginError=/);
    const session = await fetch(appOrigin + "/api/auth/session", { headers: { cookie: sessionCookie } });
    assert.equal((await session.json()).user.id, "user-fixture");
    const privateCatalog = await fetch(appOrigin + "/api/runtime/v1/marketplace/snapshot", { headers: { cookie: sessionCookie } });
    assert.equal((await privateCatalog.json()).entries[0].visibility, "private");
    assert.equal((await fetch(appOrigin + "/api/runtime/v1/admin/runtime-health", { headers: { cookie: sessionCookie } })).status, 404);
    for (const foreign of [undefined, "null", "https://foreign.test"]) {
      const rejected = await fetch(appOrigin + "/api/runtime/v1/marketplace/installations/official", {
        method: "POST", headers: { cookie: sessionCookie, ...(foreign ? { origin: foreign } : {}) }, body: "{}"
      });
      assert.equal(rejected.status, 403);
    }
    const installed = await fetch(appOrigin + "/api/runtime/v1/marketplace/installations/official", {
      method: "POST", headers: { cookie: sessionCookie, origin: marketPublicOrigin, "content-type": "application/json" }, body: "{}"
    });
    assert.equal((await installed.json()).installed, true);
    const forwarded = observed.findLast((row) => row.method === "POST");
    assert.equal(forwarded.headers.origin, runtimeOrigin);
    assert.equal(forwarded.headers.authorization, undefined);
    assert.equal(forwarded.headers.cookie, common + "; zion_account_local=" + token);
    assert.equal(forwarded.headers.cookie.includes("__Host-zioon_marketplace"), false);
    const uninstall = await fetch(appOrigin + "/api/runtime/v1/marketplace/installations/official", {
      method: "DELETE", headers: { cookie: sessionCookie, origin: marketPublicOrigin, "content-type": "application/json" },
      body: '{"expectedRevision":9}'
    });
    assert.equal(uninstall.status, 200);
    assert.equal(observed.at(-1).body, '{"expectedRevision":9}');
    const canonicalHost = await loopbackFetch(runtimeOrigin + "/v1/account/config", {
      headers: { host: "runtime.zioon.tech", cookie: "zion_account_local=" + token + "; " + common }
    });
    assert.equal(canonicalHost.status, 200);
    assert.equal(observed.at(-1).headers.host, "runtime.zioon.tech");
    const missingParent = await fetch(appOrigin + "/api/runtime/v1/marketplace/snapshot", {
      headers: { cookie: sessionCookie.split(";")[0] }
    });
    assert.equal(missingParent.status, 401);
    const switchedAccount = await fetch(appOrigin + "/api/runtime/v1/marketplace/snapshot", {
      headers: { cookie: sessionCookie.replace("unified-browser", "other-browser") }
    });
    assert.equal(switchedAccount.status, 401);
    const logout = await fetch(appOrigin + "/api/auth/logout", {
      method: "POST", headers: { origin: marketPublicOrigin, cookie: sessionCookie }, body: "{}"
    });
    assert.equal(logout.status, 200);
    assert.ok(logout.headers.getSetCookie().includes(clearedCommon));
    assert.equal(logout.headers.getSetCookie().some((value) => value.startsWith("zion_account_local=")), false);
    assert.equal(active, false);
    const revoked = await fetch(appOrigin + "/api/auth/session", { headers: { cookie: sessionCookie } });
    assert.equal((await revoked.json()).authenticated, false);
    assert.match(revoked.headers.getSetCookie()[0], /Max-Age=0/);
    const detail = await fetch(appOrigin + "/plugins/zion.evidence-research");
    assert.equal(detail.status, 200);
    assert.match(await detail.text(), /Zioon 插件市场/);
    assert.match(detail.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const unknown = await fetch(appOrigin + "/assets/missing.js");
    assert.equal(unknown.status, 404);
  } finally { await shutdown(marketplace); await shutdown(runtime); }
});

test("bootstrap and global logout failures are explicit, and failed logout preserves the app session", async () => {
  let unavailable = true;
  const common = "__Secure-zioon.session_token=central-only";
  const observed = [];
  const server = createMarketplaceServer({
    origin: "https://marketplace.test", runtimeOrigin: "https://runtime.zioon.tech", runtimeTarget: "http://127.0.0.1:8766",
    key: randomBytes(32), dist: fileURLToPath(new URL("../dist", import.meta.url)),
    accountFetchImpl: async (url, options) => {
      observed.push({ path: url.pathname, ...options });
      if (unavailable) return Response.json({ error: "unavailable" }, { status: 503 });
      return new Response('{"loggedOut":true}', { headers: { "set-cookie":
        "__Secure-zioon.session_token=; Domain=zioon.tech; Path=/; HttpOnly; Secure; Max-Age=0" } });
    }
  });
  const origin = await listen(server);
  try {
    assert.equal((await fetch(origin + "/api/auth/session", { headers: { cookie: common + "; secret=not-forwarded" } })).status, 503);
    const failed = await fetch(origin + "/api/auth/logout", { method: "POST",
      headers: { origin: "https://marketplace.test", cookie: common }, body: "{}" });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.getSetCookie().length, 0);
    unavailable = false;
    const result = await fetch(origin + "/api/auth/logout", { method: "POST",
      headers: { origin: "https://marketplace.test", cookie: common }, body: "{}" });
    assert.equal(result.status, 200);
    assert.equal(observed.at(-1).path, "/api/v1/zioon/session/logout");
    assert.equal(observed.at(-1).headers.origin, "https://auth.zioon.tech");
    assert.equal(observed[0].headers.cookie, common);
    assert.equal(result.headers.getSetCookie().length, 3);
  } finally { await shutdown(server); }
});
