const TASKS_KEY = "zion.scheduler.local.tasks.v1";
const RUNS_KEY = "zion.scheduler.local.runs.v1";
const SESSION_ARCHIVE_KEY = "zion.scheduler.local.sessionArchive.v1";
const MAX_RUNS = 20;
const MAX_EVENTS_PER_RUN = 20;
const MAX_OUTPUT_CHARS = 2_000;
const MAX_ERROR_CHARS = 2_000;
const MAX_EVENT_DATA_CHARS = 1_500;
const EMERGENCY_RUN_LIMITS = {
  runs: 8,
  events: 8,
  outputChars: 500,
  errorChars: 500,
  eventDataChars: 500
};

function read(storage, key, fallback) {
  try {
    const parsed = JSON.parse(storage.getItem(key) || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function tryWrite(storage, key, value) {
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
    storage.setItem(key, serialized);
    return { ok: true, error: null };
  } catch (error) {
    try {
      if (serialized && storage.getItem(key) === serialized) return { ok: true, error: null };
    } catch {}
    return { ok: false, error };
  }
}

function remove(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function truncateString(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32))}\n...[truncated ${text.length - maxChars} chars]`;
}

function compactValue(value, maxChars) {
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean") return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return value;
    return {
      truncated: true,
      preview: truncateString(serialized, maxChars)
    };
  } catch {
    return truncateString(String(value), maxChars);
  }
}

function compactEvent(event, limits) {
  const next = { ...(event || {}) };
  if ("message" in next) next.message = truncateString(next.message, limits.eventDataChars);
  if ("output" in next) next.output = truncateString(next.output, limits.eventDataChars);
  if ("error" in next) next.error = truncateString(next.error, limits.errorChars);
  if ("data" in next) next.data = compactValue(next.data, limits.eventDataChars);
  return next;
}

function compactRun(run, limits = {}) {
  const maxEvents = Math.max(0, Number(limits.events ?? MAX_EVENTS_PER_RUN) || 0);
  const output = String(run?.output || "");
  const error = String(run?.error || "");
  const rawEvents = Array.isArray(run?.events) ? run.events : [];
  const events = maxEvents
    ? rawEvents
      .slice(-maxEvents)
      .map((event) => compactEvent(event, {
        eventDataChars: Number(limits.eventDataChars ?? MAX_EVENT_DATA_CHARS) || MAX_EVENT_DATA_CHARS,
        errorChars: Number(limits.errorChars ?? MAX_ERROR_CHARS) || MAX_ERROR_CHARS
      }))
    : [];
  return {
    ...(run || {}),
    output: truncateString(output, Number(limits.outputChars ?? MAX_OUTPUT_CHARS) || MAX_OUTPUT_CHARS),
    outputTruncated: Boolean(run?.outputTruncated || output.length > (Number(limits.outputChars ?? MAX_OUTPUT_CHARS) || MAX_OUTPUT_CHARS)),
    error: error ? truncateString(error, Number(limits.errorChars ?? MAX_ERROR_CHARS) || MAX_ERROR_CHARS) : null,
    errorTruncated: Boolean(run?.errorTruncated || error.length > (Number(limits.errorChars ?? MAX_ERROR_CHARS) || MAX_ERROR_CHARS)),
    events,
    eventsTruncated: Boolean(run?.eventsTruncated || rawEvents.length > events.length)
  };
}

function sortRuns(runs) {
  return [...(Array.isArray(runs) ? runs : [])]
    .sort((a, b) => Number(b?.startedAt || b?.createdAt || 0) - Number(a?.startedAt || a?.createdAt || 0));
}

function compactRuns(runs, limits = {}) {
  const maxRuns = Math.max(0, Number(limits.runs ?? MAX_RUNS) || 0);
  return sortRuns(runs)
    .slice(0, maxRuns)
    .map((run) => compactRun(run, limits));
}

function storageWriteError(key, cause = null) {
  const error = new Error(
    key === TASKS_KEY
      ? "定时任务本地存储写入失败，请清理浏览器站点数据后重试"
      : "定时任务运行记录写入失败，已尽量裁剪历史记录"
  );
  error.code = "SCHEDULER_STORAGE_WRITE_FAILED";
  error.storageKey = key;
  if (cause) error.cause = cause;
  return error;
}

function reclaimRunStorage(storage) {
  const compact = compactRuns(read(storage, RUNS_KEY, []), EMERGENCY_RUN_LIMITS);
  if (tryWrite(storage, RUNS_KEY, compact).ok) return true;
  remove(storage, RUNS_KEY);
  return tryWrite(storage, RUNS_KEY, []).ok;
}

function writeDurable(storage, key, value) {
  let result = tryWrite(storage, key, value);
  if (result.ok) return true;
  if (key !== RUNS_KEY && reclaimRunStorage(storage)) {
    result = tryWrite(storage, key, value);
    if (result.ok) return true;
  }
  throw storageWriteError(key, result.error);
}

function writeRuns(storage, runs) {
  const attempts = [
    compactRuns(runs),
    compactRuns(runs, EMERGENCY_RUN_LIMITS),
    []
  ];
  for (const candidate of attempts) {
    if (tryWrite(storage, RUNS_KEY, candidate).ok) return candidate;
  }
  remove(storage, RUNS_KEY);
  return [];
}

export class LocalSchedulerStore {
  constructor(storage = localStorage) {
    this.storage = storage;
  }

  listTasks() {
    return read(this.storage, TASKS_KEY, []).sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  }

  getTask(id) {
    return this.listTasks().find((task) => task.id === id) || null;
  }

  saveTask(task) {
    const tasks = this.listTasks();
    const index = tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
    writeDurable(this.storage, TASKS_KEY, tasks);
    return task;
  }

  deleteTask(id) {
    writeDurable(this.storage, TASKS_KEY, this.listTasks().filter((task) => task.id !== id));
  }

  getSessionArchiveState() {
    const value = read(this.storage, SESSION_ARCHIVE_KEY, {});
    return {
      folderId: String(value?.folderId || "") || null,
      folderLocale: String(value?.folderLocale || ""),
      migrationVersion: Math.max(0, Number(value?.migrationVersion) || 0)
    };
  }

  saveSessionArchiveState(patch = {}) {
    const next = { ...this.getSessionArchiveState(), ...(patch || {}) };
    writeDurable(this.storage, SESSION_ARCHIVE_KEY, next);
    return next;
  }

  listRuns(taskId = null) {
    const runs = read(this.storage, RUNS_KEY, []);
    return runs
      .filter((run) => !taskId || run.taskId === taskId)
      .sort((a, b) => Number(b.startedAt) - Number(a.startedAt));
  }

  getRun(id) {
    return this.listRuns().find((run) => run.id === id) || null;
  }

  saveRun(run) {
    const runs = read(this.storage, RUNS_KEY, []);
    const next = compactRun(run);
    const index = runs.findIndex((item) => item.id === next.id);
    if (index >= 0) runs[index] = next;
    else runs.unshift(next);
    writeRuns(this.storage, runs);
    return next;
  }

  appendRunEvent(runId, event) {
    const run = this.getRun(runId);
    if (!run) return null;
    const events = [...(run.events || []), event].slice(-MAX_EVENTS_PER_RUN);
    return this.saveRun({ ...run, events });
  }

  clearRuns() {
    if (!tryWrite(this.storage, RUNS_KEY, []).ok) remove(this.storage, RUNS_KEY);
  }
}
