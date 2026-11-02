import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createOidcProvider, accountPublicUrl, safeReturnTo } from "../src/accounts/oidc-provider.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture({ activeSpaceId = "", activeMember = false } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "fixture", use: "sig", alg: "RS256" };
  const codes = new Map();
  let issuer;
  let nonceOverride;
  const sign = (claims, typ = "JWT") => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "fixture", typ })
    .setIssuer(issuer).setSubject("alice").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const send = (response, data, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(data));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      send(response, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, device_authorization_endpoint: `${issuer}/device`,
        response_types_supported: ["code"], subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"]
      });
    } else if (url.pathname === "/jwks") {
      send(response, { keys: [jwk] });
    } else if (url.pathname === "/authorize") {
      const code = `code-${codes.size}`;
      codes.set(code, Object.fromEntries(url.searchParams));
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state"));
      response.writeHead(302, { location: callback.href });
      response.end();
    } else if (url.pathname === "/device") {
      send(response, {
        device_code: "device-secret", user_code: "ABCD-EFGH",
        verification_uri: `${issuer}/activate`, expires_in: 60, interval: 1
      });
    } else if (url.pathname === "/token") {
      let data = "";
      for await (const chunk of request) data += chunk;
      const body = new URLSearchParams(data);
      let claims = { aud: "zion-fixture", name: "Alice", email: "alice@example.test", email_verified: true };
      if (body.get("grant_type") === "authorization_code") {
        const authorization = codes.get(body.get("code"));
        codes.delete(body.get("code"));
        const challenge = createHash("sha256").update(body.get("code_verifier") || "").digest("base64url");
        if (!authorization || challenge !== authorization.code_challenge
          || body.get("redirect_uri") !== authorization.redirect_uri) {
          send(response, { error: "invalid_grant" }, 400);
          return;
        }
        claims.nonce = nonceOverride ?? authorization.nonce;
      }
      send(response, {
        access_token: await sign({ aud: "zion-api", scope: "zion.api" }, "at+jwt"),
        token_type: "Bearer", expires_in: 300, id_token: await sign(claims)
      });
    } else send(response, { error: "not_found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  cleanup.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const database = await createPostgresTestDatabase("oidc_provider");
  const store = database.accounts;
  cleanup.push(() => database.close());
  if (activeSpaceId) {
    const owner = await store.resolveIdentity({
      issuer,
      subject: activeMember ? "alice" : "served-owner",
      name: activeMember ? "Alice" : "Served Space Owner"
    });
    const createdAt = Date.now();
    await database.pool.query(
      `INSERT INTO account_spaces (id, name, kind, created_by, created_at)
       VALUES ($1, 'Served Team', 'team', $2, $3)`,
      [activeSpaceId, owner.id, createdAt]
    );
    await database.pool.query(
      `INSERT INTO account_memberships
       (space_id, user_id, role, status, revision, created_at, updated_at)
       VALUES ($1, $2, 'owner', 'active', 1, $3, $3)`,
      [activeSpaceId, owner.id, createdAt]
    );
  }
  const provider = await createOidcProvider({
    issuer, clientId: "zion-fixture", publicBaseUrl: "http://127.0.0.1:9000",
    allowLoopbackHttp: true, store, audience: "zion-api", activeSpaceId
  });
  cleanup.push(() => provider.close());
  return {
    provider, store, issuer, sign,
    corruptNonce() { nonceOverride = "wrong-nonce"; },
    async authorize(returnTo = "/", options) {
      const begin = await provider.begin(returnTo, options);
      const response = await fetch(begin.url, { redirect: "manual" });
      return { ...begin, query: new URL(response.headers.get("location")).searchParams };
    }
  };
}

describe("OIDC account provider", () => {
  it("requires a fixed secure origin and sanitizes login redirects", () => {
    expect(() => accountPublicUrl("http://workbench.test", true)).toThrow("HTTPS");
    expect(() => accountPublicUrl("https://workbench.test/path")).toThrow("origin");
    expect(() => accountPublicUrl("https://user:pass@workbench.test")).toThrow("origin");
    expect(accountPublicUrl("http://127.0.0.1:9000", true).origin).toBe("http://127.0.0.1:9000");
    for (const value of ["//evil.test", "/\\evil.test", "/\nLocation:evil", "https://evil.test"]) {
      expect(safeReturnTo(value)).toBe("/");
    }
    expect(safeReturnTo("/account?tab=sessions")).toBe("/account?tab=sessions");
  });

  it("completes signed code login with PKCE and provisions the personal Space", async () => {
    const h = await fixture();
    const login = await h.authorize("/mobile/chats?view=recent", { uiTheme: "dark" });
    const authUrl = new URL(login.url);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("nonce")).toBeTruthy();
    expect(authUrl.searchParams.get("zion_ui_theme")).toBe("dark");
    const session = await h.provider.callback(login.query, login.browser);
    expect(session.returnTo).toBe("/mobile/chats?view=recent");
    const identity = await h.store.authenticate(session.token);
    expect(identity.user).toMatchObject({ name: "Alice", email: "alice@example.test" });
    expect(identity.membership).toMatchObject({ role: "owner", status: "active" });
    expect(identity.space).toMatchObject({ kind: "personal" });
    await expect(h.provider.callback(login.query, login.browser)).rejects.toThrow("invalid_login_transaction");
  });

  it("selects the Runtime team for members while keeping outsiders in their personal Zion", async () => {
    const member = await fixture({ activeSpaceId: "space:served-member", activeMember: true });
    const memberLogin = await member.authorize();
    const memberSession = await member.provider.callback(memberLogin.query, memberLogin.browser);
    expect((await member.store.authenticate(memberSession.token)).space)
      .toMatchObject({ id: "space:served-member", kind: "team" });

    const outsider = await fixture({ activeSpaceId: "space:served-outsider" });
    const outsiderLogin = await outsider.authorize();
    const outsiderSession = await outsider.provider.callback(outsiderLogin.query, outsiderLogin.browser);
    const outsiderIdentity = await outsider.store.authenticate(outsiderSession.token);
    expect(outsiderIdentity.space.kind).toBe("personal");
    expect(outsiderIdentity.space.id).not.toBe("space:served-outsider");
  });

  it("rejects another browser and mismatched state without consuming the valid transaction", async () => {
    const h = await fixture();
    const login = await h.authorize();
    await expect(h.provider.callback(login.query, "another-browser")).rejects.toThrow("invalid_login_transaction");
    const wrong = new URLSearchParams(login.query);
    wrong.set("state", "forged");
    await expect(h.provider.callback(wrong, login.browser)).rejects.toThrow("invalid_login_transaction");
    expect((await h.provider.callback(login.query, login.browser)).token).toMatch(/^zion_account_v1\./);
  });

  it("rejects a signed token with the wrong nonce", async () => {
    const h = await fixture();
    h.corruptNonce();
    const login = await h.authorize();
    await expect(h.provider.callback(login.query, login.browser)).rejects.toThrow();
    expect(await h.store.findIdentity(h.issuer, "alice")).toBeUndefined();
  });

  it("accepts a scoped access token and rejects ID tokens, wrong audiences and missing scope", async () => {
    const h = await fixture();
    const token = await h.sign({ aud: "zion-api", scope: "zion.api" }, "at+jwt");
    const session = await h.provider.exchangeAccessToken(token);
    expect((await h.store.authenticate(session.token)).user.id)
      .toBe((await h.store.findIdentity(h.issuer, "alice")).id);
    for (const candidate of [
      await h.sign({ aud: "zion-api", scope: "zion.api" }, "JWT"),
      await h.sign({ aud: "other-api", scope: "zion.api" }, "at+jwt"),
      await h.sign({ aud: "zion-api", scope: "openid" }, "at+jwt"),
      token.slice(0, -8) + "invalidx"
    ]) await expect(h.provider.exchangeAccessToken(candidate)).rejects.toThrow();
  });

  it("binds device login to a high-entropy flow and redeems it once", async () => {
    const h = await fixture();
    const flow = await h.provider.beginDevice();
    expect(flow).toMatchObject({ userCode: "ABCD-EFGH", verificationUri: `${h.issuer}/activate` });
    expect(flow).not.toHaveProperty("device_code");
    expect(await h.provider.pollDevice(flow.flowToken)).toEqual({ pending: true });
    await expect(h.provider.pollDevice("another-flow")).rejects.toThrow("device_login_expired");
    let result;
    for (let i = 0; i < 40; i += 1) {
      await delay(50);
      result = await h.provider.pollDevice(flow.flowToken);
      if (!result.pending) break;
    }
    expect((await h.store.authenticate(result.token)).user.name).toBe("Alice");
    await expect(h.provider.pollDevice(flow.flowToken)).rejects.toThrow("device_login_expired");
  });
});
