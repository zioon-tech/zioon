import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { createRuntimeServer } from "../src/server.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { createRunCompletionWorker } from "../src/run-completion-worker.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import * as Y from "yjs";
import { createSessionDocumentProjector } from "../../../extensions/dev.session-manager/session-document-projector.js";
import { createHttpRuntimeClient, createRemoteRunHandle } from "../../../src/runtime/http-runtime-client.ts";

let database;
beforeAll(async () => { database = await createPostgresTestDatabase("completion"); });
afterAll(async () => { await database.close(); });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function executor(runs) {
  return createAgentExecutor({
    runs, tools: { listTools: async () => [], invoke: async () => { throw new Error("no tools"); } },
    engine: { id: "fixture", async *streamTurn() { yield { type: "message.delta", delta: "answer" }; } }
  });
}
async function fixture(options = {}) {
  const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
  const errors = [];
  const { executorFactory = executor, ...serverOptions } = options;
  const server = createRuntimeServer({ runs, executor: executorFactory(runs), port: 0,
    onPostProcessorError: (error, meta) => errors.push({ error, meta }), ...serverOptions });
  const { url } = await server.start();
  const submit = async (content, projection = { mode: "final" }) => {
    const response = await fetch(`${url}/v1/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "doc", messages: [{ role: "user", content }],
        conversationInput: { schemaVersion: 1, mode: "snapshot", clientRequestId: content },
        metadata: { documentProjection: projection } })
    });
    return { ...await response.json(), status: response.status };
  };
  return { runs, server, submit, errors, url };
}

describe("durable nonblocking completion", () => {
  it.each(["failed", "aborted"])("finishes a never-started %s request without requiring a document anchor", async status => {
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const now = Date.now(), id = "never-started-" + status;
    await runs.createSession({ id: "doc", title: "doc", status: "active", createdAt: now, updatedAt: now });
    await runs.create({ id, attemptId: "attempt", status: "created", sessionId: "doc", output: "",
      metadata: { documentProjection: { mode: "live", anchor: {} } }, createdAt: now, updatedAt: now });
    await runs.append({ schemaVersion: 1, eventId: id, runId: id, attemptId: "attempt",
      sequence: 1, type: status === "failed" ? "run.failed" : "run.aborted", timestamp: now, data: {} }, { status });
    const prepareRun = vi.fn(() => { throw new Error("missing anchor"); }), replay = vi.fn();
    const server = createRuntimeServer({ runs, executor: executor(runs), port: 0,
      sessionDocumentService: { prepareRun, applyRunEvents: replay } });
    try {
      await server.start();
      await vi.waitFor(async () => expect((await runs.completionTaskState(id, "attempt")).status).toBe("completed"));
      expect((await runs.completionTaskState(id, "attempt")).completedSteps).toContain("runtime.document");
      expect(prepareRun).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
      expect((await runs.get(id)).status).toBe(status);
    } finally { await server.close(); }
  });

  it("retries failed snapshot preparation without reporting completed execution as failed", async () => {
    let prepared = false;
    const prepareRun = vi.fn()
      .mockRejectedValueOnce(new Error("temporary document failure"))
      .mockImplementation(async () => { prepared = true; });
    const replay = vi.fn(async () => { expect(prepared).toBe(true); });
    const f = await fixture({
      sessionDocumentService: { prepareRun, applyRunEvent() {}, applyRunEvents: replay }
    });
    try {
      const submitted = await f.submit("preparation retry", { mode: "live" });
      expect(submitted.status).toBe(202);
      await vi.waitFor(() => expect(replay).toHaveBeenCalled());
      await vi.waitFor(() => expect(f.server.isIdle()).toBe(true));
      expect((await f.runs.get(submitted.runId)).status).toBe("completed");
      expect(f.errors.some(({ meta }) => meta.processorId === "runtime.collaboration-preparation")).toBe(true);
      expect((await f.runs.getEvents(submitted.runId)).some(event => event.type === "run.failed")).toBe(false);
    } finally { await f.server.close(); }
  });

  it("stores ordered context timing on the model request without changing selected context", async () => {
    const f = await fixture({
      executorFactory: runs => createAgentExecutor({
        runs, tools: { listTools: async () => [], invoke() {} },
        contexts: [
          { id: "disabled", contribute: vi.fn(() => { throw new Error("disabled provider ran"); }) },
          { id: "pre", order: 1, prepare: async () => [{ role: "system", content: "profile" }] },
          { id: "post", stage: "post", contribute: async messages => [...messages, { role: "system", content: "selected skills" }] }
        ],
        engine: { id: "context-timing", async *streamTurn({ messages }) {
          expect(messages.map(message => message.content)).toEqual(["profile", "context timing", "selected skills"]);
          yield { type: "model.request", request: {
            url: "https://model.test", modelId: "fixture", stream: true, payload: { messages }
          } };
          yield { type: "message.delta", delta: "answer" };
        } }
      })
    });
    try {
      const client = createHttpRuntimeClient({ baseUrl: f.url });
      const handle = await createRemoteRunHandle(client, {
        prompt: "context timing", metadata: { contextProviders: { disabled: ["disabled"] } }
      }, { stopAtTerminal: true });
      for await (const event of handle.events) {}
      expect((await handle.completion).status).toBe("completed");
      const request = (await f.runs.getEvents(handle.runId)).find(event => event.type === "model.request");
      expect(request.data.contextTimings.map(({ providerId, stage }) => [providerId, stage])).toEqual([
        ["pre", "pre"], ["post", "post"]
      ]);
      expect(request.data.contextTimings.every(timing => timing.authorizationMs >= 0
        && timing.contributionMs >= 0 && timing.status === "completed")).toBe(true);
    } finally { await f.server.close(); }
  });

  it.each(["preparation", "projection"])("delivers receipt and live text while document %s is blocked", async stage => {
    const blocked = deferred();
    const entered = vi.fn();
    let prepared = false;
    const projected = [];
    const f = await fixture({
      sessionDocumentService: {
        async prepareRun() {
          if (stage === "preparation") { entered(); await blocked.promise; }
          prepared = true;
        },
        async applyRunEvent(_sessionId, event) {
          expect(prepared).toBe(true);
          if (stage === "projection" && event.type === "run.started") {
            entered(); await blocked.promise;
          }
          projected.push(event.sequence);
        }
      }
    });
    const abort = new AbortController();
    try {
      const first = await f.submit(`blocked-${stage}`, { mode: "live" });
      expect(first.status).toBe(202);
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      expect((await f.runs.getRunConversationInput(first.runId)).messages[0].content).toBe(`blocked-${stage}`);
      const events = [];
      const client = createHttpRuntimeClient({ baseUrl: f.url });
      for await (const event of client.subscribe(first.runId, { signal: abort.signal })) {
        events.push(event);
        if (event.type === "run.completed") break;
      }
      expect(events.find(event => event.type === "message.delta")?.data.delta).toBe("answer");
      if (stage === "preparation") expect(projected).toEqual([]);
      blocked.resolve();
      await vi.waitFor(() => expect(f.server.isIdle()).toBe(true));
      expect(projected).toEqual([...projected].sort((a, b) => a - b));
      expect(projected.length).toBeGreaterThan(0);
    } finally { abort.abort(); blocked.resolve(); await f.server.close(); }
  }, 10_000);

  it("delivers first text before slow timing persistence and joins the writes before completion", async () => {
    const blocked = deferred();
    const entered = vi.fn();
    const f = await fixture({
      executorFactory: runs => {
        const append = runs.append.bind(runs);
        runs.append = async (...args) => {
          if (args[0].type === "model.timing") { entered(); await blocked.promise; }
          return append(...args);
        };
        return createAgentExecutor({
          runs, tools: { listTools: async () => [], invoke() {} },
          engine: { id: "timing", async *streamTurn() {
            yield { type: "model.timing", timing: {
              phase: "first-answer", requestStartedAt: Date.now(), elapsedMs: 1
            } };
            yield { type: "message.delta", delta: "immediate" };
          } }
        });
      }
    });
    let handle;
    try {
      handle = await createRemoteRunHandle(createHttpRuntimeClient({ baseUrl: f.url }), {
        prompt: "timing persistence", sessionId: "doc"
      }, { stopAtTerminal: true });
      const iterator = handle.events[Symbol.asyncIterator]();
      let first;
      while ((first = await iterator.next()).value?.type !== "message.delta") {
        expect(first.done).toBe(false);
      }
      expect(entered).toHaveBeenCalled();
      expect(first.value.data.delta).toBe("immediate");
      expect((await f.runs.get(handle.runId)).status).toBe("running");
      blocked.resolve();
      while (!(await iterator.next()).done) {}
      expect((await handle.completion).status).toBe("completed");
      expect((await f.runs.getEvents(handle.runId)).some(event => event.type === "model.timing")).toBe(true);
    } finally { blocked.resolve(); handle?.detach(); await f.server.close(); }
  }, 10_000);

  it("closes interactive observation at execution completion while projection remains blocked", async () => {
    const blocked = deferred();
    const f = await fixture({
      sessionDocumentService: {
        prepareRun() {}, async applyRunEvent() { await blocked.promise; }
      }
    });
    let handle;
    try {
      handle = await createRemoteRunHandle(createHttpRuntimeClient({ baseUrl: f.url }), {
        prompt: "close observation", sessionId: "doc"
      }, { stopAtTerminal: true });
      const events = [];
      for await (const event of handle.events) events.push(event);
      expect(events.at(-1).type).toBe("run.completed");
      expect((await handle.completion).status).toBe("completed");
      expect(f.server.isIdle()).toBe(false);
      blocked.resolve();
      await vi.waitFor(() => expect(f.server.isIdle()).toBe(true));
    } finally { blocked.resolve(); handle?.detach(); await f.server.close(); }
  }, 10_000);

  it("recovers completion work without an HTTP listener and starts it only once", async () => {
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const handle = executor(runs).execute({ prompt: "gateway restart recovery" });
    await handle.completion;
    const processed = vi.fn();
    const server = createRuntimeServer({
      runs, executor: executor(runs),
      runPostProcessors: [{ id: "recovered", process: processed }]
    });
    try {
      expect(server.address()).toBeNull();
      server.startBackgroundWork();
      server.startBackgroundWork();
      await vi.waitFor(() => expect(processed).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(server.isIdle()).toBe(true));
      expect(server.address()).toBeNull();
      expect(await runs.claimCompletionTask("verification")).toBeNull();
      const task = (await database.pool.query(
        "SELECT status,attempts,completed_steps FROM runtime_run_completion_tasks WHERE space_id=$1 AND run_id=$2",
        [runs.spaceId, handle.runId]
      )).rows[0];
      expect(task).toMatchObject({ status: "completed", attempts: 1, completed_steps: ["recovered"] });
    } finally { await server.close(); }
  });

  it("accepts new input while document projection and a post-processor are blocked", async () => {
    const projection = deferred();
    const processor = deferred();
    const entered = vi.fn();
    const f = await fixture({
      sessionDocumentService: { prepareRun() {}, applyRunEvent() {}, async applyRunEvents() { entered(); await projection.promise; } },
      runPostProcessors: [{ id: "memory", async process() { await processor.promise; } }]
    });
    try {
      const first = await f.submit("first");
      expect(first.status).toBe(202);
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      const second = await f.submit("second");
      expect(second.status).toBe(202);
      expect(second.runId).not.toBe(first.runId);
      expect((await f.runs.getRunConversationInput(first.runId)).messages[0].content).toBe("first");
      projection.resolve();
      processor.resolve();
      await vi.waitFor(() => expect(f.server.isIdle()).toBe(true));
    } finally { projection.resolve(); processor.resolve(); await f.server.close(); }
  });

  it("does not let a delayed continuation replace a newer completed user Run", async () => {
    const hook = deferred();
    const entered = vi.fn();
    const failed = vi.fn();
    let calls = 0;
    const f = await fixture({ runControllers: [{
      id: "continue", stages: ["afterRun"],
      async handle() {
        if (++calls !== 1) return { action: "pass" };
        entered();
        await hook.promise;
        return { action: "continue-run", instruction: "stale continuation" };
      },
      continuationFailed: failed
    }] });
    try {
      expect((await f.submit("first")).status).toBe(202);
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      const second = await f.submit("second");
      expect(second.status).toBe(202);
      await vi.waitFor(async () => expect((await f.runs.get(second.runId)).status).toBe("completed"));
      hook.resolve();
      await vi.waitFor(() => expect(failed).toHaveBeenCalled());
      expect(failed.mock.calls[0][0].error.code).toBe("CONTINUATION_SUPERSEDED");
      expect(await f.runs.listRuns()).toHaveLength(2);
      expect((await f.runs.getSessionTranscript("doc")).map(m => m.content)).toEqual(["second", "answer"]);
    } finally { hook.resolve(); await f.server.close(); }
  });

  it("recovers terminal work after a server restart without rerunning completed steps", async () => {
    let time = Date.now();
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId(), now: () => time });
    const handle = executor(runs).execute({ prompt: "recover" });
    await handle.completion;
    time = Date.now() + 1;
    const old = await runs.claimCompletionTask("old", 100);
    expect(old.run.status).toBe("completed");
    await runs.updateCompletionTask(old, { step: "already", leaseMs: 100 });
    expect(await runs.claimCompletionTask("other")).toBeNull();
    time += 101;
    const retry = vi.fn();
    const already = vi.fn();
    const restarted = new PostgresRunStore(database.pool, { spaceId: runs.spaceId, now: () => time });
    expect(await restarted.getRunInputMessages(handle.runId)).toEqual([{ role: "user", content: "recover" }]);
    expect((await restarted.get(handle.runId)).inputMessages).toBeUndefined();
    const worker = createRunCompletionWorker({ store: restarted,
      steps: async () => [{ id: "already", run: already }, { id: "retry", run: retry }] });
    worker.start();
    try {
      await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(worker.isIdle()).toBe(true));
      expect(already).not.toHaveBeenCalled();
      expect(retry.mock.calls[0][0]).toBe(`${handle.runId}:${handle.attemptId}:retry`);
      await expect(runs.updateCompletionTask(old, { complete: true })).rejects.toThrow("lease lost");
      expect(await restarted.claimCompletionTask("done")).toBeNull();
    } finally { await worker.close(); }
  });

  it("retries a failed step while preserving successful independent steps", async () => {
    let time = Date.now();
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId(), now: () => time });
    await executor(runs).execute({ prompt: "retry" }).completion;
    time = Date.now() + 1;
    const flaky = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined);
    const stable = vi.fn();
    const errors = vi.fn();
    const worker = createRunCompletionWorker({ store: runs, onError: errors,
      steps: async () => [{ id: "flaky", run: flaky }, { id: "stable", run: stable }] });
    worker.start();
    try {
      await vi.waitFor(() => { expect(stable).toHaveBeenCalledTimes(1); expect(worker.isIdle()).toBe(true); });
      time += 3_000;
      await worker.kick();
      await vi.waitFor(() => { expect(flaky).toHaveBeenCalledTimes(2); expect(worker.isIdle()).toBe(true); });
      expect(stable).toHaveBeenCalledTimes(1);
      expect(flaky.mock.calls[0][0]).toBe(flaky.mock.calls[1][0]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally { await worker.close(); }
  });

  it("persists the final tool-round answer while live document consumption is delayed", async () => {
    const blocked = deferred();
    const entered = vi.fn();
    const f = await fixture({
      executorFactory: runs => createAgentExecutor({
        runs,
        tools: { listTools: async () => [{ name: "lookup", description: "lookup", inputSchema: {} }],
          invoke: async () => ({ ok: true, content: "tool result" }) },
        engine: { id: "rounds", async *streamTurn({ turn }) {
          yield { type: "message.delta", delta: turn === 1 ? "intermediate" : "final" };
          if (turn === 1) yield { type: "tool.call",
            call: { id: "lookup-1", name: "lookup", arguments: {} } };
        } }
      }),
      sessionDocumentService: {
        prepareRun() {},
        async applyRunEvent(_id, event) {
          if (event.type === "message.completed") { entered(); await blocked.promise; }
        }
      }
    });
    try {
      // The test fixture's default read-only policy permits declared read tools.
      const submitted = await f.submit("question", { mode: "live" });
      expect(submitted.status).toBe(202);
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      await vi.waitFor(async () => expect((await f.runs.getSessionMessages("doc"))
        .findLast(message => message.role === "assistant")?.content).toBe("final"));
      expect((await f.runs.getTranscript(submitted.runId)).findLast(message => message.role === "assistant").content).toBe("final");
    } finally { blocked.resolve(); await f.server.close(); }
  });

  it("queues cancellation after waiting finalization, including restart recovery", async () => {
    let time = Date.now();
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId(), now: () => time });
    const document = new Y.Doc();
    document.getText("content").insert(0, "user question");
    const projector = createSessionDocumentProjector();
    const projection = { mode: "final", anchor: { fallback: { offset: 13, before: "user question", after: "" } } };
    await runs.create({ id: "waiting", attemptId: "attempt", status: "running",
      metadata: { documentProjection: projection },
      sessionId: "doc", createdAt: time, updatedAt: time });
    await runs.suspend({
      schemaVersion: 1, runId: "waiting", attemptId: "attempt", sequence: 1,
      eventId: "wait", type: "run.waiting", timestamp: time, data: {}
    }, { schemaVersion: 1, runId: "waiting", attemptId: "attempt", sequence: 1,
      messages: [{ role: "user", content: "question" }], output: "", usage: {}, createdAt: time },
    { id: "wait", reason: "approval" });
    const first = await runs.claimCompletionTask("first");
    projector.prepareRun({ document, runId: "waiting", mode: "final", documentAnchor: projection.anchor });
    projector.projectEvents({ document, runId: "waiting", events: await runs.getEvents("waiting") });
    expect(document.getMap("runProjection").get("waiting").status).toBe("waiting");
    await runs.updateCompletionTask(first, { step: "runtime.document" });
    await runs.updateCompletionTask(first, { complete: true });
    time += 1;
    expect(await runs.cancelWait({
      schemaVersion: 1, runId: "waiting", attemptId: "attempt", sequence: 2,
      eventId: "cancel", type: "run.aborted", timestamp: time, data: { reason: "user" }
    }, "wait")).toBe(true);
    const restarted = new PostgresRunStore(database.pool, { spaceId: runs.spaceId, now: () => time });
    const task = await restarted.claimCompletionTask("restarted");
    expect(task.run.status).toBe("aborted");
    expect(task.completedSteps).toEqual([]);
    expect(task.terminalSequence).not.toBe(first.terminalSequence);
    await expect(runs.updateCompletionTask(first, { complete: true })).rejects.toThrow("lease lost");
    await restarted.updateCompletionTask(task, { retryMs: 0 });
    await runs.createSession({ id: "doc", title: "doc", status: "active", createdAt: time, updatedAt: time });
    const applied = vi.fn((_id, input) => projector.projectEvents({ document, ...input }));
    const server = createRuntimeServer({ runs: restarted, executor: executor(restarted), port: 0,
      sessionDocumentService: {
        prepareRun(_id, input) { projector.prepareRun({ document, ...input }); },
        applyRunEvent() {}, applyRunEvents: applied
      } });
    try {
      await server.start();
      await vi.waitFor(() => expect(applied).toHaveBeenCalledOnce());
      expect(applied.mock.calls[0][1].events.at(-1).type).toBe("run.aborted");
      expect(document.getMap("runProjection").get("waiting").status).toBe("aborted");
    } finally { await server.close(); document.destroy(); }
  });

  it.each(["waiting", "interrupted"])("captures upgrade-era %s checkpoint context before completion deletes it", async status => {
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const now = Date.now();
    const messages = [{ role: "user", content: "original question" },
      { role: "assistant", content: "earlier generated output" }];
    await runs.create({ id: status, attemptId: "old", status,
      sessionId: "doc", policy: { preset: "read-only" },
      ...(status === "waiting" ? { waiting: { id: "approval" } } : {}),
      createdAt: now, updatedAt: now });
    await runs.saveCheckpoint({
      schemaVersion: 1, runId: status, attemptId: "old", sequence: 1,
      messages, output: "", usage: {}, nextTurn: 2, maxTurns: 3, createdAt: now,
      ...(status === "waiting" ? { pending: {
        stage: "beforeStop", turn: 1, controllerIds: [], controllerIndex: 0
      } } : {})
    });
    expect(await runs.getRunInputMessages(status)).toBeNull();
    const handle = await executor(runs).resume(status, status === "waiting" ? { waitId: "approval" } : {});
    expect((await handle.completion).status).toBe("completed");
    expect(await runs.getLatestCheckpoint(status)).toBeNull();
    expect(await runs.getRunInputMessages(status)).toEqual([messages[0]]);
    const source = (await database.pool.query(
      "SELECT source, source_checkpoint_sequence FROM runtime_run_inputs WHERE space_id=$1 AND run_id=$2",
      [runs.spaceId, status])).rows[0];
    expect(source).toMatchObject({ source: "checkpoint", source_checkpoint_sequence: "1" });
    const processor = vi.fn();
    const server = createRuntimeServer({ runs, executor: executor(runs), port: 0,
      runPostProcessors: [{ id: "context", process: processor }] });
    try {
      await server.start();
      await vi.waitFor(() => expect(processor).toHaveBeenCalledOnce());
      expect(processor.mock.calls[0][0].messages[0]).toMatchObject(messages[0]);
    } finally { await server.close(); }
  });

  it.each(["live", "final"])("prepares %s snapshot before a fast completion overtakes admission", async mode => {
    const gate = deferred();
    const projector = createSessionDocumentProjector();
    const document = new Y.Doc();
    const source = "user question\nuser later";
    document.getText("content").insert(0, source);
    const anchor = { fallback: { offset: 13, before: "user question", after: "\nuser later" } };
    let prepared = false;
    let f;
    const service = {
      prepareRun(_id, input) { projector.prepareRun({ document, ...input }); prepared = true; },
      applyRunEvent(_id, event) { projector.projectEvents({ document, runId: event.runId, events: [event] }); },
      applyRunEvents(_id, input) {
        expect(prepared).toBe(true);
        projector.projectEvents({ document, ...input });
      }
    };
    f = await fixture({ sessionDocumentService: service });
    const append = f.runs.appendSessionMessages.bind(f.runs);
    let held = false;
    f.runs.appendSessionMessages = async (id, messages, ...rest) => {
      if (!held && messages[0].role === "user" && !messages[0].id.startsWith("message_input_")) {
        held = true; await gate.promise;
      }
      return append(id, messages, ...rest);
    };
    try {
      const submit = f.submit("question", { mode, anchor, appendUserPrompt: true });
      await vi.waitFor(() => expect(document.getText("content").toString()).toContain("answer"), { timeout: 3_000 });
      const text = document.getText("content").toString();
      expect(text.indexOf("answer")).toBeLessThan(text.indexOf("user later"));
      expect(text).toContain("\nuser \nuser later");
      gate.resolve();
      expect((await submit).status).toBe(202);
      await vi.waitFor(() => expect(f.server.isIdle()).toBe(true));
      expect((await f.runs.getSessionMessages("doc")).map(message => message.role)).toEqual(["user", "assistant"]);
    } finally { gate.resolve(); await f.server.close(); document.destroy(); }
  });
});
