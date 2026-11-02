import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentExecutor, CancellationController } from "../../../packages/runtime/src/index";
import { createPostgresTestDatabase, provisionTestTeam } from "./helpers/postgres-test-database.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { FileInteractionProfileStore } from "../src/interaction-profile-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createRuntimeControlClient } from "../src/runtime-cli.mjs";
import { NodeBroker } from "../src/node-broker.mjs";
import { RuntimeToolBroker } from "../src/runtime-tool-broker.mjs";
import { MarketplaceService } from "../src/marketplace/service.mjs";
import { createMemoryArtifactStore } from "../src/marketplace/artifact-store.mjs";
import { createMarketplaceHttpHandler } from "../src/marketplace/http-handler.mjs";
import { ExtensionExecutionService, withExtensionTools } from "../src/marketplace/execution-service.mjs";
import { ExtensionInvocationEngine } from "../src/marketplace/invocation-engine.mjs";
import { runExtensionsCli, parseExtensionsArgs } from "../src/extensions-cli.mjs";
import { normalizeExtensionPackage } from "../../../packages/runtime-client/src/extension-package.mjs";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
describe("account code plugins and MCP through normal Runs and Node dispatch", () => {
  let db, market, runs, root, owner, bob, grant, access, nodes, tools, service, server, url, headers, running, worker, dispatched;
  let dependencyPrepared = false;
  const policy = () => ({ preset: "trusted-automation", allowedTools: ["extensionsCall", "write", "Bash"],
    fileRoots: [root], allowedCommandPrefixes: [], allowedTerminalSessionIds: [], maxToolCalls: 10 });
  beforeAll(async () => {
    db = await createPostgresTestDatabase("extension_execution");
    owner = await provisionTestTeam(db, { spaceId: "space:extension-execution" });
    bob = await db.accounts.resolveIdentity({ issuer: "https://identity.test", subject: "bob" });
    root = await realpath(await mkdtemp(join(tmpdir(), "zioon-extension-node-")));
    market = await new MarketplaceService({ pool: db.pool, artifactStore: createMemoryArtifactStore(),
      defaultExecutionConfig: async () => ({ nodeId: "node:fixture", workspaceRoot: root }) }).initialize();
    runs = new PostgresRunStore(db.pool, { spaceId: "space:extension-execution" });
    access = new AccountAccessControl({ accounts: db.accounts, store: new PostgresAccessStore(db.pool, { spaceId: "space:extension-execution" }),
      servedSpaceId: "space:extension-execution", publicBaseUrl: "https://runtime.test", oidc: { secureCookies: true } });
    nodes = new NodeBroker();
    nodes.registerNode({ protocolVersion: 1, nodeId: "node:fixture", instanceId: "instance:fixture", label: "Test execution Node", platform: "darwin",
      capabilities: ["write", "Bash"].map((name) => ({ name, version: "1", inputSchema: { type: "object", additionalProperties: true }, hostKind: "local-tools", execution: { effect: name === "Bash" ? "process" : "write" } })),
      resources: [{ resourceId: "workspace:fixture", kind: "workspace", localRoot: root }] });
    service = new ExtensionExecutionService({ marketplace: market, tools: () => tools, allowNode: (node) => node === "node:fixture" });
    const plugins = withExtensionTools({ hasTool: () => false, supportedToolNames: [], getToolDefinitions: () => [], listTools: async () => [], invoke: () => { throw new Error("unsupported"); } }, service);
    tools = new RuntimeToolBroker({ localTools: nodes, pluginTools: plugins, receipts: runs, authorizeInvocation: async (input) => {
      const authorized = await access.authorizeInvocation(input);
      await plugins.authorizeInvocation(authorized);
      return authorized;
    } });
    const engine = new ExtensionInvocationEngine({ runs, engine: { id: "fixture", async *streamTurn() { yield { type: "message.delta", delta: "ordinary-chat" }; } } });
    const executor = createAgentExecutor({ runs, tools, engine, authorizeRun: (request) => access.authorizeRunExecution(request) });
    const profiles = new FileInteractionProfileStore();
    profiles.upsert({ id: "interactive.default", modelProfileId: "fixture", policy: policy() });
    server = createRuntimeServer({ executor, runs, accessControl: access, interactionProfiles: profiles,
      pluginCommandRequiresSession: () => false,
      pluginCommands: async (id, args, context) => context.invokeToolRun(await service.commandOperation(id, args, context.principal)),
      serviceHttpHandlers: [createMarketplaceHttpHandler({ service: market })], pollIntervalMs: 5 });
    url = (await server.start()).url;
    const session = await db.accounts.createSession(owner.id, { activeSpaceId: "space:extension-execution" });
    headers = { authorization: `Bearer ${session.token}` };
    running = true;
    dispatched = [];
    worker = (async () => {
      const active = new Map(), completions = new Set();
      while (running) {
        const command = await nodes.nextCommand("node:fixture", "instance:fixture", 50);
        if (!command) continue;
        if (command.type === "tool.cancel") { active.get(command.invocationId)?.abort(); continue; }
        if (command.type !== "tool.invoke") continue;
        const controller = new AbortController();
        active.set(command.invocationId, controller);
        const completion = (async () => {
        dispatched.push(command.invocation);
        const { name, arguments: args } = command.invocation.toolCall;
        let result;
        try {
          if (name === "write") { await mkdir(join(args.path, ".."), { recursive: true }); await writeFile(args.path, args.content); result = { ok: true, content: "written" }; }
          else {
            const output = await exec("/bin/sh", ["-c", args.command], { timeout: args.timeout || 60000, maxBuffer: 150000, signal: controller.signal });
            result = { ok: true, content: JSON.stringify(output) };
          }
        } catch (error) { result = { ok: false, content: error.stdout || error.message, failureCode: error.killed ? "execution_outcome_unknown" : "tool_error", retryable: false }; }
        try { nodes.completeInvocation("node:fixture", "instance:fixture", command.invocationId, result); }
        catch (error) { if (!controller.signal.aborted || error.statusCode !== 404) throw error; }
        })().finally(() => { active.delete(command.invocationId); completions.delete(completion); });
        completions.add(completion);
      }
      await Promise.all(completions);
    })();
  }, 30000);
  beforeEach(async () => {
    await db.pool.query("TRUNCATE marketplace_accounts,marketplace_private_releases");
    grant = await db.accounts.issueGrant(owner.id, policy(), { spaceId: "space:extension-execution" });
  });
  afterAll(async () => {
    running = false; await worker; nodes?.close(); await server?.close(); await db?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const cli = async (...argv) => {
    let output = "";
    return await runExtensionsCli({ parsed: parseExtensionsArgs(argv), output: { write: (value) => { output += value; } },
      baseUrl: url, headers, controlClient: createRuntimeControlClient({ baseUrl: url, headers, pollIntervalMs: 5 }), defaultProfile: "interactive.default" });
  };
  async function install(input) {
    const artifact = normalizeExtensionPackage(input);
    const uploaded = await market.uploadPrivate(owner.id, "Owner", { artifact, expectedRevision: (await market.account(owner.id)).revision });
    const added = await market.install(owner.id, uploaded.release.id, { version: artifact.manifest.version, digest: uploaded.release.digest });
    if (artifact.kind !== "skill") await cli("configure", uploaded.release.id, "--node", "node:fixture", "--root", root);
    return { id: uploaded.release.id, artifact, added };
  }
  const manifest = (slug, version = "0.1.0") => ({ slug, name: slug, summary: "Fixture", version, category: "开发", license: "MIT" });
  const plugin = (version = "0.1.0", code) => ({ schemaVersion: 1, kind: "plugin", manifest: manifest("code-fixture", version),
    plugin: { id: "code-fixture", version, entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 } },
    files: { "runtime.mjs": code || `export function activateRuntimePlugin(context) {
      context.tools.registerTool({ name: "hello", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
        async invoke(args) { return { ok: true, content: "Hello " + args.name }; } }); return {};
    }` } });
  const stdio = () => ({ schemaVersion: 1, kind: "mcp", manifest: manifest("stdio-fixture"),
    mcp: { transport: "stdio", command: process.execPath, args: ["server.mjs"], envKeys: ["TEST_SECRET"] },
    files: { "server.mjs": `import { createInterface } from "node:readline";
      for await (const line of createInterface({ input: process.stdin })) {
        const r = JSON.parse(line); if (r.id === undefined) continue;
        const result = r.method === "initialize" ? { protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }
          : r.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }] }
          : r.method === "tools/call" ? { content: [{ type: "text", text: r.params.arguments.name + ":" + process.env.TEST_SECRET + ":" + String(process.env.ZION_DATABASE_URL) }] } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\\n");
      }` } });
  it("scaffolds and packs all three kinds offline with deterministic digests", async () => {
    for (const kind of ["skill", "plugin", "mcp"]) {
      const directory = join(root, `offline-${kind}`);
      await cli("init", directory, "--kind", kind);
      const validation = await cli("validate", directory);
      const packed = join(root, `packed-${kind}.json`);
      expect((await cli("pack", directory, "--out", packed)).digest).toBe(validation.digest);
      expect(normalizeExtensionPackage(JSON.parse(await readFile(packed, "utf8"))).kind).toBe(kind);
    }
  });
  it("discovers and calls real SDK code through HTTP CLI Runs with durable nested receipts", async () => {
    const { id } = await install(plugin());
    expect((await cli("status", id))[0].status).toBe("validation_required");
    const probed = await cli("probe", id);
    expect(probed.status).toBe("completed");
    expect((await cli("status", id))[0].components[0].tools[0].name).toBe("hello");
    const called = await cli("call", id, "--tool", "hello", "--args", '{"name":"Zioon"}');
    expect(called.output).toContain("Hello Zioon");
    const rows = await db.pool.query("SELECT invocation_id,tool_name FROM runtime_tool_invocation_receipts WHERE run_id=$1", [called.runId]);
    expect(rows.rows.some((r) => r.tool_name === "extensionsCall")).toBe(true);
    const receipts = new Set(rows.rows.map((r) => r.invocation_id));
    for (const invocation of dispatched.filter((i) => i.runId === called.runId)) expect(receipts.has(invocation.invocationId)).toBe(true);
    expect(dispatched.every((invocation) => invocation.principal.userId === owner.id && invocation.policy.preset === "trusted-automation")).toBe(true);
    await expect(cli("call", id, "--tool", "hello", "--args", '{"name":42}')).rejects.toMatchObject({ code: "extension_run_failed" });
  }, 15000);
  it("dispatches installed Workbench commands through admitted Runs and durable tool receipts", async () => {
    const { id } = await install(plugin("0.1.0", `export function activateRuntimePlugin(c){
      let count=0; c.runs.registerCommands((args,ctx)=>({count:++count,action:args.action,
        grantVisible:!!ctx.request?.principal?.grantId}));return {};
    }`));
    const command = async () => {
      const installed = (await market.account(owner.id)).installations[id];
      const response = await fetch(`${url}/v1/plugins/code-fixture/commands`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect", installationDigest: installed.activeRevision?.digest || installed.digest,
          installationEpoch: installed.executionEpoch })
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect((await command()).result).toEqual({ count: 1, action: "inspect", grantVisible: false });
    expect((await command()).result.count).toBe(2);
    const rows = (await db.pool.query(`SELECT result_json FROM runtime_tool_invocation_receipts
      WHERE tool_name='extensionsCall'`)).rows;
    expect(rows.some((row) => row.result_json.content.includes(id) && row.result_json.content.includes("inspect"))).toBe(true);
  });
  it("edits persistent account files and atomically switches OSS content without changing the source install", async () => {
    const { id } = await install(plugin());
    const original = (await market.account(owner.id)).installations[id];
    const files = JSON.parse((await cli("files", id)).output);
    expect(files.files["runtime.mjs"]).toContain("Hello ");
    const changed = files.files["runtime.mjs"].replace("Hello ", "Personal ");
    const local = join(root, "personal.mjs");
    await writeFile(local, changed);
    const saved = JSON.parse((await cli("write", id, "--path", "runtime.mjs", "--file", local, "--source-hash", files.hash)).output);
    expect(saved.hash).not.toBe(files.hash);
    // Original executable remains fixed until an explicit successful reload.
    expect((await cli("call", id, "--tool", "hello", "--args", '{"name":"before"}')).output).toContain("Hello before");
    const activated = JSON.parse((await cli("reload", id, "--source-hash", saved.hash)).output);
    const active = (await market.account(owner.id)).installations[id];
    expect(active.version).toBe(original.version);
    expect(active.digest).toBe(original.digest);
    expect(active.executionEpoch).not.toBe(original.executionEpoch);
    expect(active.activeRevision.release.contentRef).toBeTruthy();
    expect(JSON.stringify(active)).not.toContain(changed);
    expect(activated.installation.activeRevision.digest).toBe(active.activeRevision.digest);
    expect((await cli("call", id, "--tool", "hello", "--args", '{"name":"after"}')).output).toContain("Personal after");
    expect((await market.snapshot(owner.id)).entries.filter((e) => e.id === id)).toHaveLength(1);
    expect((await market.snapshot(bob.id)).entries.some((e) => e.installation?.activeRevision)).toBe(false);
    await expect(market.installationRevisionFor(bob.id, id, active.activeRevision.digest)).rejects.toMatchObject({ code: "installation_not_found" });
    // Restarting the service leaves editable source and the active OSS revision intact.
    const restarted = await new MarketplaceService({ pool: db.pool, artifactStore: market.artifactStore }).initialize();
    expect((await restarted.executionFor(owner.id, id)).artifact.files["runtime.mjs"]).toBe(changed);
    expect((JSON.parse((await cli("files", id)).output)).files["runtime.mjs"]).toBe(changed);
    await cli("restore", id);
    expect((await cli("call", id, "--tool", "hello", "--args", '{"name":"restored"}')).output).toContain("Hello restored");
    expect((JSON.parse((await cli("files", id)).output)).files["runtime.mjs"]).toBe(changed);
    const receipts = (await db.pool.query("SELECT tool_name FROM runtime_tool_invocation_receipts WHERE run_id IN (SELECT id FROM runtime_runs)")).rows;
    expect(receipts.some((r) => r.tool_name === "extensionsCall")).toBe(true);
    expect(receipts.some((r) => r.tool_name === "Bash")).toBe(true);
  }, 30000);
  it("keeps the prior executable on failed reload, rejects stale writes and fences old UI commands", async () => {
    const { id } = await install(plugin("0.1.0", `export function activateRuntimePlugin(c){ c.runs.registerCommands(() => ({value:"original"})); return {}; }`));
    const original = (await market.account(owner.id)).installations[id];
    const files = JSON.parse((await cli("files", id)).output);
    const local = join(root, "invalid.mjs");
    await writeFile(local, "export function broken( {");
    const saved = JSON.parse((await cli("write", id, "--path", "runtime.mjs", "--file", local, "--source-hash", files.hash)).output);
    await expect(cli("reload", id)).rejects.toMatchObject({ code: "extension_run_failed" });
    expect((await market.account(owner.id)).installations[id].executionEpoch).toBe(original.executionEpoch);
    await expect(cli("write", id, "--path", "runtime.mjs", "--file", local, "--source-hash", files.hash)).rejects.toMatchObject({ code: "extension_run_failed" });
    await writeFile(local, `export function activateRuntimePlugin(c){ c.runs.registerCommands(() => ({value:"personal"})); return {}; }`);
    await cli("write", id, "--path", "runtime.mjs", "--file", local, "--source-hash", saved.hash);
    await cli("reload", id);
    await expect(service.commandOperation("code-fixture", { installationDigest: original.digest,
      installationEpoch: original.executionEpoch }, grant)).rejects.toMatchObject({ code: "extension_ui_changed" });
    const active = (await market.account(owner.id)).installations[id];
    expect(await service.commandOperation("code-fixture", { installationDigest: active.activeRevision.digest,
      installationEpoch: active.executionEpoch, action: "test" }, grant)).toMatchObject({ action: "command", epoch: active.executionEpoch });
    const source = await market.releaseFor(owner.id, id, "0.1.0", { content: true });
    expect(source.artifact.files["runtime.mjs"]).toContain('value:"original"');
  }, 30000);
  it("supports full Skill packages and official Skill bundles, and does not overwrite edits on updates", async () => {
    const skill = normalizeExtensionPackage({ schemaVersion: 1, kind: "skill", manifest: manifest("skill-files"),
      body: "---\nname: skill-files\ndescription: Test\n---\nOriginal", files: {
        "references/guide.md": "Original guide", "scripts/check.py": "print('ok')\n"
      } });
    const { id } = await install(skill);
    let files = JSON.parse((await cli("files", id)).output);
    expect(files.files["scripts/check.py"]).toContain("print");
    const local = join(root, "edited-skill.md");
    await writeFile(local, skill.body.replace("Original", "Personal"));
    await cli("write", id, "--path", "SKILL.md", "--file", local, "--source-hash", files.hash);
    await cli("reload", id);
    const effectiveSkill = (await market.skillsFor({ principal: grant })).catalog.find((s) => s.pluginId === id);
    expect(effectiveSkill.body).toContain("Personal");
    expect(effectiveSkill.sourcePath).toContain(".zion/installed");
    expect(await market.skillFileFor({ principal: grant }, effectiveSkill.id, "references/guide.md",
      effectiveSkill.contentHash)).toMatchObject({ content: "Original guide" });
    await expect(market.skillFileFor({ principal: grant }, effectiveSkill.id, "references/guide.md", "stale"))
      .rejects.toMatchObject({ code: "extension_changed" });
    await expect(market.skillFileFor({ principal: { userId: bob.id } }, effectiveSkill.id, "references/guide.md"))
      .rejects.toMatchObject({ code: "skill_not_found" });
    const snapshot = await market.snapshot(owner.id);
    const official = snapshot.entries.find((e) => !e.artifact && e.components.some((c) => c.kind === "skill"));
    await market.install(owner.id, official.id, { version: official.version, digest: official.digest });
    // Older accounts may not have a Skill config yet; preparation chooses the supplied account default.
    market.defaultExecutionConfig = async () => ({ nodeId: "node:fixture", workspaceRoot: root });
    files = JSON.parse((await cli("files", official.id)).output);
    const path = Object.keys(files.files).find((name) => name.endsWith("/SKILL.md"));
    await writeFile(local, files.files[path] + "\n\nPersonal bundle instruction");
    await cli("write", official.id, "--path", path, "--file", local, "--source-hash", files.hash);
    await cli("reload", official.id);
    expect((await market.skillsFor({ principal: grant })).catalog.some((s) => s.body.includes("Personal bundle instruction"))).toBe(true);
    const next = normalizeExtensionPackage({ ...skill, digest: undefined, manifest: { ...skill.manifest, version: "0.2.0" } });
    const uploaded = await market.uploadPrivate(owner.id, "Owner", { artifact: next, expectedRevision: (await market.account(owner.id)).revision });
    await expect(market.install(owner.id, id, { version: "0.2.0", digest: uploaded.release.digest })).rejects.toMatchObject({ code: "installation_workspace_exists" });
    const oldDirectory = (await market.account(owner.id)).installations[id].workspace.directory;
    await market.install(owner.id, id, { version: "0.2.0", digest: uploaded.release.digest, discardWorkspace: true });
    expect(await readFile(join(oldDirectory, "SKILL.md"), "utf8")).toContain("Personal");
  }, 30000);
  it("rejects traversal, credentials and symlink escapes before reading personal files", async () => {
    const { id } = await install(plugin());
    const files = JSON.parse((await cli("files", id)).output);
    await expect(cli("read", id, "--path", "../runtime.env")).rejects.toMatchObject({ code: "extension_run_failed" });
    await expect(cli("read", id, "--path", "credentials.json")).rejects.toMatchObject({ code: "extension_run_failed" });
    await symlink(join(root, "packed-skill.json"), join(files.directory, "outside.json"));
    await expect(cli("files", id)).rejects.toMatchObject({ code: "extension_run_failed" });
    await rm(join(files.directory, "outside.json"));
    const local = join(root, "temporary.mjs"); await writeFile(local, "test");
    await expect(cli("write", id, "--path", ".env.json", "--file", local, "--source-hash", files.hash)).rejects.toMatchObject({ code: "extension_run_failed" });
  }, 15000);
  it("isolates accounts and invalidates validation on version, config or enable changes", async () => {
    const { id } = await install(plugin());
    await cli("probe", id);
    await expect(market.executionFor(bob.id, id)).rejects.toMatchObject({ code: "extension_disabled" });
    const epoch = (await market.account(owner.id)).installations[id].executionEpoch;
    await cli("configure", id, "--node", "node:fixture", "--root", root);
    await expect(market.executionFor(owner.id, id, epoch)).rejects.toMatchObject({ code: "extension_changed" });
    expect((await cli("call", id, "--tool", "hello", "--args", '{"name":"x"}')).output).toContain("Hello x");
    await cli("probe", id); await cli("disable", id); await cli("enable", id);
    expect((await cli("status", id))[0].status).toBe("validation_required");
    await install(plugin("0.2.0"));
    expect((await cli("status", id))[0].status).toBe("validation_required");
  }, 15000);
  it("rejects platform Nodes, narrowed grants, revoked receipts and unsupported SDK hooks", async () => {
    const { id } = await install(plugin());
    const context = { runId: "fixture:security", invocationId: "fixture:invocation", principal: grant, policy: policy(), signal: new CancellationController().signal };
    await market.configure(owner.id, id, { expectedRevision: (await market.account(owner.id)).revision, config: { nodeId: "node:cloud-runtime", workspaceRoot: root } });
    await expect(service.invoke({ action: "probe", listingId: id }, context)).rejects.toMatchObject({ code: "extension_node_denied" });
    await cli("configure", id, "--node", "node:fixture", "--root", root);
    await expect(service.invoke({ action: "probe", listingId: id }, { ...context, policy: { ...policy(), preset: "read-only" } })).rejects.toMatchObject({ code: "extension_policy_denied" });
    const probed = await cli("probe", id);
    const run = await runs.get(probed.runId);
    const invocation = { ...context, runId: run.id, invocationId: `${run.id}:turn:1:tool:0`, principal: run.principal,
      toolCall: { id: "replay", name: "extensionsCall", arguments: run.metadata.extensionInvocation } };
    expect((await tools.invoke(invocation, context.signal)).ok).toBe(true);
    await db.accounts.revokeGrant(owner.id, run.principal.grantId);
    await expect(tools.invoke(invocation, context.signal)).rejects.toThrow("grant_inactive");
    await install(plugin("0.3.0", "export function activateRuntimePlugin(c) { c.context.registerProvider({ id: 'unsupported' }); }"));
    await expect(cli("probe", id)).rejects.toMatchObject({ code: "extension_run_failed" });
  }, 15000);
  it("uses actual MCP stdio handshake and calls without leaking Node secrets or Runtime env", async () => {
    const { id } = await install(stdio());
    const secret = 'fixture-secret-"quoted"\\private';
    const path = join(root, "stdio-credentials.json");
    await writeFile(path, JSON.stringify({ listingId: id, env: { TEST_SECRET: secret } }), { mode: 0o600 });
    await cli("configure", id, "--node", "node:fixture", "--root", root, "--credentials-file", path);
    await cli("probe", id);
    dependencyPrepared = true;
    const called = await cli("call", id, "--tool", "echo", "--args", '{"name":"MCP"}');
    expect(called.output).toContain("MCP:[redacted]:undefined");
    expect(called.output).not.toContain(secret);
    expect(JSON.stringify(await market.snapshot(owner.id))).not.toContain(secret);
    const stored = await db.pool.query("SELECT result_json FROM runtime_tool_invocation_receipts WHERE run_id=$1", [called.runId]);
    expect(JSON.stringify(stored.rows)).not.toContain(secret);
  }, 90000);
  it("uses Streamable HTTP MCP with exact origin credentials and rejects redirects", async () => {
    expect(dependencyPrepared).toBe(true);
    let observedAuth, redirect = false, leaked = 0;
    const endpoint = createServer(async (req, res) => {
      if (req.url === "/leak") { leaked++; res.writeHead(500); res.end(); return; }
      if (redirect) { res.writeHead(307, { location: "/leak" }); res.end(); return; }
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      let text = ""; for await (const chunk of req) text += chunk;
      const request = JSON.parse(text);
      observedAuth = req.headers.authorization;
      if (request.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = request.method === "initialize" ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1.0.0" } }
        : request.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object", additionalProperties: true } }] }
          : { content: [{ type: "text", text: observedAuth }] };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${endpoint.address().port}/mcp`;
    try {
      const { id } = await install({ schemaVersion: 1, kind: "mcp", manifest: manifest("http-fixture"), mcp: { transport: "http", endpoint: address } });
      const path = join(root, "http-credentials.json");
      await writeFile(path, JSON.stringify({ listingId: id, endpoint: address, headers: { authorization: "Bearer secret-fixture" } }), { mode: 0o600 });
      await cli("configure", id, "--node", "node:fixture", "--root", root, "--credentials-file", path);
      await cli("probe", id);
      expect(observedAuth).toBe("Bearer secret-fixture");
      expect((await cli("call", id, "--tool", "echo", "--args", "{}")).output).toContain("[redacted]");
      redirect = true;
      await expect(cli("probe", id)).rejects.toMatchObject({ code: "extension_run_failed" });
      expect(leaked).toBe(0);
      expect((await cli("status", id))[0].status).toBe("validation_required");
      redirect = false;
      await writeFile(path, JSON.stringify({ listingId: id, endpoint: address + "/wrong", headers: { authorization: "Bearer secret-fixture" } }));
      await expect(cli("probe", id)).rejects.toMatchObject({ code: "extension_run_failed" });
    } finally { await new Promise((resolve) => { endpoint.close(resolve); endpoint.closeAllConnections(); }); }
  }, 15000);
  it("cancels a stale in-flight probe and never marks its tools ready", async () => {
    const { id } = await install(plugin("0.5.0", `export async function activateRuntimePlugin(c) {
      await new Promise(r => setTimeout(r, 2000));
      c.tools.registerTool({ name: "late", inputSchema: { type: "object" }, async invoke() { return "late"; } });
    }`));
    const initial = dispatched.length;
    const operation = cli("probe", id).catch((error) => error);
    await vi.waitFor(() => expect(dispatched.slice(initial).some((i) => i.toolCall.name === "Bash")).toBe(true));
    await cli("configure", id, "--node", "node:fixture", "--root", root);
    expect(await operation).toMatchObject({ code: "extension_run_failed" });
    expect((await cli("status", id))[0].status).toBe("validation_required");
    const receipts = await db.pool.query("SELECT result_json FROM runtime_tool_invocation_receipts WHERE tool_name='Bash' ORDER BY completed_at DESC LIMIT 1");
    expect(receipts.rows[0].result_json.failureCode).toBe("execution_outcome_unknown");
  }, 10000);
  it("persists unknown outcomes and blocks the same call under a new invocation ID", async () => {
    const { id } = await install(plugin("0.6.0", `
      export function activateRuntimePlugin(c) { c.tools.registerTool({ name: "mutate", inputSchema: { type: "object" },
        async invoke() { let text = ""; try { text = await c.data.read("effects.txt"); } catch {}
          await c.data.write("effects.txt", text + "effect\\n"); throw new Error("lost-result"); } }); }`));
    const hash = (v) => createHash("sha256").update(v).digest("hex");
    const effects = join(root, ".zion", "plugin-data", ".account-extensions", hash(owner.id), hash(id), "effects.txt");
    await cli("probe", id);
    const failed = await cli("call", id, "--tool", "mutate", "--args", "{}").catch((error) => error);
    expect(failed).toMatchObject({ code: "extension_run_failed" });
    const run = await runs.get(failed.runId);
    const count = dispatched.length;
    const result = await tools.invoke({ runId: run.id, attemptId: "retry", invocationId: `${run.id}:retry`, principal: run.principal, policy: run.policy,
      toolCall: { id: "retry", name: "extensionsCall", arguments: run.metadata.extensionInvocation } }, new CancellationController().signal);
    expect(result).toMatchObject({ ok: false, failureCode: "execution_outcome_unknown", retryable: false });
    expect(dispatched.length).toBe(count);
    expect(await readFile(effects, "utf8")).toBe("effect\n");
  }, 10000);
  it("rejects traversal, tampering, packaged secrets and host-file symlinks", async () => {
    expect(() => normalizeExtensionPackage({ ...plugin(), files: { "../escape.mjs": "code" } })).toThrow();
    expect(() => normalizeExtensionPackage({ ...plugin(), files: { "runtime.mjs": "code", ".env.json": '{"secret":"bad"}' } })).toThrow();
    const input = normalizeExtensionPackage(plugin());
    expect(() => normalizeExtensionPackage({ ...input, files: { "runtime.mjs": "changed" } })).toThrow("digest");
    const directory = join(root, "symlink-plugin");
    await cli("init", directory, "--kind", "plugin");
    await symlink(join(directory, "runtime.mjs"), join(directory, "other.mjs"));
    await expect(cli("validate", directory)).rejects.toThrow("symlinks");
  });
});
