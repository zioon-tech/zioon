import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { createClientPortal } from "../server/app.mjs";
import { createAccountAppHandoff } from "../../runtime/src/accounts/account-app-handoff.mjs";

const listen = async server => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const responseCookie = (res, prefix) => res.headers.getSetCookie().find(c => c.startsWith(prefix)).split(";")[0];
test("browser clients share identity, enforce origin and PKCE, and stream HTTP/WS without exposing credentials", async () => {
  const token = "zion_account_v1." + randomBytes(32).toString("base64url");
  const parent = "__Secure-zioon.session_token=test-parent", transactions = new Map();
  let active = true, handoff, sawAbort = false, finishStream;
  const observed = [];
  const runtime = createServer(async (req, res) => {
    const url = new URL(req.url, runtimeOrigin);
    if (await handoff(req, res, url)) return;
    observed.push(req.headers);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/health") return res.end(JSON.stringify({ ok: true, service: "zion-runtime", authRequired: true, authMode: "accounts-v1" }));
    if (!active || !req.headers.cookie?.includes(parent) || !req.headers.cookie?.includes("zion_account_local=" + token)) {
      res.writeHead(401); return res.end('{"code":"authentication_required"}');
    }
    if (url.pathname === "/v1/stream") {
      res.setHeader("content-type", "text/event-stream");
      res.flushHeaders(); res.write("data: first\n\n");
      finishStream = () => res.end("data: last\n\n");
      res.once("close", () => { sawAbort = true; });
      return;
    }
    if (url.pathname.endsWith("/logout")) {
      active = false; res.setHeader("set-cookie", "__Secure-zioon.session_token=; Domain=zioon.tech; Path=/; Max-Age=0; HttpOnly; Secure");
      return res.end('{"loggedOut":true}');
    }
    res.end('{"user":{"id":"user-test"},"private":true}');
  });
  const runtimeOrigin = await listen(runtime);
  const wsServer = new WebSocketServer({ noServer: true });
  runtime.on("upgrade", (req, socket, head) => {
    observed.push(req.headers);
    if (!active || !req.headers.cookie?.includes(parent)) return socket.destroy();
    wsServer.handleUpgrade(req, socket, head, ws => ws.on("message", data => ws.send(data)));
  });
  const key = randomBytes(32);
  const apps = {};
  for (const app of ["workbench", "mobile", "admin"]) {
    const origin = `https://${app}.test`;
    const portal = createClientPortal({ app, origin, runtimeOrigin, runtimeTarget: runtimeOrigin,
      key, dist: fileURLToPath(new URL("../../../dist/admin", import.meta.url)), allowLoopbackHttp: true });
    apps[app] = { ...portal, origin, target: await listen(portal.server) };
  }
  const principal = { kind: "account", sessionId: "test", expiresAt: Date.now() + 600000, user: { id: "user-test" } };
  const access = { publicBaseUrl: runtimeOrigin, sessionCookie: "zion_account_local", checkLoginRate() {},
    requireLogin: async req => {
      if (!active || !req.headers.cookie?.includes("zion_account_local=" + token) || !req.headers.cookie?.includes(parent)) {
        throw Object.assign(new Error(), { statusCode: 401 });
      } return principal;
    },
    authenticateHeaders: async headers => active && headers.cookie?.includes(parent) ? principal : null,
    accounts: {
      saveLoginTransaction: async (code, challenge, payload) => transactions.set(code, { challenge, payload }),
      consumeLoginTransaction: async (code, challenge) => {
        const transaction = transactions.get(code);
        if (!transaction || transaction.challenge !== challenge) throw Object.assign(new Error(), { statusCode: 401 });
        transactions.delete(code); return transaction.payload;
      }
    } };
  handoff = createAccountAppHandoff({ access, key: randomBytes(32), appOrigins: Object.fromEntries(
    Object.entries(apps).map(([name, value]) => [name, value.origin])) });
  const call = (app, path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(app.target + path, { method: options.method || "GET",
      headers: { host: new URL(app.origin).host, ...options.headers } }, res => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach(v => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      resolve(new Response([204, 304].includes(res.statusCode) ? null : Readable.toWeb(res),
        { status: res.statusCode, headers }));
    });
    req.once("error", reject);
    req.end(options.body);
  });
  try {
    const cookies = {};
    for (const [name, app] of Object.entries(apps)) {
      assert.equal((await call(app, "/v1/account/me")).status, 401);
      const login = await call(app, "/api/auth/login?returnTo=%2F");
      const flow = responseCookie(login, `__Host-zioon_${name}_login_`);
      const authorization = new URL(login.headers.get("location"));
      assert.equal(authorization.searchParams.get("app"), name);
      const authorized = await fetch(authorization, { redirect: "manual",
        headers: { cookie: "zion_account_local=" + token + "; " + parent } });
      assert.equal(authorized.status, 303);
      const callback = new URL(authorized.headers.get("location"));
      assert.equal(callback.origin, app.origin);
      const wrongApp = await call(apps[name === "workbench" ? "mobile" : "workbench"], callback.pathname + callback.search,
        { headers: { cookie: flow + "; " + parent } });
      assert.match(wrongApp.headers.get("location"), /loginError=expired/);
      const accepted = await call(app, callback.pathname + callback.search, { headers: { cookie: flow + "; " + parent } });
      assert.equal(accepted.status, 303);
      cookies[name] = responseCookie(accepted, `__Host-zioon_${name}=`) + "; " + parent;
      assert.equal(cookies[name].includes(token), false);
      const me = await call(app, "/v1/account/me", { headers: { cookie: cookies[name], authorization: "Bearer malicious", "x-forwarded-host": "evil" } });
      assert.equal(me.status, 200);
      assert.equal(observed.at(-1).authorization, undefined);
      assert.equal(observed.at(-1)["x-forwarded-host"], undefined);
      assert.equal(observed.at(-1).origin, runtimeOrigin);
      assert.equal((await call(app, "/v1/account/me", { headers: { cookie: cookies[name].split(";")[0] } })).status, 401);
      const replay = await call(app, callback.pathname + callback.search, { headers: { cookie: flow + "; " + parent } });
      assert.match(replay.headers.get("location"), /loginError=unavailable/);
      assert.equal((await call(app, "/v1/account/apps/authorize")).status, 404);
    }
    for (const foreign of [undefined, "null", "https://evil.test"]) {
      const rejected = await call(apps.workbench, "/v1/write", { method: "POST",
        headers: { cookie: cookies.workbench, ...(foreign ? { origin: foreign } : {}) }, body: "{}" });
      assert.equal(rejected.status, 403);
    }
    assert.equal((await call(apps.admin, "/v1/plugins/private")).status, 404);
    const stream = await call(apps.workbench, "/v1/stream", { headers: { cookie: cookies.workbench } });
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    finishStream();
    assert.match(new TextDecoder().decode((await reader.read()).value), /last/);
    await reader.cancel();
    const cancelled = await call(apps.mobile, "/v1/stream", { headers: { cookie: cookies.mobile } });
    await cancelled.body.cancel();
    await new Promise(resolve => setImmediate(resolve));
    const ws = new WebSocket(apps.workbench.target.replace("http", "ws") + "/collaboration/test", {
      headers: { host: "workbench.test", origin: apps.workbench.origin, cookie: cookies.workbench }
    });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const echoed = new Promise(resolve => ws.once("message", data => resolve(data.toString())));
    ws.send("collaboration payload"); assert.equal(await echoed, "collaboration payload");
    ws.close(); await new Promise(resolve => ws.once("close", resolve));
    assert.equal(sawAbort, true);
    const logout = await call(apps.mobile, "/v1/account/logout", { method: "POST",
      headers: { cookie: cookies.mobile, origin: apps.mobile.origin }, body: "{}" });
    assert.equal(logout.status, 200);
    assert.ok(logout.headers.getSetCookie().some(c => c.includes("Domain=zioon.tech")));
    for (const [name, app] of Object.entries(apps)) {
      assert.equal((await call(app, "/v1/account/me", { headers: { cookie: cookies[name] } })).status, 401);
    }
  } finally {
    for (const app of Object.values(apps)) await app.close();
    for (const ws of wsServer.clients) ws.terminate();
    await stop(runtime); wsServer.close();
  }
});
