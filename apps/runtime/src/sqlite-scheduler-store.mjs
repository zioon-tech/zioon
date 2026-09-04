import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":"));

const TASK_TYPES = new Set(["agent", "command"]);
const SCHEDULE_KINDS = new Set(["interval", "daily", "weekdays", "once"]);
const POLICY_PRESETS = new Set(["read-only", "workspace-write", "trusted-automation"]);
const MUTATING_TOOLS = new Set(["write", "edit", "Bash", "sendMail", "todoWrite"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const TERMINAL_STATUSES = new Set(["success", "failed", "aborted"]);
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const LEGACY_TOOL_ALIASES = new Map([
  ["fsWrite", "write"],
  ["fsEdit", "edit"],
  ["terminalExecute", "Bash"]
]);

function encode(value) {
  return JSON.stringify(value);
}

function decode(value, fallback = null) {
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function clone(value) {
  return value == null ? value : decode(encode(value));
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function normalizeTools(value) {
  return uniqueStrings(value).map((name) => LEGACY_TOOL_ALIASES.get(name) || name);
}

function error(message, statusCode = 400) {
  const value = new Error(message);
  value.statusCode = statusCode;
  return value;
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function zonedParts(timestamp, timeZone) {
  if (!timeZone || timeZone === "local") {
    const date = new Date(timestamp);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes()
    };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function zonedEpoch(parts, timeZone) {
  if (!timeZone || timeZone === "local") {
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0
    ).getTime();
  }
  const targetAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute
  );
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute
    );
    const difference = targetAsUtc - actualAsUtc;
    candidate += difference;
    if (difference === 0) break;
  }
  return candidate;
}

function addCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

export function nextScheduledAt(schedule, after = Date.now()) {
  const kind = String(schedule?.kind || "");
  if (kind === "interval") {
    return after + Number(schedule.intervalMinutes) * 60_000;
  }
  if (kind === "once") {
    const timestamp = Number(schedule.timestamp);
    return Number.isFinite(timestamp) && timestamp > after ? timestamp : null;
  }
  const time = parseTime(schedule?.time);
  if (!time || !["daily", "weekdays"].includes(kind)) return null;
  const timeZone = String(schedule.timeZone || "local");
  let calendar = { ...zonedParts(after, timeZone), ...time };
  let candidate = zonedEpoch(calendar, timeZone);
  if (candidate <= after) {
    calendar = addCalendarDays(calendar, 1);
    candidate = zonedEpoch(calendar, timeZone);
  }
  if (kind === "weekdays") {
    while ([0, 6].includes(new Date(Date.UTC(
      calendar.year,
      calendar.month - 1,
      calendar.day
    )).getUTCDay())) {
      calendar = addCalendarDays(calendar, 1);
      candidate = zonedEpoch(calendar, timeZone);
    }
  }
  return candidate;
}

export function normalizeSchedulerPolicy(input = {}) {
  const preset = POLICY_PRESETS.has(input?.preset) ? input.preset : "read-only";
  return {
    preset,
    allowedTools: normalizeTools(input?.allowedTools),
    fileRoots: uniqueStrings(input?.fileRoots),
    allowedCommandPrefixes: uniqueStrings(input?.allowedCommandPrefixes),
    allowedTerminalSessionIds: uniqueStrings(input?.allowedTerminalSessionIds),
    allowedRecipients: uniqueStrings(input?.allowedRecipients)
      .map((value) => value.toLowerCase()),
    maxMailPerRun: Math.max(0, Math.min(100, Number(input?.maxMailPerRun) || 0)),
    maxToolCalls: Math.max(1, Math.min(500, Number(input?.maxToolCalls) || 50))
  };
}

function normalizeSchedule(input = {}) {
  const kind = SCHEDULE_KINDS.has(input?.kind) ? input.kind : "daily";
  const schedule = {
    kind,
    timeZone: String(input.timeZone || localTimeZone()),
    misfirePolicy: input.misfirePolicy === "skip" ? "skip" : "run-once",
    overlapPolicy: "forbid"
  };
  if (kind === "interval") {
    schedule.intervalMinutes = Number(input.intervalMinutes);
  } else if (kind === "once") {
    schedule.timestamp = Number(input.timestamp);
  } else {
    schedule.time = String(input.time || "");
  }
  return schedule;
}

function validateTask(task) {
  if (!String(task.title || "").trim()) throw error("title is required", 422);
  if (String(task.title).length > 120) throw error("title exceeds 120 characters", 422);
  if (task.taskType === "agent" && !String(task.prompt || "").trim()) {
    throw error("prompt is required for agent tasks", 422);
  }
  if (String(task.prompt || "").length > 50_000) {
    throw error("prompt exceeds 50000 characters", 422);
  }
  if (task.taskType === "command" && !String(task.command || "").trim()) {
    throw error("command is required for command tasks", 422);
  }
  if (String(task.command || "").length > 4_000) {
    throw error("command exceeds 4000 characters", 422);
  }
  const schedule = task.schedule || {};
  if (schedule.kind === "interval") {
    if (
      !Number.isInteger(schedule.intervalMinutes)
      || schedule.intervalMinutes < 1
      || schedule.intervalMinutes > 10_080
    ) {
      throw error("intervalMinutes must be between 1 and 10080", 422);
    }
  } else if (schedule.kind === "once") {
    if (!Number.isFinite(schedule.timestamp)) {
      throw error("timestamp is required for once schedules", 422);
    }
  } else if (!parseTime(schedule.time)) {
    throw error("time must use HH:mm", 422);
  }
  if (schedule.timeZone !== "local") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: schedule.timeZone }).format();
    } catch {
      throw error(`Invalid time zone: ${schedule.timeZone}`, 422);
    }
  }

  const policy = task.capability;
  if (
    task.interactionProfileId
    && !PROFILE_ID_PATTERN.test(task.interactionProfileId)
  ) {
    throw error("interactionProfileId is invalid", 422);
  }
  const allowed = new Set(policy.allowedTools);
  if (allowed.has("schedulerManage")) {
    throw error("schedulerManage cannot be used by scheduled tasks", 422);
  }
  if (policy.allowedCommandPrefixes.length && !allowed.has("Bash")) {
    throw error("Bash is required when terminal policy is configured", 422);
  }
  if (
    (policy.allowedRecipients.length || policy.maxMailPerRun > 0)
    && !allowed.has("sendMail")
  ) {
    throw error("sendMail is required when mail policy is configured", 422);
  }
  if (
    policy.preset === "read-only"
    && [...allowed].some((name) => MUTATING_TOOLS.has(name))
  ) {
    throw error("read-only policy cannot enable mutating tools", 422);
  }
  if (
    [...allowed].some((name) => FILE_WRITE_TOOLS.has(name))
    && !policy.fileRoots.length
  ) {
    throw error("fileRoots is required for file write tools", 422);
  }
  if (
    task.taskType === "command"
    && !policy.allowedCommandPrefixes.some(
      (prefix) => task.command === prefix || task.command.startsWith(`${prefix} `)
    )
  ) {
    throw error("command must match allowedCommandPrefixes", 422);
  }
  if (
    allowed.has("sendMail")
    && (!policy.allowedRecipients.length || policy.maxMailPerRun < 1)
  ) {
    throw error("allowedRecipients and maxMailPerRun are required for sendMail", 422);
  }
}

