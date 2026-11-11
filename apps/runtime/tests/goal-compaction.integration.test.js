import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createAgentExecutor, CancellationController } from "../../../packages/runtime/src/index";
import { RuntimePluginService } from "../src/runtime-plugin-service.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createWorkbenchStateHttpHandler } from "../src/workbench-state-http-handler.mjs";
import { workflowScope } from "../../../packages/plugin-sdk/src/runtime-workflow.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let database;
const resources = [];
const root = fileURLToPath(new URL("../../../extensions", import.meta.url));
const summary = JSON.stringify({ intent: ["完成代码修改，保留用户更正"], constraints: ["不要部署"],
  decisions: ["采用插件"], completed: ["检查过原代码"], active: ["正在修改"],
  blocked: [], references: ["src/a.ts"], next: ["验证修改"], uncertain: ["未知工具结果先核验"] });
const policy = { preset: "read-only", allowedTools: ["goalManage", "compressionRecall", "read", "bash"], maxToolCalls: 12 };
const principal = { version: 1, kind: "user", userId: "owner", spaceId: "space", grantId: "grant" };

beforeAll(async () => { database = await createPostgresTestDatabase("goal_compaction"); });
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    await resource.server?.close();
    if (resource.plugins.state === "started") await resource.plugins.stop();
  }
});
afterAll(async () => { await database.close(); });

async function setup({ engine = null, generateText = vi.fn(async () => summary), stateStore = null } = {}) {
  const spaceId = database.nextSpaceId();
  const runs = new PostgresRunStore(database.pool, { spaceId });
  const state = stateStore || await new PostgresWorkbenchStateStore(database.pool, { spaceId }).initialize();
  const plugins = new RuntimePluginService({
    pluginRoots: [root], enabledPluginIds: ["dev.goal", "dev.context-compression"], stateStore: state,
    configByPluginId: {
      "dev.goal": { runStore: runs },
      "dev.context-compression": { runStore: runs, modelService: { generateText } }
    }
  });
  const snapshot = await plugins.start();
  expect(snapshot.failures).toEqual([]);
  const tools = {
    async listTools(request) { return [...await plugins.listTools(request),
      { name: "read", execution: { effect: "read", idempotency: "safe" } },
      { name: "bash", execution: { effect: "process", idempotency: "reconcile" } }]; },
    invoke: vi.fn(async (invocation, signal) => plugins.hasTool(invocation.toolCall.name)
      ? await plugins.invoke(invocation, signal) : { ok: true, content: "observed" })
  };
  const executor = createAgentExecutor({
    engine: engine || { id: "test", async *streamTurn() { yield { type: "message.delta", delta: "done" }; } },
    runs, tools, contexts: plugins.getContextProviders(), controllers: plugins.getRunControllers()
  });
  const resource = { plugins, runs, state, tools, executor, generateText };
  resources.push(resource);
  return resource;
}
const goalStatus = (resource, sessionId = "session", actor = principal) => resource.plugins.invokeCommand(
  "dev.goal", { action: "status" }, { sessionId, principal: actor });
const request = (goal = null) => ({
  sessionId: "session", principal, messages: [{ role: "user", content: "完成代码修改" }],
  policy, ...(goal ? { metadata: { goal } } : {})
});
const finish = (executor, input) => executor.execute(input).completion;
// HTTP lifecycle transitions include multiple PostgreSQL commits and hooks.
// Keep a bounded wait for the authoritative state on slower CI runners.
const waitForLifecycle = (assertion) => vi.waitFor(assertion, { timeout: 5000 });
const call = (id, action, extra = {}) => ({ type: "tool.call",
  call: { id, name: "goalManage", arguments: { action, ...extra } } });

