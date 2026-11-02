import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.agents/runtime.js";
import {
  AGENTS_MANAGE_RUNTIME_ACTIONS,
  AGENTS_MANAGE_READONLY_ACTIONS,
  AGENTS_RUNTIME_KV_KEY,
  DEFAULT_AGENTS,
  agentsManageToolDefinition,
  normalizeAgentsSnapshot
} from "../extensions/dev.agents/agents-runtime-shared.js";
import {
  agentsSnapshotFromStorage,
  applyAgentsSnapshotToStorage,
  hasRuntimeActiveAgentTasks,
  loadAgentsSnapshotFromRuntime,
  shouldApplyRuntimeAgentsSnapshot,
  syncAgentsSnapshotToRuntime
} from "../extensions/dev.agents/agents-runtime-state.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem: vi.fn((key) => (map.has(key) ? map.get(key) : null)),
    setItem: vi.fn((key, value) => map.set(String(key), String(value))),
    removeItem: vi.fn((key) => map.delete(String(key))),
    snapshot: () => Object.fromEntries(map.entries())
  };
}

function state(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn((key) => values.get(key)),
    set: vi.fn((key, value) => {
      values.set(key, value);
      return value;
    }),
    values
  };
}

function task(overrides = {}) {
  return {
    id: "task_1",
    title: "Inspect Runtime",
    agentId: "researcher",
    status: "idle",
    sessionId: "session_1",
    body: "user inspect runtime",
    from: 1,
    to: 12,
    lineFrom: 0,
    lineTo: 1,
    updatedAt: 1000,
    ...overrides
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Agents Runtime state", () => {
  it("normalizes snapshots while preserving Workbench task fields", () => {
    const snapshot = normalizeAgentsSnapshot({
      savedAt: 1,
      activeTaskId: "task_1",
      tasks: [task({ taskSessionId: "agent-task:task_1", linkedSessionId: "session_linked" })]
    });
    expect(snapshot).toMatchObject({
      activeTaskId: "task_1",
      tasks: [expect.objectContaining({
        id: "task_1",
        body: "user inspect runtime",
        from: 1,
        to: 12,
        taskSessionId: "agent-task:task_1",
        linkedSessionId: "session_linked"
      })]
    });
  });

  it("syncs and restores agents snapshot through Runtime workbench-state KV", async () => {
    const storage = memoryStorage({
      "zion.agents.tasks.v1": JSON.stringify([task()]),
      "agents.activeTaskId": "task_1",
      "zion.runtime.mode": "runtime",
      "zion.runtime.baseUrl": "http://runtime.test"
    });
    const st = state({
      "runtime.connection": { backend: "runtime" }
    });
    const fetchImpl = vi.fn(async (url, options = {}) => {
      expect(String(url)).toContain(encodeURIComponent(AGENTS_RUNTIME_KV_KEY));
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        expect(body.value.tasks[0]).toMatchObject({
          id: "task_1",
          body: "user inspect runtime"
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: {
            savedAt: Date.now() + 1000,
            activeTaskId: "task_2",
            tasks: [task({ id: "task_2", title: "Restored Task" })]
          }
        })
      };
    });

    const snapshot = agentsSnapshotFromStorage({ storage, state: st });
    expect(snapshot.tasks[0]).toMatchObject({ id: "task_1" });

    await expect(syncAgentsSnapshotToRuntime({
      snapshot,
      storage,
      state: st,
      fetchImpl
    })).resolves.toMatchObject({ synced: true });

    const loaded = await loadAgentsSnapshotFromRuntime({
      storage,
      state: st,
      fetchImpl
    });
    expect(loaded.tasks[0]).toMatchObject({
      id: "task_2",
      title: "Restored Task"
    });

    applyAgentsSnapshotToStorage(loaded, { storage, state: st });
    expect(JSON.parse(storage.snapshot()["zion.agents.tasks.v1"])[0]).toMatchObject({
      id: "task_2",
      title: "Restored Task"
    });
    expect(st.values.get("agents.activeTaskId")).toBe("task_2");
    expect(shouldApplyRuntimeAgentsSnapshot(snapshot, loaded)).toBe(true);
    expect(shouldApplyRuntimeAgentsSnapshot({
      savedAt: 1000,
      tasks: [task({ updatedAt: 1000 })]
    }, {
      savedAt: 5000,
      lastChangedAt: 5000,
      tasks: []
    })).toBe(true);
    expect(hasRuntimeActiveAgentTasks({
      tasks: [task({ status: "running", activeRunId: "run_1" })]
    })).toBe(true);
    expect(hasRuntimeActiveAgentTasks({
      tasks: [task({ status: "running", activeRunId: "" })]
    })).toBe(false);
  });
});

