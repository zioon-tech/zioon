import { describe, expect, it, vi } from "vitest";
import { CancellationController, createAgentExecutor, MemoryRunStore } from "../../../packages/runtime/dist/index.js";
import { SpaceCapabilityBroker, SharedSpaceRuntime, SPACE_CAPABILITY_TOOL } from "../src/spaces/space-runtime.mjs";
import { createProviderCapabilities } from "../src/spaces/provider-capabilities.mjs";
import { createRuntimeServer } from "../src/server.mjs";

const principal = { userId: "bob", spaceId: "together", version: 1, grantId: "grant", kind: "user" };
const policy = { preset: "trusted-automation", allowedTools: ["webFetch", "spaceCapabilityCall"], maxToolCalls: 5 };
const model = { profileId: "fixture", providerId: "fixture", modelId: "fixture" };
const collect = async (stream) => { const values = []; for await (const item of stream) values.push(item); return values; };
function fixture() {
  const runs = new MemoryRunStore();
  const receipts = new Map();
  runs.getToolReceipt = async (id) => receipts.get(id) || null;
  runs.saveToolReceipt = async (receipt) => { receipts.set(receipt.invocationId, receipt); return receipt; };
  const reservations = new Map(), events = [];
  const execution = {
    enqueue: vi.fn(async () => {}), waitForTurn: vi.fn(async () => { events.push("queue-acquired"); }),
    finish: vi.fn(async (_space, _id, status) => { events.push(`queue-${status}`); }),
    reserve: vi.fn(async (input) => {
      const key = `${input.runId}:${input.stepId}`;
      const existing = reservations.get(key);
      if (existing) return existing;
      const r = { id: key, state: "reserved", input };
      reservations.set(key, r); events.push("reserve"); return r;
    }),
    dispatch: vi.fn(async (_space, id) => {
      const r = reservations.get(id); if (r.state !== "reserved") throw new Error("already dispatched");
      r.state = "dispatched"; events.push("dispatch");
    }),
    settle: vi.fn(async (_space, id, receipt) => { reservations.get(id).state = "settled"; events.push("settle"); expect(receipt.verified).toBe(true); }),
    pending: vi.fn(async (_space, id) => { reservations.get(id).state = "pending"; events.push("pending"); }),
    releaseUndispatched: vi.fn(async (_space, id) => { reservations.get(id).state = "released"; events.push("release"); })
  };
  let revoked = false;
  const spaces = {
    accounts: { space: async () => ({ kind: "team" }) }, content: async () => ({ revision: 7 }),
    bindings: vi.fn(async () => []),
    requireDocument: vi.fn(async () => {
      if (revoked) throw Object.assign(new Error("document revoked"), { code: "document_revoked" });
      return { aclRevision: 2 };
    }),
    requireBinding: vi.fn(async (_user, _space, id) => ({ id, kind: "device", revision: 1, name: "Shared test folder", allowedTools: ["read"] })),
    knowledge: vi.fn(async () => [{ status: "active", title: "Reviewed", text: "Space knowledge" }])
  };
  const broker = { acquire: vi.fn(async () => ({ release() {} })), invoke: vi.fn(async () => ({ ok: true, content: "shared result" })) };
  const runtime = new SharedSpaceRuntime({ spaces, execution, broker, runs, runtimeSpaceId: "together" });
  const rawTools = {
    getToolDefinitions: () => [{ name: "webFetch", inputSchema: {} }, { name: "Bash", inputSchema: {} }, { name: "personalSecret", inputSchema: {} }],
    listTools: vi.fn(async () => [{ name: "Bash" }, { name: "personalSecret" }]),
    invoke: vi.fn(async () => ({ ok: true, content: "public result" }))
  };
  const request = { principal, policy, sessionId: "document", model, messages: [{ role: "user", content: "hello" }],
    metadata: { spaceCapabilities: ["device-binding"] } };
  return { runs, runtime, execution, events, reservations, spaces, broker, rawTools, request, revoke() { revoked = true; } };
}

