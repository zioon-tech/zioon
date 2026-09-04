import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.scheduler/runtime.js";

function baseTask(patch = {}) {
  return {
    id: "sched_1",
    revision: 1,
    taskType: "agent",
    executionMode: "service-backed",
    title: "Daily report",
    prompt: "Summarize the project",
    command: "",
    cwd: "",
    note: "",
    interactionProfileId: "scheduled.default",
    schedule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
    capability: { preset: "read-only", allowedTools: [] },
    timeoutSeconds: 300,
    enabled: true,
    createdAt: 1000,
    updatedAt: 1000,
    nextRun: 2000,
    ...patch
  };
}

function activateWithService(service) {
  const tools = [];
  activateRuntimePlugin({
    apiVersion: 2,
    plugin: { id: "dev.scheduler", version: "test" },
    config: { schedulerService: service },
    log: vi.fn(),
    tools: {
      registerTool(tool) {
        tools.push(tool);
        return { dispose() {} };
      }
    },
    context: { registerProvider: vi.fn() },
    state: { namespace: vi.fn() }
  });
  return tools[0];
}

describe("Runtime schedulerManage tool", () => {
  it("manages Scheduler tasks through the Runtime-injected scheduler service", async () => {
    const tasks = new Map();
    const service = {
      listTasks: vi.fn(() => Array.from(tasks.values())),
      getTask: vi.fn((taskId) => {
        const task = tasks.get(String(taskId));
        if (!task) throw new Error("Task not found");
        return task;
      }),
      listRuns: vi.fn(() => [{
        id: "run_1",
        taskId: "sched_1",
        status: "success",
        trigger: "manual",
        startedAt: 3000,
        completedAt: 3500
      }]),
      createTask: vi.fn((input) => {
        const task = baseTask({ ...input, id: "sched_1" });
        tasks.set(task.id, task);
        return task;
      }),
      updateTask: vi.fn((taskId, patch) => {
        const current = tasks.get(String(taskId));
        const task = { ...current, ...patch, revision: current.revision + 1 };
        tasks.set(task.id, task);
        return task;
      }),
      setEnabled: vi.fn((taskId, enabled) => {
        const current = tasks.get(String(taskId));
        const task = { ...current, enabled, revision: current.revision + 1 };
        tasks.set(task.id, task);
        return task;
      }),
      runNow: vi.fn((taskId) => ({
        id: "run_queued",
        taskId,
        status: "pending",
        trigger: "manual"
      })),
      deleteTask: vi.fn((taskId) => {
        tasks.delete(String(taskId));
        return true;
      })
    };
    const tool = activateWithService(service);

    expect(tool.name).toBe("schedulerManage");
    expect(tool.policy).toEqual({ minimumPreset: "trusted-automation" });
    expect(tool.inputSchema.properties.action.enum).not.toContain("open_panel");

    await expect(tool.invoke({
      action: "create",
      task: {
        title: "Daily report",
        prompt: "Summarize the project",
        schedule: { kind: "daily", time: "09:00" }
      }
    })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("\"created\"")
    });
    expect(service.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Daily report"
    }));

    const listed = JSON.parse((await tool.invoke({ action: "list" })).content);
    expect(listed.tasks).toEqual([
      expect.objectContaining({
        id: "sched_1",
        interactionProfileId: "scheduled.default"
      })
    ]);

    const updated = JSON.parse((await tool.invoke({
      action: "update",
      task_id: "sched_1",
      patch: { title: "Updated report" }
    })).content);
    expect(updated.updated).toMatchObject({ title: "Updated report" });

    const disabled = JSON.parse((await tool.invoke({
      action: "set_enabled",
      task_id: "sched_1",
      enabled: false
    })).content);
    expect(disabled.updated).toMatchObject({ enabled: false });

    const runs = JSON.parse((await tool.invoke({
      action: "list_runs",
      task_id: "sched_1",
      limit: 10
    })).content);
    expect(runs.runs).toEqual([
      expect.objectContaining({ id: "run_1", taskId: "sched_1" })
    ]);

    const runNow = JSON.parse((await tool.invoke({
      action: "run_now",
      task_id: "sched_1"
    })).content);
    expect(runNow.run).toMatchObject({
      id: "run_queued",
      status: "pending"
    });

    const deleted = JSON.parse((await tool.invoke({
      action: "delete",
      task_id: "sched_1"
    })).content);
    expect(deleted).toEqual({
      ok: true,
      id: "sched_1",
      deleted: true
    });
  });

  it("rejects UI-only and unknown actions in the Runtime entry", async () => {
    const tool = activateWithService({
      listTasks: () => []
    });

    const result = await tool.invoke({ action: "open_panel" });
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      ok: false,
      code: "UNKNOWN_ACTION",
      allowedActions: expect.not.arrayContaining(["open_panel"])
    });
  });
});