describe("Runtime agentsManage tool", () => {
  it("lists agent definitions, syncs task mutations, and gates writes by policy", async () => {
    const bucket = new Map([
      ["snapshot", normalizeAgentsSnapshot({
        activeTaskId: "task_1",
        tasks: [task(), task({ id: "task_2", sessionId: "other", updatedAt: 500 })]
      })]
    ]);
    const tools = [];
    activateRuntimePlugin({
      apiVersion: 2,
      plugin: { id: "dev.agents", version: "test" },
      log: vi.fn(),
      tools: {
        registerTool(toolDefinition) {
          tools.push(toolDefinition);
          return { dispose() {} };
        }
      },
      context: { registerProvider: vi.fn() },
      state: {
        namespace: vi.fn(() => ({
          get: (key) => bucket.get(String(key)),
          set: (key, value) => bucket.set(String(key), value),
          entries: () => Array.from(bucket.entries())
        }))
      }
    });

    const tool = tools[0];
    expect(tool.name).toBe("agentsManage");
    expect(tool.policy).toEqual({ minimumPreset: "read-only" });
    expect(tool.inputSchema.properties.action.enum).toEqual(AGENTS_MANAGE_RUNTIME_ACTIONS);
    expect(agentsManageToolDefinition().inputSchema.properties.action.enum)
      .toEqual(AGENTS_MANAGE_READONLY_ACTIONS);

    const agents = JSON.parse((await tool.invoke({ action: "list_agents" })).content);
    expect(agents).toHaveLength(DEFAULT_AGENTS.length);
    expect(agents[0]).toMatchObject({
      id: "researcher",
      permissionMode: "read-only"
    });

    const listed = JSON.parse((await tool.invoke({
      action: "list_tasks",
      session_id: "session_1"
    })).content);
    expect(listed).toMatchObject({
      activeTaskId: "task_1",
      tasks: [expect.objectContaining({
        id: "task_1",
        agentId: "researcher"
      })]
    });

    const detail = JSON.parse((await tool.invoke({
      action: "get_task",
      task_id: "task_1"
    })).content);
    expect(detail).toMatchObject({
      id: "task_1",
      title: "Inspect Runtime"
    });

    await expect(tool.invoke({
      action: "create_task",
      prompt: "Do work"
    }, {
      policy: { preset: "read-only" }
    })).resolves.toMatchObject({
      ok: false,
      error: "agentsManage action create_task requires workspace-write capability"
    });

    const created = JSON.parse((await tool.invoke({
      action: "create_task",
      task_id: "task_3",
      agent_id: "planner",
      session_id: "session_1",
      prompt: "Plan Runtime migration",
      instruction: "Create a migration plan"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(created.created).toMatchObject({
      id: "task_3",
      agentId: "planner",
      sessionId: "session_1",
      status: "idle"
    });
    expect(bucket.get("snapshot").activeTaskId).toBe("task_3");
    expect(bucket.get("snapshot").tasks.find((item) => item.id === "task_3"))
      .toMatchObject({ body: "user Create a migration plan" });

    const research = JSON.parse((await tool.invoke({
      action: "create_research_task",
      task_id: "task_research",
      prompt: "Research Runtime APIs"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(research.created).toMatchObject({
      id: "task_research",
      agentId: "researcher"
    });

    const selected = JSON.parse((await tool.invoke({
      action: "select_task",
      task_id: "task_1"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(selected.selected).toBe("task_1");
    expect(bucket.get("snapshot").activeTaskId).toBe("task_1");

    const deleted = JSON.parse((await tool.invoke({
      action: "delete_task",
      task_id: "task_3"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(deleted.deleted).toBe("task_3");
    expect(bucket.get("snapshot").tasks.some((item) => item.id === "task_3"))
      .toBe(false);

    await expect(tool.invoke({
      action: "run_task",
      task_id: "task_1"
    }, {
      policy: { preset: "workspace-write" }
    })).resolves.toMatchObject({
      ok: false,
      error: "Runtime Agent runner service is unavailable"
    });
  });

  it("runs and stops Runtime-backed Agent Tasks through the injected runner service", async () => {
    const firstCompletion = deferred();
    const secondCompletion = deferred();
    const firstHandle = {
      runId: "run-agent-1",
      attemptId: "attempt-agent-1",
      sessionId: "agent-task:task_1",
      completion: firstCompletion.promise,
      abort: vi.fn(async () => {}),
      events: {
        async *[Symbol.asyncIterator]() {}
      }
    };
    const secondHandle = {
      runId: "run-agent-2",
      attemptId: "attempt-agent-2",
      sessionId: "agent-task:task_2",
      completion: secondCompletion.promise,
      abort: vi.fn(async () => {}),
      events: {
        async *[Symbol.asyncIterator]() {}
      }
    };
    const runnerService = {
      startTaskRun: vi.fn()
        .mockReturnValueOnce(firstHandle)
        .mockReturnValueOnce(secondHandle),
      abortRun: vi.fn()
    };
    const bucket = new Map([
      ["snapshot", normalizeAgentsSnapshot({
        activeTaskId: "task_1",
        tasks: [task(), task({ id: "task_2", title: "Second task", updatedAt: 500 })]
      })]
    ]);
    const tools = [];
    activateRuntimePlugin({
      apiVersion: 2,
      plugin: { id: "dev.agents", version: "test" },
      config: { agentRunnerService: runnerService },
      log: vi.fn(),
      tools: {
        registerTool(toolDefinition) {
          tools.push(toolDefinition);
          return { dispose() {} };
        }
      },
      context: { registerProvider: vi.fn() },
      state: {
        namespace: vi.fn(() => ({
          get: (key) => bucket.get(String(key)),
          set: (key, value) => bucket.set(String(key), value),
          entries: () => Array.from(bucket.entries())
        }))
      }
    });
    const tool = tools[0];

    const started = JSON.parse((await tool.invoke({
      action: "run_task",
      task_id: "task_1"
    }, {
      runId: "parent-run",
      attemptId: "parent-attempt",
      projectId: "project-1",
      policy: { preset: "workspace-write", allowedTools: ["agentsManage", "read"] }
    })).content);
    expect(started).toMatchObject({
      runId: "run-agent-1",
      attemptId: "attempt-agent-1",
      sessionId: "agent-task:task_1",
      started: expect.objectContaining({
        id: "task_1",
        status: "running",
        activeRunId: "run-agent-1"
      })
    });
    expect(runnerService.startTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task_1" }),
      expect.objectContaining({
        parentRunId: "parent-run",
        parentAttemptId: "parent-attempt",
        projectId: "project-1",
        policy: expect.objectContaining({ preset: "workspace-write" })
      })
    );

    const stopped = JSON.parse((await tool.invoke({
      action: "stop_task",
      task_id: "task_1"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(stopped).toMatchObject({
      stopped: "task_1",
      abortedRun: true,
      task: expect.objectContaining({
        id: "task_1",
        status: "aborted",
        activeRunId: ""
      })
    });
    expect(firstHandle.abort).toHaveBeenCalledWith("user");

    await tool.invoke({
      action: "run_task",
      task_id: "task_2"
    }, {
      policy: { preset: "workspace-write", allowedTools: ["agentsManage", "read"] }
    });
    secondCompletion.resolve({
      runId: "run-agent-2",
      attemptId: "attempt-agent-2",
      status: "completed",
      output: "sub-agent result",
      usage: { inputTokens: 1, outputTokens: 2 }
    });
    await secondCompletion.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(bucket.get("snapshot").tasks.find((item) => item.id === "task_2"))
      .toMatchObject({
        status: "done",
        activeRunId: "",
        body: expect.stringContaining("sub-agent result"),
        result: expect.objectContaining({
          workResult: "sub-agent result",
          status: "completed"
        })
      });
  });
});