describe("shared Space execution through the actual Agent executor", () => {
  it("makes only currently authorized shared resources available by default, with explicit opt-out", async () => {
    const h = fixture(), controller = new CancellationController();
    h.spaces.bindings = vi.fn(async () => [
      { id: "device-binding", kind: "device", status: "active" },
      { id: "unavailable", kind: "plugin", status: "active" },
      { id: "model-binding", kind: "model", status: "active" },
      { id: "disabled", kind: "skill", status: "disabled" }
    ]);
    h.spaces.requireBinding.mockImplementation(async (_user, _space, id) => {
      if (id === "unavailable") throw Object.assign(new Error("capability_not_shared"), { statusCode: 403 });
      return { id, kind: "device", allowedTools: ["read"], revision: 1 };
    });
    const defaultRequest = { ...h.request, metadata: {} };
    const enabled = await h.runtime.prepare(defaultRequest,
      { runId: "defaults", preview: true, signal: controller.signal });
    expect(enabled.metadata.spaceCapabilities).toEqual(["device-binding"]);
    const disabled = await h.runtime.prepare({ ...defaultRequest, metadata: { spaceCapabilities: [] } },
      { runId: "opt-out", preview: true, signal: controller.signal });
    expect(disabled.metadata.spaceCapabilities).toEqual([]);
  });
  it("waits for the writer queue before contributing knowledge or starting the model", async () => {
    const h = fixture();
    let release;
    h.execution.waitForTurn.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const engine = { id: "fixture", async *streamTurn(request) {
      h.events.push("model-started");
      expect(request.messages.some((m) => m.content.includes("Space knowledge"))).toBe(true);
      yield { type: "model.request", request: { url: "http://fixture", modelId: "fixture", payload: {}, stream: true } };
      h.events.push("transport"); yield { type: "message.delta", delta: "hello" };
      yield { type: "model.usage", usage: { inputTokens: 12, outputTokens: 3 } };
    } };
    const executor = createAgentExecutor({
      engine: h.runtime.wrapEngine(engine), tools: h.runtime.wrapTools(h.rawTools), runs: h.runs,
      bindRun: (request, context) => h.runtime.prepare(request, context)
    });
    const handle = executor.execute(h.request);
    await handle.ready;
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(h.spaces.knowledge).not.toHaveBeenCalled();
    expect(h.events).not.toContain("transport");
    release();
    expect((await handle.completion).status).toBe("completed");
    await vi.waitFor(() => expect(h.execution.finish).toHaveBeenCalledWith("together", handle.runId, "completed"));
    expect(h.events.indexOf("dispatch")).toBeLessThan(h.events.indexOf("transport"));
    expect(h.execution.settle).toHaveBeenCalledWith("together", expect.any(String),
      expect.objectContaining({ calls: 1, inputTokens: 12, outputTokens: 3 }));
  });

  it("previews with the actual executor without queueing, transport or quota", async () => {
    const h = fixture();
    let transport = false;
    const engine = { id: "fixture", async *streamTurn() {
      yield { type: "model.request", request: { url: "http://fixture", modelId: "fixture", payload: {}, stream: true } };
      transport = true; throw new Error("preview dispatched");
    } };
    const executor = createAgentExecutor({ engine: h.runtime.wrapEngine(engine), tools: h.runtime.wrapTools(h.rawTools), runs: h.runs,
      bindRun: (request, context) => h.runtime.prepare(request, context) });
    expect((await executor.preview(h.request)).request.modelId).toBe("fixture");
    expect(transport).toBe(false);
    expect(h.execution.enqueue).not.toHaveBeenCalled();
    expect(h.execution.reserve).not.toHaveBeenCalled();
  });

  it("preserves uncertain model dispatches for reconciliation", async () => {
    const h = fixture(), parent = new CancellationController();
    const bindings = await h.runtime.prepare(h.request, { runId: "run", attemptId: "attempt", signal: parent.signal });
    const engine = h.runtime.wrapEngine({ id: "fixture", async *streamTurn() {
      yield { type: "model.request", request: { payload: {} } };
      throw new Error("socket reset after dispatch");
    } });
    await expect(collect(engine.streamTurn({ ...h.request, runId: "run", attemptId: "attempt", turn: 1, signal: parent.signal })))
      .rejects.toThrow("socket reset");
    expect(h.execution.pending).toHaveBeenCalledOnce();
    expect(h.execution.settle).not.toHaveBeenCalled();
    expect(h.execution.releaseUndispatched).not.toHaveBeenCalled();
    await bindings.dispose();
  });

  it("releases an unsubmitted model request when cancelled before transport", async () => {
    const h = fixture(), parent = new CancellationController();
    await h.runtime.prepare(h.request, { runId: "run", attemptId: "attempt", signal: parent.signal });
    let transport = false;
    const engine = h.runtime.wrapEngine({ id: "fixture", async *streamTurn() {
      yield { type: "model.request", request: { payload: {} } }; transport = true;
    } });
    const iterator = engine.streamTurn({ ...h.request, runId: "run", attemptId: "attempt", turn: 1, signal: parent.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("model.request");
    parent.cancel("user");
    await expect(iterator.next()).rejects.toThrow("cancelled");
    expect(transport).toBe(false);
    expect(h.execution.releaseUndispatched).toHaveBeenCalledOnce();
    expect(h.execution.dispatch).not.toHaveBeenCalled();
  });

  it("never discovers a consumer's private tools in a shared Space", async () => {
    const h = fixture(), tools = h.runtime.wrapTools(h.rawTools);
    expect((await tools.listTools(h.request)).map((t) => t.name)).toEqual(["webFetch", SPACE_CAPABILITY_TOOL.name]);
    expect(h.rawTools.listTools).not.toHaveBeenCalled();
    const parent = new CancellationController();
    await h.runtime.prepare(h.request, { runId: "run", signal: parent.signal });
    await expect(tools.invoke({ ...h.request, runId: "run", invocationId: "secret", toolCall: { name: "Bash", arguments: {} } }, parent.signal))
      .rejects.toMatchObject({ code: "tool_not_shared" });
    expect(h.rawTools.invoke).not.toHaveBeenCalled();
  });

  it("rejects a mismatched execution scope instead of using a local model fallback", async () => {
    const h = fixture(), parent = new CancellationController();
    const stream = vi.fn(async function* () { yield { type: "message.delta", delta: "private" }; });
    await expect(collect(h.runtime.wrapEngine({ id: "private", streamTurn: stream }).streamTurn({
      ...h.request, principal: { ...principal, spaceId: "personal" }, signal: parent.signal
    }))).rejects.toMatchObject({ code: "space_execution_scope_mismatch" });
    expect(stream).not.toHaveBeenCalled();
  });

  it("uses only selected shared bindings and settles a trusted tool result", async () => {
    const h = fixture(), parent = new CancellationController();
    await h.runtime.prepare(h.request, { runId: "run", signal: parent.signal });
    const invocation = { ...h.request, runId: "run", invocationId: "tool-1", toolCall: {
      name: SPACE_CAPABILITY_TOOL.name, arguments: { bindingId: "device-binding", tool: "read", arguments: { path: "plan.txt" } }
    } };
    const tools = h.runtime.wrapTools(h.rawTools);
    expect((await tools.invoke(invocation, parent.signal)).content).toBe("shared result");
    expect(h.broker.invoke).toHaveBeenCalledWith(principal, "device-binding", "document", invocation, parent.signal);
    expect(h.execution.settle).toHaveBeenCalledOnce();
    await expect(tools.invoke({ ...invocation, invocationId: "tool-2", toolCall: { ...invocation.toolCall,
      arguments: { ...invocation.toolCall.arguments, bindingId: "private-binding" } } }, parent.signal))
      .rejects.toMatchObject({ code: "capability_not_selected" });
  });
});

describe("provider broker boundaries", () => {
  it("redacts origin model identifiers and endpoint while retaining the user's request", async () => {
    const binding = { id: "shared", kind: "model", spaceId: "together", originSpaceId: "alice-private",
      providerId: "alice", originResourceId: "secret-model", name: "Our model", sourceVersion: "v1", revision: 1 };
    const released = vi.fn(), app = {
      describeSharedSource: async () => ({ id: "secret-model", kind: "model", version: "v1" }),
      async *streamSharedModel() {
        yield { type: "model.request", request: { url: "https://private-provider", modelId: "secret-model",
          payload: { model: "secret-model", messages: [{ role: "user", content: "our question" }] } } };
        yield { type: "message.delta", delta: "reply" };
      }
    };
    const broker = new SpaceCapabilityBroker({ spaces: { requireBinding: async () => binding, requireDocument: async () => ({}) },
      acquireRuntime: async () => ({ app, release: released }) });
    const parent = new CancellationController();
    const output = await collect(broker.streamModel({ principal, signal: parent.signal }, "shared", "document"));
    expect(output[0].request).toMatchObject({ url: "space://model", modelId: "shared", payload: { model: "shared" } });
    expect(JSON.stringify(output)).not.toContain("private-provider");
    expect(JSON.stringify(output)).not.toContain("secret-model");
    expect(JSON.stringify(output)).toContain("our question");
    expect(released).toHaveBeenCalledOnce();
  });

  it("refuses changed source versions and releases the provider Runtime lease", async () => {
    const release = vi.fn();
    const broker = new SpaceCapabilityBroker({
      spaces: { requireBinding: async () => ({ id: "shared", sourceVersion: "old", limits: {}, allowedTools: [] }) },
      acquireRuntime: async () => ({ release, app: { describeSharedSource: async () => ({ version: "new" }) } })
    });
    await expect(broker.acquire(principal, "shared")).rejects.toMatchObject({ code: "capability_source_changed" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("runs a borrowed model under an auditable provider service grant", async () => {
    const accounts = { membership: async () => ({ role: "owner", status: "active" }), space: async () => ({ kind: "personal" }),
      issueGrant: vi.fn(async () => ({ userId: "alice", spaceId: "alice-private", grantId: "service-grant", kind: "service" })),
      validateGrant: vi.fn(async () => ({})), revokeGrant: vi.fn(async () => {}) };
    const sourceModel = { id: "source", label: "Private label", model: "upstream", credentialConfigured: true };
    const stream = vi.fn(async function* (request) {
      expect(request.principal).toMatchObject({ userId: "alice", kind: "service", grantId: "service-grant" });
      expect(request.metadata.sharedDestination.requesterId).toBe("bob");
      yield { type: "model.request", request: { payload: {} } };
      yield { type: "message.delta", delta: "complete" };
    });
    const service = createProviderCapabilities({ accounts, runtimeSpaceId: "alice-private",
      listModels: async () => [sourceModel], resolveModel: () => ({ profileId: "source", modelId: "upstream" }),
      configuredEngine: { streamTurn: stream }, profileId: "default" });
    const source = await service.describeSharedSource("alice", { kind: "model", originResourceId: "source" });
    const binding = { id: "shared", spaceId: "together", providerId: "alice", originResourceId: "source", sourceVersion: source.version };
    const parent = new CancellationController();
    await collect(service.streamSharedModel(binding, { principal, runId: "run", signal: parent.signal,
      authorize: vi.fn(async () => {}), destinationId: "document" }));
    expect(accounts.issueGrant.mock.calls[0][2]).toMatchObject({ purpose: "task", sourceId: "shared-capability:together:shared" });
    expect(accounts.revokeGrant).toHaveBeenCalledWith("alice", "service-grant", "alice-private");
  });

  it("rejects filesystem-wide device sharing and unvalidated plugin tools", async () => {
    const service = createProviderCapabilities({
      accounts: { membership: async () => ({ role: "owner", status: "active" }), space: async () => ({ kind: "personal" }) }, runtimeSpaceId: "alice-private",
      accessStore: { listDevices: async () => [{ deviceId: "node", kind: "resource" }] },
      nodeBroker: { snapshot: () => ({ nodes: [{ nodeId: "node", status: "online", capabilities: [{ name: "read" }] }] }) },
      marketplace: { assertExecution: async () => ({ install: { validation: null } }) }
    });
    await expect(service.describeSharedSource("alice", { kind: "device", originResourceId: "node", dedicatedRoot: "/" }))
      .rejects.toMatchObject({ code: "dedicated_root_required" });
    await expect(service.describeSharedSource("alice", { kind: "plugin", originResourceId: "plugin" }))
      .rejects.toMatchObject({ code: "plugin_validation_required" });
  });
  it("maps shared device paths to the dedicated root and rejects traversal before dispatch", async () => {
    const invoke = vi.fn(async () => ({ ok: true, content: "file" }));
    const accounts = {
      membership: async () => ({ role: "owner", status: "active" }), space: async () => ({ kind: "personal" }),
      issueGrant: async () => ({ userId: "alice", grantId: "service" }),
      validateGrant: async () => ({}), revokeGrant: async () => {}
    };
    const service = createProviderCapabilities({ accounts, runtimeSpaceId: "personal", profileId: "default",
      accessStore: { listDevices: async () => [{ deviceId: "node", kind: "resource", createdAt: 1 }] },
      nodeBroker: { invoke, snapshot: () => ({ nodes: [{ nodeId: "node", status: "online", capabilities: [{ name: "read" }] }] }) } });
    const source = await service.describeSharedSource("alice", { kind: "device", originResourceId: "node",
      dedicatedRoot: "/private/shared-folder", allowedTools: ["read"] });
    const binding = { providerId: "alice", kind: "device", originResourceId: "node",
      sourceVersion: source.version, allowedTools: ["read"], limits: { dedicatedRoot: "/private/shared-folder" } };
    const controller = new CancellationController();
    const request = path => ({ principal, toolCall: { id: "call", arguments: { tool: "read", arguments: { path } } } });
    await service.invokeSharedCapability(binding, request("/shared/plan.txt"), controller.signal, async () => {});
    expect(invoke.mock.calls[0][0].toolCall.arguments.path).toBe("/private/shared-folder/plan.txt");
    await expect(service.invokeSharedCapability(binding, request("/shared/../secret"), controller.signal, async () => {}))
      .rejects.toMatchObject({ code: "file_outside_shared_capability" });
    await expect(service.invokeSharedCapability(binding, request("/etc/passwd"), controller.signal, async () => {}))
      .rejects.toMatchObject({ code: "file_outside_shared_capability" });
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe("shared queue through real local HTTP admission and document projection", () => {
  it("acknowledges two submissions and projects them only when each acquires the writer", async () => {
    const h = fixture(), records = new Map(), messages = new Map(), waiting = [];
    let current = null, releaseModel;
    const prepared = [], projected = [], modelStarts = [];
    h.execution.waitForTurn.mockImplementation(async (_space, runId) => {
      if (current) await new Promise((resolve) => waiting.push({ runId, resolve }));
      current = runId;
    });
    h.execution.finish.mockImplementation(async (_space, runId) => {
      expect(projected).toContain(runId);
      current = null;
      waiting.shift()?.resolve();
    });
    const sessions = {
      async listSessions() { return [...records.values()]; },
      async createSession(record) { records.set(record.id, record); messages.set(record.id, []); },
      async getSession(id) { return records.get(id) || null; },
      async forkSession() {},
      async getSessionMessages(id) { return messages.get(id) || []; },
      async getSessionTranscript(id) { return messages.get(id) || []; },
      async appendSessionMessages(id, values) { messages.get(id).push(...values); }
    };
    h.runtime.prepareDocument = async (_request, context) => { prepared.push(context.runId); };
    const engine = { id: "fixture", async *streamTurn(request) {
      modelStarts.push(request.runId);
      yield { type: "model.request", request: { payload: {} } };
      if (modelStarts.length === 1) await new Promise((resolve) => { releaseModel = resolve; });
      yield { type: "message.delta", delta: "answer" };
    } };
    const executor = createAgentExecutor({
      engine: h.runtime.wrapEngine(engine), tools: h.runtime.wrapTools(h.rawTools), runs: h.runs,
      bindRun: (request, context) => h.runtime.prepare(request, context)
    });
    const server = createRuntimeServer({
      executor, runs: h.runs, sessions, sharedRunQueue: true,
      accessControl: {
        authorizeRuntimeRequest: async () => ({ kind: "account", user: { id: "bob" }, space: { id: "together", kind: "team" } }),
        authorizeRunRequest: async (_actor, request) => ({ ...request, principal })
      },
      interactionProfiles: { get: (id) => ({ id, policy }) },
      sessionDocumentService: {
        prepareRun: vi.fn(() => { throw new Error("queued documents must not be prepared at admission"); }),
        async applyRunEvent(_id, event) {
          if (event.type === "run.completed") {
            await new Promise((resolve) => setTimeout(resolve, 10));
            projected.push(event.runId);
          }
        }
      }
    });
    h.runtime.waitForProjection = (...args) => server.waitForProjection(...args);
    const { url } = await server.start();
    try {
      const post = () => fetch(`${url}/v1/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "document", model, prompt: "hello", policy })
      });
      const first = await post(), firstBody = await first.json();
      expect(first.status).toBe(202);
      await vi.waitFor(() => expect(releaseModel).toBeTypeOf("function"));
      const second = await post(), secondBody = await second.json();
      expect(second.status).toBe(202);
      expect(prepared).toEqual([firstBody.runId]);
      expect(modelStarts).toEqual([firstBody.runId]);
      releaseModel();
      await vi.waitFor(() => expect(modelStarts).toEqual([firstBody.runId, secondBody.runId]));
      expect(projected).toContain(firstBody.runId);
      await vi.waitFor(() => expect(h.execution.finish).toHaveBeenCalledTimes(2));
      expect(prepared).toEqual([firstBody.runId, secondBody.runId]);
    } finally { releaseModel?.(); await server.close(); }
  });
});
