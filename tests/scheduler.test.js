import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSchedulerEngine } from "../extensions/dev.scheduler/engine.js";
import { computeNextRun, describeSchedule, validateSchedule } from "../extensions/dev.scheduler/schedule.js";
import { LocalSchedulerStore } from "../extensions/dev.scheduler/store.js";

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

  it("persists tasks and bounded run events", () => {
    const store = new LocalSchedulerStore();
    store.saveTask({ id: "task-1", createdAt: 1 });
    expect(new LocalSchedulerStore().getTask("task-1")).toMatchObject({ id: "task-1" });

    store.saveRun({ id: "run-1", taskId: "task-1", startedAt: 1, events: [] });
    for (let i = 0; i < 210; i++) store.appendRunEvent("run-1", { sequence: i });
    const run = store.getRun("run-1");
    expect(run.events).toHaveLength(200);
    expect(run.events[0].sequence).toBe(10);
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
});
