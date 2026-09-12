import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nextScheduledAt,
  SqliteSchedulerStore
} from "../src/sqlite-scheduler-store.mjs";

const resources = [];

function createStore(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "zion-scheduler-store-"));
  const store = new SqliteSchedulerStore(
    join(directory, "runtime.sqlite3"),
    options
  );
  resources.push({ directory, store });
  return store;
}

function task(overrides = {}) {
  return {
    title: "Daily summary",
    prompt: "Summarize the project",
    schedule: {
      kind: "interval",
      intervalMinutes: 10,
      timeZone: "UTC",
      misfirePolicy: "run-once",
      overlapPolicy: "forbid"
    },
    capability: {
      preset: "read-only",
      allowedTools: [],
      fileRoots: [],
      allowedCommandPrefixes: [],
      allowedTerminalSessionIds: [],
      allowedRecipients: [],
      maxMailPerRun: 0,
      maxToolCalls: 50
    },
    timeoutSeconds: 300,
    enabled: true,
    ...overrides
  };
}

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("SqliteSchedulerStore", () => {
  it("persists task CRUD with revision conflicts", () => {
    const store = createStore({ now: () => 1_000 });
    const created = store.createTask(task());
    expect(created).toMatchObject({
      revision: 1,
      executionMode: "service-backed",
      nextRun: 601_000
    });

    const updated = store.updateTask(created.id, {
      revision: 1,
      title: "Updated"
    });
    expect(updated).toMatchObject({ revision: 2, title: "Updated" });
    expect(() => store.updateTask(created.id, {
      revision: 1,
      title: "Stale"
    })).toThrow("Task revision conflict");
  });

  it("persists optional Runtime interaction profile ids for tasks", () => {
    const store = createStore({ now: () => 1_000 });
    const created = store.createTask(task({
      interactionProfileId: "scheduled.default"
    }));

    expect(created).toMatchObject({
      interactionProfileId: "scheduled.default"
    });
    expect(store.getTask(created.id)).toMatchObject({
      interactionProfileId: "scheduled.default"
    });
    expect(() => store.createTask(task({
      title: "Invalid profile",
      interactionProfileId: "../escape"
    }))).toThrow("interactionProfileId is invalid");
  });

  it("persists task model overrides and rejects unavailable model profiles", () => {
    const store = createStore({
      now: () => 1_000,
      availableModels: [{
        id: "workbench.deepseek.deepseek-v4-flash",
        credentialRequired: true,
        credentialConfigured: true
      }, {
        id: "workbench.local.free",
        credentialRequired: false,
        credentialConfigured: false
      }, {
        id: "workbench.deepseek.unconfigured",
        credentialRequired: true,
        credentialConfigured: false
      }]
    });
    const created = store.createTask(task({
      modelProfileId: "workbench.deepseek.deepseek-v4-flash"
    }));

    expect(created).toMatchObject({
      interactionProfileId: "scheduled.default",
      modelProfileId: "workbench.deepseek.deepseek-v4-flash"
    });
    expect(store.updateTask(created.id, {
      revision: created.revision,
      modelProfileId: "workbench.local.free"
    })).toMatchObject({
      modelProfileId: "workbench.local.free"
    });
    expect(() => store.createTask(task({
      modelProfileId: "workbench.missing"
    }))).toThrow("model profile not found");
    expect(() => store.createTask(task({
      modelProfileId: "workbench.deepseek.unconfigured"
    }))).toThrow("model credential is not configured");
    expect(store.createTask(task({
      taskType: "command",
      prompt: "",
      command: "/usr/bin/true",
      nodeId: "node:macbook",
      modelProfileId: "workbench.missing"
    }))).toMatchObject({
      taskType: "command",
      modelProfileId: ""
    });
  });

  it("persists optional Agent Nodes and requires a registered Node for commands", () => {
    const store = createStore({
      now: () => 1_000,
      availableNodes: [{ nodeId: "node:macbook" }]
    });
    expect(store.createTask(task({
      nodeId: "node:macbook"
    }))).toMatchObject({
      taskType: "agent",
      nodeId: "node:macbook"
    });
    expect(() => store.createTask(task({
      nodeId: "node:missing"
    }))).toThrow("Node not found");
    expect(() => store.createTask(task({
      taskType: "command",
      prompt: "",
      command: "/usr/bin/true"
    }))).toThrow("nodeId is required");
  });

  it("rejects service-backed tasks that the Runtime cannot execute", () => {
    const store = createStore({
      availableTools: ["read", "write"]
    });

    expect(() => store.createTask(task({
      capability: {
        preset: "trusted-automation",
        allowedTools: ["Bash"],
        allowedCommandPrefixes: ["npm test"]
      }
    }))).toThrow("does not provide required tools: Bash");
  });

  it("ticks due tasks and completes a leased run", () => {
    let now = 1_000;
    const store = createStore({ now: () => now });
    const created = store.createTask(task({
      enabled: false,
      capability: {
        preset: "read-only",
        allowedTools: ["read"],
        fileRoots: ["/workspace"],
        allowedTerminalSessionIds: ["terminal-1"]
      }
    }));
    const queued = store.runNow(created.id);
    const claimed = store.claim({
      workerId: "runtime-1",
      workerKind: "runtime",
      leaseSeconds: 120,
      availableTools: ["read"]
    });
    expect(claimed).toMatchObject({ id: queued.id, status: "leased" });

    expect(store.linkSession(queued.id, "runtime-1", {
      sessionId: "scheduler-session-1",
      chatRunId: "run-1"
    })).toMatchObject({
      sessionId: "scheduler-session-1",
      chatRunId: "run-1"
    });
    store.appendEvent(queued.id, "runtime-1", { type: "run.started" });
    now = 2_000;
    const completed = store.complete(queued.id, "runtime-1", {
      status: "success",
      output: "done",
      chatRunId: "run-1"
    });
    expect(completed).toMatchObject({
      status: "success",
      output: "done",
      sessionId: "scheduler-session-1",
      chatRunId: "run-1",
      completedAt: 2_000
    });
    expect(store.getTask(created.id).lastRun.id).toBe(queued.id);
  });

  it("claims only jobs supported by the worker capability set", () => {
    const store = createStore();
    const runtimeTask = store.createTask(task({
      enabled: false,
      capability: {
        preset: "read-only",
        allowedTools: ["read"],
        fileRoots: ["/workspace"],
        allowedTerminalSessionIds: ["terminal-1"]
      }
    }));
    const browserTask = store.createTask(task({
      enabled: false,
      capability: {
        preset: "trusted-automation",
        allowedTools: ["Bash"],
        allowedCommandPrefixes: ["npm test"]
      }
    }));
    store.runNow(runtimeTask.id);
    store.runNow(browserTask.id);

    const readClaim = store.claim({
      workerId: "runtime-1",
      workerKind: "runtime",
      availableTools: ["read"]
    });
    expect(readClaim.taskId).toBe(runtimeTask.id);

    const bashClaim = store.claim({
      workerId: "runtime-2",
      workerKind: "runtime",
      availableTools: ["Bash"]
    });
    expect(bashClaim.taskId).toBe(browserTask.id);
  });

  it("imports legacy scheduler state idempotently", () => {
    const store = createStore();
    const payload = {
      tasks: [{ id: "legacy-task", title: "Legacy", createdAt: 1 }],
      runs: [{ id: "legacy-run", taskId: "legacy-task", createdAt: 2 }]
    };
    const first = store.importLegacySnapshot(payload, "legacy-revision");
    const second = store.importLegacySnapshot(payload, "legacy-revision");

    expect(first).toEqual({ ok: true, importedTasks: 1, importedRuns: 1 });
    expect(second).toMatchObject({
      duplicate: true,
      importedTasks: 1,
      importedRuns: 1
    });
    expect(store.snapshot()).toMatchObject({
      tasks: [{ id: "legacy-task" }],
      runs: [{ id: "legacy-run" }]
    });
  });
});

describe("nextScheduledAt", () => {
  it("honors explicit schedule time zones", () => {
    const after = Date.parse("2026-09-03T09:30:00Z");
    expect(nextScheduledAt({
      kind: "daily",
      time: "18:00",
      timeZone: "Asia/Shanghai"
    }, after)).toBe(Date.parse("2026-09-03T10:00:00Z"));
  });
});
