import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSchedulerEngine } from "../extensions/dev.scheduler/engine.js";
import { computeNextRun, describeSchedule, validateSchedule } from "../extensions/dev.scheduler/schedule.js";
import { LocalSchedulerStore } from "../extensions/dev.scheduler/store.js";

function createMemoryStorage({ throwOnSet = () => false } = {}) {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => {
      if (throwOnSet(key, value, values)) throw new DOMException("quota exceeded", "QuotaExceededError");
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
    clear: () => values.clear()
  };
}

describe("scheduler schedule model", () => {
  it("computes interval, daily and weekday occurrences", () => {
    const monday = new Date(2026, 6, 27, 8, 0, 0).getTime();
    expect(computeNextRun({ kind: "interval", intervalMinutes: 30 }, monday)).toBe(monday + 30 * 60_000);
    expect(new Date(computeNextRun({ kind: "daily", time: "09:15" }, monday)).getHours()).toBe(9);

    const fridayEvening = new Date(2026, 6, 31, 20, 0, 0).getTime();
    const nextWeekday = new Date(computeNextRun({ kind: "weekdays", time: "09:00" }, fridayEvening));
    expect(nextWeekday.getDay()).toBe(1);
    expect(nextWeekday.getHours()).toBe(9);
  });

  it("validates and describes supported schedules", () => {
    expect(validateSchedule({ kind: "interval", intervalMinutes: 0 })).toContain("1 分钟");
    expect(validateSchedule({ kind: "daily", time: "25:00" })).toContain("HH:mm");
    expect(validateSchedule({ kind: "daily", time: "09:00" })).toBe("");
    expect(describeSchedule({ kind: "weekdays", time: "09:00" })).toBe("工作日 09:00");
  });
});

describe("local scheduler store", () => {
  beforeEach(() => localStorage.clear());

  it("persists tasks and lightweight run summaries", () => {
    const store = new LocalSchedulerStore();
    store.saveTask({ id: "task-1", createdAt: 1 });
    expect(new LocalSchedulerStore().getTask("task-1")).toMatchObject({ id: "task-1" });

    store.saveRun({
      id: "run-1",
      taskId: "task-1",
      startedAt: 1,
      output: "x".repeat(10_000),
      events: []
    });
    for (let i = 0; i < 30; i++) {
      store.appendRunEvent("run-1", {
        sequence: i,
        data: { output: "y".repeat(5_000) }
      });
    }
    const run = store.getRun("run-1");
    expect(run.output.length).toBeLessThan(2_100);
    expect(run.outputTruncated).toBe(true);
    expect(run.events).toHaveLength(20);
    expect(run.events[0].sequence).toBe(10);
    expect(run.events[0].data).toMatchObject({ truncated: true });
  });

  it("reclaims oversized run history before persisting tasks", () => {
    const taskKey = "zion.scheduler.local.tasks.v1";
    const runsKey = "zion.scheduler.local.runs.v1";
    const storage = createMemoryStorage({
      throwOnSet: (key, _value, values) => (
        key === taskKey && String(values.get(runsKey) || "").length > 50_000
      )
    });
    storage.setItem(runsKey, JSON.stringify(Array.from({ length: 10 }, (_, index) => ({
      id: `old-run-${index}`,
      taskId: "task-old",
      taskTitle: "Old task",
      status: "success",
      startedAt: 1_000 + index,
      output: "x".repeat(100_000),
      events: [{ type: "run.finished", ts: 1_000 + index, data: { output: "y".repeat(100_000) } }]
    }))));

    const store = new LocalSchedulerStore(storage);
    store.saveTask({ id: "task-quota", title: "Recovered", createdAt: 1 });

    expect(store.getTask("task-quota")).toMatchObject({ title: "Recovered" });
    expect(String(storage.getItem(runsKey) || "").length).toBeLessThan(50_000);
  });

  it("throws instead of reporting task persistence success when storage stays unavailable", () => {
    const taskKey = "zion.scheduler.local.tasks.v1";
    const storage = createMemoryStorage({
      throwOnSet: (key) => key === taskKey
    });
    const store = new LocalSchedulerStore(storage);

    expect(() => store.saveTask({ id: "task-fail", title: "Fail", createdAt: 1 })).toThrow("本地存储写入失败");
    expect(store.getTask("task-fail")).toBeNull();
  });

  it("drops run history instead of blocking execution when run storage stays unavailable", () => {
    const runsKey = "zion.scheduler.local.runs.v1";
    const storage = createMemoryStorage({
      throwOnSet: (key) => key === runsKey
    });
    const store = new LocalSchedulerStore(storage);

    expect(store.saveRun({
      id: "run-unavailable",
      taskId: "task-1",
      startedAt: 1,
      output: "x"
    })).toMatchObject({ id: "run-unavailable" });
    expect(store.listRuns()).toEqual([]);
  });
});

