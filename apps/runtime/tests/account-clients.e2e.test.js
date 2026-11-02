import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountOidcFixture } from "./helpers/account-oidc-fixture.mjs";
import { startAccountRuntimeFixture, browserAccountLogin } from "./helpers/account-runtime-fixture.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { runRuntimeCli } from "../src/runtime-cli.mjs";
import { runChatCli } from "../src/chat-cli.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const api = async (origin, login, path, body, method = body === undefined ? "GET" : "POST") => fetch(origin + path, {
  method, headers: { cookie: login.cookie, origin, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

describe("account clients with signed OIDC and two Runtime processes", () => {
  it("bootstraps and starts the deployment launcher with separate storage and built-in plugins", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-space-launcher-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const idp = await createAccountOidcFixture();
    cleanup.push(() => idp.close());
    const database = await createPostgresTestDatabase("space_launcher");
    cleanup.push(() => database.close());
    const socket = createServer();
    await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    idp.registerRuntime(origin);
    const config = join(directory, "space.json");
    const databaseUrl = new URL(database.connectionString);
    databaseUrl.searchParams.set("options", `-c search_path=${database.schema}`);
    writeFileSync(config, JSON.stringify({
      spaceId: "space:launch", dataDirectory: "./data", publicUrl: origin, port,
      issuer: idp.issuer, clientId: "zion-account-test", ownerSubject: "test-owner",
      allowLoopbackHttp: true, databaseUrl: databaseUrl.href
    }));
    const launcher = fileURLToPath(new URL("../../../deploy/accounts/start-space.mjs", import.meta.url));
    const bridge = join(directory, "memory-bridge.key");
    writeFileSync(bridge, "test-only-memory-bridge-secret-at-least-32-bytes");
    let logs = "";
    const launch = action => {
      const child = spawn(process.execPath, [launcher, config, action], {
        env: { PATH: process.env.PATH, ZION_MEMORY_SERVICE_URL: idp.issuer,
          ZION_ARTIFACT_STORE: "local", ZION_ENV: "development",
          ZION_ARTIFACT_DIRECTORY: join(directory, "artifacts"),
          ZION_MEMORY_BRIDGE_SECRET_FILE: bridge, ZION_MEMORY_MCP_ENABLED: "0" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-5000); });
      child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-5000); });
      return child;
    };
    const bootstrap = launch("bootstrap");
    expect(await new Promise(resolve => bootstrap.once("exit", resolve))).toBe(0);
    const child = launch("start");
    const exited = new Promise(resolve => child.once("exit", resolve));
    cleanup.push(async () => { child.kill("SIGTERM"); await exited; });
    let healthy = false;
    for (let count = 0; count < 100; count++) {
      if (child.exitCode !== null) throw new Error(logs);
      healthy = await fetch(`${origin}/health`).then(response => response.ok).catch(() => false);
      if (healthy) break;
      await delay(100);
    }
    expect(healthy, logs).toBe(true);
    const login = await browserAccountLogin(origin);
    const me = await (await api(origin, login, "/v1/account/me")).json();
    expect(me).toMatchObject({ space: { id: "space:launch" }, membership: { role: "owner" } });
    expect(me.user.name).toBe("test-owner");
  }, 20_000);

  it("logs in browsers and CLI, isolates Spaces, shares membership, and revokes only selected authority", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-account-clients-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const idp = await createAccountOidcFixture();
    cleanup.push(() => idp.close());
    const a = await startAccountRuntimeFixture({ directory: join(directory, "a"), spaceId: "space:a", idp });
    cleanup.push(a.close);
    const b = await startAccountRuntimeFixture({ directory: join(directory, "b"), spaceId: "space:b", idp });
    cleanup.push(b.close);
    const owner = await browserAccountLogin(a.url);
    const ownerOther = await browserAccountLogin(a.url, "/mobile/devices");
    expect(ownerOther.returnTo).toBe("/mobile/devices");
    expect(owner.headers.getSetCookie().join()).toContain("HttpOnly");
    expect(owner.headers.getSetCookie().join()).toContain("SameSite=Strict");
    expect((await api(b.url, owner, "/v1/sessions")).status).toBe(401);
    const session = await (await api(a.url, owner, "/v1/sessions", { title: "Space A private fixture" })).json();
    expect(session.session.id).toBeTruthy();
    const bOwner = await browserAccountLogin(b.url);
    expect((await api(b.url, bOwner, `/v1/sessions/${session.session.id}`)).status).toBe(404);
    expect(JSON.parse(
      readFileSync(join(a.dataDirectory, ".zion-space.json"), "utf8")
    ).spaceId).toBe("space:a");
    idp.setSubject("test-member");
    const member = await browserAccountLogin(a.url);
    expect((await api(a.url, member, "/v1/sessions")).status).toBe(409);
    const invitation = await (await api(a.url, owner, "/v1/account/invitations", { role: "member" })).json();
    const acceptedResponse = await api(a.url, member, "/v1/account/invitations/accept", { token: invitation.token });
    expect(acceptedResponse.status).toBe(200);
    const accepted = await acceptedResponse.json();
    expect(accepted.space.id).toBe("space:a");
    expect((await api(a.url, member, "/v1/account/spaces/select", { spaceId: accepted.space.id })).status).toBe(200);
    const identity = await (await api(a.url, member, "/v1/account/me")).json();
    expect(identity.membership.role).toBe("member");
    expect((await api(a.url, member, `/v1/sessions/${session.session.id}`)).status).toBe(200);
    const credentials = new Map();
    const store = {
      get: async key => credentials.get(key),
      set: async (key, value) => { credentials.set(key, value); },
      delete: async key => credentials.delete(key)
    };
    const output = new PassThrough();
    let text = "";
    output.on("data", chunk => { text += chunk.toString(); });
    const cliOptions = { credentialStore: store, output, environment: {}, sleep: () => delay(100) };
    const flags = ["--account", "--url", a.url, "--jsonl"];
    await runRuntimeCli({ ...cliOptions, argv: ["auth", "login", ...flags] });
    expect(text).toContain("auth.completed");
    expect(text).not.toContain("zion_account_v1.");
    const status = await runRuntimeCli({ ...cliOptions, argv: ["auth", "status", ...flags] });
    expect(status.membership.role).toBe("member");
    await runRuntimeCli({ ...cliOptions, argv: ["session", "list", ...flags] });
    await runChatCli({ ...cliOptions, argv: ["--account", "--url", a.url], input: Readable.from([]) });
    await expect(runRuntimeCli({ ...cliOptions, argv: ["session", "list", "--account", "--url", b.url] }))
      .rejects.toThrow("login required");
    const run = await runRuntimeCli({ ...cliOptions, argv: ["run", "Hello fixture", ...flags] });
    expect(run.status).toBe("completed");
    const memberGrants = await (await api(a.url, member, "/v1/account/grants?limit=1")).json();
    expect(memberGrants.grants).toHaveLength(1);
    expect(memberGrants.grants[0].userId).toBe(identity.user.id);
    expect(memberGrants.grants[0]).not.toHaveProperty("policy_json");
    expect((await api(a.url, member, "/v1/account/grants/revoke", { grantId: run.principal.grantId })).status).toBe(200);
    expect((await api(a.url, member, `/v1/runs/${run.id}/resume`, {})).status).toBe(403);
    await runRuntimeCli({ ...cliOptions, argv: ["auth", "logout", ...flags] });
    expect(credentials.size).toBe(0);
    expect((await api(a.url, member, "/v1/sessions")).status).toBe(200);
    await api(a.url, owner, "/v1/account/logout", {});
    expect((await api(a.url, owner, "/v1/sessions")).status).toBe(401);
    expect((await api(a.url, ownerOther, "/v1/sessions")).status).toBe(200);
    await api(a.url, ownerOther, `/v1/account/members/${encodeURIComponent(identity.user.id)}`, { role: "viewer" }, "PATCH");
    expect((await api(a.url, member, "/v1/runs", { prompt: "forbidden" })).status).toBe(403);
    await api(a.url, ownerOther, `/v1/account/members/${encodeURIComponent(identity.user.id)}`,
      { role: "viewer", status: "removed" }, "PATCH");
    expect((await api(a.url, member, "/v1/sessions")).status).toBe(409);
  }, 30_000);
});
