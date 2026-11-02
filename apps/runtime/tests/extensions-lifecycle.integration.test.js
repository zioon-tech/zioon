import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresAccountStore } from "../src/accounts/postgres-account-store.mjs";
import { initializePostgresRuntimeSchema } from "../src/postgres-runtime-schema.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { MarketplaceService } from "../src/marketplace/service.mjs";
import { createMemoryArtifactStore } from "../src/marketplace/artifact-store.mjs";
import { ExtensionExecutionService, withExtensionTools } from "../src/marketplace/execution-service.mjs";
import { ExtensionRunBindings } from "../src/marketplace/run-bindings.mjs";
import { ExtensionOutbox } from "../src/marketplace/outbox.mjs";
import { ExtensionHostBridge } from "../src/marketplace/host-bridge.mjs";
import { ExtensionHost } from "../../device-connector/src/extension-host.mjs";
import { normalizeExtensionPackage } from "../../../packages/runtime-client/src/extension-package.mjs";
import { createAgentExecutor, CancellationController } from "../../../packages/runtime/dist/index.js";

const suite = process.env.ZION_TEST_POSTGRES_URL ? describe : describe.skip;
const schema = `extension_lifecycle_${randomBytes(8).toString("hex")}`;
const resources = [];
suite("installed account extensions in ordinary Runs and durable outbox", () => {
  let admin, pool, alice, bob, space, marketplace;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.ZION_TEST_POSTGRES_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.ZION_TEST_POSTGRES_URL, max: 8, options: `-c search_path=${schema}` });
    const accounts = await new PostgresAccountStore({ pool }).initialize();
    alice = await accounts.resolveIdentity({ issuer: "https://fixture.test", subject: "alice", name: "Alice" });
    bob = await accounts.resolveIdentity({ issuer: "https://fixture.test", subject: "bob", name: "Bob" });
    [space] = await accounts.listSpaces(alice.id);
    await initializePostgresRuntimeSchema(pool);
    marketplace = await new MarketplaceService({ pool, artifactStore: createMemoryArtifactStore() }).initialize();
  });
  afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  async function fixture(code, kinds = ["context", "controller", "post-processor", "job"]) {
    const root = await mkdtemp(join(tmpdir(), "zioon-lifecycle-"));
    resources.push(() => rm(root, { recursive: true, force: true }));
    const slug = `fixture-${randomBytes(6).toString("hex")}`;
    const artifact = normalizeExtensionPackage({ schemaVersion: 1, kind: "plugin",
      manifest: { slug, name: "Lifecycle", summary: "fixture", version: "0.1.0", category: "开发", license: "MIT" },
      plugin: { id: slug, version: "0.1.0", entries: { runtime: "./runtime.mjs" }, runtime: { apiVersion: 2 },
        capabilities: kinds.map((kind) => typeof kind === "string" ? { id: kind, kind, host: "runtime" } : kind) },
      files: { "runtime.mjs": code } });
    const upload = await marketplace.uploadPrivate(alice.id, alice.name, {
      artifact, expectedRevision: (await marketplace.account(alice.id)).revision
    });
    const listingId = upload.release.id;
    await marketplace.install(alice.id, listingId, { version: artifact.manifest.version, digest: upload.release.digest });
    await marketplace.configure(alice.id, listingId, {
      expectedRevision: (await marketplace.account(alice.id)).revision,
      config: { nodeId: "node:fixture", workspaceRoot: root }
    });
    resources.push(async () => {
      const account = await marketplace.account(alice.id);
      if (account.installations[listingId]) await marketplace.change(alice.id, listingId, { expectedRevision: account.revision }, true);
    });
    const host = new ExtensionHost();
    resources.push(() => host.close());
    const bridge = new ExtensionHostBridge({ tools: () => { throw new Error("Run Bash must remain separate"); },
      hasNativeHost: () => true, nativeInvoke: (inv, signal) => host.invoke(inv.toolCall.arguments, signal, inv) });
    const runs = new PostgresRunStore(pool, { spaceId: space.id });
    const execution = new ExtensionExecutionService({ marketplace, hostBridge: bridge, runs, allowNode: (id) => id === "node:fixture" });
    let bindings;
    const outbox = new ExtensionOutbox({ pool, spaceId: space.id, runs, execute: (...args) => bindings.runJob(...args) });
    bindings = new ExtensionRunBindings({ execution, outbox });
    const policy = { preset: "trusted-automation", allowedTools: ["write", "Bash", "read"], fileRoots: [root], maxToolCalls: 5 };
    const request = { prompt: "hello", principal: { userId: alice.id, spaceId: space.id, grantId: "secret-grant" }, policy };
    const executor = (engine, tools = { listTools: async () => [], invoke: async () => ({ ok: true, content: "read" }) }) =>
      createAgentExecutor({ engine, tools, runs, bindRun: (r, c) => bindings.prepare(r, c) });
    const run = (engine, input = request, tools) => executor(engine, tools).execute(input);
    const call = async (name, id) => {
      const install = (await marketplace.account(alice.id)).installations[listingId];
      const binding = bridge.binding(install, artifact, alice.id);
      const context = { ...request, signal: new CancellationController().signal, runId: "inspect", invocationId: id };
      const description = await bridge.ensure(binding, artifact, context);
      return bridge.invoke(binding, description, description.handlers.find((h) => h.id === name), {}, context);
    };
    return { root, run, executor, runs, outbox, bindings, bridge, host, listingId, request, call };
  }
  it("runs required context and controllers before the model and commits deferred work before completion", async () => {
    const f = await fixture(`export function activateRuntimePlugin(c) {
      const s=c.state.namespace();
      c.context.registerProvider({id:"first",order:1,prepare(r){
        if(r.principal.grantId) throw Error("grant leaked"); return [{role:"system",content:"first"}]; }});
      c.context.registerProvider({id:"second",order:2,contribute(m){return [...m,{role:"system",content:"second"}];}});
      c.context.registerProvider({id:"third",stage:"post",contribute(m){return [...m,{role:"system",content:"third"}];}});
      c.runs.registerController({id:"guard",beforeModel(ctx){
        if(ctx.messages.filter(x=>x.role==="system").map(x=>x.content).join(",")!=="first,second,third") throw Error("order");
      },async afterRun(ctx){await s.put("after",ctx.result.status);}});
      c.runs.registerPostProcessor({id:"summary",async process(ctx){await s.put("summary",ctx.output);}});
      c.tools.registerTool({name:"inspect",execution:{effect:"read",idempotency:"safe"},
        async invoke(){return {after:await s.read("after"),summary:await s.read("summary")};}});
      return {};
    }`);
    let activity = 0;
    f.bridge.acquireActivity = () => { activity++; return { dispose() { activity--; } }; };
    const handle = f.run({ id: "model", async *streamTurn(req) {
      expect(activity).toBeGreaterThan(0);
      expect(req.messages.filter((m) => m.role === "system").map((m) => m.content)).toEqual(["first", "second", "third"]);
      yield { type: "message.delta", delta: "visible reply" };
    } });
    expect((await handle.completion).status).toBe("completed");
    expect(activity).toBe(0);
    const jobs = await f.outbox.list(alice.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.status === "queued")).toBe(true);
    expect(await f.call("inspect", "inspect:before")).toEqual({});
    await f.outbox.tick(); await f.outbox.tick();
    expect(await f.call("inspect", "inspect:after")).toEqual({ after: "completed", summary: "visible reply" });
  });
  it("stops before any model request when necessary context fails", async () => {
    const f = await fixture(`export function activateRuntimePlugin(c){
      c.context.registerProvider({id:"required",required:true,prepare(){throw Error("missing");}});return {};
    }`, ["context"]);
    let calls = 0;
    const handle = f.run({ id: "never", async *streamTurn() { calls++; yield { type: "message.delta", delta: "wrong" }; } });
    expect((await handle.completion).status).toBe("failed");
    expect(calls).toBe(0);
    expect((await f.runs.getEvents(handle.runId)).some((e) => e.type === "context.failed")).toBe(true);
  });
  it("does not discover or activate another account's hooks or an unrelated model-only Node", async () => {
    const f = await fixture(`export function activateRuntimePlugin(){throw Error("offline");}`, ["model"]);
    const model = { id: "independent", async *streamTurn() { yield { type: "message.delta", delta: "ok" }; } };
    expect((await f.run(model).completion).output).toBe("ok");
    expect((await f.run(model, { ...f.request, principal: { userId: bob.id, spaceId: space.id } }).completion).output).toBe("ok");
    expect(f.host.workers.size).toBe(0);
    expect(await f.outbox.list(bob.id)).toEqual([]);
  });
  it("skips a disabled optional-only context before contacting its offline Node", async () => {
    const f = await fixture(`export function activateRuntimePlugin(c){
      c.context.registerProvider({id:"optional",required:false,prepare(){throw Error("must not run");}});return {};
    }`, [{ id: "optional", kind: "context", host: "runtime", required: false }]);
    const model = { id: "independent", async *streamTurn() { yield { type: "message.delta", delta: "ok" }; } };
    const result = await f.run(model, { ...f.request, metadata: { contextProviders: {
      disabled: [`extension:${f.listingId}:optional`]
    } } }).completion;
    expect(result.output).toBe("ok");
    expect(f.host.workers.size).toBe(0);
  });
  it("pins a metadata-only tool catalog into the model prompt and fences calls after an epoch change", async () => {
    const f = await fixture(`export function activateRuntimePlugin(c){
      c.tools.registerTool({name:"hello",inputSchema:{type:"object"},invoke(){return "hello";}});return {};
    }`, ["tool"]);
    const tools = withExtensionTools({ hasTool: () => false, supportedToolNames: [], getToolDefinitions: () => [],
      listTools: async () => [], invoke() { throw Error("unexpected"); } }, f.bindings.execution);
    const handle = f.run({ id: "catalog", async *streamTurn(request) {
      expect(f.host.workers.size).toBe(0);
      expect(request.tools[0].description).toContain(f.listingId);
      expect(request.tools[0].description).toContain('"validationRequired":true');
      yield { type: "message.delta", delta: "catalog visible" };
    } }, { ...f.request, policy: { ...f.request.policy, allowedTools: [...f.request.policy.allowedTools, "extensionsCall"] } }, tools);
    expect((await handle.completion).output).toBe("catalog visible");
    const run = await f.runs.get(handle.runId), initial = run.metadata.extensionToolCatalog[0];
    expect(initial.listingId).toBe(f.listingId);
    await marketplace.configure(alice.id, f.listingId, {
      expectedRevision: (await marketplace.account(alice.id)).revision,
      config: { nodeId: "node:fixture", workspaceRoot: f.root }
    });
    await expect(f.bindings.execution.invoke({ action: "probe", listingId: f.listingId },
      { ...f.request, runId: handle.runId, invocationId: "probe:fixed", signal: new CancellationController().signal }))
      .rejects.toMatchObject({ code: "extension_changed" });
    expect(f.host.workers.size).toBe(0);
  });
  it("fences the existing Run on disable instead of adopting the changed configuration", async () => {
    const f = await fixture(`export function activateRuntimePlugin(c){
      c.context.registerProvider({id:"each",stage:"post",contribute(m){return m;}});return {};
    }`, ["context"]);
    let calls = 0;
    const handle = f.run({ id: "tools", async *streamTurn() {
      calls++; yield { type: "tool.call", call: { id: "call", name: "read", arguments: {} } };
    } }, f.request, { listTools: async () => [{ name: "read", inputSchema: { type: "object" } }],
      invoke: async () => {
        await marketplace.change(alice.id, f.listingId, { enabled: false, expectedRevision: (await marketplace.account(alice.id)).revision });
        return { ok: true, content: "done" };
      } });
    expect((await handle.completion).status).toBe("failed");
    expect(calls).toBe(1);
    expect((await f.runs.get(handle.runId)).metadata.extensionPlan[0].listingId).toBe(f.listingId);
  });
  it("replays the execution receipt after consumer replacement without duplicating job state writes", async () => {
    const f = await fixture(`export function activateRuntimePlugin(c){
      const s=c.state.namespace(); c.runs.registerPostProcessor({id:"summary",async process(){
        await s.put("count",(await s.read("count")||0)+1); return {saved:true}; }});
      c.tools.registerTool({name:"inspect",execution:{effect:"read",idempotency:"safe"},async invoke(){return s.read("count");}});
      return {};
    }`, ["post-processor"]);
    const handle = f.run({ id: "reply", async *streamTurn() { yield { type: "message.delta", delta: "reply" }; } });
    await handle.completion;
    const job = await f.outbox.claim();
    expect(await f.bindings.runJob(job, f.runs, new CancellationController().signal)).toEqual({ saved: true });
    await pool.query(`UPDATE runtime_run_outbox SET lease_until=0 WHERE space_id=$1 AND id=$2`, [space.id, job.id]);
    const replacement = new ExtensionOutbox({ pool, spaceId: space.id, runs: f.runs, execute: (...args) => f.bindings.runJob(...args) });
    await replacement.tick();
    expect((await f.outbox.list(alice.id)).find((j) => j.id === job.id).status).toBe("completed");
    expect(await f.call("inspect", "inspect:replayed")).toBe(1);
    expect(await f.outbox.settle(job, "completed", { obsolete: true })).toBe(false);
  });
  it("delivers SDK events durably within the owning plugin and account", async () => {
    const f = await fixture(`export function activateRuntimePlugin(c){
      const s=c.state.namespace(); c.events.on("summary.saved",async(payload)=>{await s.put("event",payload);});
      c.jobs.registerHandler({id:"save-extra",async process(args){await s.put("extra",args.value);}});
      c.runs.registerPostProcessor({id:"summary",process(){
        c.events.emit("summary.saved",{value:7}); c.jobs.enqueue("save-extra",{value:9});}});
      c.tools.registerTool({name:"inspect",execution:{effect:"read",idempotency:"safe"},
        async invoke(){return {event:await s.read("event"),extra:await s.read("extra")};}});
      return {};
    }`, ["post-processor", "job"]);
    await f.run({ id: "reply", async *streamTurn() { yield { type: "message.delta", delta: "reply" }; } }).completion;
    await f.outbox.tick(); await f.outbox.tick(); await f.outbox.tick();
    expect(await f.call("inspect", "inspect:event")).toEqual({ event: { value: 7 }, extra: 9 });
    expect(await f.outbox.list(bob.id)).toEqual([]);
  });
  it("rolls back a terminal event when its outbox intent cannot be persisted", async () => {
    const f = await fixture(`export function activateRuntimePlugin(){return {};}`, ["model"]);
    const id = `run:atomic:${randomBytes(5).toString("hex")}`;
    await f.runs.create({ id, attemptId: "attempt:atomic", principal: f.request.principal, status: "running", policy: f.request.policy,
      createdAt: Date.now(), updatedAt: Date.now() });
    await expect(f.runs.append({ schemaVersion: 1, runId: id, attemptId: "attempt:atomic",
      eventId: `${id}:event`, sequence: 1, type: "run.completed", timestamp: Date.now(), data: {} },
    { status: "completed", updatedAt: Date.now() }, undefined, [{ id: "invalid id", kind: "extension.handler", payload: {} }])).rejects.toThrow();
    expect((await f.runs.get(id)).status).toBe("running");
    expect(await f.runs.getEvents(id)).toEqual([]);
  });
  it("releases all preview activity when a required context fails", async () => {
    const f = await fixture(`export function activateRuntimePlugin(c){
      c.context.registerProvider({id:"required",required:true,prepare(){throw Error("missing");}});return {};
    }`, ["context"]);
    let activity = 0;
    f.bridge.acquireActivity = () => { activity++; return { dispose() { activity--; } }; };
    const executor = f.executor({ id: "never", async *streamTurn() { throw Error("must not run"); } });
    await expect(executor.preview(f.request)).rejects.toThrow();
    expect(activity).toBe(0);
  });
  it("rejects an excessive terminal job plan before execution and persists a failed Run", async () => {
    const code = `export function activateRuntimePlugin(c){
      for(let i=0;i<60;i++) c.runs.registerController({id:"after-"+i,afterRun(){}});return {};
    }`;
    const first = await fixture(code, ["controller"]), second = await fixture(code, ["controller"]);
    let called = false;
    const run = first.run({ id: "never", async *streamTurn() { called = true; yield { type: "message.delta", delta: "wrong" }; } },
      { ...first.request, policy: { ...first.request.policy, fileRoots: [first.root, second.root] } });
    expect((await run.completion).error).toContain("extension_outbox_budget");
    expect((await first.runs.get(run.runId)).status).toBe("failed");
    expect(called).toBe(false);
  });
  it("delivers context events while the originating Run is still waiting for its model", async () => {
    const f = await fixture(`export function activateRuntimePlugin(c){
      const s=c.state.namespace(); c.events.on("during",async(p)=>{await s.put("during",p.value);});
      c.context.registerProvider({id:"emit",prepare(){c.events.emit("during",{value:11});return [];}});
      c.tools.registerTool({name:"inspect",execution:{effect:"read",idempotency:"safe"},async invoke(){return s.read("during");}});
      return {};
    }`, ["context", "job"]);
    let started, release;
    const active = new Promise((r) => { started = r; }), wait = new Promise((r) => { release = r; });
    const handle = f.run({ id: "waiting", async *streamTurn() { started(); await wait; yield { type: "message.delta", delta: "reply" }; } });
    await active;
    await f.outbox.tick();
    expect((await f.runs.get(handle.runId)).status).toBe("running");
    expect(await f.call("inspect", "inspect:during")).toBe(11);
    release();
    expect((await handle.completion).status).toBe("completed");
    expect((await f.outbox.list(alice.id)).every((j) => j.status === "completed")).toBe(true);
  });
});