describe("local scheduler engine", () => {
  it("runs a recently due task once and advances its next occurrence", async () => {
    let task = {
      id: "task-1",
      enabled: true,
      schedule: { kind: "interval", intervalMinutes: 10 },
      nextRun: 99_000
    };
    const store = {
      listTasks: () => [task],
      saveTask: (next) => { task = next; }
    };
    const runTask = vi.fn(async () => {});
    const timers = [];
    const engine = new LocalSchedulerEngine({
      store,
      runTask,
      now: () => 100_000,
      setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
      clearTimer: vi.fn()
    });

    engine.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(task.nextRun).toBe(700_000);
    engine.stop();
  });

  it("skips stale occurrences and prevents overlapping runs", async () => {
    let task = {
      id: "task-1",
      enabled: true,
      schedule: { kind: "interval", intervalMinutes: 10 },
      nextRun: 1
    };
    const store = {
      listTasks: () => [task],
      saveTask: (next) => { task = next; }
    };
    let release;
    const runTask = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const engine = new LocalSchedulerEngine({
      store,
      runTask,
      now: () => 200_000,
      setTimer: () => 1,
      clearTimer: vi.fn()
    });

    engine.start();
    expect(runTask).not.toHaveBeenCalled();
    const running = engine.execute(task);
    await expect(engine.execute(task)).resolves.toBeNull();
    expect(runTask).toHaveBeenCalledTimes(1);
    release();
    await running;
    engine.stop();
  });

  it("does not start a new local instance while a persisted active run exists", async () => {
    let task = {
      id: "task-1",
      enabled: true,
      schedule: { kind: "interval", intervalMinutes: 10 },
      nextRun: 199_000,
      timeoutSeconds: 600
    };
    const runs = [{
      id: "run-active",
      taskId: "task-1",
      status: "running",
      startedAt: 100_000,
      completedAt: null,
      events: []
    }];
    const store = {
      listTasks: () => [task],
      saveTask: (next) => { task = next; },
      listRuns: (taskId) => runs.filter((run) => run.taskId === taskId),
      saveRun: vi.fn((run) => run)
    };
    const runTask = vi.fn(async () => {});
    const engine = new LocalSchedulerEngine({
      store,
      runTask,
      now: () => 200_000,
      setTimer: () => 1,
      clearTimer: vi.fn()
    });

    engine.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(runTask).not.toHaveBeenCalled();
    expect(task.nextRun).toBe(800_000);
    engine.stop();
  });

  it("marks stale persisted runs before allowing the next local instance", async () => {
    let task = {
      id: "task-1",
      enabled: true,
      schedule: { kind: "interval", intervalMinutes: 10 },
      nextRun: 799_000,
      timeoutSeconds: 60
    };
    let runs = [{
      id: "run-stale",
      taskId: "task-1",
      status: "running",
      startedAt: 100_000,
      completedAt: null,
      events: []
    }];
    const store = {
      listTasks: () => [task],
      saveTask: (next) => { task = next; },
      listRuns: (taskId) => runs.filter((run) => run.taskId === taskId),
      saveRun: vi.fn((next) => {
        runs = runs.map((run) => run.id === next.id ? next : run);
        return next;
      })
    };
    const runTask = vi.fn(async () => {});
    const engine = new LocalSchedulerEngine({
      store,
      runTask,
      now: () => 800_001,
      setTimer: () => 1,
      clearTimer: vi.fn()
    });

    engine.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.saveRun).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-stale",
      status: "failed",
      stale: true
    }));
    expect(runTask).toHaveBeenCalledTimes(1);
    engine.stop();
  });
});
