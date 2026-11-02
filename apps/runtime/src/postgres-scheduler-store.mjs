import { createHash, randomUUID } from "node:crypto";

const TASK_TYPES = new Set(["agent", "command"]);
const SCHEDULE_KINDS = new Set(["interval", "daily", "weekdays", "once"]);
const POLICY_PRESETS = new Set(["read-only", "workspace-write", "trusted-automation"]);
const MUTATING_TOOLS = new Set(["write", "edit", "Bash", "sendMail", "todoWrite"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const TERMINAL_STATUSES = new Set(["success", "failed", "aborted"]);
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const LEGACY_TOOL_ALIASES = new Map([
  ["fsWrite", "write"],
  ["fsEdit", "edit"],
  ["terminalExecute", "Bash"]
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function jsonValue(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return clone(value);
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function normalizeTools(value) {
  return uniqueStrings(value).map((name) => LEGACY_TOOL_ALIASES.get(name) || name);
}

function normalizeModels(value) {
  return new Map(
    (Array.isArray(value) ? value : [])
      .map((profile) => [String(profile?.id || "").trim(), profile])
      .filter(([id]) => id)
  );
}

function normalizeNodes(value) {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map((node) => String(node?.nodeId || node || "").trim())
      .filter(Boolean)
  );
}

function statusError(message, statusCode = 400) {
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
  if (kind === "interval") schedule.intervalMinutes = Number(input.intervalMinutes);
  else if (kind === "once") schedule.timestamp = Number(input.timestamp);
  else schedule.time = String(input.time || "");
  return schedule;
}

function validateTask(task) {
  if (!String(task.title || "").trim()) throw statusError("title is required", 422);
  if (String(task.title).length > 120) {
    throw statusError("title exceeds 120 characters", 422);
  }
  if (task.taskType === "agent" && !String(task.prompt || "").trim()) {
    throw statusError("prompt is required for agent tasks", 422);
  }
  if (String(task.prompt || "").length > 50_000) {
    throw statusError("prompt exceeds 50000 characters", 422);
  }
  if (task.taskType === "command" && !String(task.command || "").trim()) {
    throw statusError("command is required for command tasks", 422);
  }
  if (String(task.command || "").length > 4_000) {
    throw statusError("command exceeds 4000 characters", 422);
  }
  const schedule = task.schedule || {};
  if (schedule.kind === "interval") {
    if (
      !Number.isInteger(schedule.intervalMinutes)
      || schedule.intervalMinutes < 1
      || schedule.intervalMinutes > 10_080
    ) {
      throw statusError("intervalMinutes must be between 1 and 10080", 422);
    }
  } else if (schedule.kind === "once") {
    if (!Number.isFinite(schedule.timestamp)) {
      throw statusError("timestamp is required for once schedules", 422);
    }
  } else if (!parseTime(schedule.time)) {
    throw statusError("time must use HH:mm", 422);
  }
  if (schedule.timeZone !== "local") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: schedule.timeZone }).format();
    } catch {
      throw statusError(`Invalid time zone: ${schedule.timeZone}`, 422);
    }
  }
  const policy = task.capability;
  if (task.interactionProfileId && !PROFILE_ID_PATTERN.test(task.interactionProfileId)) {
    throw statusError("interactionProfileId is invalid", 422);
  }
  if (task.modelProfileId && !PROFILE_ID_PATTERN.test(task.modelProfileId)) {
    throw statusError("modelProfileId is invalid", 422);
  }
  if (task.nodeId && !NODE_ID_PATTERN.test(task.nodeId)) {
    throw statusError("nodeId is invalid", 422);
  }
  if (task.taskType === "command" && !task.nodeId) {
    throw statusError("nodeId is required for command tasks", 422);
  }
  const allowed = new Set(policy.allowedTools);
  if (policy.allowedCommandPrefixes.length && !allowed.has("Bash")) {
    throw statusError("Bash is required when terminal policy is configured", 422);
  }
  if (
    (policy.allowedRecipients.length || policy.maxMailPerRun > 0)
    && !allowed.has("sendMail")
  ) {
    throw statusError("sendMail is required when mail policy is configured", 422);
  }
  if (
    policy.preset === "read-only"
    && [...allowed].some((name) => MUTATING_TOOLS.has(name))
  ) {
    throw statusError("read-only policy cannot enable mutating tools", 422);
  }
  if (
    [...allowed].some((name) => FILE_WRITE_TOOLS.has(name))
    && !policy.fileRoots.length
  ) {
    throw statusError("fileRoots is required for file write tools", 422);
  }
  if (
    task.taskType === "command"
    && !policy.allowedCommandPrefixes.some(
      (prefix) => task.command === prefix || task.command.startsWith(`${prefix} `)
    )
  ) {
    throw statusError("command must match allowedCommandPrefixes", 422);
  }
  if (
    allowed.has("sendMail")
    && (!policy.allowedRecipients.length || policy.maxMailPerRun < 1)
  ) {
    throw statusError(
      "allowedRecipients and maxMailPerRun are required for sendMail",
      422
    );
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
    ...(input?.executionPrincipal
      ? { executionPrincipal: clone(input.executionPrincipal) }
      : {}),
    executionMode: "service-backed",
    title: String(input?.title ?? existing?.title ?? "").trim(),
    prompt: String(input?.prompt ?? existing?.prompt ?? ""),
    command: String(input?.command ?? existing?.command ?? "").trim(),
    cwd: String(input?.cwd ?? existing?.cwd ?? "").trim(),
    note: String(input?.note ?? existing?.note ?? ""),
    nodeId: String(input?.nodeId ?? existing?.nodeId ?? "").trim(),
    interactionProfileId: String(
      input?.interactionProfileId
      ?? existing?.interactionProfileId
      ?? "scheduled.default"
    ).trim() || "scheduled.default",
    modelProfileId: taskType === "agent"
      ? String(input?.modelProfileId ?? existing?.modelProfileId ?? "").trim()
      : "",
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
  const { events, output, task, ...summary } = run;
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

export class PostgresSchedulerStore {
  backend = "postgres";

  constructor(pool, {
    spaceId,
    now = () => Date.now(),
    availableTools = null,
    availableModels = null,
    availableNodes = null
  } = {}) {
    if (!pool?.query || !pool?.connect) {
      throw new Error("PostgreSQL Scheduler store requires a Pool");
    }
    if (!spaceId) throw new Error("PostgreSQL Scheduler store requires a Space ID");
    this.pool = pool;
    this.spaceId = String(spaceId);
    this.now = now;
    this.availableTools = Array.isArray(availableTools)
      ? normalizeTools(availableTools)
      : null;
    this.availableModels = Array.isArray(availableModels)
      ? normalizeModels(availableModels)
      : null;
    this.availableNodes = Array.isArray(availableNodes)
      ? normalizeNodes(availableNodes)
      : null;
  }

  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshot(client = this.pool) {
    const [tasks, runs] = await Promise.all([
      client.query(
        `SELECT payload_json FROM runtime_scheduler_tasks
         WHERE space_id = $1 ORDER BY created_at`,
        [this.spaceId]
      ),
      client.query(
        `SELECT payload_json FROM runtime_scheduler_runs
         WHERE space_id = $1 ORDER BY created_at`,
        [this.spaceId]
      )
    ]);
    return {
      schemaVersion: 1,
      tasks: tasks.rows.map((row) => jsonValue(row.payload_json, {})),
      runs: runs.rows.map((row) => jsonValue(row.payload_json, {}))
    };
  }

  async writeTaskRow(task, client = this.pool) {
    await client.query(
      `INSERT INTO runtime_scheduler_tasks
       (space_id, id, payload_json, enabled, next_run, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (space_id, id) DO UPDATE SET
         payload_json = EXCLUDED.payload_json,
         enabled = EXCLUDED.enabled,
         next_run = EXCLUDED.next_run,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [
        this.spaceId,
        task.id,
        JSON.stringify(task),
        Boolean(task.enabled),
        task.nextRun == null ? null : Number(task.nextRun),
        Number(task.createdAt || this.now()),
        Number(task.updatedAt || this.now())
      ]
    );
  }

  async writeRunRow(run, client = this.pool) {
    await client.query(
      `INSERT INTO runtime_scheduler_runs
       (space_id, id, task_id, occurrence_id, status, lease_until,
        payload_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT (space_id, id) DO UPDATE SET
         task_id = EXCLUDED.task_id,
         occurrence_id = EXCLUDED.occurrence_id,
         status = EXCLUDED.status,
         lease_until = EXCLUDED.lease_until,
         payload_json = EXCLUDED.payload_json,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [
        this.spaceId,
        run.id,
        String(run.taskId || ""),
        String(run.occurrenceId || run.id),
        String(run.status || "pending"),
        run.leaseUntil == null ? null : Number(run.leaseUntil),
        JSON.stringify(run),
        Number(run.createdAt || this.now()),
        Number(run.completedAt || run.startedAt || run.createdAt || this.now())
      ]
    );
  }

  async listTasks() {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_scheduler_tasks
       WHERE space_id = $1 ORDER BY created_at`,
      [this.spaceId]
    );
    return result.rows.map((row) => jsonValue(row.payload_json, {}));
  }

  async getTask(taskId, client = this.pool, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT payload_json FROM runtime_scheduler_tasks
       WHERE space_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [this.spaceId, String(taskId)]
    );
    const task = result.rows[0]
      ? jsonValue(result.rows[0].payload_json, {})
      : null;
    if (!task) throw statusError("Task not found", 404);
    return task;
  }

  setAvailableTools(tools) {
    this.availableTools = normalizeTools(tools);
  }

  setAvailableModels(models) {
    this.availableModels = normalizeModels(models);
  }

  setAvailableNodes(nodes) {
    this.availableNodes = normalizeNodes(nodes);
  }

  async createTask(input, { availableModels } = {}) {
    const timestamp = this.now();
    const task = {
      id: `sched_${randomUUID().replaceAll("-", "")}`,
      revision: 1,
      ...taskPayload(input, null, timestamp),
      createdAt: timestamp
    };
    this.assertTaskSupported(task, { availableModels });
    task.nextRun = task.enabled ? nextScheduledAt(task.schedule, timestamp) : null;
    await this.writeTaskRow(task);
    return clone(task);
  }

  async updateTask(taskId, input, { availableModels } = {}) {
    return this.transaction(async (client) => {
      const current = await this.getTask(taskId, client, { forUpdate: true });
      if (Number(input?.revision) !== Number(current.revision)) {
        throw statusError("Task revision conflict", 409);
      }
      const timestamp = this.now();
      const task = {
        ...taskPayload(input, current, timestamp),
        id: current.id,
        revision: current.revision + 1,
        createdAt: current.createdAt
      };
      this.assertTaskSupported(task, { availableModels });
      task.nextRun = task.enabled
        ? nextScheduledAt(task.schedule, timestamp)
        : null;
      await this.writeTaskRow(task, client);
      return clone(task);
    });
  }

  assertTaskSupported(task, { availableModels } = {}) {
    const models = availableModels === undefined ? this.availableModels : normalizeModels(availableModels);
    if (task.nodeId && this.availableNodes && !this.availableNodes.has(task.nodeId)) {
      throw statusError(`Runtime Scheduler Node not found: ${task.nodeId}`, 422);
    }
    if (task.taskType === "agent" && task.modelProfileId && models) {
      const profile = models.get(task.modelProfileId);
      if (!profile) {
        throw statusError(
          `Runtime Scheduler model profile not found: ${task.modelProfileId}`,
          422
        );
      }
      if (
        profile.credentialRequired !== false
        && profile.credentialConfigured !== true
      ) {
        throw statusError(
          `Runtime Scheduler model credential is not configured: ${task.modelProfileId}`,
          422
        );
      }
    }
    if (!this.availableTools) return;
    const unsupported = normalizeTools(task?.capability?.allowedTools)
      .filter((name) => !this.availableTools.includes(name));
    if (unsupported.length) {
      throw statusError(
        `Runtime Scheduler does not provide required tools: ${unsupported.join(", ")}`,
        422
      );
    }
  }

  async deleteTask(taskId) {
    const result = await this.pool.query(
      `DELETE FROM runtime_scheduler_tasks
       WHERE space_id = $1 AND id = $2`,
      [this.spaceId, String(taskId)]
    );
    if (result.rowCount === 0) throw statusError("Task not found", 404);
    return null;
  }

  async listRuns({
    taskId = "",
    limit = 50,
    offset = 0,
    includeDetails = false
  } = {}) {
    const maximum = Math.max(1, Math.min(200, Number(limit) || 50));
    const start = Math.max(0, Number(offset) || 0);
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_scheduler_runs
       WHERE space_id = $1 AND ($2::text = '' OR task_id = $2)
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [this.spaceId, String(taskId || ""), maximum + 1, start]
    );
    const page = result.rows.map((row) => jsonValue(row.payload_json, {}));
    const hasMore = page.length > maximum;
    return {
      runs: page.slice(0, maximum).map((run) =>
        includeDetails ? run : summarizeRun(run)
      ),
      limit: maximum,
      offset: start,
      hasMore,
      nextOffset: hasMore ? start + maximum : null
    };
  }

  async getRun(runId, client = this.pool, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT payload_json FROM runtime_scheduler_runs
       WHERE space_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [this.spaceId, String(runId)]
    );
    const run = result.rows[0]
      ? jsonValue(result.rows[0].payload_json, {})
      : null;
    if (!run) throw statusError("Run not found", 404);
    return run;
  }

  async enqueue(task, scheduledFor, trigger, client = null) {
    const action = async (activeClient) => {
      const occurrence = occurrenceId(task.id, scheduledFor, trigger);
      const existing = await activeClient.query(
        `SELECT payload_json FROM runtime_scheduler_runs
         WHERE space_id = $1 AND occurrence_id = $2 FOR UPDATE`,
        [this.spaceId, occurrence]
      );
      if (existing.rows[0]) {
        return jsonValue(existing.rows[0].payload_json, {});
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
      await this.writeRunRow(run, activeClient);
      await activeClient.query(
        `WITH stale AS (
           SELECT id FROM runtime_scheduler_runs
           WHERE space_id = $1
           ORDER BY created_at DESC
           OFFSET 1000
         )
         DELETE FROM runtime_scheduler_runs target
         USING stale
         WHERE target.space_id = $1 AND target.id = stale.id`,
        [this.spaceId]
      );
      return clone(run);
    };
    return client ? action(client) : this.transaction(action);
  }

  async runNow(taskId) {
    return this.transaction(async (client) => {
      const task = await this.getTask(taskId, client, { forUpdate: true });
      return this.enqueue(task, this.now(), "manual", client);
    });
  }

  async tick() {
    return this.transaction(async (client) => {
      const current = this.now();
      const expired = await client.query(
        `SELECT id, payload_json FROM runtime_scheduler_runs
         WHERE space_id = $1 AND status = 'leased' AND lease_until <= $2
         FOR UPDATE`,
        [this.spaceId, current]
      );
      for (const row of expired.rows) {
        const run = jsonValue(row.payload_json, {});
        Object.assign(run, {
          status: "failed",
          completedAt: current,
          leaseUntil: null,
          error: run.error || "Run lease expired before completion"
        });
        await this.writeRunRow(run, client);
      }

      const due = await client.query(
        `SELECT payload_json FROM runtime_scheduler_tasks
         WHERE space_id = $1 AND enabled = TRUE AND next_run <= $2
         ORDER BY next_run FOR UPDATE`,
        [this.spaceId, current]
      );
      const enqueued = [];
      for (const row of due.rows) {
        const task = jsonValue(row.payload_json, {});
        const active = await client.query(
          `SELECT 1 FROM runtime_scheduler_runs
           WHERE space_id = $1 AND task_id = $2
             AND status = ANY($3::text[])
           LIMIT 1`,
          [this.spaceId, task.id, ["pending", "leased"]]
        );
        const scheduledFor = Number(task.nextRun);
        const stale = current - scheduledFor > 90_000;
        if (
          !active.rowCount
          && (!stale || task.schedule.misfirePolicy === "run-once")
        ) {
          const before = await client.query(
            `SELECT 1 FROM runtime_scheduler_runs
             WHERE space_id = $1 AND occurrence_id = $2`,
            [
              this.spaceId,
              occurrenceId(task.id, scheduledFor, "schedule")
            ]
          );
          const run = await this.enqueue(task, scheduledFor, "schedule", client);
          if (!before.rowCount) enqueued.push(run);
        }
        if (task.schedule.kind === "once") {
          task.enabled = false;
          task.nextRun = null;
        } else {
          task.nextRun = nextScheduledAt(task.schedule, current);
        }
        await this.writeTaskRow(task, client);
      }
      return enqueued;
    });
  }

  async claim({
    workerId,
    workerKind = "workbench",
    leaseSeconds = 120,
    availableTools = []
  }) {
    const id = String(workerId || "").trim();
    if (!id) throw statusError("workerId is required", 422);
    return this.transaction(async (client) => {
      const result = await client.query(
        `SELECT id, payload_json FROM runtime_scheduler_runs
         WHERE space_id = $1 AND status = 'pending'
         ORDER BY created_at
         LIMIT 100
         FOR UPDATE SKIP LOCKED`,
        [this.spaceId]
      );
      const row = result.rows.find((candidate) =>
        taskSupportedBy(jsonValue(candidate.payload_json, {}).task, availableTools)
      );
      if (!row) return null;
      const run = jsonValue(row.payload_json, {});
      const current = this.now();
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
      await this.writeRunRow(run, client);
      return clone(run);
    });
  }

  async requireLeasedRun(runId, workerId, client = this.pool) {
    const run = await this.getRun(runId, client, { forUpdate: true });
    if (run.status !== "leased" || run.workerId !== String(workerId)) {
      throw statusError("Run lease is not owned by this worker", 409);
    }
    return run;
  }

  async appendEvent(runId, workerId, eventValue) {
    return this.transaction(async (client) => {
      const run = await this.requireLeasedRun(runId, workerId, client);
      run.events = [...(run.events || []), clone(eventValue)].slice(-500);
      await this.writeRunRow(run, client);
      return clone(run);
    });
  }

  async linkSession(runId, workerId, { sessionId, chatRunId } = {}) {
    return this.transaction(async (client) => {
      const run = await this.requireLeasedRun(runId, workerId, client);
      run.sessionId = sessionId ? String(sessionId) : null;
      run.chatRunId = chatRunId ? String(chatRunId) : null;
      await this.writeRunRow(run, client);
      return clone(run);
    });
  }

  async complete(runId, workerId, result) {
    if (!TERMINAL_STATUSES.has(String(result?.status))) {
      throw statusError("Invalid terminal status", 422);
    }
    return this.transaction(async (client) => {
      const run = await this.requireLeasedRun(runId, workerId, client);
      Object.assign(run, {
        status: result.status,
        sessionId: result.sessionId || run.sessionId || null,
        chatRunId: result.chatRunId || run.chatRunId || null,
        output: String(result.output || ""),
        error: result.error ? String(result.error) : null,
        usage: result.usage || null,
        completedAt: this.now(),
        leaseUntil: null
      });
      await this.writeRunRow(run, client);
      const taskResult = await client.query(
        `SELECT payload_json FROM runtime_scheduler_tasks
         WHERE space_id = $1 AND id = $2 FOR UPDATE`,
        [this.spaceId, run.taskId]
      );
      if (taskResult.rows[0]) {
        const task = jsonValue(taskResult.rows[0].payload_json, {});
        task.lastRun = {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt
        };
        task.updatedAt = this.now();
        await this.writeTaskRow(task, client);
      }
      return clone(run);
    });
  }

  async cancel(runId, reason = "user") {
    return this.transaction(async (client) => {
      const run = await this.getRun(runId, client, { forUpdate: true });
      if (TERMINAL_STATUSES.has(run.status)) return run;
      Object.assign(run, {
        status: "aborted",
        completedAt: this.now(),
        leaseUntil: null,
        error: reason === "timeout" ? "Run timed out" : "Run cancelled",
        cancelReason: String(reason || "user")
      });
      await this.writeRunRow(run, client);
      return clone(run);
    });
  }

  async hasLegacyMigration() {
    const result = await this.pool.query(
      `SELECT 1 FROM runtime_scheduler_migrations
       WHERE space_id = $1 AND source = 'zion-local-tools:scheduler'
       LIMIT 1`,
      [this.spaceId]
    );
    return result.rowCount > 0;
  }

  async importLegacySnapshot(payload, fingerprint) {
    const source = "zion-local-tools:scheduler";
    const marker = String(fingerprint || "").trim();
    if (!marker) throw statusError("scheduler migration fingerprint required");
    return this.transaction(async (client) => {
      const existing = await client.query(
        `SELECT result_json FROM runtime_scheduler_migrations
         WHERE space_id = $1 AND source = $2 AND fingerprint = $3`,
        [this.spaceId, source, marker]
      );
      if (existing.rows[0]) {
        return {
          ...jsonValue(existing.rows[0].result_json, {}),
          duplicate: true
        };
      }
      const taskIds = new Set((await client.query(
        "SELECT id FROM runtime_scheduler_tasks WHERE space_id = $1",
        [this.spaceId]
      )).rows.map((row) => row.id));
      const runIds = new Set((await client.query(
        "SELECT id FROM runtime_scheduler_runs WHERE space_id = $1",
        [this.spaceId]
      )).rows.map((row) => row.id));
      let importedTasks = 0;
      let importedRuns = 0;
      for (const task of Array.isArray(payload?.tasks) ? payload.tasks : []) {
        if (!task?.id || taskIds.has(task.id)) continue;
        await this.writeTaskRow(clone(task), client);
        taskIds.add(task.id);
        importedTasks += 1;
      }
      for (const run of Array.isArray(payload?.runs) ? payload.runs : []) {
        if (!run?.id || runIds.has(run.id) || !taskIds.has(run.taskId)) continue;
        await this.writeRunRow(clone(run), client);
        runIds.add(run.id);
        importedRuns += 1;
      }
      const result = { ok: true, importedTasks, importedRuns };
      await client.query(
        `INSERT INTO runtime_scheduler_migrations
         (space_id, source, fingerprint, result_json, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [this.spaceId, source, marker, JSON.stringify(result), this.now()]
      );
      return result;
    });
  }

  async checkpoint() {}

  async close() {}
}
