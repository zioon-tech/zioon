import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSchedulerTask,
  mergeSchedulerTask,
  SchedulerController,
  validateSchedulerTask
} from "../extensions/dev.scheduler/controller.js";
import { LocalSchedulerStore } from "../extensions/dev.scheduler/store.js";

const NOW = new Date(2026, 6, 27, 8, 0, 0).getTime();

function createController({ service = {}, engine = null } = {}) {
  const store = new LocalSchedulerStore();
  const onChange = vi.fn();
  const onServiceStatus = vi.fn();
  const controller = new SchedulerController({
    store,
    service,
    onChange,
    onServiceStatus,
    now: () => NOW
  });
  if (engine) controller.setEngine(engine);
  return { controller, store, onChange, onServiceStatus };
}

describe("scheduler controller", () => {
  beforeEach(() => localStorage.clear());

  it("normalizes task input and rejects unsafe capability combinations", () => {
    const task = buildSchedulerTask({
      title: "Daily summary",
      prompt: "Summarize project updates",
      schedule: { kind: "daily", time: "09:00" }
    }, null, NOW);

    expect(task.executionMode).toBe("local-only");
    expect(task.capability).toMatchObject({ preset: "read-only", allowedTools: [] });
    expect(validateSchedulerTask(task)).toBe("");

    const unsafe = mergeSchedulerTask(task, {
      capability: { preset: "read-only", allowedTools: ["terminalExecute"] }
    }, NOW);
    expect(validateSchedulerTask(unsafe)).toContain("只读权限");

    const trusted = mergeSchedulerTask(task, {
      capability: {
        preset: "trusted-automation",
        allowedTools: ["terminalExecute"],
        allowedCommandPrefixes: ["npm test"]
      }
    }, NOW);
    expect(validateSchedulerTask(trusted)).toBe("");

    const recursive = mergeSchedulerTask(task, {
      capability: { preset: "trusted-automation", allowedTools: ["schedulerManage"] }
    }, NOW);
    expect(validateSchedulerTask(recursive)).toContain("schedulerManage");

    const missingTerminalTool = mergeSchedulerTask(task, {
      capability: {
        preset: "trusted-automation",
        allowedCommandPrefixes: ["bash"]
      }
    }, NOW);
    expect(validateSchedulerTask(missingTerminalTool)).toContain("terminalExecute");

    const commandTask = buildSchedulerTask({
      taskType: "command",
      title: "Parking monitor",
      command: "bash /tmp/parking_monitor.sh",
      schedule: { kind: "interval", intervalMinutes: 5 }
    }, null, NOW);
    expect(commandTask).toMatchObject({
      taskType: "command",
      prompt: "",
      capability: {
        preset: "trusted-automation",
        allowedTools: ["terminalExecute"],
        allowedCommandPrefixes: ["bash /tmp/parking_monitor.sh"]
      }
    });
    expect(validateSchedulerTask(commandTask)).toBe("");
  });

  it("calls randomUUID with the correct browser API binding", () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        randomUUID() {
          if (this !== globalThis.crypto) throw new TypeError("Illegal invocation");
          return "uuid-1";
        }
      }
    });
    try {
      const task = buildSchedulerTask({
        title: "Bound uuid",
        prompt: "Check uuid binding",
        schedule: { kind: "daily", time: "09:00" }
      }, null, NOW);
      expect(task.id).toBe("sched_uuid-1");
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto
      });
    }
  });

  it("uses the same local lifecycle for save, pause, manual run, and delete", async () => {
    const engine = {
      reconcile: vi.fn(),
      execute: vi.fn(async (task) => ({ status: "completed", taskId: task.id }))
    };
    const { controller, store, onChange } = createController({ engine });
    const task = buildSchedulerTask({
      title: "Local task",
      prompt: "Read the workspace",
      schedule: { kind: "daily", time: "09:00" }
    }, null, NOW);

    const saved = await controller.saveTask(task);
    expect(store.getTask(saved.id)).toMatchObject({ title: "Local task", enabled: true });

    const paused = await controller.setEnabled(saved.id, false);
    expect(paused).toMatchObject({ enabled: false, nextRun: null });

    await controller.runNow(saved.id);
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ id: saved.id, enabled: false }));

    await expect(controller.deleteTask(saved.id)).resolves.toEqual({ id: saved.id, deleted: true });
    expect(store.getTask(saved.id)).toBeNull();
    expect(onChange).toHaveBeenCalled();
  });

  it("keeps saved data when UI change notification fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new LocalSchedulerStore();
    const controller = new SchedulerController({
      store,
      onChange: () => { throw new TypeError("Illegal invocation"); },
      now: () => NOW
    });
    const task = buildSchedulerTask({
      title: "Notification failure",
      prompt: "Persist despite UI notification failure",
      schedule: { kind: "daily", time: "09:00" }
    }, null, NOW);

    try {
      await expect(controller.saveTask(task)).resolves.toMatchObject({ id: task.id });
      expect(store.getTask(task.id)).toMatchObject({ title: "Notification failure" });
      expect(warn).toHaveBeenCalledWith("[scheduler] change notification failed", expect.any(TypeError));
    } finally {
      warn.mockRestore();
    }
  });

  it("persists service-backed identity and merges remote run history", async () => {
    const service = {
      createTask: vi.fn(async () => ({ id: "remote-task", revision: 4, nextRun: NOW + 60_000, enabled: true })),
      updateTask: vi.fn(async () => ({ id: "remote-task", revision: 5, nextRun: null, enabled: false })),
      deleteTask: vi.fn(async () => undefined),
      runNow: vi.fn(async () => ({ id: "remote-run", status: "pending" })),
      listTasks: vi.fn(async () => []),
      listRuns: vi.fn(async () => [{
        id: "remote-run",
        taskId: "remote-task",
        status: "success",
        createdAt: NOW,
        completedAt: NOW + 10,
        output: "remote output"
      }])
    };
    const { controller, store, onServiceStatus } = createController({ service });
    const task = buildSchedulerTask({
      title: "Service task",
      prompt: "Produce a report",
      executionMode: "service-backed",
      schedule: { kind: "daily", time: "09:00" }
    }, null, NOW);

    const saved = await controller.saveTask(task);
    expect(service.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Service task" }));
    expect(saved).toMatchObject({ remoteTaskId: "remote-task", remoteRevision: 4, nextRun: NOW + 60_000 });

    store.saveRun({
      id: "remote-run",
      taskId: saved.id,
      taskTitle: saved.title,
      status: "success",
      startedAt: NOW,
      output: "local output",
      events: []
    });
    const runs = await controller.listRuns({ taskId: saved.id });
    expect(service.listRuns).toHaveBeenCalledWith("remote-task");
    expect(runs[0]).toMatchObject({ id: "remote-run", taskId: saved.id, output: "local output" });

    const paused = await controller.setEnabled(saved.id, false);
    expect(service.updateTask).toHaveBeenCalledWith(expect.objectContaining({ remoteTaskId: "remote-task", enabled: false }));
    expect(paused.remoteRevision).toBe(5);

    await expect(controller.runNow(saved.id)).resolves.toMatchObject({
      queued: true,
      run: { id: "remote-run", status: "pending" }
    });
    await controller.deleteTask(saved.id);
    expect(service.deleteTask).toHaveBeenCalledWith(expect.objectContaining({ remoteTaskId: "remote-task" }));
    expect(onServiceStatus).toHaveBeenCalledWith(true);
  });
});
