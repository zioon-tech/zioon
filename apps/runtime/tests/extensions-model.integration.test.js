import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresAccountStore } from "../src/accounts/postgres-account-store.mjs";
import { initializePostgresRuntimeSchema } from "../src/postgres-runtime-schema.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { MarketplaceService } from "../src/marketplace/service.mjs";
import { createMemoryArtifactStore } from "../src/marketplace/artifact-store.mjs";
import { ExtensionExecutionService } from "../src/marketplace/execution-service.mjs";
import { ExtensionHostBridge } from "../src/marketplace/host-bridge.mjs";
import { AccountExtensionModelCatalog, AccountExtensionModelEngine } from "../src/marketplace/model-engine.mjs";
import { ExtensionHost } from "../../device-connector/src/extension-host.mjs";
import { normalizeExtensionPackage } from "../../../packages/runtime-client/src/extension-package.mjs";
import { createAgentExecutor } from "../../../packages/runtime/dist/index.js";
import { DeviceConnector } from "../../device-connector/src/device-connector.mjs";
import { NodeBroker } from "../src/node-broker.mjs";
import { createNodeHttpHandler } from "../src/node-http-handler.mjs";
import { EXTENSION_HOST_CAPABILITY } from "../../../packages/plugin-sdk/src/host-contract.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { AccountModelSelection, createModelManagementPluginService } from "../src/marketplace/model-selection.mjs";
import { FileInteractionProfileStore } from "../src/interaction-profile-store.mjs";
import { activateRuntimePlugin as activateModelManagement } from "../../../extensions/dev.langchain-chat/runtime.js";

