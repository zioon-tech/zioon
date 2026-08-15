const TASKS_KEY = "zion.scheduler.local.tasks.v1";
const RUNS_KEY = "zion.scheduler.local.runs.v1";
const MAX_RUNS = 100;
const MAX_EVENTS_PER_RUN = 200;
const MAX_OUTPUT_CHARS = 100_000;

function read(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export class LocalSchedulerStore {
  listTasks() {
    return read(TASKS_KEY, []).sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  }

  getTask(id) {
    return this.listTasks().find((task) => task.id === id) || null;
  }

  saveTask(task) {
    const tasks = this.listTasks();
    const index = tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
    write(TASKS_KEY, tasks);
    return task;
  }

  deleteTask(id) {
    write(TASKS_KEY, this.listTasks().filter((task) => task.id !== id));
  }

  listRuns(taskId = null) {
    const runs = read(RUNS_KEY, []);
    return runs
      .filter((run) => !taskId || run.taskId === taskId)
      .sort((a, b) => Number(b.startedAt) - Number(a.startedAt));
  }

  getRun(id) {
    return this.listRuns().find((run) => run.id === id) || null;
  }

  saveRun(run) {
    const runs = read(RUNS_KEY, []);
    const next = {
      ...run,
      output: String(run.output || "").slice(0, MAX_OUTPUT_CHARS),
      events: Array.isArray(run.events) ? run.events.slice(-MAX_EVENTS_PER_RUN) : []
    };
    const index = runs.findIndex((item) => item.id === next.id);
    if (index >= 0) runs[index] = next;
    else runs.unshift(next);
    const ordered = runs.sort((a, b) => Number(b.startedAt) - Number(a.startedAt)).slice(0, MAX_RUNS);
    if (!write(RUNS_KEY, ordered)) {
      const compact = ordered.slice(0, 20).map((item) => ({
        ...item,
        output: String(item.output || "").slice(0, 20_000),
        events: (item.events || []).slice(-50)
      }));
      write(RUNS_KEY, compact);
    }
    return next;
  }

  appendRunEvent(runId, event) {
    const run = this.getRun(runId);
    if (!run) return null;
    const events = [...(run.events || []), event].slice(-MAX_EVENTS_PER_RUN);
    return this.saveRun({ ...run, events });
  }

  clearRuns() {
    write(RUNS_KEY, []);
  }
}
