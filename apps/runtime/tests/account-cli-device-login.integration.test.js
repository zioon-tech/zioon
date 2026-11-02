import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { createLocalDevOidc, seedLocalIdentityUser } from "../src/accounts/local-dev-oidc.mjs";
import { createOidcProvider } from "../src/accounts/oidc-provider.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { MarketplaceService } from "../src/marketplace/service.mjs";
import { createMemoryArtifactStore } from "../src/marketplace/artifact-store.mjs";
import { createMarketplaceHttpHandler } from "../src/marketplace/http-handler.mjs";
import { loginWithAccount } from "../src/accounts/cli-account-auth.mjs";
import { runRuntimeCli } from "../src/runtime-cli.mjs";

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const freePort = async () => {
  const socket = createSocketServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
};
const start = async (server, port = 0) => {
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
};
const post = (url, body) => fetch(url, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body)
});
const credentialStore = () => {
  const values = new Map();
  return {
    values, get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => values.delete(key)
  };
};

describe("account CLI device activation through real HTTP and local OIDC", () => {
  it("prints the complete activation link, preserves manual code entry, and logs in before listing extensions", async () => {
    const db = await createPostgresTestDatabase("cli_device_activation");
    cleanup.push(() => db.close());
    const runtimePort = await freePort();
    const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
    const provider = await createLocalDevOidc({ pool: db.pool, port: await freePort(), runtimeOrigin, clientId: "cli-test" });
    cleanup.push(() => provider.close());
    const user = await seedLocalIdentityUser({ pool: db.pool, email: "cli@example.test", name: "CLI User",
      password: "local-test-password", verified: true });
    const account = await db.accounts.resolveIdentity({ issuer: provider.issuer, subject: user.subject, name: user.name });
    const space = await db.accounts.personalSpace(account.id);
    const oidc = await createOidcProvider({
      issuer: provider.issuer, clientId: "cli-test", publicBaseUrl: runtimeOrigin,
      allowLoopbackHttp: true, activeSpaceId: space.id, store: db.accounts
    });
    cleanup.push(() => oidc.close());
    const access = new AccountAccessControl({
      accounts: db.accounts, oidc, servedSpaceId: space.id, publicBaseUrl: runtimeOrigin,
      store: new PostgresAccessStore(db.pool, { spaceId: space.id })
    });
    const marketplace = await new MarketplaceService({ pool: db.pool,
      artifactStore: createMemoryArtifactStore() }).initialize();
    const handler = createMarketplaceHttpHandler({ service: marketplace });
    await start(createServer(async (request, response) => {
      try {
        const url = new URL(request.url, runtimeOrigin);
        if (await access.handleHttp(request, response, url)) return;
        request.zionPrincipal = await access.authorizeRuntimeRequest(request);
        if (await handler(request, response, url)) return;
        response.writeHead(404); response.end();
      } catch (error) {
        response.writeHead(error.statusCode || 500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error.message }));
      }
    }), runtimePort);

    const bare = await fetch(`${provider.issuer}/activate`);
    const entryPage = await bare.text();
    expect(bare.status).toBe(200);
    expect(entryPage).toContain('name="user_code"');
    expect(entryPage).toContain('method="get"');
    expect(entryPage).not.toContain("设备码无效");
    const invalid = await fetch(`${provider.issuer}/activate?user_code=NOT-A-CODE`);
    expect(invalid.status).toBe(400);
    const invalidPage = await invalid.text();
    expect(invalidPage).toContain("设备码无效或已过期");
    expect(invalidPage).toContain('name="user_code" value="NOT-A-CODE"');

    const store = credentialStore();
    const output = new PassThrough();
    let text = "";
    let announced;
    const announcement = new Promise((resolve) => { announced = resolve; });
    output.on("data", (chunk) => {
      text += chunk.toString();
      const line = text.split("\n").find((line) => line.includes('"type":"auth.deviceCode"'));
      if (line) announced(JSON.parse(line));
    });
    const flags = ["--url", runtimeOrigin, "--account", "--jsonl"];
    const options = { output, credentialStore: store, environment: {}, sleep: () => delay(1000) };
    const operation = runRuntimeCli({ ...options, argv: ["auth", "login", ...flags] });
    const event = await Promise.race([announcement, operation.then(() => { throw new Error("Login completed without a device event"); })]);
    const activation = new URL(event.verificationUri);
    expect(activation.origin).toBe(provider.issuer);
    expect(activation.pathname).toBe("/activate");
    expect(activation.searchParams.get("user_code")).toBe(event.userCode);
    const loginPage = await (await fetch(event.verificationUri)).text();
    expect(loginPage).toContain('name="device" value="' + event.userCode + '"');
    expect(loginPage).toContain("登录 Zion");
    expect(store.values.size).toBe(0);

    const expired = await post(`${provider.issuer}/device`, { client_id: "cli-test" });
    const expiredFlow = await expired.json();
    await db.pool.query("UPDATE local_identity_state SET expires_at=0 WHERE namespace='device' AND value->>'userCode'=$1",
      [expiredFlow.user_code]);
    const expiredPage = await fetch(`${provider.issuer}/activate?user_code=${expiredFlow.user_code}`);
    expect(expiredPage.status).toBe(400);
    expect(await expiredPage.text()).toContain("已过期");

    const wrongPassword = await post(`${provider.issuer}/login`, {
      device: event.userCode, email: "cli@example.test", password: "incorrect-password"
    });
    expect(wrongPassword.status).toBe(401);
    expect(store.values.size).toBe(0);
    const approved = await post(`${provider.issuer}/login`, {
      device: event.userCode, email: "cli@example.test", password: "local-test-password"
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("设备已授权");
    await operation;
    expect(text).toContain("auth.completed");
    expect(text).not.toContain("zion_account_v1.");
    const status = await runRuntimeCli({ ...options, argv: ["auth", "status", ...flags] });
    expect(status.authenticated).toBe(true);
    expect(status.user.id).toBe(account.id);
    const installed = await runRuntimeCli({ ...options, argv: ["extensions", "list", ...flags] });
    expect(installed).toEqual([]);
    const all = await runRuntimeCli({ ...options, argv: ["extensions", "list", "--all", ...flags] });
    expect(all.some((entry) => entry.id === "zion.evidence-research")).toBe(true);
    await runRuntimeCli({ ...options, argv: ["auth", "logout", ...flags] });
    expect(store.values.size).toBe(0);
  }, 20_000);

  it.each([
    ["base URI fallback", { verificationUri: "https://id.example.test/activate" }, "https://id.example.test/activate"],
    ["complete URI without a base URI", { verificationUriComplete: "https://id.example.test/activate?user_code=ABC123" },
      "https://id.example.test/activate?user_code=ABC123"]
  ])("supports %s", async (_name, urls, expected) => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url.endsWith("/start") ? {
        ...urls, flowToken: "fixture-flow", userCode: "ABC123", expiresAt: Date.now() + 60000
      } : { token: "zion_account_v1.fixture", expiresAt: Date.now() + 60000 }));
    });
    const baseUrl = await start(server);
    const events = [];
    await loginWithAccount({ baseUrl, credentialStore: credentialStore(), sleep: async () => {},
      emit: (event) => events.push(event) });
    expect(events[0]).toMatchObject({ type: "auth.deviceCode", userCode: "ABC123", verificationUri: expected });
    expect(events[1].type).toBe("auth.completed");
  });
});
