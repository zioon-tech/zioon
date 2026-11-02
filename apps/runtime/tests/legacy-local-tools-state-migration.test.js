import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateLegacyLocalToolsState } from "../src/legacy-local-tools-state-migration.mjs";
import { PostgresSchedulerStore } from "../src/postgres-scheduler-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const resources = [];
let database;

beforeAll(async () => {
  database = await createPostgresTestDatabase("legacy_import");
});

afterAll(async () => {
  await database.close();
});

function stores() {
  const spaceId = database.nextSpaceId();
  const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId });
  const scheduler = new PostgresSchedulerStore(database.pool, { spaceId });
  resources.push({ workbenchState, scheduler });
  return { workbenchState, scheduler };
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.scheduler.close();
    await resource.workbenchState.close();
  }
});

function response(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("legacy local-tools state migration", () => {
  it("imports Workbench and Scheduler state once", async () => {
    const { workbenchState, scheduler } = stores();
    const fetchImpl = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/app-sessions/status")) {
        return response({ revision: "legacy-session-revision" });
      }
      if (value.endsWith("/app-sessions/snapshot")) {
        return response({
          snapshot: {
            docs: [{ id: "session-1", text: "legacy" }],
            metas: [{ id: "session-1", meta: { title: "Legacy" } }]
          }
        });
      }
      if (value.endsWith("/scheduler/tasks")) {
        return response({
          tasks: [{ id: "task-1", title: "Legacy task", createdAt: 1 }]
        });
      }
      if (value.includes("/scheduler/runs?")) {
        return response({
          runs: [{ id: "run-1", taskId: "task-1", status: "success", createdAt: 2 }],
          hasMore: false
        });
      }
      throw new Error(`Unexpected URL: ${value}`);
    });

    const first = await migrateLegacyLocalToolsState({
      workbenchState,
      scheduler,
      fetchImpl
    });
    const second = await migrateLegacyLocalToolsState({
      workbenchState,
      scheduler,
      fetchImpl
    });

    expect(first).toMatchObject({
      ok: true,
      workbenchState: { importedCount: 1 },
      scheduler: { importedTasks: 1, importedRuns: 1 }
    });
    expect(second).toMatchObject({
      ok: true,
      workbenchState: { duplicate: true },
      scheduler: { duplicate: true }
    });
    expect((await workbenchState.readSession("session-1")).text).toBe("legacy");
    expect(await scheduler.listTasks()).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/scheduler/")
    )).toHaveLength(2);
  });
});
