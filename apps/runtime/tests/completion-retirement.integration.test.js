import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { activateRuntimePlugin } from "../../../extensions/dev.identity/runtime.js";
import { createRuntimeServer } from "../src/server.mjs";
import { createRuntimeCollaborationService } from "../src/collaboration-service.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let database;
beforeAll(async () => { database = await createPostgresTestDatabase("completion_retirement"); });
afterAll(async () => { await database.close(); });

describe("permanent postprocessing outcomes", () => {
  it.each([true, false])("retires postprocessing only with a confirmed tombstone (deleted=%s)", async deleted => {
    const spaceId = database.nextSpaceId();
    const runs = new PostgresRunStore(database.pool, { spaceId });
    const store = new PostgresWorkbenchStateStore(database.pool, { spaceId });
    await store.createSession({ id: "deleted", text: "original" });
    if (deleted) await store.deleteSession("deleted");
    await runs.createSession({ id: "deleted", status: "idle", createdAt: Date.now(), updatedAt: Date.now() });
    const collaboration = createRuntimeCollaborationService({ store });
    const executor = createAgentExecutor({
      runs, tools: { listTools: async () => [], invoke: async () => { throw new Error("no tools"); } },
      engine: { id: "fixture", async *streamTurn() { yield { type: "message.delta", delta: "answer" }; } }
    });
    const handle = executor.execute({ sessionId: "deleted", prompt: "already accepted" });
    await handle.completion;
    const errors = vi.fn();
    const process = vi.fn();
    const server = createRuntimeServer({ runs, executor, port: 0,
      sessionDocumentService: collaboration, sessionEventStore: store, onPostProcessorError: errors,
      runPostProcessors: [{ id: "optional", process }],
      accessControl: { authorizeRunExecution: async () => {
        throw Object.assign(new Error("document unavailable"), { code: "document_not_found" });
      } } });
    try {
      if (deleted) await expect(collaboration.applyRunEvents("deleted", { runId: handle.runId, events: [] }))
          .rejects.toMatchObject({ code: "session_deleted", statusCode: 410 });
      await server.start();
      await vi.waitFor(async () => expect(
        (await runs.completionTaskState(handle.runId, handle.attemptId))?.status
      ).toBe(deleted ? "completed" : "queued"), { timeout: 5000 });
      expect((await runs.get(handle.runId)).status).toBe("completed");
      expect((await runs.getEvents(handle.runId)).some(event => event.type === "run.completed")).toBe(true);
      expect((await store.readSession("deleted")).deleted === true).toBe(deleted);
      expect(process).not.toHaveBeenCalled();
      if (deleted) expect(errors).not.toHaveBeenCalled();
      else expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: "document_not_found" }),
        expect.objectContaining({ processorId: "optional" }));
    } finally { await server.close(); await collaboration.close(); }
  });

  it.each(["policy_outside_grant", "file_write_denied", "file_outside_grant", "temporary_failure"])(
    "handles identity write authorization outcome %s before model cost", async code => {
      const processors = [];
      const failure = Object.assign(new Error(code), { code, statusCode: code === "temporary_failure" ? 503 : 403 });
      const authorizeContext = vi.fn(async () => { throw failure; });
      const fileService = { readTextFiles: vi.fn(), writeTextFiles: vi.fn(), appendJsonl: vi.fn() };
      const modelService = { generateText: vi.fn() };
      const log = vi.fn();
      const plugin = activateRuntimePlugin({
        plugin: { id: "dev.identity" },
        config: { fileService, modelService, authorizeContext },
        locations: { forRequest: async () => ({ root: "/memory/dev.identity" }) },
        state: { namespace: () => ({ get() {}, set() {}, delete() {}, entries: () => [] }) },
        context: { registerProvider: () => ({ dispose() {} }) },
        tools: { registerTool: () => ({ dispose() {} }) },
        runs: { registerPostProcessor(p) { processors.push(p); return { dispose() {} }; } },
        log
      });
      const run = { runId: "accepted", sessionId: "doc", status: "completed",
        principal: { userId: "owner", grantId: "immutable" },
        policy: { preset: "read-only", fileRoots: ["/project"] },
        messages: [{ role: "user", content: "read" }, { role: "assistant", content: "answer" }] };
      try {
        const result = processors[0].process(run);
        if (code === "temporary_failure") await expect(result).rejects.toBe(failure);
        else {
          await expect(result).resolves.toBeUndefined();
          expect(log).toHaveBeenCalledWith("info", expect.stringContaining(`skipped for run accepted: ${code}`));
        }
        expect(modelService.generateText).not.toHaveBeenCalled();
        expect(fileService.readTextFiles).not.toHaveBeenCalled();
        expect(fileService.writeTextFiles).not.toHaveBeenCalled();
        expect(fileService.appendJsonl).not.toHaveBeenCalled();
        expect(run.policy).toEqual({ preset: "read-only", fileRoots: ["/project"] });
      } finally { plugin?.dispose?.(); }
    }
  );
});