function taskPayload(input, existing = null, timestamp = Date.now()) {
  const taskType = TASK_TYPES.has(input?.taskType)
    ? input.taskType
    : existing?.taskType || "agent";
  const schedule = normalizeSchedule({
    ...(existing?.schedule || {}),
    ...(input?.schedule || {})
  });
  const capability = normalizeSchedulerPolicy({
    ...(existing?.capability || {}),
    ...(input?.capability || {})
  });
  const task = {
    ...(existing || {}),
    taskType,
    executionMode: "service-backed",
    title: String(input?.title ?? existing?.title ?? "").trim(),
    prompt: String(input?.prompt ?? existing?.prompt ?? ""),
    command: String(input?.command ?? existing?.command ?? "").trim(),
    cwd: String(input?.cwd ?? existing?.cwd ?? "").trim(),
    note: String(input?.note ?? existing?.note ?? ""),
    interactionProfileId: String(
      input?.interactionProfileId
      ?? existing?.interactionProfileId
      ?? ""
    ).trim(),
    schedule,
    capability,
    timeoutSeconds: Math.max(
      10,
      Math.min(3600, Number(input?.timeoutSeconds ?? existing?.timeoutSeconds) || 300)
    ),
    enabled: typeof input?.enabled === "boolean"
      ? input.enabled
      : existing?.enabled ?? true,
    clientTaskId: input?.clientTaskId ?? existing?.clientTaskId ?? null,
    updatedAt: timestamp
  };
  if (taskType === "command") {
    task.capability = normalizeSchedulerPolicy({
      ...capability,
      preset: "trusted-automation",
      allowedTools: capability.allowedTools.includes("Bash")
        ? capability.allowedTools
        : [...capability.allowedTools, "Bash"],
      allowedCommandPrefixes: capability.allowedCommandPrefixes.length
        ? capability.allowedCommandPrefixes
        : task.command ? [task.command] : []
    });
  }
  validateTask(task);
  return task;
}