describe("Persistent goal lifecycle", () => {
  it("returns bounded persisted Goal records and output pages only within the owner/session scope", async () => {
    const resource = await setup({ engine: { id: "records", async *streamTurn() {
      yield { type: "message.delta", delta: "实际产物\n" + "x".repeat(13000) };
    }}});
    const result = await finish(resource.executor, request({ action: "start", objective: "可复核的目标" }));
    const inspect = (args, actor = principal, sessionId = "session") => resource.plugins.invokeCommand(
      "dev.goal", { action: "status", ...args }, { sessionId, principal: actor });
    const page = await inspect({ view: "records" });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ id: result.runId, status: "completed" });
    expect(page.records[0].preview.length).toBeLessThanOrEqual(240);
    expect(page.records[0]).not.toHaveProperty("policy");
    expect(page.records[0]).not.toHaveProperty("principal");
    const first = await inspect({ view: "run", runId: result.runId });
    expect(first.output).toHaveLength(6000);
    expect(first.nextOffset).toBe(6000);
    const second = await inspect({ view: "run", runId: result.runId, offset: first.nextOffset });
    expect(second.output).toHaveLength(6000);
    expect(second.offset).toBe(6000);
    expect(await inspect({ view: "records" }, { ...principal, userId: "other" })).toBeNull();
    expect(await inspect({ view: "run", runId: result.runId }, principal, "other-session")).toBeNull();
    await expect(inspect({ view: "run", runId: "foreign-run" })).rejects.toMatchObject({ statusCode: 404 });
    // Even an accidentally linked record cannot expose a foreign Session's payload.
    const original = await resource.runs.get(result.runId);
    await database.pool.query("UPDATE runtime_runs SET payload_json = $1::jsonb WHERE space_id = $2 AND id = $3",
      [JSON.stringify({ ...original, sessionId: "foreign-session" }), resource.runs.spaceId, result.runId]);
    expect((await inspect({ view: "records" })).records[0].status).toBe("unavailable");
    await expect(inspect({ view: "run", runId: result.runId })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("leaves ordinary chat as one Run and requires explicit activation", async () => {
    const resource = await setup();
    expect((await finish(resource.executor, request())).status).toBe("completed");
    expect(await goalStatus(resource)).toBeNull();
    expect((await resource.runs.listRuns()).length).toBe(1);
    const delegated = await finish(resource.executor, {
      ...request({ action: "start", objective: "模型生成的子任务" }),
      principal: { ...principal, kind: "service" }
    });
    expect(delegated).toMatchObject({ status: "failed", error: "Goal activation requires an explicit user Run" });
    expect(await goalStatus(resource)).toBeNull();
  });

  it("continues natural Stop, accepts criterion evidence, and retains the complete objective", async () => {
    let turns = 0;
    const resource = await setup({ engine: { id: "goal", async *streamTurn(input) {
      turns++;
      expect(input.messages.some((message) => String(message.content).includes("完整目标：保留所有约束"))).toBe(true);
      if (turns === 2) yield call("progress", "progress", { note: "代码已修改，测试已运行" });
      else if (turns === 3) yield call("complete", "complete", { evidence: [{ criterion: 0, reference: "src/a.ts 与测试运行记录，全部通过" }] });
      else yield { type: "message.delta", delta: turns === 1 ? "我接下来会修改。" : "已完成。" };
    }}});
    const result = await finish(resource.executor, request({ action: "start", objective: "完整目标：保留所有约束", tokenBudget: 10000 }));
    expect(result.status).toBe("completed");
    expect(turns).toBe(4);
    expect(await goalStatus(resource)).toMatchObject({ status: "completed", objective: "完整目标：保留所有约束",
      evidenceSource: "model-report", cycles: 1 });
  });

  it("stops stalled goals and budgets without marking them completed", async () => {
    let attemptSideEffect = false;
    const resource = await setup({ engine: { id: "stall", async *streamTurn() {
      yield { type: "model.usage", usage: { inputTokens: 50, outputTokens: 50 } };
      yield { type: "message.delta", delta: "继续。" };
      if (attemptSideEffect) yield { type: "tool.call", call: {
        id: "budget-side-effect", name: "bash", arguments: { command: "publish" }
      }};
    }}});
    await finish(resource.executor, request({ action: "start", objective: "不能完成就继续" }));
    expect(await goalStatus(resource)).toMatchObject({ status: "blocked", stalls: 3 });
    await resource.plugins.invokeCommand("dev.goal", { action: "cancel" }, { sessionId: "session", principal });
    attemptSideEffect = true;
    const budgetRequest = request({ action: "start", objective: "有限预算", tokenBudget: 100 });
    const budgetResult = await finish(resource.executor, budgetRequest);
    await resource.plugins.getRunControllers()[0].afterRun({ runId: budgetResult.runId, request: budgetRequest, result: budgetResult });
    expect(await goalStatus(resource)).toMatchObject({ status: "budget_exhausted", tokenUsage: 100 });
    expect(resource.tools.invoke).not.toHaveBeenCalled();
  });

  it("does not count rewritten progress notes or repeated identical reads as new progress", async () => {
    const resource = await setup();
    const [controller] = resource.plugins.getRunControllers();
    const ctx = { runId: "novelty", request: request({ action: "start", objective: "实际推进" }),
      tools: [{ name: "goalManage" }, { name: "read", execution: { effect: "read" } }], usage: {}, turn: 1 };
    await controller.beforeStart(ctx);
    for (let turn = 1; turn <= 4; turn++) {
      ctx.turn = turn;
      await controller.afterTool({ invocationId: `read-${turn}`,
        toolCall: { id: `read-${turn}`, name: "read", arguments: { path: "/same" } } },
      { ok: true, content: "identical facts" }, ctx);
      await resource.plugins.invoke({ runId: ctx.runId, sessionId: "session", principal, policy,
        toolCall: { name: "goalManage", arguments: {
          action: "progress", note: `继续工作 ${turn}`, nextAction: "检查下一项", plan: ["核验", "交付"],
          evidence: [{ criterion: 0, reference: "相同文件与相同验证记录" }]
        }} }, new CancellationController().signal);
      await controller.beforeStop(ctx);
    }
    expect(await goalStatus(resource)).toMatchObject({ status: "blocked", stalls: 3,
      nextAction: "检查下一项", plan: ["核验", "交付"] });
  });

  it("amends only a stopped goal, preserves the original objective and clears outdated acceptance evidence", async () => {
    const resource = await setup();
    const [controller] = resource.plugins.getRunControllers();
    const ctx = { runId: "amend", request: request({ action: "start", objective: "原始完整目标" }),
      tools: [{ name: "goalManage" }], usage: {} };
    await controller.beforeStart(ctx);
    const amend = () => resource.plugins.invokeCommand("dev.goal", { action: "amend", objective: "用户更正后的目标" },
      { sessionId: "session", principal });
    await expect(amend()).rejects.toThrow("Pause");
    await resource.plugins.invokeCommand("dev.goal", { action: "pause" }, { sessionId: "session", principal });
    await expect(amend()).rejects.toThrow("Pause");
    await controller.afterRun({ runId: ctx.runId, request: ctx.request, result: { status: "aborted", reason: "user", usage: {} } });
    expect(await amend()).toMatchObject({ status: "paused", objective: "用户更正后的目标",
      criteria: ["用户更正后的目标"], evidence: [], objectiveHistory: [{ objective: "原始完整目标" }] });
  });

  it("pauses an in-flight model through the same CancellationSignal", async () => {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const resource = await setup({ engine: { id: "wait", async *streamTurn(input) {
      started();
      await new Promise((resolve) => input.signal.onCancel(resolve));
      input.signal.throwIfCancelled();
    }}});
    const handle = resource.executor.execute(request({ action: "start", objective: "需要暂停的任务" }));
    await ready;
    await resource.plugins.invokeCommand("dev.goal", { action: "pause" }, {
      sessionId: "session", principal, activeRunId: handle.runId, abort: (reason) => handle.abort(reason)
    });
    expect((await handle.completion).status).toBe("aborted");
    expect(await goalStatus(resource)).toMatchObject({ status: "paused", reason: "user-pause" });
  });

  it("pauses the active Session Run through the HTTP Goal command", async () => {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const resource = await setup({ engine: { id: "http-pause", async *streamTurn(input) {
      started();
      await new Promise((resolve) => input.signal.onCancel(resolve));
      input.signal.throwIfCancelled();
    }}});
    resource.server = createRuntimeServer({ executor: resource.executor, runs: resource.runs,
      runControllers: () => resource.plugins.getRunControllers(),
      pluginCommands: (id, args, ctx) => resource.plugins.invokeCommand(id, args, ctx) });
    const { url } = await resource.server.start();
    const initial = await fetch(`${url}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request({ action: "start", objective: "通过标题栏暂停" }), maxTurns: 1 }) });
    expect(initial.status).toBe(202);
    await ready;
    const response = await fetch(`${url}/v1/plugins/dev.goal/commands`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause", sessionId: "session" })
    });
    expect(response.status).toBe(200);
    await waitForLifecycle(async () => {
      expect(await goalStatus(resource, "session", null)).toMatchObject({
        status: "paused", reason: "user-pause", activeRunId: null
      });
    });
    expect((await resource.runs.listRuns())[0]).toMatchObject({ status: "aborted", terminalReason: "goal:user-pause" });
  });

  it("charges summary usage to the goal and stops before another model request exceeds the budget", async () => {
    const model = vi.fn();
    const resource = await setup({
      generateText: vi.fn(async ({ onUsage }) => {
        onUsage({ inputTokens: 120, outputTokens: 10 });
        return summary;
      }),
      engine: { id: "budget", async *streamTurn() { model(); yield { type: "message.delta", delta: "unexpected" }; } }
    });
    await resource.state.writeKV("runtime.plugins.dev.context-compression.compression.settings", {
      contextLimitTokens: 16000, outputTokens: 512, threshold: .5
    });
    const input = { ...request({ action: "start", objective: "长任务与摘要共享预算", tokenBudget: 100 }), messages: longHistory() };
    const result = await finish(resource.executor, input);
    expect(result).toMatchObject({ status: "aborted", reason: "goal:token-budget" });
    expect(model).not.toHaveBeenCalled();
    await resource.plugins.getRunControllers()[0].afterRun({ runId: result.runId, request: input, result });
    expect(await goalStatus(resource)).toMatchObject({ status: "budget_exhausted", tokenUsage: 130 });
  });

  it("isolates owner/Session state and restores an interrupted goal after host restart", async () => {
    const resource = await setup();
    await finish(resource.executor, { ...request({ action: "start", objective: "跨重启的目标" }), maxTurns: 1 });
    expect(await goalStatus(resource)).toMatchObject({ status: "active" });
    expect(await goalStatus(resource, "session", { ...principal, userId: "other" })).toBeNull();
    expect(await goalStatus(resource, "session", { ...principal, spaceId: "other" })).toBeNull();
    expect(await goalStatus(resource, "other")).toBeNull();
    await resource.plugins.stop();
    const restored = await setup({ stateStore: resource.state });
    expect(await goalStatus(restored)).toMatchObject({ status: "interrupted", reason: "runtime-restarted", objective: "跨重启的目标" });
  });

  it("blocks the same uncertain operation across Runs without invoking the tool again", async () => {
    const resource = await setup();
    const [controller] = resource.plugins.getRunControllers();
    const ctx = { runId: "run-a", request: request({ action: "start", objective: "一次副作用" }),
      tools: [{ name: "goalManage" }, { name: "bash", execution: { effect: "process", idempotency: "reconcile" } }],
      messages: [], usage: {}, turn: 1 };
    await controller.beforeStart(ctx);
    const invocation = { runId: ctx.runId, invocationId: "op-a", toolCall: { id: "call-a", name: "bash", arguments: { command: "publish", cwd: "/tmp" } } };
    expect(await controller.beforeTool(invocation, ctx)).toBeUndefined();
    await controller.afterTool(invocation, { ok: false, content: "unknown", failureCode: "execution_outcome_unknown" }, ctx);
    await controller.afterRun({ runId: ctx.runId, request: ctx.request, result: { status: "completed", usage: {} } });
    const next = { ...ctx, runId: "run-b", request: { ...ctx.request, metadata: { goal: { action: "continue", id: (await goalStatus(resource)).id } } } };
    await controller.beforeStart(next);
    // Different key ordering must still refer to the same operation.
    const repeated = await controller.beforeTool({ ...invocation, runId: "run-b", invocationId: "op-b",
      toolCall: { ...invocation.toolCall, id: "call-b", arguments: { cwd: "/tmp", command: "publish" } } }, next);
    expect(repeated).toMatchObject({ ok: false, failureCode: "execution_outcome_unknown", retryable: false });
    expect(resource.tools.invoke).not.toHaveBeenCalled();
    await controller.continuationFailed({ request: ctx.request, error: new Error("A newer user Run won admission") });
    expect(await goalStatus(resource)).toMatchObject({ status: "active", activeRunId: "run-b" });
  });

  it("admits subsequent Runs on the server and persists their canonical transcript", async () => {
    let turn = 0;
    const resource = await setup({ engine: { id: "http-goal", async *streamTurn() {
      turn++;
      if (turn === 2) yield call("done", "complete", { evidence: [{ criterion: 0, reference: "实际检查的代码与输出记录" }] });
      else yield { type: "message.delta", delta: `阶段 ${turn}` };
    }}});
    resource.server = createRuntimeServer({ executor: resource.executor, runs: resource.runs,
      runControllers: () => resource.plugins.getRunControllers(),
      pluginCommands: (id, args, ctx) => resource.plugins.invokeCommand(id, args, ctx) });
    const { url } = await resource.server.start();
    const response = await fetch(`${url}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request({ action: "start", objective: "HTTP 持续目标" }), maxTurns: 1 }) });
    expect(response.status).toBe(202);
    await waitForLifecycle(async () => {
      // beforeStop records Goal completion; afterRun clears its live Run only
      // after the server has finalized the canonical Session transcript.
      expect(await goalStatus(resource, "session", null)).toMatchObject({
        status: "completed", cycles: 2, activeRunId: null
      });
    });
    const transcript = await resource.runs.getSessionTranscript("session");
    expect(transcript.filter((message) => message.role === "user")).toHaveLength(2);
    expect(transcript.some((message) => message.role === "tool" && message.toolCallId === "done")).toBe(true);
    expect((await resource.runs.listRuns()).length).toBe(2);
  });

  it("resumes through the scoped command with prior model/target, excludes draft input and fences duplicate admission", async () => {
    let resume = false, releaseModel, resumedInput;
    const waiting = new Promise((resolve) => { releaseModel = resolve; });
    const resource = await setup({ engine: { id: "resume", async *streamTurn(input) {
      if (resume) {
        resumedInput = input;
        await waiting;
        yield call("resume-complete", "complete", { evidence: [{ criterion: 0, reference: "核验过的输出与文件记录" }] });
      } else yield { type: "message.delta", delta: "暂未取得进展" };
    }}});
    const projection = { prepareRun: vi.fn() };
    const authorizeRunRequest = vi.fn(async (_principal, input) => ({ ...input, principal }));
    const authorizeExistingRun = vi.fn();
    resource.server = createRuntimeServer({ executor: resource.executor, runs: resource.runs,
      sessionDocumentService: projection,
      accessControl: { authorizeRuntimeRequest: async () => principal,
        requireScope: vi.fn(), authorizeExistingRun, authorizeRunRequest, authorizeRunExecution: vi.fn() },
      interactionProfiles: { get: () => ({ id: "test", policy }) },
      runControllers: () => resource.plugins.getRunControllers(),
      pluginCommands: (id, args, ctx) => resource.plugins.invokeCommand(id, args, ctx) });
    const { url } = await resource.server.start();
    const post = (path, body) => fetch(`${url}${path}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const initial = await post("/v1/runs", { ...request({ action: "start", objective: "继续已授权目标" }),
      model: { providerId: "test", modelId: "model-a" }, modelOptions: { thinkingEffort: "low" },
      target: { nodeId: "device-a" } });
    expect(initial.status).toBe(202);
    await waitForLifecycle(async () => expect(await goalStatus(resource)).toMatchObject({ status: "blocked", activeRunId: null }));
    resume = true;
    const response = await post("/v1/plugins/dev.goal/commands", { action: "resume", sessionId: "session",
      messages: [{ role: "user", content: "未发送的草稿不能成为输入" }] });
    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({ status: "accepted" });
    await waitForLifecycle(() => expect(resumedInput).toBeDefined());
    expect(resumedInput).toMatchObject({ model: { providerId: "test", modelId: "model-a" },
      modelOptions: { thinkingEffort: "low" } });
    expect(authorizeRunRequest.mock.calls.at(-1)[1]).toMatchObject({ target: { nodeId: "device-a" } });
    expect(JSON.stringify(resumedInput.messages)).not.toContain("未发送的草稿");
    expect(projection.prepareRun).toHaveBeenLastCalledWith("session", expect.objectContaining({ forceNewUser: true }));
    expect(authorizeExistingRun).toHaveBeenCalledWith(principal, expect.any(Object), { allowRevoked: true });
    expect(authorizeRunRequest).toHaveBeenCalledTimes(2);
    expect((await post("/v1/plugins/dev.goal/commands", { action: "resume", sessionId: "session" })).status).toBe(409);
    releaseModel();
    await waitForLifecycle(async () => expect(await goalStatus(resource)).toMatchObject({ status: "completed", activeRunId: null }));
    expect((await resource.runs.listRuns()).length).toBe(2);
  });
});

function longHistory() {
  const messages = [{ role: "system", content: "不可改写的系统规则" },
    { role: "user", content: "原始目标：修改代码，不要部署" }];
  for (let index = 0; index < 16; index++) {
    messages.push({ role: "assistant", content: `历史 ${index} ${"a".repeat(2000)}` });
  }
  messages.push({ role: "assistant", content: "", toolCalls: [{
    id: "failed", type: "function", function: { name: "bash", arguments: "{}" }
  }] }, { role: "tool", toolCallId: "failed", content: "execution_outcome_unknown: handle-42",
    toolResultStatus: { ok: false, failureCode: "execution_outcome_unknown" } });
  for (let index = 0; index < 6; index++) messages.push({ role: "assistant", content: `近期 ${index}` });
  messages.push({ role: "user", content: "更正：保留中文输出，先核验 handle-42" });
  return messages;
}
const compressionContext = (input = {}) => ({ runId: "run", attemptId: "attempt", turn: 2,
  request: request(), signal: new CancellationController().signal, tools: [], ...input });

describe("Durable model handoff", () => {
  it("prunes only durably recorded successful outputs and provides scoped paged recovery", async () => {
    const resource = await setup();
    await resource.state.writeKV("runtime.plugins.dev.context-compression.compression.settings", {
      contextLimitTokens: 64000, outputTokens: 512, threshold: .5
    });
    await resource.runs.create({ id: "outputs", attemptId: "attempt", sessionId: "session", principal,
      status: "running", title: "", policy, metadata: {}, createdAt: Date.now(), updatedAt: Date.now() });
    const messages = [{ role: "user", content: "检查输出" }];
    for (let index = 0; index < 10; index++) {
      const assistant = { role: "assistant", content: "", toolCalls: [{
        id: `output-${index}`, type: "function", function: { name: "read", arguments: "{}" }
      }] };
      const output = { role: "tool", toolCallId: `output-${index}`, content: `${index}:${"x".repeat(9000)}`,
        toolResultStatus: { ok: true } };
      messages.push(assistant, output);
      for (const [ordinal, message] of [assistant, output].entries()) await resource.runs.appendTranscript({
        schemaVersion: 1, id: `entry-${index}-${ordinal}`, runId: "outputs", attemptId: "attempt",
        turn: index + 1, ordinal, createdAt: Date.now(), ...message
      });
    }
    messages.push({ role: "user", content: "继续检查" });
    const provider = resource.plugins.getContextProviders().find((item) => item.id === "dev.context-compression");
    const result = await provider.contribute(messages, compressionContext({ runId: "outputs",
      tools: [{ name: "compressionRecall" }] }));
    const pruned = result.find((message) => message.role === "tool" && message.content.includes('"recovery"'));
    expect(pruned).toBeDefined();
    const locator = JSON.parse(pruned.content);
    const invoke = (actor) => resource.plugins.invoke({ runId: "outputs", attemptId: "attempt", sessionId: "session",
      principal: actor, policy, toolCall: { name: "compressionRecall", arguments: {
        outputId: locator.recovery.outputId, offset: 600, length: 120
      } } }, new CancellationController().signal);
    expect(JSON.parse((await invoke(principal)).content)).toMatchObject({
      status: { ok: true }, offset: 600, totalChars: 9002, content: "x".repeat(120)
    });
    await expect(invoke({ ...principal, userId: "other" })).rejects.toThrow("not found");
    expect((await resource.runs.getTranscript("outputs")).filter((entry) => entry.role === "tool")[0].content.length).toBe(9002);
    expect(resource.generateText).not.toHaveBeenCalled();
  });

  it("preserves system, latest correction, unknown facts and pairing; reuses the checkpoint across host restart", async () => {
    const resource = await setup();
    await resource.state.writeKV("runtime.plugins.dev.context-compression.compression.settings", {
      autoCompression: true, contextLimitTokens: 16000, outputTokens: 512, threshold: .5
    });
    const provider = resource.plugins.getContextProviders().find((item) => item.id === "dev.context-compression");
    const durable = longHistory();
    await resource.runs.createSession({ id: "session", title: "历史状态", status: "active",
      policy, metadata: {}, createdAt: Date.now(), updatedAt: Date.now() });
    await resource.runs.saveSessionSeedTranscript("session", durable, Date.now());
    // The HTTP admission layer strips client-supplied status; recover matching durable facts.
    const messages = durable.map(({ toolResultStatus: _status, ...message }) => message);
    const before = JSON.stringify(messages);
    const result = await provider.contribute(messages, compressionContext());
    expect(JSON.stringify(messages)).toBe(before);
    expect(result[0]).toEqual(messages[0]);
    expect(result.at(-1)).toEqual(messages.at(-1));
    expect(JSON.stringify(result)).toContain("handle-42");
    expect(resource.generateText).toHaveBeenCalled();
    const count = resource.generateText.mock.calls.length;
    const repeated = await provider.contribute(messages, compressionContext());
    expect(repeated).toEqual(result);
    expect(resource.generateText).toHaveBeenCalledTimes(count);
    await resource.plugins.stop();
    const restored = await setup({ stateStore: resource.state, generateText: resource.generateText });
    const restoredProvider = restored.plugins.getContextProviders().find((item) => item.id === "dev.context-compression");
    expect(await restoredProvider.contribute(messages, compressionContext())).toEqual(result);
    expect(resource.generateText).toHaveBeenCalledTimes(count);
    const extended = [...messages, ...Array.from({ length: 12 }, (_, index) => ({
      role: "assistant", content: `新增历史 ${index} ${"b".repeat(2000)}`
    })), { role: "user", content: "继续保留目标与中文约束" }];
    const incremental = await restoredProvider.contribute(extended, compressionContext());
    const mergedCalls = resource.generateText.mock.calls.length;
    expect(mergedCalls).toBeGreaterThan(count);
    expect(incremental.at(-1)).toEqual(extended.at(-1));
    expect(await restoredProvider.contribute(extended, compressionContext())).toEqual(incremental);
    expect(resource.generateText).toHaveBeenCalledTimes(mergedCalls);
  });

  it("retains the original context on malformed summary and parent cancellation", async () => {
    const generateText = vi.fn(async ({ signal }) => { signal.throwIfCancelled(); return '{"intent":[]}'; });
    const resource = await setup({ generateText });
    await resource.state.writeKV("runtime.plugins.dev.context-compression.compression.settings", {
      contextLimitTokens: 16000, outputTokens: 512, threshold: .5
    });
    const provider = resource.plugins.getContextProviders().find((item) => item.id === "dev.context-compression");
    await expect(provider.contribute(longHistory(), compressionContext())).rejects.toThrow("Invalid handoff");
    const key = workflowScope({ request: request() }).key;
    expect((await resource.state.readKV(`runtime.plugins.dev.context-compression.private.${key}`)).value.checkpoint).toBeUndefined();
    const cancellation = new CancellationController();
    cancellation.cancel("user");
    await expect(provider.contribute(longHistory(), compressionContext({ signal: cancellation.signal }))).rejects.toThrow("cancelled");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("runs manual compact through the same Runtime pipeline without editing the Session history", async () => {
    const resource = await setup();
    await resource.state.writeKV("runtime.plugins.dev.context-compression.compression.settings", {
      contextLimitTokens: 16000, outputTokens: 512
    });
    const seed = longHistory();
    await resource.runs.createSession({ id: "manual", title: "手动压缩", status: "active",
      policy, metadata: {}, createdAt: Date.now(), updatedAt: Date.now() });
    await resource.runs.saveSessionSeedTranscript("manual", seed, Date.now());
    resource.server = createRuntimeServer({ executor: resource.executor, runs: resource.runs,
      pluginCommands: (id, args, ctx) => resource.plugins.invokeCommand(id, args, ctx) });
    const { url } = await resource.server.start();
    const before = await resource.runs.getSessionTranscript("manual");
    const response = await fetch(`${url}/v1/plugins/dev.context-compression/commands`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "manual", action: "compact" })
    });
    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({ mode: "manual", status: "completed", summaryCalls: 1 });
    expect(resource.generateText).toHaveBeenCalled();
    expect(await resource.runs.getSessionTranscript("manual")).toEqual(before);
  });

  it("excludes private workflow state from snapshots and direct KV reads", async () => {
    const resource = await setup();
    const key = "runtime.plugins.dev.goal.private.owner";
    await resource.state.writeKV(key, { objective: "私有目标" });
    resource.server = createRuntimeServer({ executor: resource.executor, runs: resource.runs,
      serviceHttpHandlers: [createWorkbenchStateHttpHandler({ store: resource.state })] });
    const { url } = await resource.server.start();
    const snapshot = await (await fetch(`${url}/v1/workbench-state/snapshot`)).json();
    expect(snapshot.snapshot.kv[key]).toBeUndefined();
    expect((await fetch(`${url}/v1/workbench-state/kv/${key}`)).status).toBe(404);
    expect((await fetch(`${url}/v1/workbench-state/kv/${key}`, { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ value: {} }) })).status).toBe(409);
  });
});
