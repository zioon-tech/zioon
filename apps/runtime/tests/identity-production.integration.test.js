import { createServer } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createLocalDevOidc, seedLocalIdentityUser } from "../src/accounts/local-dev-oidc.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const post = (url, body, cookie = "", origin = "") => fetch(url, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie, ...(origin ? { origin } : {}) },
  body: new URLSearchParams(body)
});

it("delivers codes privately, persists sessions and signing keys, and blocks replay and cross-origin writes", async () => {
  const db = await createPostgresTestDatabase("identity_prod");
  cleanup.push(() => db.close());
  const port = await freePort();
  const mail = [];
  const options = { pool: db.pool, port, development: false, sendMail: async message => mail.push(message) };
  let provider = await createLocalDevOidc(options);
  cleanup.push(() => provider.close());
  const issuer = provider.issuer;
  const jwks = await (await fetch(`${issuer}/jwks`)).json();
  const registration = await post(`${issuer}/register`, {
    name: "Production", email: "private@example.test", password: "long enough password"
  });
  expect(registration.status).toBe(201);
  const html = await registration.text();
  const code = mail[0].text.match(/\d{6}/)[0];
  expect(html).not.toContain(code);
  expect(html).not.toContain("本地验证码");
  expect(mail[0].to).toBe("private@example.test");
  expect((await post(`${issuer}/verify`, { email: mail[0].to, code }, "", "https://evil.test")).status).toBe(403);
  const verified = await post(`${issuer}/verify`, { email: mail[0].to, code });
  expect(verified.status).toBe(200);
  const cookie = verified.headers.get("set-cookie").split(";")[0];
  await provider.close();
  provider = await createLocalDevOidc(options);
  expect(await (await fetch(`${issuer}/jwks`)).json()).toEqual(jwks);
  const authorization = `${issuer}/authorize?${new URLSearchParams({
    client_id: "zion-local", redirect_uri: "http://127.0.0.1:18866/v1/account/callback",
    response_type: "code", scope: "openid profile email", state: "persist",
    code_challenge_method: "S256", code_challenge: "challenge"
  })}`;
  const continued = await fetch(authorization, { redirect: "manual", headers: { cookie } });
  expect(continued.status).toBe(303);
  const resend = await post(`${issuer}/resend`, { email: "other@example.test" });
  expect(resend.status).toBe(200);
  expect((await post(`${issuer}/resend`, { email: "other@example.test" })).status).toBe(429);
  expect(mail).toHaveLength(1);
});

it("validates GitHub browser state, verified email and explicit linking before creating a session", async () => {
  const db = await createPostgresTestDatabase("identity_github");
  cleanup.push(() => db.close());
  const port = await freePort();
  let verified = true;
  let networkFailure = false;
  let email = "github@example.test";
  let providerId = 123;
  const provider = await createLocalDevOidc({
    pool: db.pool, port, development: false,
    github: { clientId: "test-client", clientSecret: "test-secret", callbackUrl: "https://adc.test/api/auth/callback/github" },
    fetchImpl: async url => {
      if (networkFailure) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
      return Response.json(url.includes("access_token") ? { access_token: "test" }
      : url.endsWith("/emails") ? [{ email, primary: true, verified }]
        : { id: providerId, login: "github-user" });
    }
  });
  cleanup.push(() => provider.close());
  const begin = async () => {
    const response = await post(`${provider.issuer}/github`, {});
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location"));
    expect(target.searchParams.get("redirect_uri")).toBe("https://adc.test/api/auth/callback/github");
    expect(target.searchParams.get("state")).toMatch(/^zion_/);
    return { state: target.searchParams.get("state"), cookie: response.headers.get("set-cookie").split(";")[0] };
  };
  const call = flow => fetch(`${provider.issuer}/github/callback?state=${flow.state}&code=test`, {
    redirect: "manual", headers: { cookie: flow.cookie }
  });
  const wrongBrowser = await begin();
  expect((await call({ ...wrongBrowser, cookie: "" })).status).toBe(400);
  verified = false;
  expect((await call(await begin())).status).toBe(400);
  verified = true;
  const flow = await begin();
  const success = await call(flow);
  expect(success.status).toBe(303);
  expect(success.headers.get("set-cookie")).toContain("zion_local_identity=");
  expect((await call(flow)).status).toBe(400);
  expect((await db.pool.query("SELECT * FROM local_identity_social_accounts")).rows).toHaveLength(1);
  email = "existing@example.test";
  providerId = 456;
  await seedLocalIdentityUser({
    pool: db.pool, email, name: "Existing", password: "existing password long"
  });
  const conflict = await call(await begin());
  expect(conflict.status).toBe(409);
  expect((await db.pool.query("SELECT * FROM local_identity_social_accounts")).rows).toHaveLength(1);
  const login = await post(`${provider.issuer}/login`, { email, password: "existing password long" });
  const identityCookie = login.headers.get("set-cookie").split(";")[0];
  const linking = await begin();
  const linked = await call({ ...linking, cookie: `${identityCookie}; ${linking.cookie}` });
  expect(linked.status).toBe(303);
  expect((await db.pool.query("SELECT * FROM local_identity_social_accounts")).rows).toHaveLength(2);
  const settings = await fetch(`${provider.issuer}/settings`, { headers: { cookie: identityCookie } });
  expect(settings.status).toBe(200);
  expect(await settings.text()).toContain('class="method-list"');
  const beginLink = await post(`${provider.issuer}/github`, { settings: "1" }, identityCookie);
  const linkState = new URL(beginLink.headers.get("location")).searchParams.get("state");
  const linkCookie = beginLink.headers.get("set-cookie").split(";")[0];
  networkFailure = true;
  const failure = await call({ state: linkState, cookie: `${identityCookie}; ${linkCookie}` });
  expect(failure.status).toBe(503);
  const failurePage = await failure.text();
  expect(failurePage).toContain("返回登录方式");
  expect(failurePage).not.toContain("账号服务暂时不可用");
  expect(failurePage).toContain("/settings?");
  networkFailure = false;
  email = "different@example.test";
  providerId = 789;
  const beginMismatch = await post(`${provider.issuer}/github`, { settings: "1" }, identityCookie);
  const mismatch = await call({
    state: new URL(beginMismatch.headers.get("location")).searchParams.get("state"),
    cookie: `${identityCookie}; ${beginMismatch.headers.get("set-cookie").split(";")[0]}`
  });
  expect(mismatch.status).toBe(409);
  expect((await db.pool.query("SELECT * FROM local_identity_users")).rows).toHaveLength(2);
});
