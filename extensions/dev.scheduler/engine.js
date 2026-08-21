import { ACTIVE_RUN_STATUSES, isStaleActiveRun } from "./controller.js";
import { computeNextRun } from "./schedule.js";

const MAX_TIMER_DELAY = 2_147_000_000;

function defaultSetTimer(callback, delay) {
  return globalThis.setTimeout(callback, delay);
}

function defaultClearTimer(timer) {
  return globalThis.clearTimeout(timer);
}

function staleRunError(run) {
  if (run?.sessionId) return "运行超过超时时间，已自动标记为失败";
  if (run?.status === "pending") return "运行在分配执行会话前超时，已自动清理";
  return "运行状态长时间未完成，已自动清理";
}

export class LocalSchedulerEngine {
  constructor({ store, runTask, onChange, now = () => Date.now(), setTimer = defaultSetTimer, clearTimer = defaultClearTimer }) {
    this.store = store;
    this.runTask = runTask;
    this.onChange = onChange;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.runningTasks = new Set();
    this.started = false;
    this.onVisibility = () => {
      if (!globalThis.document?.hidden) this.reconcile();
    };
    this.onStorage = (event) => {
      if (!event?.key || event.key.startsWith("zion.scheduler.local.")) {
        this.reconcile();
        this.onChange?.();
      }
    };
  }

  _listRuns(taskId) {
    try {
      return typeof this.store?.listRuns === "function" ? this.store.listRuns(taskId) : [];
    } catch {
      return [];
    }
  }

  _updateTaskLastRun(task, run, now) {
    if (!task || typeof this.store?.saveTask !== "function") return;
    this.store.saveTask({
      ...task,
      lastRun: {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt || run.scheduledFor || run.createdAt || null,
        completedAt: run.completedAt || null
      },
      updatedAt: now
    });
  }

  _markStaleActiveRuns(task, now) {
    if (!task?.id || typeof this.store?.saveRun !== "function") return false;
    let changed = false;
    for (const run of this._listRuns(task.id)) {
      if (!ACTIVE_RUN_STATUSES.has(run?.status)) continue;
      if (!isStaleActiveRun(run, task, now)) continue;
      const next = this.store.saveRun({
        ...run,
        status: "failed",
        completedAt: now,
        error: run.error || staleRunError(run),
        stale: true
      });
      this._updateTaskLastRun(task, next || run, now);
      changed = true;
    }
    return changed;
  }

  _findActiveRun(task) {
    if (!task?.id) return null;
    return this._listRuns(task.id).find((run) => ACTIVE_RUN_STATUSES.has(run?.status)) || null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    globalThis.document?.addEventListener?.("visibilitychange", this.onVisibility);
    globalThis.addEventListener?.("storage", this.onStorage);
    this.reconcile();
  }

  stop() {
    this.started = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    globalThis.document?.removeEventListener?.("visibilitychange", this.onVisibility);
    globalThis.removeEventListener?.("storage", this.onStorage);
  }

  reconcile() {
    if (!this.started) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;

    const now = this.now();
    const tasks = this.store.listTasks();
    let changed = false;
    let nearest = null;

    for (let task of tasks) {
      if (!task.enabled || (task.executionMode && task.executionMode !== "local-only")) continue;
      if (this._markStaleActiveRuns(task, now)) {
        changed = true;
        task = this.store.getTask?.(task.id) || task;
      }
      const activeRun = this._findActiveRun(task);
      let nextRun = Number(task.nextRun);
      if (!Number.isFinite(nextRun)) {
        nextRun = computeNextRun(task.schedule, now);
        this.store.saveTask({ ...task, nextRun });
        changed = true;
      }

      if (nextRun != null && nextRun <= now) {
        const missedBy = now - nextRun;
        const due = missedBy <= 90_000;
        const advanced = computeNextRun(task.schedule, now);
        this.store.saveTask({
          ...task,
          enabled: task.schedule?.kind === "once" ? false : task.enabled,
          nextRun: advanced,
          lastSkippedAt: due ? task.lastSkippedAt : now
        });
        changed = true;
        if (due && !activeRun && !this.runningTasks.has(task.id)) void this.execute(task);
        nextRun = advanced;
      }
      if (nextRun != null && (nearest == null || nextRun < nearest)) nearest = nextRun;
    }

    if (changed) this.onChange?.();
    if (nearest != null) {
      const delay = Math.max(250, Math.min(MAX_TIMER_DELAY, nearest - this.now()));
      this.timer = this.setTimer(() => this.reconcile(), delay);
    }
  }

  async execute(task) {
    if (this.runningTasks.has(task.id)) {
      return null;
    }
    const now = this.now();
    if (this._markStaleActiveRuns(task, now)) this.onChange?.();
    if (this._findActiveRun(task)) {
      return null;
    }
    this.runningTasks.add(task.id);
    this.onChange?.();
    try {
      return await this.runTask(task);
    } finally {
      this.runningTasks.delete(task.id);
      this.onChange?.();
      this.reconcile();
    }
  }

  isRunning(taskId) {
    return this.runningTasks.has(taskId);
  }
}
