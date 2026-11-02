import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresTestDatabase, provisionTestTeam } from "./helpers/postgres-test-database.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { createPluginDevelopmentHttpHandler } from "../src/plugin-development-http-handler.mjs";
import { createWorkbenchStateHttpHandler } from "../src/workbench-state-http-handler.mjs";
import { createPluginDevelopmentClient } from "../../../packages/runtime-client/src/plugin-development.mjs";
import { createMemoryArtifactStore } from "../src/marketplace/artifact-store.mjs";

const execute = promisify(execFile);
describe("account directory development through CLI and independent HTTP clients", () => {
  let db, workbench, server, baseUrl, alice, bob, directory, config, online = true;
  let sourceRevision = "first", sourceCode = "export const message = 'First successful build';";
  const tokens = new Map();
  beforeAll(async () => {
    db = await createPostgresTestDatabase("plugin_development");
    alice = await provisionTestTeam(db, { spaceId: "space:dev", ownerSubject: "dev-alice" });
    bob = await db.accounts.resolveIdentity({ issuer: "https://identity.test", subject: "dev-bob" });
    await db.accounts.acceptInvitation(bob.id, (await db.accounts.invite(alice.id, {}, "space:dev")).token);
    for (const user of [alice, bob]) tokens.set(user.id,
      (await db.accounts.createSession(user.id, { activeSpaceId: "space:dev" })).token);
    workbench = await new PostgresWorkbenchStateStore(db.pool, { spaceId: "space:dev" }).initialize();
    const access = new AccountAccessControl({
      accounts: db.accounts, store: new PostgresAccessStore(db.pool, { spaceId: "space:dev" }),
      publicBaseUrl: "https://workbench.test", oidc: { secureCookies: true }, servedSpaceId: "space:dev"
    });
    const handlers = [
      createPluginDevelopmentHttpHandler({ store: workbench, artifactStore: createMemoryArtifactStore(), platformNodeIds: ["node:cloud-runtime"] }),
      createWorkbenchStateHttpHandler({ store: workbench })
    ];
    server = createServer(async (req, res) => {
      try {
        req.zionPrincipal = await access.authorizeRuntimeRequest(req);
        const url = new URL(req.url, "http://test");
        for (const handle of handlers) if (await handle(req, res, url)) return;
        if (url.pathname.startsWith("/v1/device-services/plugin-service/")) {
          if (!online) { res.writeHead(503); res.end(JSON.stringify({ error: "Source Node offline" })); return; }
          expect(url.searchParams.get("node_id")).toBe("node:mac");
          if (url.pathname.endsWith("/main.js")) {
            res.writeHead(200); res.end(sourceCode); return;
          }
          if (url.pathname.endsWith("/missing.js")) {
            res.writeHead(404); res.end("Not found"); return;
          }
          const result = url.pathname.endsWith("/start")
            ? { success: true, data: { devId: "dev-source", dir: "/tmp/fixture", baseUrl: "/plugins/dev/dev-source" } }
            : url.pathname.endsWith("/list")
              ? { success: true, data: { sessions: [{ devId: "dev-source", active: true, dirExists: true }] } }
              : url.pathname.endsWith("/__revision") ? { revision: sourceRevision }
                : { manifestVersion: 2, id: "dev.fixture", name: "Fixture", version: "0.1.0", entries: { workbench: "./main.js" } };
          res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result)); return;
        }
        res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));
      } catch (error) {
        res.writeHead(error.statusCode || 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error.message, code: error.code }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    directory = await mkdtemp(join(tmpdir(), "zioon-dev-cli-"));
    config = join(directory, "cli.json");
    await writeFile(config, JSON.stringify({ profiles: { test: { url: baseUrl, auth: { type: "bearer", env: "ZION_TEST_ACCOUNT_TOKEN" } } } }));
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const cli = async (...args) => {
    const { stdout } = await execute(process.execPath, [new URL("../bin/zion.mjs", import.meta.url).pathname,
      "extensions", "dev", ...args, "--runtime-profile", "test", "--jsonl"], {
      env: { ...process.env, ZION_RUNTIME_CLI_CONFIG: config, ZION_RUNTIME_PROFILE: "", ZION_RUNTIME_URL: "",
        ZION_TEST_ACCOUNT_TOKEN: tokens.get(alice.id) }
    });
    return JSON.parse(stdout.trim()).value;
  };
  const client = (user) => createPluginDevelopmentClient({ baseUrl, headers: { authorization: `Bearer ${tokens.get(user.id)}` } });
  const call = async (user, path, method = "GET", body) => {
    const response = await fetch(baseUrl + path, { method, headers: {
      authorization: `Bearer ${tokens.get(user.id)}`, "content-type": "application/json"
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };

  it("registers through the CLI, discovers from a fresh client, and retains metadata while offline", async () => {
    const started = await cli("start", "/tmp/fixture", "--node", "node:mac");
    expect(started.registration).toBe("account");
    expect(started.buildStatus).toBe("available");
    expect((await client(alice).snapshot()).entries[0]).toMatchObject({ pluginId: "dev.fixture", nodeId: "node:mac" });
    expect((await cli("list")).entries[0].status).toBe("online");
    online = false;
    expect((await client(alice).list()).entries[0].status).toBe("offline");
    expect((await client(alice).snapshot()).entries).toHaveLength(1);
    online = true;
    expect((await client(alice).list()).entries[0].status).toBe("online");
  });

  it("serves immutable successful builds to a fresh client while the Node is offline, fences competing builds and preserves failures", async () => {
    const current = await client(alice).snapshot();
    const first = current.entries[0].build;
    const path = `/v1/workbench-state/plugin-development/dev.fixture/builds/${first.digest}`;
    online = false;
    const loaded = await fetch(baseUrl + path + "/main.js", { headers: { authorization: `Bearer ${tokens.get(alice.id)}` } });
    expect(loaded.status).toBe(200);
    expect(await loaded.text()).toBe(sourceCode);
    expect((await call(bob, path + "/manifest.json")).status).toBe(404);
    online = true;
    const body = { expectedRevision: current.revision, generation: first.generation + 1,
      build: { schemaVersion: 1, manifest: { manifestVersion: 2, id: "dev.fixture", name: "Fixture", version: "0.1.0", entries: { workbench: "./main.js" } },
        files: { "main.js": "export const message = 'Next build';" } } };
    const results = await Promise.all([1, 2].map(() => call(alice,
      "/v1/workbench-state/plugin-development/dev.fixture/builds", "PUT", body)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const next = (await client(alice).snapshot()).entries[0].build;
    expect(next.generation).toBe(first.generation + 1);
    sourceCode = "import './missing.js';";
    sourceRevision = "broken";
    await expect(client(alice).publish("dev.fixture")).rejects.toMatchObject({ statusCode: 404 });
    expect((await client(alice).snapshot()).entries[0].build.digest).toBe(next.digest);
    expect((await call(alice, path + "/manifest.json")).status).toBe(200);
    sourceCode = "export const message = 'Recovered source';";
    sourceRevision = "recovered";
    const published = await cli("build", "dev.fixture");
    expect(published.build.generation).toBe(next.generation + 1);
    expect(published.baseUrl).toContain(published.build.digest);
  });

  it("isolates users sharing the same Space and hides registration from generic snapshots and KV", async () => {
    expect((await client(bob).snapshot()).entries).toEqual([]);
    const other = await call(bob, "/v1/workbench-state/plugin-development/dev.fixture", "DELETE", { expectedRevision: 0 });
    expect(other.status).toBe(404);
    const raw = await workbench.readSnapshot();
    const key = Object.keys(raw.snapshot.kv).find((value) => value.startsWith("runtime.plugins.development.private."));
    expect(key).toBeTruthy();
    expect((await call(alice, `/v1/workbench-state/kv/${encodeURIComponent(key)}`)).status).toBe(404);
    expect((await call(bob, `/v1/workbench-state/kv/${encodeURIComponent(key)}`)).status).toBe(403);
    expect(Object.keys((await call(bob, "/v1/workbench-state/snapshot")).body.snapshot.kv)).not.toContain(key);
  });

  it("atomically rejects concurrent stale edits across independent handler instances", async () => {
    const { revision, entries } = await client(alice).snapshot();
    const record = entries[0];
    const results = await Promise.all(["First", "Second"].map((name) => call(alice,
      "/v1/workbench-state/plugin-development", "PUT", { record: { ...record, name }, expectedRevision: revision })));
    expect(results.map((value) => value.status).sort()).toEqual([200, 409]);
    const restored = await new PostgresWorkbenchStateStore(db.pool, { spaceId: "space:dev" }).initialize();
    const keys = Object.keys((await restored.readSnapshot()).snapshot.kv);
    const registry = (await restored.readKV(keys.find((key) => key.startsWith("runtime.plugins.development.private.")))).value;
    expect(registry.revision).toBe(revision + 1);
    const denied = await call(alice, "/v1/workbench-state/plugin-development", "PUT", {
      record: { ...record, nodeId: "node:cloud-runtime" }, expectedRevision: registry.revision
    });
    expect(denied.status).toBe(403);
  });

  it("unregisters through CLI without needing an online source", async () => {
    online = false;
    await cli("stop", "dev.fixture");
    expect((await client(alice).snapshot()).entries).toEqual([]);
    online = true;
  });
});