function summarizeRun(run) {
  const {
    events,
    output,
    task,
    ...summary
  } = run;
  return {
    ...summary,
    task: {
      id: task?.id,
      title: task?.title,
      taskType: task?.taskType
    },
    eventCount: Array.isArray(events) ? events.length : 0,
    outputLength: String(output || "").length,
    isSummary: true
  };
}

function occurrenceId(taskId, scheduledFor, trigger) {
  return createHash("sha256")
    .update(`${taskId}:${scheduledFor}:${trigger}`)
    .digest("hex")
    .slice(0, 32);
}

function taskSupportedBy(task, tools) {
  const available = new Set(normalizeTools(tools));
  return normalizeTools(task?.capability?.allowedTools)
    .every((name) => available.has(name));
}

export class SqliteSchedulerStore {
  constructor(path, {
    now = () => Date.now(),
    availableTools = null
  } = {}) {
    this.path = path;
    this.now = now;
    this.availableTools = Array.isArray(availableTools)
      ? normalizeTools(availableTools)
      : null;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 30000;

      CREATE TABLE IF NOT EXISTS runtime_scheduler_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_scheduler_tasks (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        next_run INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_scheduler_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        lease_until INTEGER,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_scheduler_migrations (
        source TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source, fingerprint)
      );

      CREATE INDEX IF NOT EXISTS runtime_scheduler_tasks_due
        ON runtime_scheduler_tasks(enabled, next_run);
      CREATE INDEX IF NOT EXISTS runtime_scheduler_runs_task
        ON runtime_scheduler_runs(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS runtime_scheduler_runs_status
        ON runtime_scheduler_runs(status, created_at);
    `);
    const runColumns = new Set(this.db.prepare(
      "PRAGMA table_info(runtime_scheduler_runs)"
    ).all().map((column) => column.name));
    if (!runColumns.has("lease_until")) {
      this.db.exec(
        "ALTER TABLE runtime_scheduler_runs ADD COLUMN lease_until INTEGER"
      );
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO runtime_scheduler_state (id, payload_json, updated_at)
      VALUES (1, ?, ?)
    `).run(encode({ schemaVersion: 1, tasks: [], runs: [] }), this.now());
    const normalizedCount = Number(this.db.prepare(
      "SELECT COUNT(*) AS count FROM runtime_scheduler_tasks"
    ).get().count) + Number(this.db.prepare(
      "SELECT COUNT(*) AS count FROM runtime_scheduler_runs"
    ).get().count);
    const legacy = decode(this.db.prepare(
      "SELECT payload_json FROM runtime_scheduler_state WHERE id = 1"
    ).get()?.payload_json, {});
    if (
      normalizedCount === 0
      && ((legacy?.tasks?.length || 0) > 0 || (legacy?.runs?.length || 0) > 0)
    ) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const task of legacy.tasks || []) this.writeTaskRow(task);
        for (const run of legacy.runs || []) this.writeRunRow(run);
        this.db.prepare(`
          UPDATE runtime_scheduler_state
          SET payload_json = ?, updated_at = ?
          WHERE id = 1
        `).run(encode({ schemaVersion: 1, tasks: [], runs: [] }), this.now());
        this.db.exec("COMMIT");
      } catch (migrationError) {
        this.db.exec("ROLLBACK");
        throw migrationError;
      }
    }
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Some filesystems do not support POSIX permissions.
      }
    }
  }

  snapshot() {
    return {
      schemaVersion: 1,
      tasks: this.db.prepare(`
        SELECT payload_json FROM runtime_scheduler_tasks ORDER BY created_at
      `).all().map((row) => decode(row.payload_json, {})),
      runs: this.db.prepare(`
        SELECT payload_json FROM runtime_scheduler_runs ORDER BY created_at
      `).all().map((row) => decode(row.payload_json, {}))
    };
  }

  writeTaskRow(task) {
    this.db.prepare(`
      INSERT INTO runtime_scheduler_tasks
        (id, payload_json, enabled, next_run, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        enabled = excluded.enabled,
        next_run = excluded.next_run,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      task.id,
      encode(task),
      task.enabled ? 1 : 0,
      task.nextRun == null ? null : Number(task.nextRun),
      Number(task.createdAt || this.now()),
      Number(task.updatedAt || this.now())
    );
  }

  writeRunRow(run) {
    this.db.prepare(`
      INSERT INTO runtime_scheduler_runs
        (id, task_id, occurrence_id, status, lease_until, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        occurrence_id = excluded.occurrence_id,
        status = excluded.status,
        lease_until = excluded.lease_until,
        payload_json = excluded.payload_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      run.id,
      String(run.taskId || ""),
      String(run.occurrenceId || run.id),
      String(run.status || "pending"),
      run.leaseUntil == null ? null : Number(run.leaseUntil),
      encode(run),
      Number(run.createdAt || this.now()),
      Number(run.completedAt || run.startedAt || run.createdAt || this.now())
    );
  }

  update(mutator) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const data = this.snapshot();
      const previousTasks = new Map(data.tasks.map((task) => [task.id, encode(task)]));
      const previousRuns = new Map(data.runs.map((run) => [run.id, encode(run)]));
      const result = mutator(data);
      const nextTaskIds = new Set();
      for (const task of data.tasks) {
        nextTaskIds.add(task.id);
        if (previousTasks.get(task.id) !== encode(task)) this.writeTaskRow(task);
      }
      const nextRunIds = new Set();
      for (const run of data.runs) {
        nextRunIds.add(run.id);
        if (previousRuns.get(run.id) !== encode(run)) this.writeRunRow(run);
      }
      for (const id of previousTasks.keys()) {
        if (!nextTaskIds.has(id)) {
          this.db.prepare("DELETE FROM runtime_scheduler_tasks WHERE id = ?").run(id);
        }
      }
      for (const id of previousRuns.keys()) {
        if (!nextRunIds.has(id)) {
          this.db.prepare("DELETE FROM runtime_scheduler_runs WHERE id = ?").run(id);
        }
      }
      this.db.exec("COMMIT");
      return clone(result);
    } catch (errorValue) {
      this.db.exec("ROLLBACK");
      throw errorValue;
    }
  }

  listTasks() {
    return this.db.prepare(`
      SELECT payload_json
      FROM runtime_scheduler_tasks
      ORDER BY created_at
    `).all().map((row) => decode(row.payload_json, {}));
  }

  getTask(taskId) {
    const row = this.db.prepare(
      "SELECT payload_json FROM runtime_scheduler_tasks WHERE id = ?"
    ).get(String(taskId));
    const task = row ? decode(row.payload_json, {}) : null;
    if (!task) throw error("Task not found", 404);
    return task;
  }

  setAvailableTools(tools) {
    this.availableTools = normalizeTools(tools);
  }

  createTask(input) {
    const timestamp = this.now();
    const task = {
      id: `sched_${randomUUID().replaceAll("-", "")}`,
      revision: 1,
      ...taskPayload(input, null, timestamp),
      createdAt: timestamp
    };
    this.assertTaskSupported(task);
    task.nextRun = task.enabled ? nextScheduledAt(task.schedule, timestamp) : null;
    this.writeTaskRow(task);
    return clone(task);
  }

  updateTask(taskId, input) {
    const current = this.getTask(taskId);
    if (Number(input?.revision) !== Number(current.revision)) {
      throw error("Task revision conflict", 409);
    }
    const timestamp = this.now();
    const task = {
      ...taskPayload(input, current, timestamp),
      id: current.id,
      revision: current.revision + 1,
      createdAt: current.createdAt
    };
    this.assertTaskSupported(task);
    task.nextRun = task.enabled ? nextScheduledAt(task.schedule, timestamp) : null;
    this.writeTaskRow(task);
    return clone(task);
  }

  assertTaskSupported(task) {
    if (!this.availableTools) return;
    const unsupported = normalizeTools(task?.capability?.allowedTools)
      .filter((name) => !this.availableTools.includes(name));
    if (unsupported.length) {
      throw error(
        `Runtime Scheduler does not provide required tools: ${unsupported.join(", ")}`,
        422
      );
    }
  }

  deleteTask(taskId) {
    const result = this.db.prepare(
      "DELETE FROM runtime_scheduler_tasks WHERE id = ?"
    ).run(String(taskId));
    if (Number(result.changes) === 0) throw error("Task not found", 404);
    return null;
  }

  listRuns({
    taskId = "",
    limit = 50,
    offset = 0,
    includeDetails = false
  } = {}) {
    const maximum = Math.max(1, Math.min(200, Number(limit) || 50));
    const start = Math.max(0, Number(offset) || 0);
    const page = (
      taskId
        ? this.db.prepare(`
            SELECT payload_json
            FROM runtime_scheduler_runs
            WHERE task_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
          `).all(String(taskId), maximum + 1, start)
        : this.db.prepare(`
            SELECT payload_json
            FROM runtime_scheduler_runs
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
          `).all(maximum + 1, start)
    ).map((row) => decode(row.payload_json, {}));
    const hasMore = page.length > maximum;
    return {
      runs: page.slice(0, maximum).map((run) => (
        includeDetails ? run : summarizeRun(run)
      )),
      limit: maximum,
      offset: start,
      hasMore,
      nextOffset: hasMore ? start + maximum : null
    };
  }

  getRun(runId) {
    const row = this.db.prepare(
      "SELECT payload_json FROM runtime_scheduler_runs WHERE id = ?"
    ).get(String(runId));
    const run = row ? decode(row.payload_json, {}) : null;
    if (!run) throw error("Run not found", 404);
    return run;
  }

  enqueue(task, scheduledFor, trigger) {
    const occurrence = occurrenceId(task.id, scheduledFor, trigger);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = this.db.prepare(
        "SELECT payload_json FROM runtime_scheduler_runs WHERE occurrence_id = ?"
      ).get(occurrence);
      if (existingRow) {
        this.db.exec("COMMIT");
        return decode(existingRow.payload_json, {});
      }
      const run = {
        id: `scheduler_run_${randomUUID().replaceAll("-", "")}`,
        occurrenceId: occurrence,
        taskId: task.id,
        taskRevision: task.revision,
        task: clone(task),
        status: "pending",
        trigger,
        scheduledFor,
        createdAt: this.now(),
        startedAt: null,
        completedAt: null,
        workerId: null,
        workerKind: null,
        leaseUntil: null,
        sessionId: null,
        chatRunId: null,
        output: "",
        error: null,
        usage: null,
        events: []
      };
      this.writeRunRow(run);
      this.db.prepare(`
        DELETE FROM runtime_scheduler_runs
        WHERE id IN (
          SELECT id
          FROM runtime_scheduler_runs
          ORDER BY created_at DESC
          LIMIT -1 OFFSET 1000
        )
      `).run();
      this.db.exec("COMMIT");
      return clone(run);
    } catch (errorValue) {
      this.db.exec("ROLLBACK");
      throw errorValue;
    }
  }

  runNow(taskId) {
    return this.enqueue(this.getTask(taskId), this.now(), "manual");
  }

  tick() {
    const current = this.now();
    const hasExpiredLease = !!this.db.prepare(`
      SELECT 1
      FROM runtime_scheduler_runs
      WHERE status = 'leased' AND lease_until <= ?
      LIMIT 1
    `).get(current);
    const hasDueTask = !!this.db.prepare(`
      SELECT 1
      FROM runtime_scheduler_tasks
      WHERE enabled = 1 AND next_run <= ?
      LIMIT 1
    `).get(current);
    if (!hasExpiredLease && !hasDueTask) return [];
    return this.update((data) => {
      const enqueued = [];
      for (const run of data.runs) {
        if (run.status === "leased" && Number(run.leaseUntil || 0) <= current) {
          Object.assign(run, {
            status: "failed",
            completedAt: current,
            leaseUntil: null,
            error: run.error || "Run lease expired before completion"
          });
        }
      }
      for (const task of data.tasks) {
        const due = Number(task.nextRun);
        if (!task.enabled || !Number.isFinite(due) || due > current) continue;
        const active = data.runs.some(
          (run) => run.taskId === task.id && ["pending", "leased"].includes(run.status)
        );
        const stale = current - due > 90_000;
        if (!active && (!stale || task.schedule.misfirePolicy === "run-once")) {
          const occurrence = occurrenceId(task.id, due, "schedule");
          if (!data.runs.some((run) => run.occurrenceId === occurrence)) {
            const run = {
              id: `scheduler_run_${randomUUID().replaceAll("-", "")}`,
              occurrenceId: occurrence,
              taskId: task.id,
              taskRevision: task.revision,
              task: clone(task),
              status: "pending",
              trigger: "schedule",
              scheduledFor: due,
              createdAt: current,
              startedAt: null,
              completedAt: null,
              workerId: null,
              workerKind: null,
              leaseUntil: null,
              sessionId: null,
              chatRunId: null,
              output: "",
              error: null,
              usage: null,
              events: []
            };
            data.runs.push(run);
            enqueued.push(run);
          }
        }
        if (task.schedule.kind === "once") {
          task.enabled = false;
          task.nextRun = null;
        } else {
          task.nextRun = nextScheduledAt(task.schedule, current);
        }
      }
      data.runs = data.runs.slice(-1000);
      return enqueued;
    });
  }

  claim({
    workerId,
    workerKind = "workbench",
    leaseSeconds = 120,
    availableTools = []
  }) {
    const id = String(workerId || "").trim();
    if (!id) throw error("workerId is required", 422);
    const current = this.now();
    const available = normalizeTools(availableTools);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT payload_json
        FROM runtime_scheduler_runs
        WHERE status = 'pending'
        ORDER BY created_at
      `).all();
      const run = rows
        .map((row) => decode(row.payload_json, {}))
        .find((candidate) => taskSupportedBy(candidate.task, available));
      if (!run) {
        this.db.exec("COMMIT");
        return null;
      }
      const effectiveLeaseSeconds = Math.max(
        30,
        Number(leaseSeconds) || 120,
        Number(run.task?.timeoutSeconds || 0) + 60
      );
      Object.assign(run, {
        status: "leased",
        workerId: id,
        workerKind: String(workerKind || "workbench"),
        leaseUntil: current + effectiveLeaseSeconds * 1000,
        startedAt: run.startedAt || current
      });
      this.writeRunRow(run);
      this.db.exec("COMMIT");
      return clone(run);
    } catch (errorValue) {
      this.db.exec("ROLLBACK");
      throw errorValue;
    }
  }

  requireLeasedRun(runId, workerId) {
    const run = this.getRun(runId);
    if (run.status !== "leased" || run.workerId !== String(workerId)) {
      throw error("Run lease is not owned by this worker", 409);
    }
    return run;
  }

  appendEvent(runId, workerId, eventValue) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.requireLeasedRun(runId, workerId);
      run.events = [...(run.events || []), clone(eventValue)].slice(-500);
      this.writeRunRow(run);
      this.db.exec("COMMIT");
      return clone(run);
    } catch (errorValue) {
      this.db.exec("ROLLBACK");
      throw errorValue;
    }
  }

  complete(runId, workerId, result) {
    if (!TERMINAL_STATUSES.has(String(result?.status))) {
      throw error("Invalid terminal status", 422);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.requireLeasedRun(runId, workerId);
      Object.assign(run, {
        status: result.status,
        sessionId: result.sessionId || null,
        chatRunId: result.chatRunId || null,
        output: String(result.output || ""),
        error: result.error ? String(result.error) : null,
        usage: result.usage || null,
        completedAt: this.now(),
        leaseUntil: null
      });
      this.writeRunRow(run);
      let task = null;
      try {
        task = this.getTask(run.taskId);
      } catch (taskError) {
        if (taskError.statusCode !== 404) throw taskError;
      }
      if (task != null) {
        task.lastRun = {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt
        };
        task.updatedAt = this.now();
        this.writeTaskRow(task);
      }
      this.db.exec("COMMIT");
      return clone(run);
    } catch (errorValue) {
      this.db.exec("ROLLBACK");
      throw errorValue;
    }
  }

  cancel(runId, reason = "user") {
    const run = this.getRun(runId);
    if (TERMINAL_STATUSES.has(run.status)) return run;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      Object.assign(run, {
        status: "aborted",
        completedAt: this.now(),
        leaseUntil: null,
        error: reason === "timeout" ? "Run timed out" : "Run cancelled",
        cancelReason: String(reason || "user")
      });
      this.writeRunRow(run);
      this.db.exec("COMMIT");
      return clone(run);
    } catch (errorValue) {
      this.db.exec("ROLLBACK");
      throw errorValue;
    }
  }

  hasLegacyMigration() {
    return !!this.db.prepare(`
      SELECT 1
      FROM runtime_scheduler_migrations
      WHERE source = 'zion-local-tools:scheduler'
      LIMIT 1
    `).get();
  }

  importLegacySnapshot(payload, fingerprint) {
    const source = "zion-local-tools:scheduler";
    const marker = String(fingerprint || "").trim();
    if (!marker) throw error("scheduler migration fingerprint required");
    const existing = this.db.prepare(`
      SELECT result_json FROM runtime_scheduler_migrations
      WHERE source = ? AND fingerprint = ?
    `).get(source, marker);
    if (existing) return { ...decode(existing.result_json, {}), duplicate: true };
    const incomingTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    const incomingRuns = Array.isArray(payload?.runs) ? payload.runs : [];
    const result = this.update((data) => {
      const taskIds = new Set(data.tasks.map((task) => task.id));
      const runIds = new Set(data.runs.map((run) => run.id));
      let importedTasks = 0;
      let importedRuns = 0;
      for (const task of incomingTasks) {
        if (!task?.id || taskIds.has(task.id)) continue;
        data.tasks.push(clone(task));
        taskIds.add(task.id);
        importedTasks += 1;
      }
      for (const run of incomingRuns) {
        if (!run?.id || runIds.has(run.id)) continue;
        data.runs.push(clone(run));
        runIds.add(run.id);
        importedRuns += 1;
      }
      data.runs = data.runs.slice(-1000);
      return { ok: true, importedTasks, importedRuns };
    });
    this.db.prepare(`
      INSERT INTO runtime_scheduler_migrations
        (source, fingerprint, result_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(source, marker, encode(result), this.now());
    return result;
  }

  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close() {
    this.db.close();
  }
}
