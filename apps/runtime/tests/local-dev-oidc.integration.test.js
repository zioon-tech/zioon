import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { calculatePKCECodeChallenge, randomPKCECodeVerifier } from "openid-client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  createLocalDevOidc,
  localDevSubject,
  seedLocalIdentityUser
} from "../src/accounts/local-dev-oidc.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const cleanup = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function hidden(html, name) {
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] || "";
}

async function post(url, body, cookie = "") {
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {})
    },
    body: new URLSearchParams(body)
  });
}

describe("local development OIDC", () => {
  it("registers, verifies, completes PKCE, resets password and authorizes a device", async () => {
    const database = await createPostgresTestDatabase("local_oidc");
    cleanup.push(() => database.close());
    const port = await freePort();
    const runtimePort = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
    const clientId = "zion-local-test";
    const provider = await createLocalDevOidc({
      pool: database.pool,
      port, runtimeOrigin, clientId
    });
    cleanup.push(() => provider.close());

    const metadata = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
    expect(metadata).toMatchObject({
      issuer,
      device_authorization_endpoint: `${issuer}/device`,
      token_endpoint: `${issuer}/token`
    });
    const favicon = await fetch(`${issuer}/favicon.svg`);
    expect(favicon.headers.get("content-type")).toContain("image/svg+xml");
    expect(await favicon.text()).toContain('stroke="#67d3b5"');
    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    const authorization = new URL(`${issuer}/authorize`);
    for (const [key, value] of Object.entries({
      client_id: clientId,
      redirect_uri: `${runtimeOrigin}/v1/account/callback`,
      response_type: "code",
      scope: "openid profile email",
      state: "state-one",
      nonce: "nonce-one",
      code_challenge: challenge,
      code_challenge_method: "S256",
      zion_ui_theme: "dark"
    })) authorization.searchParams.set(key, value);
    const authorizeResponse = await fetch(authorization);
    const authorizePage = await authorizeResponse.text();
    const transaction = hidden(authorizePage, "tx");
    expect(transaction).toBeTruthy();
    expect(authorizePage).toContain("<strong>Zion</strong>");
    expect(authorizePage).toContain('<html lang="zh-CN" data-theme="dark">');
    expect(authorizePage).toContain('class="brand-mark"');
    expect(hidden(authorizePage, "theme")).toBe("dark");
    expect(authorizePage).toContain("登录后自动返回 Zion");
    expect(authorizePage).toContain(`href="${runtimeOrigin}/account?zionAuth=cancelled"`);
    expect(authorizePage).toContain("@media(prefers-color-scheme:dark)");

    const registration = await post(`${issuer}/register`, {
      tx: transaction, theme: "dark", name: "Alice", email: "alice@example.test",
      password: "correct horse battery staple"
    });
    expect(registration.status).toBe(201);
    const registrationPage = await registration.text();
    const verificationCode = /<code>(\d{6})<\/code>/.exec(registrationPage)?.[1];
    expect(verificationCode).toMatch(/^\d{6}$/);
    const verified = await post(`${issuer}/verify`, {
      tx: transaction, theme: "dark", email: "alice@example.test", code: verificationCode
    });
    expect(verified.status).toBe(200);
    const verifiedPage = await verified.text();
    expect(verifiedPage).toContain("邮箱验证完成");
    const idpCookie = verified.headers.get("set-cookie").split(";")[0];
    const repeated = await post(`${issuer}/verify`, {
      tx: transaction, theme: "dark", email: "alice@example.test", code: verificationCode
    });
    expect(await repeated.text()).toContain("邮箱已经验证");
    const continuePath = /href="([^"]+)">进入 Zion/.exec(verifiedPage)?.[1];
    const completed = await fetch(new URL(continuePath, issuer), {
      redirect: "manual", headers: { cookie: idpCookie }
    });
    expect(completed.status).toBe(303);
    const callback = new URL(completed.headers.get("location"));
    expect(callback.searchParams.get("state")).toBe("state-one");

    const tokens = await post(`${issuer}/token`, {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: `${runtimeOrigin}/v1/account/callback`,
      code: callback.searchParams.get("code"),
      code_verifier: verifier
    });
    expect(tokens.status).toBe(200);
    const tokenSet = await tokens.json();
    const { payload } = await jwtVerify(
      tokenSet.id_token,
      createRemoteJWKSet(new URL(`${issuer}/jwks`)),
      { issuer, audience: clientId }
    );
    expect(payload).toMatchObject({
      sub: localDevSubject("alice@example.test"),
      email: "alice@example.test",
      email_verified: true,
      nonce: "nonce-one"
    });

    const forgot = await post(`${issuer}/forgot`, {
      tx: "return-to-zion",
      theme: "dark",
      email: "alice@example.test"
    });
    const forgotPage = await forgot.text();
    const resetCode = /<code>(\d{6})<\/code>/.exec(forgotPage)?.[1];
    expect(resetCode).toMatch(/^\d{6}$/);
    expect(hidden(forgotPage, "tx")).toBe("return-to-zion");
    expect(hidden(forgotPage, "theme")).toBe("dark");
    const reset = await post(`${issuer}/reset`, {
      tx: "return-to-zion", theme: "dark", email: "alice@example.test",
      code: resetCode, password: "new correct horse password"
    });
    expect(reset.status).toBe(303);
    expect(reset.headers.get("location")).toContain("/login?tx=return-to-zion");
    expect((await post(`${issuer}/login`, {
      email: "alice@example.test", password: "correct horse battery staple"
    })).status).toBe(401);
    const newLogin = await post(`${issuer}/login`, {
      email: "alice@example.test", password: "new correct horse password"
    });
    expect(newLogin.status).toBe(303);
    const newCookie = newLogin.headers.get("set-cookie").split(";")[0];

    const device = await post(`${issuer}/device`, {
      client_id: clientId, scope: "openid profile email"
    });
    const deviceFlow = await device.json();
    expect(deviceFlow.verification_uri_complete).toContain(deviceFlow.user_code);
    const revokedActivation = await post(`${issuer}/activate`, {
      user_code: deviceFlow.user_code
    }, idpCookie);
    expect(revokedActivation.status).toBe(303);
    const activation = await post(`${issuer}/activate`, {
      user_code: deviceFlow.user_code
    }, newCookie);
    expect(await activation.text()).toContain("设备已授权");
    const deviceTokens = await post(`${issuer}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: deviceFlow.device_code
    });
    expect(deviceTokens.status).toBe(200);
    expect((await deviceTokens.json()).id_token).toBeTruthy();
  });

  it("rejects non-loopback listeners and invalid authorization redirects", async () => {
    await expect(createLocalDevOidc({
      databaseUrl: "postgresql://unused", host: "0.0.0.0", port: await freePort()
    })).rejects.toThrow("loopback");
    const database = await createPostgresTestDatabase("local_oidc_invalid");
    cleanup.push(() => database.close());
    const provider = await createLocalDevOidc({
      pool: database.pool, port: await freePort()
    });
    cleanup.push(() => provider.close());
    const alias = new URL(provider.issuer);
    alias.hostname = "localhost";
    alias.pathname = "/register";
    const canonical = await fetch(alias, { redirect: "manual" });
    expect(canonical.status).toBe(307);
    expect(canonical.headers.get("location")).toBe(`${provider.issuer}/register`);
    const response = await fetch(`${provider.issuer}/authorize?client_id=zion-local&`
      + "redirect_uri=https%3A%2F%2Fevil.example%2Fcallback&response_type=code");
    expect(response.status).toBe(400);
  });

  it("supports a public path-prefixed issuer behind a reverse proxy", async () => {
    const database = await createPostgresTestDatabase("local_oidc_path");
    cleanup.push(() => database.close());
    const port = await freePort();
    const runtimePort = await freePort();
    const publicIssuer = "https://runtime.zioon.tech/idp";
    const provider = await createLocalDevOidc({
      pool: database.pool,
      port,
      runtimeOrigin: `http://127.0.0.1:${runtimePort}`,
      clientId: "zion-runtime",
      publicIssuer,
      sendMail: async () => {}
    });
    cleanup.push(() => provider.close());
    await seedLocalIdentityUser({
      pool: database.pool,
      email: "owner@example.test",
      name: "Owner",
      password: "correct horse battery staple"
    });

    const forwarded = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      redirect: "manual",
      headers: {
        host: "runtime.zioon.tech",
        ...(options.headers || {})
      }
    });
    const metadata = await (await forwarded("/.well-known/openid-configuration")).json();
    expect(metadata).toMatchObject({
      issuer: publicIssuer,
      authorization_endpoint: `${publicIssuer}/authorize`,
      token_endpoint: `${publicIssuer}/token`,
      jwks_uri: `${publicIssuer}/jwks`
    });

    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    const authorization = new URL(`http://127.0.0.1:${port}/authorize`);
    for (const [key, value] of Object.entries({
      client_id: "zion-runtime",
      redirect_uri: `http://127.0.0.1:${runtimePort}/v1/account/callback`,
      response_type: "code",
      scope: "openid profile email",
      state: "path-state",
      nonce: "path-nonce",
      code_challenge: challenge,
      code_challenge_method: "S256"
    })) authorization.searchParams.set(key, value);
    const authorizePage = await (await forwarded(`${authorization.pathname}${authorization.search}`)).text();
    expect(authorizePage).toContain(`action="${publicIssuer}/login"`);
    expect(authorizePage).toContain(`href="${publicIssuer}/register?`);

    const login = await forwarded("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tx: hidden(authorizePage, "tx"),
        email: "owner@example.test",
        password: "correct horse battery staple"
      })
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("set-cookie")).toContain("Path=/idp");
  });
});
