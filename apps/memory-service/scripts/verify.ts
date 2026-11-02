import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PostgresAccountStore } from "../../runtime/src/accounts/postgres-account-store.mjs";
import { AccountAccessControl } from "../../runtime/src/accounts/account-access-control.mjs";
import { createPluginFileService } from "../../runtime/src/plugin-file-service.mjs";
import { createAgentFsMemoryClient } from "../../runtime/src/agentfs-memory-client.mjs";
import { createAgentFsMcpClient } from "../../runtime/src/agentfs-mcp-client.mjs";
import { createMemoryDelegation } from "../../runtime/src/accounts/memory-delegation.mjs";
import { activateRuntimePlugin } from "../../../extensions/dev.identity/runtime.js";

// Real account schema and HTTP services, with disposable test identities/files.
const config = JSON.parse(await readFile(join(homedir(), ".zion-next/sandbox-demo/account.json"), "utf8"));
const dbUrl = new URL(config.url);
assert(["127.0.0.1", "localhost"].includes(dbUrl.hostname));
const directory = await mkdtemp(join(tmpdir(), "zion-memory-verification-"));
process.env.AGENT_FS_HOME = directory;
process.env.AGENT_FS_STORAGE_PROVIDER = "local";
process.env.AGENT_FS_LOCAL_ROOT = join(directory, "objects");
const { core } = await import("../src/upstream.ts");
const { createMemoryGateway } = await import("../src/gateway.ts");
const schema = `memory_verify_${randomBytes(6).toString("hex")}`;
const admin = new pg.Pool({ connectionString: config.url, max: 1 });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({ connectionString: config.url, options: `-c search_path=${schema}`, max: 2 });
const accounts = new PostgresAccountStore({ pool });
const secret = randomBytes(48).toString("base64url");
const access = new AccountAccessControl({
  accounts, oidc: { secureCookies: false },
  store: { authenticate: async () => null, exchangePairing: async () => null },
  memoryBridgeSecret: secret, publicBaseUrl: "http://127.0.0.1"
});
const identityServer = createServer(async (request, response) => {
  if (!await access.handleHttp(request, response, new URL(request.url, "http://127.0.0.1"))) {
    response.writeHead(404); response.end();
  }
});
const sqlite = core.createDatabase(join(directory, "agent-fs.db"));
const storage = new core.LocalStorageAdapter({ root: join(directory, "objects") });
let server;
let checks = 0;
const check = () => checks++;
try {
  await accounts.initialize();
  await new Promise((done) => identityServer.listen(0, "127.0.0.1", done));
  const runtimeUrl = `http://127.0.0.1:${identityServer.address().port}`;
  const gateway = createMemoryGateway({ db: sqlite, storage, secret, runtimeUrl });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: gateway.fetch });
  const origin = `http://127.0.0.1:${server.port}`;
  const userCount = () => sqlite.$client.query("SELECT COUNT(*) AS count FROM users").get().count;
  const countBeforeDiscovery = userCount();
  const nativeMcp = createAgentFsMcpClient({ baseUrl: origin, secret });
  const discovered = await nativeMcp.discover();
  assert.equal(userCount(), countBeforeDiscovery); check();
  assert(discovered.some((tool) => tool.name === "mcp__agentfs__cat"));
  assert(!discovered.some((tool) => tool.name.includes("member")));
  assert.equal(discovered.find((tool) => tool.name === "mcp__agentfs__append").execution.effect, "write"); check();
  const unauthenticatedCall = await fetch(`${origin}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "cat", arguments: { path: "/memory/dev.identity/user.md" }
    } })
  });
  assert.equal(unauthenticatedCall.status, 401); check();
  const sessions = [];
  for (const subject of ["one", "two"]) {
    const user = await accounts.resolveIdentity({ issuer: "memory-verification", subject, name: subject });
    const space = await accounts.personalSpace(user.id);
    sessions.push({ user, space, ...await accounts.createSession(user.id, { activeSpaceId: space.id }) });
  }
  async function request(index, path, options = {}) {
    const response = await fetch(origin + path, { ...options, headers: {
      authorization: `Bearer ${sessions[index].token}`,
      "content-type": "application/json", accept: "application/json, text/event-stream",
      ...options.headers
    } });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  }
  const me = await request(0, "/auth/me");
  assert.equal(me.status, 200); check();
  const org = me.data.defaultOrgId, drive = me.data.defaultDriveId;
  async function op(index, name, params = {}) {
    return request(index, `/orgs/${org}/ops`, { method: "POST", body: JSON.stringify({ op: name, ...params }) });
  }
  const path = "/memory/dev.identity/user.md";
  assert.equal((await op(0, "write", { path, content: "# Memory\n", expectedVersion: 0 })).status, 200); check();
  assert.equal((await op(0, "cat", { path })).data.content, "# Memory\n"); check();
  assert.equal((await op(1, "cat", { path })).status, 404); check();
  const parallel = await Promise.all(["first", "second"].map((content) => op(0, "write", { path, content, expectedVersion: 1 })));
  assert.deepEqual(parallel.map((v) => v.status).sort(), [200, 409]); check();
  assert.equal((await op(0, "log", { path })).data.versions.length, 2); check();
  assert.equal((await request(0, "/auth/register", { method: "POST", body: '{"email":"bypass@test.invalid"}' })).status, 403); check();
  const raw = await fetch(`${origin}/orgs/${org}/drives/${drive}/files/memory/dev.identity/user.md/raw`, {
    headers: { authorization: `Bearer ${sessions[0].token}` }
  });
  const winningContent = parallel[0].status === 200 ? "first" : "second";
  assert.equal(await raw.text(), winningContent); check();
  const mcp = (method, params, id = 1) => request(0, "/mcp", {
    method: "POST", headers: { "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  assert.equal((await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "verify", version: "1" } })).status, 200); check();
  const tools = await mcp("tools/list", {});
  assert(tools.data.result.tools.some((tool) => tool.name === "cat")); check();
  const readMcp = await mcp("tools/call", { name: "cat", arguments: { path } });
  assert.equal(JSON.parse(readMcp.data.result.content[0].text).content, winningContent); check();
  assert.equal((await mcp("tools/call", { name: "member-invite", arguments: { email: "other", role: "admin" } })).status, 403); check();
  const client = createAgentFsMemoryClient({ baseUrl: origin, secret });
  const files = createPluginFileService({
    fileClient: client, dataLocation: () => ({ root: "/memory/dev.identity", nodeId: "" })
  });
  const actor = await access.authenticateHeaders({ authorization: `Bearer ${sessions[0].token}` });
  const runContext = { principal: actor, policy: {
    preset: "workspace-write", fileRoots: ["/memory/dev.identity"], allowedTerminalSessionIds: []
  } };
  const mcpPolicy = { ...runContext.policy, allowedTools: discovered.map((tool) => tool.name), maxToolCalls: 20 };
  const nativeContext = { principal: actor, policy: mcpPolicy };
  assert.equal(JSON.parse((await nativeMcp.invoke("mcp__agentfs__cat", { path }, nativeContext)).content).content,
    winningContent); check();
  const readOnlyContext = { ...nativeContext, policy: { ...mcpPolicy, preset: "read-only" } };
  await assert.rejects(() => nativeMcp.invoke("mcp__agentfs__write", {
    path, content: "denied", expectedVersion: 2
  }, readOnlyContext), (error) => error.code === 403); check();
  await assert.rejects(() => nativeMcp.invoke("mcp__agentfs__cat", {
    path: "/memory/dev.identity/../outside"
  }, nativeContext), /Invalid agent-fs path/); check();
  const nativeWrites = await Promise.all(["native A", "native B"].map((content) =>
    nativeMcp.invoke("mcp__agentfs__write", { path, content, expectedVersion: 2 }, nativeContext)));
  assert.equal(nativeWrites.filter((result) => result.ok).length, 1);
  assert.equal(JSON.parse(nativeWrites.find((result) => !result.ok).content).error, "EDIT_CONFLICT"); check();
  const boundBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "cat", arguments: { path } } });
  const wrongBinding = await createMemoryDelegation(secret, { context: nativeContext,
    method: "POST", path: "/mcp", body: boundBody, toolName: "mcp__agentfs__cat",
    filePaths: ["/other"], write: false });
  assert.equal((await request(0, "/mcp", { method: "POST", body: boundBody,
    headers: { authorization: `Bearer ${wrongBinding}` } })).status, 403); check();
  const lostReply = createAgentFsMcpClient({ baseUrl: origin, secret,
    async fetchImpl(url, options) {
      const result = await fetch(url, options);
      if (options.body && JSON.parse(options.body).method === "tools/call") {
        await result.arrayBuffer();
        throw new TypeError("Simulated reply loss after the service committed");
      }
      return result;
    } });
  await lostReply.discover();
  const lostPath = "/memory/dev.identity/reply-loss.md";
  const unknown = await lostReply.invoke("mcp__agentfs__write", {
    path: lostPath, content: "committed once", expectedVersion: 0
  }, nativeContext);
  assert.equal(unknown.failureCode, "execution_outcome_unknown");
  assert.equal(unknown.retryable, false);
  assert.equal(JSON.parse((await nativeMcp.invoke("mcp__agentfs__cat", { path: lostPath }, nativeContext)).content).content,
    "committed once");
  assert.equal(JSON.parse((await nativeMcp.invoke("mcp__agentfs__log", { path: lostPath }, nativeContext)).content).versions.length, 1); check();
  const loaded = await files.readTextFile({ relativePath: "user.md", runContext });
  assert(["native A", "native B"].includes(loaded.content)); check();
  const writes = await Promise.allSettled(["panel A", "panel B"].map((content) =>
    files.writeTextFile({ relativePath: "user.md", content, expectedHash: loaded.contentHash, runContext })));
  assert.equal(writes.filter((v) => v.status === "fulfilled").length, 1); check();
  const appends = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    files.appendJsonl({ relativePath: "biography/events.jsonl", records: [{ id: `event-${index}`, content: "验证" }], runContext })));
  assert(appends.every((v) => v.appended.length === 1)); check();
  assert.equal((await files.readTextFile({ relativePath: "biography/events.jsonl", runContext })).content.trim().split("\n").length, 8); check();
  assert.deepEqual((await files.appendJsonl({ relativePath: "biography/events.jsonl",
    records: [{ id: "event-0", content: "验证" }], runContext })).skipped, ["event-0"]); check();
  await assert.rejects(() => files.appendJsonl({ relativePath: "biography/events.jsonl",
    records: [{ id: "event-0", content: "different" }], runContext })); check();
  const grantPolicy = { ...runContext.policy, allowedTools: ["read", "write"], maxToolCalls: 20 };
  const grant = await accounts.issueGrant(sessions[0].user.id, grantPolicy, { spaceId: sessions[0].space.id, ttlMs: 60000 });
  assert.equal((await files.readTextFile({ relativePath: "user.md", runContext: { principal: grant, policy: grantPolicy } })).missing, false); check();
  await accounts.revokeGrant(sessions[0].user.id, grant.grantId, sessions[0].space.id);
  await assert.rejects(() => files.readTextFile({ relativePath: "user.md", runContext: { principal: grant, policy: grantPolicy } })); check();
  // Execute the actual upstream CLI with a Zion token, without creating an af_ credential.
  const child = Bun.spawn([process.execPath, join(process.env.AGENT_FS_UPSTREAM_DIR, "packages/cli/src/index.ts"), "cat", path], {
    env: { ...process.env, AGENT_FS_API_URL: origin, AGENT_FS_API_KEY: sessions[0].token },
    stdout: "pipe", stderr: "pipe"
  });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  assert.equal(await child.exited, 0, errors);
  const panelContent = (await files.readTextFile({ relativePath: "user.md", runContext })).content;
  assert(output.includes(panelContent)); check();
  // The logical drive path is identical for both users. Cache keys must still
  // isolate concurrent requests using the same Session and Run identifiers.
  const actorTwo = await access.authenticateHeaders({ authorization: `Bearer ${sessions[1].token}` });
  const readContext = (principal) => ({
    runId: "shared-run-id",
    sessionId: "shared-session-id",
    principal,
    policy: { preset: "read-only", fileRoots: ["/memory/dev.identity"], allowedTerminalSessionIds: [] }
  });
  await files.writeTextFile({ relativePath: "user.md", content: "Second account private profile",
    runContext: { ...runContext, principal: actorTwo } });
  await files.appendJsonl({ relativePath: "biography/events.jsonl", records: [{
    id: "verification:run:0", sessionId: "verification", runId: "run",
    at: new Date().toISOString(), kind: "outcome", summary: "Verified account isolated memory",
    project: "memory-verification", topics: ["agentfs"], confirmed: false
  }], runContext });
  const pluginTools = new Map(), state = new Map();
  let provider;
  const plugin = activateRuntimePlugin({
    plugin: { id: "dev.identity", version: "verification" },
    locations: { scopeMode: "account", forRequest: () => ({
      root: "/memory/dev.identity", nodeId: "", backend: "agent-fs", apiUrl: origin
    }) },
    config: { fileService: files, mcpService: nativeMcp, biography: { enabled: false } },
    state: { namespace: () => ({ get: (key) => state.get(key), set: (key, value) => state.set(key, value) }) },
    context: { registerProvider(value) { provider = value; return { dispose() {} }; } },
    tools: { registerTool(value) { pluginTools.set(value.name, value); return { dispose() {} }; } }
  });
  try {
    const messages = [{ role: "user", content: "inspect memory" }];
    const [one, two] = await Promise.all([actor, actorTwo].map((principal) =>
      provider.contribute(messages, readContext(principal))));
    assert(one[0].content.includes(panelContent));
    assert(!one[0].content.includes("Second account private profile"));
    assert(two[0].content.includes("Second account private profile"));
    assert(!two[0].content.includes(panelContent)); check();
    const again = await provider.contribute(messages, { ...readContext(actor), runId: "next-run" });
    assert(again[0].content.includes(panelContent));
    assert(!again[0].content.includes("Second account private profile")); check();
    assert(!pluginTools.has("biographyQuery"));
    const query = JSON.parse((await pluginTools.get("mcp__agentfs__grep").invoke({
      pattern: "memory-verification", path: "/memory/dev.identity/biography"
    }, { ...readContext(actor), policy: { ...mcpPolicy, preset: "read-only" } })).content);
    assert.equal(query.matches.length, 1);
    assert.equal(JSON.parse(query.matches[0].content).id, "verification:run:0"); check();
    const second = JSON.parse((await nativeMcp.invoke("mcp__agentfs__cat", { path },
      { ...nativeContext, principal: actorTwo })).content).content;
    assert.equal(second, "Second account private profile"); check();
    const delegated = await accounts.issueGrant(sessions[0].user.id, {
      ...mcpPolicy, fileRoots: [path]
    }, { spaceId: sessions[0].space.id, ttlMs: 60000 });
    const delegatedContext = { principal: delegated, policy: { ...mcpPolicy, fileRoots: [path] } };
    assert.equal((await nativeMcp.invoke("mcp__agentfs__cat", { path }, delegatedContext)).ok, true); check();
    await assert.rejects(() => nativeMcp.invoke("mcp__agentfs__cat", {
      path: "/memory/dev.identity/biography/events.jsonl"
    }, delegatedContext), (error) => error.code === 403); check();
    await assert.rejects(() => nativeMcp.invoke("mcp__agentfs__cp", {
      from: path, to: "/outside-copy.md"
    }, delegatedContext), (error) => error.code === 403); check();
    await accounts.revokeGrant(sessions[0].user.id, delegated.grantId, sessions[0].space.id);
    await assert.rejects(() => nativeMcp.invoke("mcp__agentfs__cat", { path }, delegatedContext)); check();
    assert(again[0].content.includes("mcp__agentfs__grep"));
    assert(again[0].content.includes("agentfs-memory"));
    assert(!again[0].content.includes("query-biography.py")); check();
  } finally { await plugin.dispose(); }
  // Run the real Node Runtime entrypoint with the Identity plugin and call the
  // exact panel endpoints. Its file API uses this standalone memory service.
  const secretFile = join(directory, "bridge.key");
  await writeFile(secretFile, secret, { mode: 0o600 });
  const execute = promisify(execFile);
  const node = (await execute("node", ["-p", "process.execPath"])).stdout.trim();
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const runtime = spawn(node, ["apps/runtime/src/main.mjs"], {
    cwd: repository, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ZION_DATABASE_URL: config.url, PGOPTIONS: `-c search_path=${schema}`,
      ZION_SPACE_ID: sessions[0].space.id, ZION_RUNTIME_HOST: "127.0.0.1", ZION_RUNTIME_PORT: "0",
      ZION_RUNTIME_PUBLIC_URL: "http://127.0.0.1:18891", ZION_RUNTIME_DATA_DIR: join(directory, "runtime"),
      ZION_RUNTIME_ENGINE: "echo", ZION_RUNTIME_AUTH_MODE: "accounts",
      ZION_OIDC_ISSUER: "http://127.0.0.1:18091", ZION_OIDC_CLIENT_ID: "zion-local",
      ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP: "1", ZION_RUNTIME_TOOL_MODE: "local",
      ZION_PLUGIN_DATA_HOST: "runtime", ZION_PLUGIN_DATA_SCOPE: "account",
      ZION_MEMORY_SERVICE_URL: origin, ZION_MEMORY_BRIDGE_SECRET_FILE: secretFile,
      ZION_RUNTIME_PLUGINS: "dev.identity", ZION_RUNTIME_EXTERNAL_PLUGINS: "",
      ZION_RUNTIME_MIGRATE_LOCAL_TOOLS_STATE: "0", ZION_RUNTIME_STORAGE_MAINTENANCE: "0",
      ZION_RUNTIME_SCHEDULER_WORKER: "0", ZION_RUNTIME_PROJECT_AUTOMATION_WORKER: "0",
      OTEL_SDK_DISABLED: "true" }
  });
  let runtimeOutput = "";
  runtime.stdout.on("data", (chunk) => { runtimeOutput += chunk; });
  runtime.stderr.on("data", (chunk) => { runtimeOutput += chunk; });
  try {
    let actual;
    const deadline = Date.now() + 20000;
    while (!actual && Date.now() < deadline) {
      actual = runtimeOutput.match(/Zion Runtime listening at (http:\/\/\S+)/)?.[1];
      if (runtime.exitCode !== null) throw new Error(`Runtime startup failed: ${runtimeOutput}`);
      if (!actual) await delay(100);
    }
    assert(actual, runtimeOutput);
    const headers = { authorization: `Bearer ${sessions[0].token}`, "content-type": "application/json" };
    const location = await fetch(`${actual}/v1/plugins/dev.identity/locations`, { headers }).then((v) => v.json());
    assert.equal(location.data.backend, "agent-fs"); check();
    const panel = await fetch(`${actual}/v1/plugins/dev.identity/files/read?path=user.md`, { headers }).then((v) => v.json());
    assert.equal(panel.content, panelContent); check();
    const saved = await fetch(`${actual}/v1/plugins/dev.identity/files/write`, {
      method: "POST", headers, body: JSON.stringify({ path: "user.md", content: "Actual Runtime panel", expected_hash: panel.content_hash })
    });
    assert.equal(saved.status, 200); check();
    assert.equal((await op(0, "cat", { path })).data.content, "Actual Runtime panel"); check();
  } finally {
    const exited = new Promise((done) => runtime.once("exit", done));
    if (runtime.exitCode === null) { runtime.kill("SIGTERM"); await exited; }
  }
  const backup = Bun.spawn([process.execPath, "scripts/backup.ts", join(directory, "backup")], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env, stdout: "pipe", stderr: "pipe"
  });
  const backupOutput = await new Response(backup.stdout).text();
  const backupError = await new Response(backup.stderr).text();
  assert.equal(await backup.exited, 0, backupError);
  assert(backupOutput.includes("SQLite snapshot verified")); check();
  await accounts.revokeSession(sessions[0].user.id, sessions[0].sessionId);
  assert.equal((await request(0, "/auth/me")).status, 401); check();
  await assert.rejects(() => files.readTextFile({ relativePath: "user.md", runContext })); check();
  console.log(JSON.stringify({ ok: true, checks, upstream: core.VERSION,
    verified: ["real Zion PostgreSQL accounts", "native API", "raw files", "CLI", "MCP", "account isolation",
      "same-version concurrency conflict", "panel content-hash conflict", "JSONL concurrent append and dedup",
      "grant revocation", "session revocation", "actual Runtime Identity panel API", "SQLite backup",
      "account-isolated caches at identical logical paths", "native MCP discovery without creating users",
      "Runtime native MCP forwarding", "MCP write conflicts and read-only denial",
      "MCP path grants, copy destination and revocation", "native MCP biography retrieval and Skill context"],
    storage: "upstream LocalStorageAdapter", oss: "not tested without Bucket credentials" }, null, 2));
} finally {
  if (server) await server.stop(true);
  await new Promise((done) => {
    identityServer.close(done);
    identityServer.closeAllConnections();
  });
  sqlite.$client.close();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
