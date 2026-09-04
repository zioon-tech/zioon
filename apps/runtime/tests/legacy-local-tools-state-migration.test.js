import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyLocalToolsState } from "../src/legacy-local-tools-state-migration.mjs";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.mjs";
import { SqliteWorkbenchStateStore } from "../src/sqlite-workbench-state-store.mjs";

const resources = [];

function stores() {
  const directory = mkdtempSync(join(tmpdir(), "zion-legacy-migration-"));
  const path = join(directory, "runtime.sqlite3");
  const workbenchState = new SqliteWorkbenchStateStore(path);
  const scheduler = new SqliteSchedulerStore(path);
  resources.push({ directory, workbenchState, scheduler });
  return { workbenchState, scheduler };
}

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.scheduler.close();
    resource.workbenchState.close();
    rmSync(resource.directory, { recursive: true, force: true });
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
    expect(workbenchState.readSession("session-1").text).toBe("legacy");
    expect(scheduler.listTasks()).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/scheduler/")
    )).toHaveLength(2);
  });
});