const suite = process.env.ZION_TEST_POSTGRES_URL ? describe : describe.skip;
const schema = `extension_model_${randomBytes(8).toString("hex")}`, resources = [];
suite("account model providers through isolated Node transport", () => {
  let admin, pool, alice, bob, space, marketplace;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.ZION_TEST_POSTGRES_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.ZION_TEST_POSTGRES_URL, max: 8, options: `-c search_path=${schema}` });
    const accounts = await new PostgresAccountStore({ pool }).initialize();
    alice = await accounts.resolveIdentity({ issuer: "https://fixture.test", subject: "alice" });
    bob = await accounts.resolveIdentity({ issuer: "https://fixture.test", subject: "bob" });
    [space] = await accounts.listSpaces(alice.id);
    await initializePostgresRuntimeSchema(pool);
    marketplace = await new MarketplaceService({ pool, artifactStore: createMemoryArtifactStore() }).initialize();
  });
  afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  async function fixture(respond, streaming = false, outbound = false) {
    const root = await mkdtemp(join(tmpdir(), "zioon-model-"));
    resources.push(() => rm(root, { recursive: true, force: true }));
    const requests = [];
    const upstream = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      requests.push({ input, authorization: req.headers.authorization });
      respond(input, res, req, requests.length);
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    resources.push(() => new Promise((r) => { upstream.closeAllConnections(); upstream.close(r); }));
    const url = `http://127.0.0.1:${upstream.address().port}`;
    const slug = `model-${randomBytes(6).toString("hex")}`;
    const models = [{ id: "local", name: "内网模型", supportsStreaming: streaming, supportsTools: true, contextWindow: 32000 }];
    const artifact = normalizeExtensionPackage({ schemaVersion: 1, kind: "plugin",
      manifest: { slug, name: "Model", summary: "fixture", version: "0.1.0", category: "开发", license: "MIT" },
      plugin: { id: slug, version: "0.1.0", entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 },
        capabilities: [{ id: "relay", kind: "model", host: "runtime", models }] },
      files: { "runtime.mjs": `export function activateRuntimePlugin(c) {
        c.models.registerProvider({id:"relay",models:${JSON.stringify(models)},request(input,ctx){
          return fetch(${JSON.stringify(url)},{method:"POST",headers:{"content-type":"application/json",...c.credentials.headers},
            body:JSON.stringify(input),redirect:"error",signal:ctx.abortSignal});}}); return {};
      }` } });
    const upload = await marketplace.uploadPrivate(alice.id, "Alice", { artifact, expectedRevision: (await marketplace.account(alice.id)).revision });
    const listingId = upload.release.id;
    await marketplace.install(alice.id, listingId, { version: artifact.manifest.version, digest: upload.release.digest });
    const credentialsFile = join(root, "connection.json");
    await writeFile(credentialsFile, JSON.stringify({ listingId, accountId: alice.id, headers: { authorization: "Bearer node-only-secret" } }), { mode: 0o600 });
    await marketplace.configure(alice.id, listingId, { expectedRevision: (await marketplace.account(alice.id)).revision,
      config: { nodeId: "node:intranet", workspaceRoot: root, credentialsFile } });
    resources.push(async () => {
      await marketplace.change(alice.id, listingId, { expectedRevision: (await marketplace.account(alice.id)).revision }, true);
    });
    const host = new ExtensionHost();
    resources.push(() => host.close());
    let nativeInvoke = (inv, signal) => host.invoke(inv.toolCall.arguments, signal, inv);
    let broker, connector;
    if (outbound) {
      broker = new NodeBroker();
      const handler = createNodeHttpHandler({ broker, token: "fixture", maxWaitMs: 30 });
      const server = createServer((req, res) => handler(req, res, new URL(req.url, `http://${req.headers.host}`)));
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      connector = new DeviceConnector({
        runtimeUrl: `http://127.0.0.1:${server.address().port}`, token: "fixture",
        registration: { protocolVersion: 1, nodeId: "node:intranet", instanceId: "instance:model",
          capabilities: [EXTENSION_HOST_CAPABILITY], resources: [{ resourceId: "workspace:model", kind: "workspace" }] },
        toolHost: { invoke() { throw new Error("Model Node must not execute Run Bash"); } },
        extensionHost: host, pollWaitMs: 10, retryDelayMs: 5
      });
      resources.push(async () => { await connector.stop(); broker.close(); await new Promise((r) => server.close(r)); });
      await connector.start();
      nativeInvoke = (inv, signal) => broker.invoke(inv, signal);
    }
    const bridge = new ExtensionHostBridge({ tools: () => { throw new Error("No platform shell fallback"); }, hasNativeHost: () => true, nativeInvoke });
    const execution = new ExtensionExecutionService({ marketplace, hostBridge: bridge, allowNode: (id) => id === "node:intranet" });
    const runs = new PostgresRunStore(pool, { spaceId: space.id });
    const catalog = new AccountExtensionModelCatalog({ marketplace });
    let authorized = true;
    const engine = new AccountExtensionModelEngine({ engine: { id: "builtin", async *streamTurn() { throw new Error("No builtin fallback"); } },
      runs, execution, catalog, authorize: () => { if (!authorized) throw Object.assign(new Error("grant_revoked"), { code: "grant_revoked" }); } });
    const principal = { userId: alice.id, spaceId: space.id, grantId: "private-grant" };
    const selected = (await catalog.list(principal)).find((p) => p.extension.listingId === listingId);
    const request = { prompt: "你好", principal, target: { nodeId: "managed:sandbox" },
      model: await catalog.resolve({ profileId: selected.id }, principal),
      policy: { preset: "trusted-automation", allowedTools: ["read", "write", "Bash"], fileRoots: [root], maxToolCalls: 5 } };
    const executor = (tools = { listTools: async () => [], invoke: async () => { throw new Error("Unexpected tool"); } }) =>
      createAgentExecutor({ engine, runs, tools, bindRun: (r, c) => engine.prepare(r, c) });
    const run = (input = request, tools) => executor(tools).execute(input);
    return { run, executor, request, requests, host, runs, catalog, listingId, broker, connector, revoke() { authorized = false; } };
  }
  const jsonResponse = (res, content = "你好") => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
  };
  it("discovers without waking a Node, hides another account, and uses non-streaming JSON/usage with Node-only credentials", async () => {
    const f = await fixture((_, res) => jsonResponse(res), false, true);
    expect(f.host.workers.size).toBe(0);
    expect(await f.catalog.list({ userId: bob.id })).toEqual([]);
    await expect(f.catalog.resolve(f.request.model, { userId: bob.id })).rejects.toMatchObject({ code: "extension_model_unavailable" });
    const handle = f.run();
    const result = await handle.completion;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("你好");
    expect(result.usage.inputTokens).toBe(7);
    expect(f.requests[0].input.stream).toBe(false);
    expect(f.requests[0].input.stream_options).toBeUndefined();
    expect(f.requests[0].authorization).toBe("Bearer node-only-secret");
    const record = await f.runs.get(handle.runId);
    expect(record.target.nodeId).toBe("managed:sandbox");
    expect(record.metadata.extensionModelPlan.listingId).toBe(f.listingId);
    expect(JSON.stringify(await f.runs.getEvents(handle.runId))).not.toContain("node-only-secret");
  }, 15000);
  it("previews an account model request without persisting a Run or contacting the execution Node", async () => {
    const f = await fixture((_, res) => jsonResponse(res), false, true);
    const preview = await f.executor().preview(f.request);
    expect(preview.request.modelId).toBe("local");
    expect(preview.request.payload.stream).toBe(false);
    expect(f.host.workers.size).toBe(0);
    expect(f.requests).toEqual([]);
    expect(await f.runs.get(preview.runId)).toBeNull();
  });
  it("uses the invocation account in trusted asynchronous modelsManage discovery and selection", async () => {
    const f = await fixture((_, res) => jsonResponse(res));
    const profiles = new FileInteractionProfileStore();
    profiles.upsert({ id: "interactive.default", modelProfileId: "builtin", policy: f.request.policy });
    const listProfiles = async (principal) => [{
      id: "builtin", providerId: "builtin", model: "builtin", credentialConfigured: true
    }, ...await f.catalog.list(principal)];
    const selection = new AccountModelSelection({ marketplace, listProfiles, interactionProfiles: profiles,
      resolveModel: (value, principal) => value.profileId === "builtin" ? value : f.catalog.resolve(value, principal) });
    const modelService = createModelManagementPluginService({ listProfiles, selection });
    let tool;
    activateModelManagement({ config: { modelService }, tools: { registerTool(value) {
      tool = value; return { dispose() {} };
    } } });
    const visible = await tool.invoke({ action: "list" }, { principal: f.request.principal });
    expect(JSON.parse(visible.content).models.some((model) => model.profileId === f.request.model.profileId)).toBe(true);
    const hidden = await tool.invoke({ action: "list" }, { principal: { userId: bob.id } });
    expect(JSON.parse(hidden.content).models.some((model) => model.profileId === f.request.model.profileId)).toBe(false);
    const active = await tool.invoke({ action: "set_active", provider_id: f.request.model.providerId, model_id: "local" },
      { principal: f.request.principal });
    expect(active.ok).toBe(true);
    expect((await selection.get(f.request.principal)).modelProfileId).toBe(f.request.model.profileId);
    expect(profiles.get("interactive.default").modelProfileId).toBe("builtin");
    expect(f.host.workers.size).toBe(0);
  });
  it("rejects a JSON response without a model completion", async () => {
    const f = await fixture((_, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"choices":[]}'); });
    const result = await f.run().completion;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no completion choice");
  });
  it("resumes a failed model request through HTTP using its original pinned model plan", async () => {
    const f = await fixture((_, res, _request, turn) => {
      if (turn === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "recover-read", type: "function", function: { name: "read", arguments: "{}" }
        }] }, finish_reason: "tool_calls" }] }));
      } else if (turn === 2) {
        res.writeHead(200, { "content-type": "application/json" }); res.end('{"choices":[]}');
      } else jsonResponse(res, "recovered");
    });
    const handle = f.run(f.request, { listTools: async () => [{ name: "read", inputSchema: { type: "object" } }],
      invoke: async () => ({ ok: true, content: "read complete" }) });
    expect((await handle.completion).status).toBe("failed");
    const previous = await f.runs.get(handle.runId);
    expect(await f.runs.getLatestCheckpoint(handle.runId)).toBeTruthy();
    const runtime = createRuntimeServer({ executor: f.executor(), runs: f.runs,
      serviceInfo: { modelProfile: { id: "new-default", providerId: "builtin", model: "other" } },
      accessControl: { authorizeRuntimeRequest: async () => f.request.principal } });
    const { url } = await runtime.start();
    resources.push(() => runtime.close());
    const resumed = await fetch(`${url}/v1/runs/${handle.runId}/resume`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    expect(resumed.status, await resumed.clone().text()).toBe(202);
    for (let i = 0; i < 100; i++) {
      const current = await f.runs.get(handle.runId);
      if (current.attemptId !== previous.attemptId && current.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const current = await f.runs.get(handle.runId);
    expect(current.status).toBe("completed");
    expect(current.output).toBe("recovered");
    expect(current.model).toEqual(previous.model);
    expect(current.metadata.extensionModelPlan).toEqual(previous.metadata.extensionModelPlan);
  });
  it("parses split UTF-8 SSE, finish state, and usage through the ordinary model engine", async () => {
    const f = await fixture((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"你好🙂"}}]}\n\n');
      const offset = bytes.indexOf(Buffer.from("你")) + 1;
      res.write(bytes.subarray(0, offset));
      res.end(Buffer.concat([bytes.subarray(offset), Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n')]));
    }, true);
    const result = await f.run().completion;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("你好🙂");
    expect(result.usage.outputTokens).toBe(2);
    expect(f.requests[0].input.stream_options).toEqual({ include_usage: true });
  });
  it("keeps tool calls on the separately selected Sandbox Node and returns results to the model", async () => {
    const f = await fixture((input, res, _, turn) => {
      if (turn > 1) { expect(input.messages.at(-1).role).toBe("tool"); jsonResponse(res, "read complete"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
        id: "read-call", type: "function", function: { name: "read", arguments: '{"path":"/workspace/file"}' }
      }] }, finish_reason: "tool_calls" }] }));
    }, false, true);
    let toolCalls = 0;
    const result = await f.run(f.request, { listTools: async () => [{ name: "read", inputSchema: { type: "object" } }],
      invoke: async (inv) => { expect(inv.target.nodeId).toBe("managed:sandbox"); toolCalls++; return { ok: true, content: "file content" }; } }).completion;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("read complete");
    expect(toolCalls).toBe(1);
  }, 15000);
  it("fails an unfinished SSE stream and never falls back to platform execution", async () => {
    const f = await fixture((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    }, true);
    const result = await f.run().completion;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("before a completion signal");
    expect(f.requests).toHaveLength(1);
  });
  it("fails an offline model Node explicitly before the upstream receives any request", async () => {
    const f = await fixture((_, res) => jsonResponse(res), false, true);
    await f.connector.stop();
    f.broker.disconnectNode("node:intranet", "instance:model");
    const result = await f.run().completion;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("offline");
    expect(f.requests).toHaveLength(0);
  }, 15000);
  it("cancels the Node's upstream request promptly when the user cancels", async () => {
    let ready, closed;
    const received = new Promise((r) => { ready = r; }), disconnected = new Promise((r) => { closed = r; });
    const f = await fixture((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"waiting"}}]}\n\n');
      res.on("close", closed); ready();
    }, true);
    const handle = f.run();
    await received; handle.abort("user");
    expect((await handle.completion).status).toBe("aborted");
    await disconnected;
  });
  it("fences revocation during a stream and closes the execution-side upstream", async () => {
    let ready, closed;
    const received = new Promise((r) => { ready = r; }), disconnected = new Promise((r) => { closed = r; });
    const f = await fixture((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"waiting"}}]}\n\n');
      res.on("close", closed); ready();
    }, true);
    const handle = f.run();
    await received; f.revoke();
    const result = await handle.completion;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("grant_revoked");
    await disconnected;
  });
  it("redacts a credential echoed across upstream chunks before it reaches Runtime events", async () => {
    const f = await fixture((_, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.write('{"error":{"message":"Bearer node-only-');
      res.end('secret"}}');
    });
    const handle = f.run(), result = await handle.completion;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Model HTTP 401");
    expect(result.error).toContain("[redacted]");
    expect(JSON.stringify(await f.runs.getEvents(handle.runId))).not.toContain("node-only-secret");
  });
  it("fences changed installation epochs before admission and forbids another account's selected model", async () => {
    const f = await fixture((_, res) => jsonResponse(res));
    const other = await f.run({ ...f.request, principal: { userId: bob.id, spaceId: space.id } }).completion;
    expect(other.status).toBe("failed");
    expect(f.requests).toHaveLength(0);
    await marketplace.change(alice.id, f.listingId, { enabled: false, expectedRevision: (await marketplace.account(alice.id)).revision });
    expect((await f.run().completion).status).toBe("failed");
    expect(f.host.workers.size).toBe(0);
  });
});
