import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeAccessControl } from "../src/access-control.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { createSharedAccountProvider } from "../src/accounts/shared-account-provider.mjs";
import { createAccountClient } from "../../../packages/zioon-account/src/client.mjs";
import { accountError } from "../src/accounts/account-policy.mjs";
import { WORKBENCH_NAVIGATION_FALLBACK_DENYLIST } from "../../../src/pwa-navigation";

const disposers = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
const request = (address, forwarded) => ({
  socket: { remoteAddress: address },
  headers: forwarded ? { "x-forwarded-for": forwarded } : {}
});
const access = (options = {}) => new RuntimeAccessControl({
  store: { authenticate: async () => null, exchangePairing: async () => null }, ...options
});

async function nativeLoginHarness(options = {}) {
  let control;
  const server = createServer(async (req, res) => {
    if (!control.applyCors(req, res)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Browser origin is not allowed" }));
      return;
    }
    if (await control.handleHttp(req, res, new URL(req.url, control.publicBaseUrl))) return;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<main>cached-workbench-shell</main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  disposers.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transactions = new Map();
  const onSessionCreated = vi.fn();
  const store = {
    pool: { query: async () => ({ rows: [] }) },
    saveLoginTransaction: async (state, browser, value) => transactions.set(state, { browser, ...value }),
    readLoginTransaction: async (state, browser) => {
      const transaction = transactions.get(state);
      if (!transaction || transaction.browser !== browser) throw accountError(401, "invalid_login_transaction");
      return transaction;
    },
    consumeLoginTransaction: async (state, browser) => {
      const transaction = await store.readLoginTransaction(state, browser);
      transactions.delete(state); return transaction;
    },
    resolveIdentity: async () => ({ id: "user:new-account" }),
    createSession: async () => ({ token: randomUUID(), sessionId: randomUUID(), expiresAt: Date.now() + 3600000 }),
    authenticate: async () => null
  };
  const client = {
    issuer: "https://identity.test",
    begin: () => ({ transaction: { state: randomUUID(), nonce: randomUUID(), verifier: randomUUID() } }),
    hostedLoginUrl: createAccountClient({
      issuer: "https://identity.test", adcOrigin: "https://adc.test",
      clientId: "runtime-test", callbackUrl: `${origin}/v1/account/callback`
    }).hostedLoginUrl,
    loginConfig: async () => ({ githubEnabled: true, registrationEnabled: true }),
    emailLogin: async (_input, transaction) => ({ query: new URLSearchParams({ state: transaction.state }) }),
    callback: async (query, transaction) => {
      assert.equal(query.get("state"), transaction.state);
      assert.equal(query.get("iss"), "https://identity.test");
      assert(query.get("code") && !query.has("error"));
      return ({
      identity: { iss: "https://identity.test", aud: "runtime-test", sub: "new-subject", scope: "openid zion.api" },
      token: "fixture-provider-token", expiresAt: Date.now() + 3600000
      });
    }
  };
  const oidc = await createSharedAccountProvider({
    store, client, issuer: client.issuer, adcOrigin: "https://adc.test", clientId: "runtime-test",
    publicBaseUrl: origin, allowLoopbackHttp: true, key: randomBytes(32), onSessionCreated
  });
  control = new AccountAccessControl({
    accounts: store, store: { authenticate: async () => null, exchangePairing: async () => null },
    oidc, publicBaseUrl: origin, ...options
  });
  return { origin, control, oidc, transactions, onSessionCreated };
}

describe("hosted account login navigation", () => {
  it("escapes an installed Workbench service worker and provisions only after the bound callback", async () => {
    const h = await nativeLoginHarness({ pairingRateLimit: 1 });
    // Existing workers already exclude /v1, but still serve their cached app
    // shell for /account/login. Exercise that exact deployed routing behavior.
    let cookie, state;
    for (let i = 0; i < 21; i++) {
      const begin = await fetch(h.origin + "/v1/account/login?returnTo=" + encodeURIComponent("/account/login?state=stale"), { redirect: "manual" });
      expect(begin.status).toBe(302);
      const destination = new URL(begin.headers.get("location"));
      expect(destination.origin).toBe("https://identity.test");
      expect(destination.pathname).toBe("/api/v1/zioon/authorize");
      cookie = begin.headers.getSetCookie()[0].split(";")[0];
      const authorization = destination;
      expect(authorization.pathname).toBe("/api/v1/zioon/authorize");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("redirect_uri")).toBe(h.origin + "/v1/account/callback");
      state = authorization.searchParams.get("state");
    }
    expect(h.control.pairingAttempts.size).toBe(0);
    h.control.checkPairingRate(request("127.0.0.1"));
    expect(h.onSessionCreated).not.toHaveBeenCalled();
    const signedIn = await fetch(h.origin + "/v1/account/callback?" + new URLSearchParams({
      state, iss: "https://identity.test", code: "fixture-code"
    }), {
      redirect: "manual", headers: { cookie }
    });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe("/");
    expect(signedIn.headers.getSetCookie().some((value) => value.startsWith("zion_account_local="))).toBe(true);
    expect(h.onSessionCreated).toHaveBeenCalledTimes(1);
  });

  it("redirects the legacy login address and keeps the device confirmation return path", async () => {
    const h = await nativeLoginHarness();
    const legacy = await fetch(h.origin + "/account/login?state=old", { redirect: "manual" });
    expect(legacy.status).toBe(303);
    expect(legacy.headers.get("location")).toBe("/v1/account/shared/login?state=old");
    const begin = await h.oidc.begin("/v1/account/shared/device?user_code=ABCD");
    const authorization = new URL(begin.url);
    expect(h.transactions.get(authorization.searchParams.get("state")).returnTo)
      .toBe("/v1/account/shared/device?user_code=ABCD");
    expect(WORKBENCH_NAVIGATION_FALLBACK_DENYLIST.some((pattern) => pattern.test("/account/login?state=old"))).toBe(true);
    expect(WORKBENCH_NAVIGATION_FALLBACK_DENYLIST.some((pattern) => pattern.test("/account"))).toBe(false);
  });

  it("moves cached native forms to the account service only after Origin and CSRF validation", async () => {
    const h = await nativeLoginHarness();
    const begin = await fetch(h.origin + "/v1/account/login", { redirect: "manual" });
    const location = new URL(begin.headers.get("location"));
    const cookie = begin.headers.getSetCookie()[0].split(";")[0];
    const authorization = location;
    const state = authorization.searchParams.get("state");
    const csrf = h.transactions.get(state).csrf;
    const action = h.origin + "/v1/account/shared/email";
    const submit = (origin, formCsrf = csrf) => fetch(action, {
      method: "POST", redirect: "manual",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state, csrf: formCsrf, email: "fixture@example.test", password: "fixture-password" })
    });
    for (const origin of ["null", "https://foreign.test"]) {
      const rejected = await submit(origin);
      expect(rejected.status).toBe(403);
      expect((await rejected.json()).error).toBe("Browser origin is not allowed");
    }
    const badCsrf = await submit(h.origin, "wrong");
    expect(badCsrf.status).toBe(403);
    expect((await badCsrf.json()).code).toBe("invalid_csrf");
    const signedIn = await submit(h.origin);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe(location.href);
    expect(h.onSessionCreated).not.toHaveBeenCalled();
  });

  it("reports login throttling with a retry delay, independently of pairing", async () => {
    const h = await nativeLoginHarness({ loginRateLimit: 1 });
    for (let i = 0; i < 3; i++) {
      expect((await fetch(h.origin + "/v1/account/login", { redirect: "manual" })).status).toBe(302);
    }
    const limited = await fetch(h.origin + "/v1/account/login", { redirect: "manual" });
    expect(limited.status).toBe(303);
    expect(new URL(limited.headers.get("location")).searchParams.get("error")).toBe("login_rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(h.control.pairingAttempts.size).toBe(0);
  });

  it("cancels without creating a session and redirects to an explicit central retry", async () => {
    const h = await nativeLoginHarness();
    const begin = await fetch(h.origin + "/v1/account/login?returnTo=%2Faccount", { redirect: "manual" });
    const hosted = new URL(begin.headers.get("location"));
    const authorization = hosted;
    const state = authorization.searchParams.get("state");
    const cookie = begin.headers.getSetCookie()[0].split(";")[0];
    const cancelled = await fetch(h.origin + "/v1/account/callback?" + new URLSearchParams({
      state, iss: "https://identity.test", error: "access_denied"
    }), { headers: { cookie }, redirect: "manual" });
    expect(cancelled.status).toBe(303);
    const recovery = new URL(cancelled.headers.get("location"));
    expect(recovery.origin).toBe("https://identity.test");
    expect(recovery.pathname).toBe("/login");
    expect(recovery.searchParams.get("error")).toBe("login_cancelled");
    expect(recovery.searchParams.get("return_to")).toBe("/api/v1/zioon/restart?client_id=runtime-test");
    expect(h.onSessionCreated).not.toHaveBeenCalled();
    expect(h.transactions.has(state)).toBe(false);
    const retry = await fetch(h.origin + "/v1/account/login", { redirect: "manual", headers: { cookie } });
    const fresh = new URL(retry.headers.get("location"));
    expect(fresh.searchParams.get("state")).not.toBe(state);
    expect(h.transactions.get(fresh.searchParams.get("state")).returnTo).toBe("/");
    expect(retry.headers.getSetCookie()[0].split(";")[0]).toBe(cookie);
  });

  it("rejects another browser and replayed callbacks with a typed central recovery", async () => {
    const h = await nativeLoginHarness();
    const begin = await fetch(h.origin + "/v1/account/login", { redirect: "manual" });
    const hosted = new URL(begin.headers.get("location"));
    const state = hosted.searchParams.get("state");
    const target = h.origin + "/v1/account/callback?" + new URLSearchParams({
      state, iss: "https://identity.test", code: "fixture-code"
    });
    const foreign = await fetch(target, { redirect: "manual" });
    expect(foreign.status).toBe(303);
    expect(new URL(foreign.headers.get("location")).searchParams.get("error")).toBe("invalid_login_transaction");
    expect(h.onSessionCreated).not.toHaveBeenCalled();
    const cookie = begin.headers.getSetCookie()[0].split(";")[0];
    expect((await fetch(target, { headers: { cookie }, redirect: "manual" })).status).toBe(303);
    const replay = await fetch(target, { headers: { cookie }, redirect: "manual" });
    expect(replay.status).toBe(303);
    expect(new URL(replay.headers.get("location")).searchParams.get("error")).toBe("invalid_login_transaction");
    expect(h.onSessionCreated).toHaveBeenCalledTimes(1);
  });
});

