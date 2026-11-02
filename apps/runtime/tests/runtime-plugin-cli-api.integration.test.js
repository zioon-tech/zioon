import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { createPostgresTestDatabase, provisionTestTeam } from "./helpers/postgres-test-database.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { RuntimePluginService } from "../src/runtime-plugin-service.mjs";
import { RuntimeToolBroker } from "../src/runtime-tool-broker.mjs";
import { FileInteractionProfileStore } from "../src/interaction-profile-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createRuntimeControlClient } from "../src/runtime-cli.mjs";
import { ExtensionInvocationEngine } from "../src/marketplace/invocation-engine.mjs";
import { runtimePluginToolRequest } from "../../../packages/runtime-client/src/extensions.mjs";

const exec = promisify(execFile);
const entry = new URL("../bin/zion.mjs", import.meta.url).pathname;
describe("installed Runtime plugin tools through CLI and Run API", () => {
  let db, root, plugins, runs, server, url, token, bobToken, config, tool;
  beforeAll(async () => {
    db = await createPostgresTestDatabase("native_plugin_cli");
    const owner = await provisionTestTeam(db, { spaceId: "space:native-plugin-cli" });
    const bob = await db.accounts.resolveIdentity({ issuer: "https://identity.test", subject: "bob" });
    await db.accounts.acceptInvitation(bob.id, (await db.accounts.invite(owner.id, {}, "space:native-plugin-cli")).token);
    await db.accounts.setMember(owner.id, bob.id, { role: "viewer" }, "space:native-plugin-cli");
    token = (await db.accounts.createSession(owner.id, { activeSpaceId: "space:native-plugin-cli" })).token;
    bobToken = (await db.accounts.createSession(bob.id, { activeSpaceId: "space:native-plugin-cli" })).token;
    root = await mkdtemp(join(tmpdir(), "zioon-native-tools-"));
    for (const id of ["fixture.account", "fixture.session"]) {
      await mkdir(join(root, id));
      await writeFile(join(root, id, "manifest.json"), JSON.stringify({ manifestVersion: 2, id, version: "0.1.0",
        entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 } }));
      await writeFile(join(root, id, "runtime.mjs"), `export function activateRuntimePlugin(c) {
        c.runs.registerCommands(async (args, request) => ({ connected: false, accountId: request.principal.user.id,
          sessionId: request.sessionId || null }), ${id === "fixture.account" ? "{requiresSession:false}" : "{}"});
        c.tools.registerTool({name:"${id === "fixture.account" ? "native_echo" : "session_echo"}",
          inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false},
          execution:{effect:"read"}, async invoke({text},request){return {ok:true,content:JSON.stringify({
            text,accountId:request.principal.userId,runId:request.runId})};}});
      }`);
    }
    plugins = new RuntimePluginService({ pluginRoots: [{ path: root }], enabledPluginIds: ["fixture.account", "fixture.session"] });
    const snapshot = await plugins.start();
    expect(snapshot.failures).toEqual([]);
    tool = plugins.getToolDefinitions().find((tool) => tool.name === "native_echo");
    runs = new PostgresRunStore(db.pool, { spaceId: "space:native-plugin-cli" });
    const access = new AccountAccessControl({ accounts: db.accounts,
      store: new PostgresAccessStore(db.pool, { spaceId: "space:native-plugin-cli" }),
      servedSpaceId: "space:native-plugin-cli", publicBaseUrl: "https://runtime.test", oidc: { secureCookies: true } });
    const tools = new RuntimeToolBroker({ pluginTools: plugins, receipts: runs,
      localTools: { listTools: async () => [], invoke: async () => { throw new Error("No device fallback"); } },
      authorizeInvocation: (invocation) => access.authorizeInvocation(invocation) });
    const engine = new ExtensionInvocationEngine({ runs, resolvePluginTool: (id, name) => plugins.getToolDefinitions()
      .find((tool) => tool.pluginId === id && tool.name === name),
      engine: { id: "echo", async *streamTurn() { yield { type: "message.delta", delta: "ordinary chat" }; } } });
    const executor = createAgentExecutor({ runs, tools, engine, authorizeRun: (request) => access.authorizeRunExecution(request) });
    const profiles = new FileInteractionProfileStore();
    profiles.upsert({ id: "interactive.default", modelProfileId: "echo",
      policy: { preset: "read-only", allowedTools: ["native_echo"], fileRoots: [], maxToolCalls: 5 } });
    server = createRuntimeServer({ runs, executor, accessControl: access, interactionProfiles: profiles,
      capabilityTools: () => plugins.getToolDefinitions(), serviceInfo: { runtimePlugins: snapshot.plugins },
      pluginCommands: (id, args, context) => plugins.invokeCommand(id, args, context),
      pluginCommandRequiresSession: (id) => plugins.commandRequiresSession(id), pollIntervalMs: 5 });
    url = (await server.start()).url;
    config = join(root, "cli.json");
    await writeFile(config, JSON.stringify({ version: 1, profiles: { test: { url,
      auth: { type: "bearer", env: "NATIVE_TEST_TOKEN" } } } }), { mode: 0o600 });
  });
  afterAll(async () => {
    await server?.close(); await plugins?.stop(); await db?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const cli = async (...args) => {
    const result = await exec(process.execPath, [entry, "extensions", ...args, "--host", "runtime",
      "--runtime-profile", "test", "--jsonl"], { env: { ...process.env,
      ZION_RUNTIME_CLI_CONFIG: config, ZION_RUNTIME_PROFILE: "", NATIVE_TEST_TOKEN: token }, timeout: 10000 });
    return JSON.parse(result.stdout).value;
  };
  const post = async (path, body, authorization = token) => {
    const response = await fetch(url + path, { method: "POST", headers: { authorization: `Bearer ${authorization}`,
      "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  it("allows opted-in account commands before any Session or Run exists", async () => {
    expect(plugins.commandRequiresSession("fixture.account")).toBe(false);
    expect((await post("/v1/plugins/fixture.account/commands", { action: "status" })).body.result.sessionId).toBeNull();
    expect((await post("/v1/plugins/fixture.account/commands", { action: "connect", sessionId: "workbench-only" })).status).toBe(200);
    expect((await post("/v1/plugins/fixture.account/commands", { action: "connect" }, bobToken)).status).toBe(403);
  });
  it("keeps existing Session-required workflows strict", async () => {
    expect(plugins.commandRequiresSession("fixture.session")).toBe(true);
    expect((await post("/v1/plugins/fixture.session/commands", { action: "status" })).status).toBe(400);
    expect((await post("/v1/plugins/fixture.session/commands", { action: "status", sessionId: "missing" })).status).toBe(404);
  });
  it("lists the full native tool catalog and executes real CLI calls with durable receipts", async () => {
    const list = await cli("list");
    expect(list.find((plugin) => plugin.id === "fixture.account")).toMatchObject({ status: "active", tools: [{ name: "native_echo" }] });
    const result = await cli("call", "fixture.account", "--tool", "native_echo", "--args", '{"text":"CLI call"}');
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.output)).toMatchObject({ text: "CLI call", runId: result.runId });
    const rows = await db.pool.query("SELECT tool_name FROM runtime_tool_invocation_receipts WHERE run_id=$1", [result.runId]);
    expect(rows.rows.map((row) => row.tool_name)).toEqual(["native_echo"]);
  });
  it("executes the same installed tool through authenticated POST /v1/runs", async () => {
    const accepted = await post("/v1/runs", runtimePluginToolRequest("fixture.account", tool, { text: "API call" }));
    expect(accepted.status).toBe(202);
    const client = createRuntimeControlClient({ baseUrl: url, headers: { authorization: `Bearer ${token}` }, pollIntervalMs: 5 });
    const run = await client.followRun(accepted.body.runId, () => {});
    expect(run.status).toBe("completed");
    expect(JSON.parse(run.output).text).toBe("API call");
  });
  it("refuses wrong plugin ownership, invalid arguments, and narrowed capability policy", async () => {
    await expect(cli("call", "fixture.session", "--tool", "native_echo", "--args", '{"text":"x"}')).rejects.toMatchObject({ code: 1 });
    await expect(cli("call", "fixture.account", "--tool", "native_echo", "--args", '{"text":42}')).rejects.toMatchObject({ code: 1 });
    const client = createRuntimeControlClient({ baseUrl: url, headers: { authorization: `Bearer ${token}` }, pollIntervalMs: 5 });
    const input = runtimePluginToolRequest("fixture.account", tool, { text: "denied" });
    const accepted = await post("/v1/runs", { ...input, policy: { preset: "read-only", allowedTools: [] } });
    const result = await client.followRun(accepted.body.runId, () => {});
    expect(result.status).toBe("failed");
    const rows = await db.pool.query("SELECT tool_name FROM runtime_tool_invocation_receipts WHERE run_id=$1", [result.id]);
    expect(rows.rows).toHaveLength(0);
    const forged = await post("/v1/runs", { ...input, metadata: { pluginToolInvocation: { pluginId: "fixture.session", tool: "native_echo", arguments: { text: "forged" } } } });
    expect((await client.followRun(forged.body.runId, () => {})).status).toBe("failed");
  });
});
