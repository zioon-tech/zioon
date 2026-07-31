import { computeNextRun, normalizeSchedule, validateSchedule } from "./schedule.js";

const EXECUTION_MODES = new Set(["local-only", "service-backed"]);
const TASK_TYPES = new Set(["agent", "command"]);
const POLICY_PRESETS = new Set(["read-only", "workspace-write", "trusted-automation"]);
const FILE_WRITE_TOOLS = new Set(["fsWrite", "fsEdit"]);
const TRUSTED_TOOLS = new Set(["terminalExecute", "sendMail", "todoWrite"]);
const MUTATING_TOOLS = new Set([...FILE_WRITE_TOOLS, ...TRUSTED_TOOLS]);
const MAX_COMMAND_LENGTH = 4000;

function id(prefix) {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") return `${prefix}_${randomUUID.call(globalThis.crypto)}`;
  } catch {}
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function list(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

export function normalizeCapabilityPolicy(input = {}) {
  const preset = POLICY_PRESETS.has(input?.preset) ? input.preset : "read-only";
  return {
    preset,
    allowedTools: list(input?.allowedTools),
    fileRoots: list(input?.fileRoots),
    allowedCommandPrefixes: list(input?.allowedCommandPrefixes),
    allowedTerminalSessionIds: list(input?.allowedTerminalSessionIds),
    allowedRecipients: list(input?.allowedRecipients).map((value) => value.toLowerCase()),
    maxMailPerRun: Math.max(0, Math.min(100, Number(input?.maxMailPerRun) || 0)),
    maxToolCalls: Math.max(1, Math.min(500, Number(input?.maxToolCalls) || 50))
  };
}

export function buildSchedulerTask(input = {}, existing = null, now = Date.now()) {
  const taskType = TASK_TYPES.has(input?.taskType) ? input.taskType : existing?.taskType || "agent";
  const executionMode = EXECUTION_MODES.has(input?.executionMode)
    ? input.executionMode
    : existing?.executionMode || "local-only";
  const schedule = normalizeSchedule({
    ...(existing?.schedule || {}),
    ...(input?.schedule || {})
  });
  const capability = normalizeCapabilityPolicy({
    ...(existing?.capability || {}),
    ...(input?.capability || {})
  });
  const command = String(input?.command ?? existing?.command ?? "").trim();
  let taskCapability = capability;
  if (taskType === "command") {
    taskCapability = normalizeCapabilityPolicy({
      ...capability,
      preset: "trusted-automation",
      allowedTools: capability.allowedTools.includes("terminalExecute")
        ? capability.allowedTools
        : [...capability.allowedTools, "terminalExecute"],
      allowedCommandPrefixes: capability.allowedCommandPrefixes.length
        ? capability.allowedCommandPrefixes
        : command ? [command] : []
    });
  }
  const enabled = typeof input?.enabled === "boolean" ? input.enabled : existing?.enabled ?? true;

  return {
    ...(existing || {}),
    id: String(input?.id || existing?.id || id("sched")),
    revision: Number(existing?.revision || 0) + 1,
    taskType,
    executionMode,
    title: String(input?.title ?? existing?.title ?? "").trim(),
    prompt: String(input?.prompt ?? existing?.prompt ?? "").trim(),
    command,
    cwd: String(input?.cwd ?? existing?.cwd ?? "").trim(),
    note: String(input?.note ?? existing?.note ?? "").trim(),
    schedule: {
      ...schedule,
      timeZone: String(input?.schedule?.timeZone || existing?.schedule?.timeZone || localTimeZone()),
      misfirePolicy: executionMode === "service-backed" ? "run-once" : "skip",
      overlapPolicy: "forbid"
    },
    capability: taskCapability,
    timeoutSeconds: Math.max(10, Math.min(3600, Number(input?.timeoutSeconds ?? existing?.timeoutSeconds) || 300)),
    enabled,
    createdAt: Number(existing?.createdAt || now),
    updatedAt: now,
    nextRun: executionMode === "local-only" && enabled ? computeNextRun(schedule, now) : null,
    lastRun: existing?.lastRun || null,
    remoteTaskId: existing?.remoteTaskId || null,
    remoteRevision: existing?.remoteRevision || null
  };
}

export function mergeSchedulerTask(existing, patch = {}, now = Date.now()) {
  if (!existing) throw new Error("Task not found");
  return buildSchedulerTask({
    ...existing,
    ...patch,
    schedule: { ...(existing.schedule || {}), ...(patch.schedule || {}) },
    capability: { ...(existing.capability || {}), ...(patch.capability || {}) }
  }, existing, now);
}

function commandAllowedByPrefixes(command, prefixes) {
  return prefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
}

export function validateSchedulerTask(task) {
  if (!task?.title) return "请输入名称";
  if (task.title.length > 80) return "名称不能超过 80 个字符";
  const taskType = TASK_TYPES.has(task?.taskType) ? task.taskType : "agent";
  if (taskType === "agent" && !task?.prompt) return "请输入任务提示词";
  if (String(task?.prompt || "").length > 12_000) return "任务提示词不能超过 12000 个字符";
  if (taskType === "command" && !String(task?.command || "").trim()) return "请输入要执行的命令";
  if (String(task?.command || "").length > MAX_COMMAND_LENGTH) return "命令不能超过 4000 个字符";
  if (!EXECUTION_MODES.has(task.executionMode)) return "不支持的执行模式";

  const scheduleError = validateSchedule(task.schedule);
  if (scheduleError) return scheduleError;

  const policy = normalizeCapabilityPolicy(task.capability);
  const allowed = new Set(policy.allowedTools);
  if (allowed.has("schedulerManage")) {
    return "定时任务不能调用 schedulerManage";
  }
  if ((policy.allowedCommandPrefixes.length || policy.allowedTerminalSessionIds.length) && !allowed.has("terminalExecute")) {
    return "配置了终端限制，但未允许 terminalExecute 工具";
  }
  if ((policy.allowedRecipients.length || policy.maxMailPerRun > 0) && !allowed.has("sendMail")) {
    return "配置了邮件限制，但未允许 sendMail 工具";
  }
  if (policy.preset === "read-only" && [...allowed].some((name) => MUTATING_TOOLS.has(name))) {
    return "只读权限不能启用变更工具";
  }
  if ([...allowed].some((name) => FILE_WRITE_TOOLS.has(name)) && !policy.fileRoots.length) {
    return "启用文件写入时必须配置允许目录";
  }
  if ([...allowed].some((name) => TRUSTED_TOOLS.has(name)) && policy.preset !== "trusted-automation") {
    return "终端、邮件和任务清单需要受信自动化权限";
  }
  if (allowed.has("terminalExecute") && !policy.allowedCommandPrefixes.length) {
    return "启用终端时必须配置允许的命令前缀";
  }
  if (taskType === "command" && !commandAllowedByPrefixes(String(task.command || "").trim(), policy.allowedCommandPrefixes)) {
    return "命令必须匹配允许的命令前缀";
  }
  if (allowed.has("sendMail") && (!policy.allowedRecipients.length || policy.maxMailPerRun < 1)) {
    return "启用邮件时必须配置收件人和发送上限";
  }
  return "";
}

function taskFromRemote(remote, existing = null) {
  return {
    ...(existing || {}),
    id: remote.clientTaskId || existing?.id || `service_${remote.id}`,
    revision: existing?.revision || 1,
    taskType: remote.taskType || existing?.taskType || "agent",
    executionMode: "service-backed",
    title: remote.title,
    prompt: remote.prompt || "",
    command: remote.command || existing?.command || "",
    cwd: remote.cwd || existing?.cwd || "",
    note: remote.note || existing?.note || "",
    schedule: remote.schedule,
    capability: remote.capability,
    timeoutSeconds: remote.timeoutSeconds,
    enabled: remote.enabled,
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    nextRun: remote.nextRun,
    lastRun: existing?.lastRun || null,
    remoteTaskId: remote.id,
    remoteRevision: remote.revision
  };
}

function runFromRemote(remote, taskByRemoteId) {
  const localTask = taskByRemoteId.get(String(remote.taskId || ""));
  return {
    ...remote,
    taskId: localTask?.id || remote.taskId,
    taskTitle: localTask?.title || remote.task?.title || remote.taskId,
    startedAt: remote.startedAt || remote.createdAt || remote.scheduledFor || Date.now(),
    completedAt: remote.completedAt || null,
    output: remote.output || "",
    error: remote.error || null,
    events: Array.isArray(remote.events) ? remote.events : []
  };
}

export class SchedulerController {
  constructor({ store, service, runTask, onChange = () => {}, onServiceStatus = () => {}, now = () => Date.now() }) {
    this.store = store;
    this.service = service;
    this.runTask = runTask;
    this.onChange = onChange;
    this.onServiceStatus = onServiceStatus;
    this.now = now;
    this.engine = null;
  }

  setEngine(engine) {
    this.engine = engine;
  }

  listTasks() {
    return this.store.listTasks();
  }

  getTask(taskId) {
    return this.store.getTask(String(taskId || ""));
  }

  async listRuns({ taskId = "", limit = 50 } = {}) {
    const localTask = taskId ? this.getTask(taskId) : null;
    const localRuns = this.store.listRuns(taskId || null);
    let remoteRuns = [];

    if (this.service?.listRuns) {
      try {
        const remoteTaskId = localTask?.remoteTaskId || "";
        const remote = await this.service.listRuns(remoteTaskId);
        const taskByRemoteId = new Map(
          this.listTasks()
            .filter((task) => task.remoteTaskId)
            .map((task) => [String(task.remoteTaskId), task])
        );
        remoteRuns = remote.map((run) => runFromRemote(run, taskByRemoteId));
        this.onServiceStatus(true);
      } catch {
        this.onServiceStatus(false);
      }
    }

    const merged = new Map(remoteRuns.map((run) => [String(run.id), run]));
    for (const run of localRuns) {
      const previous = merged.get(String(run.id));
      merged.set(String(run.id), previous ? { ...previous, ...run } : run);
    }
    return [...merged.values()]
      .filter((run) => !taskId || String(run.taskId) === String(taskId))
      .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 50)));
  }

  async saveTask(task) {
    const error = validateSchedulerTask(task);
    if (error) throw new Error(error);

    const previous = this.getTask(task.id);
    let saved;
    if (task.executionMode === "service-backed") {
      const remote = await this._serviceCall(() =>
        task.remoteTaskId ? this.service.updateTask(task) : this.service.createTask(task)
      );
      saved = {
        ...task,
        remoteTaskId: remote.id,
        remoteRevision: remote.revision,
        nextRun: remote.nextRun,
        enabled: remote.enabled
      };
    } else {
      if (previous?.remoteTaskId) await this._serviceCall(() => this.service.deleteTask(previous));
      saved = {
        ...task,
        remoteTaskId: null,
        remoteRevision: null,
        nextRun: task.enabled ? computeNextRun(task.schedule, this.now()) : null
      };
    }
    this.store.saveTask(saved);
    this._notify();
    return saved;
  }

  async setEnabled(taskId, enabled) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const nextEnabled = Boolean(enabled);
    let saved;
    if (task.executionMode === "service-backed") {
      const remote = await this._serviceCall(() => this.service.updateTask({ ...task, enabled: nextEnabled }));
      saved = {
        ...task,
        enabled: remote.enabled,
        nextRun: remote.nextRun,
        remoteRevision: remote.revision,
        updatedAt: this.now()
      };
    } else {
      saved = {
        ...task,
        enabled: nextEnabled,
        updatedAt: this.now(),
        nextRun: nextEnabled ? computeNextRun(task.schedule, this.now()) : null
      };
    }
    this.store.saveTask(saved);
    this._notify();
    return saved;
  }

  async deleteTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.remoteTaskId) await this._serviceCall(() => this.service.deleteTask(task));
    this.store.deleteTask(task.id);
    this._notify();
    return { id: task.id, deleted: true };
  }

  async runNow(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.executionMode === "service-backed") {
      const run = await this._serviceCall(() => this.service.runNow(task));
      this._notify();
      return { queued: true, run };
    }
    if (!this.engine) throw new Error("Scheduler engine is unavailable");
    const result = await this.engine.execute(task);
    return { queued: false, result };
  }

  async refreshServiceTasks() {
    if (!this.service?.listTasks) return { online: false, tasks: [] };
    try {
      const remoteTasks = await this.service.listTasks();
      for (const remote of remoteTasks) {
        const existing = this.listTasks().find((task) =>
          task.remoteTaskId === remote.id || task.id === remote.clientTaskId
        );
        this.store.saveTask(taskFromRemote(remote, existing));
      }
      this.onServiceStatus(true);
      this._notify();
      return { online: true, tasks: remoteTasks };
    } catch (error) {
      this.onServiceStatus(false);
      this._notify();
      return { online: false, tasks: [], error };
    }
  }

  async _serviceCall(call) {
    try {
      const result = await call();
      this.onServiceStatus(true);
      return result;
    } catch (error) {
      this.onServiceStatus(false);
      throw error;
    }
  }

  _notify() {
    try {
      this.engine?.reconcile?.();
    } catch (error) {
      console.warn("[scheduler] reconcile failed", error);
    }
    try {
      this.onChange();
    } catch (error) {
      console.warn("[scheduler] change notification failed", error);
    }
  }
}
