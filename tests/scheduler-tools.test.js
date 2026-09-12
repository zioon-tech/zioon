import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulerController } from "../extensions/dev.scheduler/controller.js";
import { registerSchedulerTool } from "../extensions/dev.scheduler/scheduler-tools.js";
import { LocalSchedulerStore } from "../extensions/dev.scheduler/store.js";

function createState() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value)
  };
}

describe("schedulerManage tool", () => {
  let state;

  beforeEach(() => {
    localStorage.clear();
    state = createState();
    window.zion = {
      state,
      commands: { executeCommand: vi.fn() }
    };
  });

  afterEach(() => {
    delete window.zion;
  });

  it("manages scheduler tasks through the shared controller and cleans up on dispose", async () => {
    const engine = {
      reconcile: vi.fn(),
      execute: vi.fn(async (task) => ({ status: "completed", taskId: task.id }))
    };
    const service = {
      listTasks: vi.fn(async () => []),
      listRuns: vi.fn(async () => []),
      createTask: vi.fn(async (task) => ({
        ...task,
        id: "remote-command",
        revision: 1,
        enabled: true,
        nextRun: Date.now() + 60_000
      }))
    };
    const controller = new SchedulerController({
      store: new LocalSchedulerStore(),
      service,
      onChange: vi.fn()
    });
    controller.setEngine(engine);
    const openPanel = vi.fn();
    const disposable = registerSchedulerTool({
      controller,
      openPanel,
      getSessionTag: () => "scheduled_tasks"
    });
    const tools = state.get("chat.tools");
    const handler = state.get("chat.toolHandlers").schedulerManage;

    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "schedulerManage" }) })
    ]));
    expect(tools.find((tool) => tool?.function?.name === "schedulerManage")
      ?.function?.parameters?.properties?.task?.properties?.modelProfileId)
      .toMatchObject({ type: "string" });
    expect(tools.find((tool) => tool?.function?.name === "schedulerManage")
      ?.function?.parameters?.properties?.task?.properties?.nodeId)
      .toMatchObject({ type: "string" });
    expect(state.get("chat.enabledTools")).toContain("schedulerManage");

    const created = JSON.parse(await handler({
      action: "create",
      task: {
        title: "Daily report",
        prompt: "Summarize the project",
        modelProfileId: "workbench.deepseek.deepseek-v4-flash",
        schedule: { kind: "daily", time: "09:00" }
      }
    }));
    const taskId = created.created.id;
    expect(created).toMatchObject({ ok: true });
    expect(created.created).toMatchObject({
      title: "Daily report",
      executionMode: "local-only",
      modelProfileId: "workbench.deepseek.deepseek-v4-flash",
      enabled: true
    });
    expect(controller.getTask(taskId).sessionTag).toBe("scheduled_tasks");

    const listed = JSON.parse(await handler({ action: "list" }));
    expect(listed.tasks).toEqual([expect.objectContaining({ id: taskId, title: "Daily report" })]);

    const commandCreated = JSON.parse(await handler({
      action: "create",
      task: {
        taskType: "command",
        executionMode: "service-backed",
        nodeId: "node:macbook",
        title: "Parking monitor",
        command: "bash /tmp/parking_monitor.sh",
        cwd: "/tmp",
        note: "Watch parking messages",
        schedule: { kind: "interval", intervalMinutes: 5 }
      }
    }));
    expect(commandCreated).toMatchObject({
      ok: true,
      created: {
        taskType: "command",
        nodeId: "node:macbook",
        title: "Parking monitor",
        command: "bash /tmp/parking_monitor.sh"
      }
    });

    const commandWithoutNode = JSON.parse(await handler({
      action: "create",
      task: {
        taskType: "command",
        executionMode: "service-backed",
        title: "Missing Node",
        command: "/usr/bin/true",
        schedule: { kind: "daily", time: "09:00" }
      }
    }));
    expect(commandWithoutNode).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      error: expect.stringContaining("必须选择执行 Node")
    });

    const updated = JSON.parse(await handler({
      action: "update",
      task_id: taskId,
      patch: {
        title: "Weekday report",
        modelProfileId: "workbench.kimi.k2",
        schedule: { kind: "weekdays", time: "10:00" }
      }
    }));
    expect(updated.updated).toMatchObject({
      title: "Weekday report",
      modelProfileId: "workbench.kimi.k2",
      schedule: expect.objectContaining({ kind: "weekdays", time: "10:00" })
    });
    expect(controller.getTask(taskId).sessionTag).toBe("scheduled_tasks");

    const paused = JSON.parse(await handler({ action: "set_enabled", task_id: taskId, enabled: false }));
    expect(paused.updated).toMatchObject({ enabled: false, nextRun: null });

    const run = JSON.parse(await handler({ action: "run_now", task_id: taskId }));
    expect(run.run).toMatchObject({ queued: false });
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ id: taskId, enabled: false }));

    const opened = JSON.parse(await handler({ action: "open_panel" }));
    expect(opened).toEqual({ ok: true, opened: true });
    expect(openPanel).toHaveBeenCalledTimes(1);

    const missingPrompt = JSON.parse(await handler({ action: "create", task: { title: "Missing prompt" } }));
    expect(missingPrompt).toMatchObject({
      ok: false,
      action: "create",
      code: "VALIDATION_FAILED",
      error: "请输入任务提示词"
    });
    const missingTerminalTool = JSON.parse(await handler({
      action: "create",
      task: {
        title: "Run shell",
        prompt: "Run bash /tmp/check.sh",
        schedule: { kind: "interval", intervalMinutes: 5 },
        capability: {
          preset: "trusted-automation",
          allowedCommandPrefixes: ["bash"]
        }
      }
    }));
    expect(missingTerminalTool).toMatchObject({
      ok: false,
      action: "create",
      code: "VALIDATION_FAILED",
      error: expect.stringContaining("Bash")
    });
    disposable.dispose();
    expect((state.get("chat.tools") || []).some((tool) => tool?.function?.name === "schedulerManage")).toBe(false);
    expect(state.get("chat.toolHandlers").schedulerManage).toBeUndefined();
    expect(state.get("chat.enabledTools")).not.toContain("schedulerManage");
  });
});