describe("proxy-aware authentication rate limits", () => {
  it("keeps password attempts separate from page loads, device polls and pairing", () => {
    const control = access({ pairingRateLimit: 1, loginRateLimit: 1 });
    const req = request("192.0.2.1");
    for (let i = 0; i < 3; i++) control.checkLoginRate(req, "page");
    for (let i = 0; i < 6; i++) control.checkLoginRate(req, "device-poll");
    control.checkPairingRate(req); control.checkLoginRate(req);
    expect(() => control.checkLoginRate(req)).toThrow("登录请求过于频繁");
    expect(() => control.checkPairingRate(req)).toThrow("Too many pairing attempts");
  });

  it("separates clients behind an explicitly trusted proxy and ignores a spoofed leftmost hop", () => {
    const control = access({ trustedProxyAddresses: ["127.0.0.1"], loginRateLimit: 1 });
    const a = request("::ffff:127.0.0.1", "198.51.100.100, 192.0.2.1");
    const b = request("127.0.0.1", "192.0.2.2");
    control.checkLoginRate(a);
    control.checkLoginRate(b);
    expect(control.clientAddress(a)).toBe("192.0.2.1");
    expect(() => control.checkLoginRate(request("127.0.0.1", "198.51.100.101, 192.0.2.1"))).toThrow();
  });

  it("does not trust forwarded addresses from an untrusted network client", () => {
    const control = access({ trustedProxyAddresses: ["127.0.0.1"], loginRateLimit: 1 });
    control.checkLoginRate(request("192.0.2.1", "198.51.100.100"));
    expect(() => control.checkLoginRate(request("192.0.2.1", "198.51.100.101"))).toThrow();
    expect(control.clientAddress(request("127.0.0.1", "not-an-address"))).toBe("127.0.0.1");
  });

  it("resets the window so throttling does not persist after the retry delay", () => {
    let now = 1000;
    const control = access({ loginRateLimit: 1, now: () => now, pairingRateWindowMs: 1000 });
    const req = request("192.0.2.1");
    control.checkLoginRate(req);
    expect(() => control.checkLoginRate(req)).toThrow();
    now += 1000;
    expect(() => control.checkLoginRate(req)).not.toThrow();
  });
});
