import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import pg from "pg";
import { createAccountProvider, registerAccountRoutes } from "../../../packages/zioon-account/src/provider.mjs";
import { PostgresAccountStore } from "../../runtime/src/accounts/postgres-account-store.mjs";
import { AccountAccessControl } from "../../runtime/src/accounts/account-access-control.mjs";
import { createOidcProvider } from "../../runtime/src/accounts/oidc-provider.mjs";
import { createSharedAccountProvider } from "../../runtime/src/accounts/shared-account-provider.mjs";
import { manageAgentfsAuth } from "../../../scripts/agentfs-login.mjs";

const deps = process.env.ZIOON_ACCOUNT_TEST_DEPS_DIR || resolve(import.meta.dir, "../../../packages/zioon-account/node_modules");
const { default: Fastify } = await import(pathToFileURL(join(deps, "fastify/fastify.js")).href);
const { betterAuth } = await import(pathToFileURL(join(deps, "better-auth/dist/index.mjs")).href);
const { bearer } = await import(pathToFileURL(join(deps, "better-auth/dist/plugins/bearer/index.mjs")).href);
const { getMigrations } = await import(pathToFileURL(join(deps, "better-auth/dist/db/get-migration.mjs")).href);
const config = JSON.parse(await readFile(join(homedir(), ".zion-next/sandbox-demo/account.json"), "utf8"));
assert(["127.0.0.1", "localhost"].includes(new URL(config.url).hostname));
const directory = await mkdtemp(join(tmpdir(), "zioon-portal-verify-"));
process.env.AGENT_FS_HOME = directory;
process.env.AGENT_FS_STORAGE_PROVIDER = "local";
process.env.AGENT_FS_LOCAL_ROOT = join(directory, "objects");
const { core } = await import("../src/upstream.ts");
const { createMemoryGateway } = await import("../src/gateway.ts");
const { createMemoryPortal } = await import("../src/portal.ts");
const schema = `zioon_portal_${randomBytes(6).toString("hex")}`;
const admin = new pg.Pool({ connectionString: config.url, max: 1 });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({ connectionString: config.url, options: `-c search_path=${schema}`, max: 3 });
const sqlite = core.createDatabase(join(directory, "agent-fs.db"));
const storage = new core.LocalStorageAdapter({ root: join(directory, "objects") });
const secret = randomBytes(48).toString("base64url");
let authServer, memoryServer, runtimeServer, runtimeOidc;
let checks = 0;
function check(value, expected) { assert.deepEqual(value, expected); checks++; }
try {
  authServer = Fastify();
  authServer.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));
  await authServer.listen({ host: "127.0.0.1", port: 0 });
  // Fastify cannot register routes after listen; reserve its port, then reopen.
  const accountOrigin = `http://127.0.0.1:${authServer.server.address().port}`;
  await authServer.close();
  authServer = Fastify();
  authServer.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));
  const auth = betterAuth({
    baseURL: accountOrigin, secret, database: pool, emailAndPassword: { enabled: true },
    socialProviders: { github: { clientId: "verification-only", clientSecret: "verification-only" } },
    plugins: [bearer()], advanced: { database: { validateSchema: false } }
  });
  await (await getMigrations(auth.options)).runMigrations();
  const { adapter } = await auth.$context;
  const signup = await auth.api.signUpEmail({ body: {
    name: "Portal owner", email: "owner@portal.invalid", password: "test-only-long-password"
  } });
  const current = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${signup.token}` }) });
  assert(current?.session.id);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const accounts = await new PostgresAccountStore({ pool }).initialize();
  const legacyUser = await accounts.resolveIdentity({ issuer: "legacy-test", subject: "legacy-owner", name: "Owner" });
  const legacySpace = await accounts.personalSpace(legacyUser.id);
  const legacySession = await accounts.createSession(legacyUser.id, { activeSpaceId: legacySpace.id });
  const access = new AccountAccessControl({
    accounts, oidc: { issuer: "legacy-test", secureCookies: false }, sharedAccountIssuer: accountOrigin,
    publicBaseUrl: "http://127.0.0.1",
    store: { authenticate: async () => null, exchangePairing: async () => null }, memoryBridgeSecret: secret
  });
  runtimeServer = createServer(async (request, response) => {
    if (!await access.handleHttp(request, response, new URL(request.url, "http://127.0.0.1"))) {
      response.writeHead(404); response.end();
    }
  });
  await new Promise((done) => runtimeServer.listen(0, "127.0.0.1", done));
  const runtimeUrl = `http://127.0.0.1:${runtimeServer.address().port}`;
  let portal;
  const gateway = createMemoryGateway({ db: sqlite, storage, secret, runtimeUrl,
    accountIssuer: accountOrigin, adcOrigin: accountOrigin });
  memoryServer = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: async (request) => await portal.fetch(request) || gateway.fetch(request) });
  const memoryOrigin = `http://127.0.0.1:${memoryServer.port}`;
  const provider = await createAccountProvider({
    pool, issuer: accountOrigin, adcOrigin: accountOrigin, privateKey,
    clients: [
      { id: "zioon-memory", name: "Memory", redirectUris: [`${memoryOrigin}/account/callback`],
        loginUri: `${memoryOrigin}/account/login`,
        scopes: ["openid", "profile", "email", "memory.read", "memory.write"] },
      { id: "zioon-runtime", name: "Workbench", redirectUris: [`${runtimeUrl}/v1/account/callback`],
        loginUri: `${runtimeUrl}/account/login`,
        scopes: ["openid", "profile", "email", "zion.api"] }
    ],
    async getSession(id) {
      const session = await adapter.findOne({ model: "session", where: [{ field: "id", value: id }] });
      const user = session && await adapter.findOne({ model: "user", where: [{ field: "id", value: session.userId }] });
      return user ? { session, user } : null;
    }
  });
  async function readSession(request) {
    return auth.api.getSession({ headers: new Headers(request.headers) });
  }
  registerAccountRoutes(authServer, provider, {
    nativeAuth: { githubEnabled: true, registrationEnabled: true, handle: (request) => auth.handler(request) },
    readSession,
    authenticate: async (request) => (await readSession(request)) ? { kind: "session" } : null
  });
  authServer.all("/api/auth/*", async (request, reply) => {
    const response = await auth.handler(new Request(`${accountOrigin}${request.url}`, {
      method: request.method, headers: new Headers(request.headers),
      ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {})
    }));
    for (const [name, value] of response.headers) if (name !== "set-cookie") reply.header(name, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header("set-cookie", cookies);
    return reply.code(response.status).send(await response.text());
  });
  authServer.get("/api/v1/me", async (request, reply) => {
    const session = await readSession(request);
    if (!session) return reply.code(401).send({ error: "login_required" });
    return { kind: "session", user: session.user };
  });
  authServer.get("/.well-known/openid-configuration", () => provider.metadata);
  authServer.get("/jwks", () => provider.jwks);
  authServer.get("/userinfo", (request, reply) => provider.userinfo(String(request.headers.authorization).slice(7))
    .catch((error) => reply.code(error.statusCode).send({ error: error.code })));
  authServer.post("/token", async (request, reply) => provider.token(Object.fromEntries(new URLSearchParams(request.body)))
    .catch((error) => reply.code(error.statusCode).send({ error: error.code })));
  authServer.post("/device_authorization", (request) => provider.device(Object.fromEntries(new URLSearchParams(request.body))));
  authServer.post("/revoke", async (request) => {
    const input = Object.fromEntries(new URLSearchParams(request.body));
    await provider.revoke(input.token, input.client_id); return {};
  });
  await authServer.listen({ host: "127.0.0.1", port: Number(new URL(accountOrigin).port) });
  portal = createMemoryPortal({ db: sqlite, gateway, secret, publicOrigin: memoryOrigin,
    issuer: accountOrigin, adcOrigin: accountOrigin });
  async function call(path, options = {}) {
    const response = await fetch(`${memoryOrigin}${path}`, { redirect: "manual", ...options });
    return { response, status: response.status, data: response.headers.get("content-type")?.includes("json") ? await response.json() : null };
  }
  const page = await call("/");
  check(page.status, 200);
  check(page.response.headers.get("content-security-policy").includes("frame-ancestors 'none'"), true);
  check((await call("/console/api/me")).status, 401);
  check((await call("/account/config", { headers: { host: "evil.invalid" } })).status, 403);
  const legacyWrite = await call("/zion/files/write", { method: "POST",
    headers: { authorization: `Bearer ${legacySession.token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: "/memory/dev.identity/profile.md", content: "中文记忆\n项目背景", expected_hash: null })
  });
  check(legacyWrite.status, 200);
  const link = await call("/zion/accounts/link", { method: "POST",
    headers: { authorization: `Bearer ${signup.token}`, "content-type": "application/json" },
    body: JSON.stringify({ runtimeToken: legacySession.token })
  });
  check(link.data, { linked: true, changed: true });
  const login = await call("/account/login");
  check(login.status, 200);
  check((await login.response.text()).includes("Agent Device Cloud"), false);
  const configuration = await call("/account/config");
  const browserCookie = configuration.response.headers.getSetCookie()[0].split(";")[0];
  const loginHeaders = { cookie: browserCookie, origin: memoryOrigin, "x-csrf-token": configuration.data.csrf,
    "content-type": "application/json" };
  check((await call("/account/email", { method: "POST", headers: { ...loginHeaders, "x-csrf-token": "bad" },
    body: JSON.stringify({ email: "owner@portal.invalid", password: "test-only-long-password" }) })).status, 403);
  const social = await call("/account/social", { method: "POST", headers: loginHeaders, body: "{}" });
  const socialStart = await fetch(social.data.url, { redirect: "manual" });
  check(new URL(socialStart.headers.get("location")).origin, "https://github.com");
  check(socialStart.headers.getSetCookie().length > 0, true);
  const invalidSocial = new URL(social.data.url);
  invalidSocial.searchParams.set("redirect_uri", "https://evil.invalid/callback");
  check((await fetch(invalidSocial, { redirect: "manual" })).status, 400);
  const authorizeUrl = new URL(social.data.url);
  authorizeUrl.pathname = "/api/v1/zioon/authorize";
  const authorize = authorizeUrl.href;
  check(new URL(authorize).origin, accountOrigin);
  const noSession = await fetch(authorize, { redirect: "manual" });
  check(new URL(noSession.headers.get("location")).pathname, "/login");
  const accepted = await fetch(authorize, { redirect: "manual", headers: { authorization: `Bearer ${signup.token}` } });
  const callback = new URL(accepted.headers.get("location"));
  check(callback.origin, memoryOrigin);
  const originalQuery = Object.fromEntries(new URL(authorize).searchParams);
  await assert.rejects(() => provider.token({ grant_type: "authorization_code", client_id: "zioon-memory",
    code: callback.searchParams.get("code"), redirect_uri: `${memoryOrigin}/account/callback`,
    code_verifier: "x".repeat(43) }), /invalid_grant/); checks++;
  const completed = await call(callback.pathname + callback.search, { headers: { cookie: browserCookie } });
  check(completed.status, 303);
  const webCookie = completed.response.headers.getSetCookie().find((value) => value.startsWith("memory_session_local=")).split(";")[0];
  const me = await call("/console/api/me", { headers: { cookie: webCookie } });
  check(me.data.user.email, "owner@portal.invalid");
  check(me.data.canWrite, true);
  const emailConfiguration = await call("/account/config");
  const emailCookie = emailConfiguration.response.headers.getSetCookie()[0].split(";")[0];
  const emailHeaders = { cookie: emailCookie, origin: memoryOrigin, "x-csrf-token": emailConfiguration.data.csrf,
    "content-type": "application/json" };
  check((await call("/account/email", { method: "POST", headers: emailHeaders, body: JSON.stringify({
    email: "owner@portal.invalid", password: "wrong-password"
  }) })).status, 401);
  const emailCompleted = await call("/account/email", { method: "POST", headers: emailHeaders,
    body: JSON.stringify({ email: "owner@portal.invalid", password: "test-only-long-password" }) });
  check(emailCompleted.status, 200);
  check(emailCompleted.data, { loggedIn: true, returnTo: "/console" });
  check(JSON.stringify(emailCompleted.data).includes("token"), false);
  const emailSession = emailCompleted.response.headers.getSetCookie().find((value) => value.startsWith("memory_session_local=")).split(";")[0];
  check((await call("/console/api/me", { headers: { cookie: emailSession } })).data.user.email, "owner@portal.invalid");
  const device = await call("/v1/account/device/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check(device.status, 200);
  check(new URL(device.data.verificationUriComplete).origin, memoryOrigin);
  check((await call("/v1/account/device/poll", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowToken: device.data.flowToken }) })).data.pending, true);
  const approved = await call("/account/device-approve", { method: "POST",
    headers: { cookie: emailSession, origin: memoryOrigin, "x-csrf-token": (await call("/console/api/me", {
      headers: { cookie: emailSession } })).data.csrf, "content-type": "application/json" },
    body: JSON.stringify({ user_code: device.data.userCode, decision: "approve" }) });
  check(approved.status, 200);
  // Avoid a blocking poll interval: advance only this isolated flow's durable next-poll time.
  await pool.query("UPDATE zioon_device_flows SET next_poll_at=0 WHERE user_code=$1", [device.data.userCode]);
  const deviceCompleted = await call("/v1/account/device/poll", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowToken: device.data.flowToken }) });
  check(deviceCompleted.data.token.startsWith("zioon_at_"), true);
  check((await call("/auth/me", { headers: { authorization: `Bearer ${deviceCompleted.data.token}` } })).status, 200);
  check((await call("/v1/account/logout", { method: "POST", headers: {
    authorization: `Bearer ${deviceCompleted.data.token}`, "content-type": "application/json"
  }, body: "{}" })).status, 200);
  check((await call("/auth/me", { headers: { authorization: `Bearer ${deviceCompleted.data.token}` } })).status, 401);
  const cliHome = join(directory, "cli");
  let cliCode;
  check(await manageAgentfsAuth({
    args: ["login", "--api-url", memoryOrigin, "--json"], env: { AGENT_FS_HOME: cliHome },
    emit: (text) => { const event = JSON.parse(text); if (event.type === "auth.deviceCode") cliCode = event.userCode; },
    sleep: async () => {
      const emailMe = await call("/console/api/me", { headers: { cookie: emailSession } });
      check((await call("/account/device-approve", { method: "POST",
        headers: { cookie: emailSession, origin: memoryOrigin, "x-csrf-token": emailMe.data.csrf, "content-type": "application/json" },
        body: JSON.stringify({ user_code: cliCode, decision: "approve" }) })).status, 200);
    }
  }), 0);
  const cliConfig = JSON.parse(await readFile(join(cliHome, "config.json"), "utf8"));
  check(cliConfig.apiUrl, memoryOrigin);
  check(cliConfig.apiKey.startsWith("zioon_at_"), true);
  check(await manageAgentfsAuth({ args: ["auth", "status"], env: { AGENT_FS_HOME: cliHome }, emit: () => {} }), 0);
  check(await manageAgentfsAuth({ args: ["logout"], env: { AGENT_FS_HOME: cliHome }, emit: () => {} }), 0);
  check(Object.hasOwn(JSON.parse(await readFile(join(cliHome, "config.json"), "utf8")), "apiKey"), false);
  const registration = await call("/account/config");
  const registered = await call("/account/email", { method: "POST", headers: {
    cookie: registration.response.headers.getSetCookie()[0].split(";")[0], origin: memoryOrigin,
    "x-csrf-token": registration.data.csrf, "content-type": "application/json"
  }, body: JSON.stringify({ register: true, email: "registered@portal.invalid", name: "Registered", password: "test-only-long-password" }) });
  check(registered.status, 200);
  const registeredCookie = registered.response.headers.getSetCookie().find((value) => value.startsWith("memory_session_local=")).split(";")[0];
  check((await call("/console/api/me", { headers: { cookie: registeredCookie } })).data.user.email, "registered@portal.invalid");
  check((await call("/console/api/file?path=/memory/dev.identity/profile.md", { headers: { cookie: registeredCookie } })).status, 404);
  check((await call(callback.pathname + callback.search, { headers: { cookie: browserCookie } })).status, 401);
  const headers = { cookie: webCookie, origin: memoryOrigin, "x-csrf-token": me.data.csrf, "content-type": "application/json" };
  const file = await call("/console/api/file?path=/memory/dev.identity/profile.md", { headers: { cookie: webCookie } });
  check(file.data.content, "中文记忆\n项目背景");
  check(file.data.content_hash, legacyWrite.data.content_hash);
  const saved = await call("/console/api/file?path=/memory/dev.identity/profile.md", {
    method: "POST", headers, body: JSON.stringify({ content: "已更新的记忆", expected_hash: file.data.content_hash })
  });
  check(saved.status, 200);
  check((await call("/console/api/file?path=/memory/dev.identity/profile.md", {
    method: "POST", headers, body: JSON.stringify({ content: "stale", expected_hash: file.data.content_hash })
  })).status, 409);
  check((await call("/console/api/file?path=/memory/dev.identity/profile.md", {
    method: "POST", headers: { ...headers, origin: "https://evil.invalid" },
    body: JSON.stringify({ content: "csrf", expected_hash: saved.data.content_hash })
  })).status, 403);
  check((await call("/console/api/file?path=/memory/dev.identity/profile.md", {
    method: "POST", headers: { ...headers, "x-csrf-token": "wrong" },
    body: JSON.stringify({ content: "csrf", expected_hash: saved.data.content_hash })
  })).status, 403);
  check((await call("/console/api/file?path=/memory/dev.identity/profile.md", {
    method: "POST", headers, body: JSON.stringify({ content: "no precondition" })
  })).status, 400);
  check((await call("/console/api/file?path=/outside/private.md", { headers: { cookie: webCookie } })).status, 400);
  const search = await call("/console/api/search?q=" + encodeURIComponent("更新"), { headers: { cookie: webCookie } });
  check(search.data.matches.map((value) => value.path), ["/memory/dev.identity/profile.md"]);
  const history = await call("/console/api/history?path=/memory/dev.identity/profile.md", { headers: { cookie: webCookie } });
  check(history.data.versions.length, 2);
  const legacyRead = await call("/zion/files/read?path=/memory/dev.identity/profile.md", { headers: { authorization: `Bearer ${legacySession.token}` } });
  check(legacyRead.data.content, "已更新的记忆");
  check(legacyRead.data.content_hash, saved.data.content_hash);
  const persisted = sqlite.$client.query("SELECT payload FROM memory_web_sessions").get().payload;
  check(persisted.includes("zioon_at_"), false);
  check(persisted.includes("owner@portal.invalid"), false);
  const other = await auth.api.signUpEmail({ body: { name: "Other", email: "other@portal.invalid", password: "test-only-long-password" } });
  const otherSession = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${other.token}` }) });
  const flow = await provider.device({ client_id: "zioon-memory", scope: "openid profile email memory.read" });
  await provider.approve(flow.user_code, otherSession.session.id);
  const otherTokens = await provider.token({ client_id: "zioon-memory", device_code: flow.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  check((await call("/zion/files/read?path=/memory/dev.identity/profile.md", { headers: {
    authorization: `Bearer ${otherTokens.access_token}`
  } })).status, 404);
  check((await call("/zion/files/write", { method: "POST", headers: {
    authorization: `Bearer ${otherTokens.access_token}`, "content-type": "application/json"
  }, body: JSON.stringify({ path: "/memory/dev.identity/profile.md", content: "denied" }) })).status, 403);
  const identityLink = await accounts.linkIdentity(legacyUser.id, legacySpace.id, { issuer: accountOrigin, subject: current.user.id });
  check(identityLink.changed, true);
  check((await accounts.resolveIdentity({ issuer: accountOrigin, subject: current.user.id })).id, legacyUser.id);
  const preparedIdentity = await fetch(`${runtimeUrl}/v1/account/me`, {
    headers: { authorization: `Bearer ${legacySession.token}` }
  }).then((response) => response.json());
  check(preparedIdentity.accountIdentity, { issuer: accountOrigin, subject: current.user.id });
  check(preparedIdentity.user.id, legacyUser.id);
  await assert.rejects(() => accounts.linkIdentity(other.user.id, legacySpace.id, {
    issuer: accountOrigin, subject: current.user.id
  }), /identity_already_linked/); checks++;
  const concurrentUser = await accounts.resolveIdentity({ issuer: "legacy-race", subject: "same-user" });
  const concurrentSpace = await accounts.personalSpace(concurrentUser.id);
  const links = await Promise.allSettled(["first", "second"].map((subject) => accounts.linkIdentity(
    concurrentUser.id, concurrentSpace.id, { issuer: accountOrigin, subject: `race-${subject}` }
  )));
  check(links.filter((value) => value.status === "fulfilled").length, 1);
  check(links.find((value) => value.status === "rejected").reason.code, "account_already_linked");
  runtimeOidc = await createOidcProvider({ issuer: accountOrigin, clientId: "zioon-runtime",
    publicBaseUrl: runtimeUrl, allowLoopbackHttp: true, store: accounts });
  const runtimeLogin = await runtimeOidc.begin("/");
  const runtimeAuthorization = new URL(runtimeLogin.url);
  const runtimeCode = await provider.authorize(Object.fromEntries(runtimeAuthorization.searchParams), current.session.id);
  const runtimeCompleted = await runtimeOidc.callback(new URL(runtimeCode).searchParams, runtimeLogin.browser);
  check((await accounts.authenticate(runtimeCompleted.token)).user.id, legacyUser.id);
  const pending = await provider.device({ client_id: "zioon-runtime" });
  await assert.rejects(() => provider.token({ client_id: "zioon-runtime", device_code: pending.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code" }), /authorization_pending/); checks++;
  await assert.rejects(() => provider.token({ client_id: "zioon-runtime", device_code: pending.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code" }), /slow_down/); checks++;
  await assert.rejects(() => provider.authorize({ ...originalQuery, redirect_uri: "https://evil.invalid/callback" }, current.session.id),
    /invalid_request/); checks++;
  // Exercise Zion's actual server forms and device flow with the shared authority.
  const sessionKey = randomBytes(32);
  const sharedOptions = { issuer: accountOrigin, adcOrigin: accountOrigin, clientId: "zioon-runtime",
    publicBaseUrl: runtimeUrl, allowLoopbackHttp: true, store: accounts, key: sessionKey, activeSpaceId: legacySpace.id };
  access.oidc = await createSharedAccountProvider(sharedOptions);
  access.publicBaseUrl = runtimeUrl;
  access.allowedOrigins.add(runtimeUrl);
  const nativeCall = (path, options = {}) => fetch(`${runtimeUrl}${path}`, { redirect: "manual", ...options });
  const nativeBegin = await nativeCall("/v1/account/login?returnTo=/mobile/&uiTheme=dark");
  check(nativeBegin.status, 302);
  check(new URL(nativeBegin.headers.get("location")).pathname, "/account/login");
  const nativeCookie = nativeBegin.headers.getSetCookie()[0].split(";")[0];
  const nativePage = await nativeCall(new URL(nativeBegin.headers.get("location")).pathname
    + new URL(nativeBegin.headers.get("location")).search, { headers: { cookie: nativeCookie } });
  const nativeHtml = await nativePage.text();
  check(nativePage.status, 200);
  check(nativeHtml.includes('data-theme="dark"'), true);
  check(nativeHtml.includes("Agent Device Cloud"), false);
  const nativeState = nativeHtml.match(/name="state" value="([^"]+)"/)[1];
  const nativeCsrf = nativeHtml.match(/name="csrf" value="([^"]+)"/)[1];
  const nativeHeaders = { cookie: nativeCookie, origin: runtimeUrl, "content-type": "application/x-www-form-urlencoded" };
  const nativeBody = { state: nativeState, csrf: nativeCsrf, email: "owner@portal.invalid", password: "test-only-long-password" };
  check((await nativeCall("/v1/account/shared/email", { method: "POST", headers: nativeHeaders,
    body: new URLSearchParams({ ...nativeBody, csrf: "wrong" }) })).status, 403);
  check((await nativeCall("/v1/account/shared/email", { method: "POST", headers: { ...nativeHeaders, origin: "https://evil.invalid" },
    body: new URLSearchParams(nativeBody) })).status, 403);
  const nativeSocial = await nativeCall("/v1/account/shared/social", {
    method: "POST", headers: nativeHeaders, body: new URLSearchParams(nativeBody)
  });
  check(new URL(nativeSocial.headers.get("location")).pathname, "/api/v1/zioon/social/start");
  const nativeLogin = await nativeCall("/v1/account/shared/email", {
    method: "POST", headers: nativeHeaders, body: new URLSearchParams(nativeBody)
  });
  check(nativeLogin.status, 303);
  check(nativeLogin.headers.get("location"), "/mobile/");
  const nativeSessionCookie = nativeLogin.headers.getSetCookie().find((value) => value.startsWith("zion_account_local=")).split(";")[0];
  const nativeMe = await nativeCall("/v1/account/me", { headers: { cookie: nativeSessionCookie } }).then((response) => response.json());
  check(nativeMe.user.id, legacyUser.id);
  check(nativeMe.space.id, legacySpace.id);
  check(nativeMe.capabilities.loginSettingsUrl, "");
  const persistedShared = await pool.query("SELECT payload FROM account_shared_grants WHERE session_id=$1", [nativeMe.sessionId]);
  check(persistedShared.rows[0].payload.includes("zioon_at_"), false);
  // Reopening the adapter reuses durable login/session/device state and the key.
  access.oidc = await createSharedAccountProvider(sharedOptions);
  check((await nativeCall("/v1/account/me", { headers: { cookie: nativeSessionCookie } })).status, 200);
  const nativeDevice = await nativeCall("/v1/account/device/start", { method: "POST" }).then((response) => response.json());
  check(new URL(nativeDevice.verificationUriComplete).origin, runtimeUrl);
  const nativePending = await nativeCall("/v1/account/device/poll", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ flowToken: nativeDevice.flowToken }) });
  check((await nativePending.json()).pending, true);
  const devicePage = await nativeCall(new URL(nativeDevice.verificationUriComplete).pathname
    + new URL(nativeDevice.verificationUriComplete).search, { headers: { cookie: nativeSessionCookie } });
  const confirmCookie = devicePage.headers.getSetCookie()[0].split(";")[0];
  const confirmCsrf = (await devicePage.text()).match(/name="csrf" value="([^"]+)"/)[1];
  check((await nativeCall("/v1/account/shared/device", { method: "POST",
    headers: { ...nativeHeaders, cookie: `${nativeSessionCookie}; ${confirmCookie}` },
    body: new URLSearchParams({ user_code: nativeDevice.userCode, csrf: confirmCsrf, decision: "approve" })
  })).status, 200);
  await pool.query("UPDATE zioon_device_flows SET next_poll_at=0 WHERE user_code=$1", [nativeDevice.userCode]);
  const deviceSession = await nativeCall("/v1/account/device/poll", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ flowToken: nativeDevice.flowToken })
  }).then((response) => response.json());
  check(deviceSession.token.startsWith("zion_account_v1."), true);
  check((await accounts.authenticate(deviceSession.token)).user.id, legacyUser.id);
  check((await nativeCall("/v1/account/logout", { method: "POST",
    headers: { authorization: `Bearer ${deviceSession.token}` } })).status, 200);
  check((await nativeCall("/v1/account/me", { headers: { authorization: `Bearer ${deviceSession.token}` } })).status, 401);
  check((await nativeCall("/v1/account/me", { headers: { authorization: `Bearer ${legacySession.token}` } })).status, 200);
  check((await nativeCall("/v1/account/shared/email", {
    method: "POST", headers: nativeHeaders, body: new URLSearchParams(nativeBody)
  })).status, 401);
  await adapter.delete({ model: "session", where: [{ field: "id", value: current.session.id }] });
  check((await call("/console/api/me", { headers: { cookie: webCookie } })).status, 401);
  console.log(`${checks} portal/account checks passed: real BetterAuth + PostgreSQL, real OIDC/PKCE, durable sessions, legacy linkage, shared files, CSRF, conflict, isolation and revocation.`);
} finally {
  runtimeOidc?.close();
  await memoryServer?.stop(true);
  await authServer?.close();
  if (runtimeServer) await new Promise((done) => runtimeServer.close(done));
  sqlite.$client.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
