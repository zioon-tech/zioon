import { computeNextRun, normalizeSchedule, validateSchedule } from "./schedule.js";

const EXECUTION_MODES = new Set(["local-only", "service-backed"]);
const TASK_TYPES = new Set(["agent", "command"]);
const POLICY_PRESETS = new Set(["read-only", "workspace-write", "trusted-automation"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const TRUSTED_TOOLS = new Set(["Bash", "sendMail", "todoWrite"]);
const MUTATING_TOOLS = new Set([...FILE_WRITE_TOOLS, ...TRUSTED_TOOLS]);
export const ACTIVE_RUN_STATUSES = new Set(["pending", "claimed", "running"]);
const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "aborted"]);
const DEFAULT_STALE_RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_COMMAND_LENGTH = 4000;
const LEGACY_TOOL_ALIASES = new Map([
  ["fsWrite", "write"],
  ["fsEdit", "edit"],
  ["terminalExecute", "Bash"]
]);

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

function normalizeAllowedTools(value) {
  return list(value).map((name) => LEGACY_TOOL_ALIASES.get(name) || name);
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

function activeRunStatusText(status) {
  if (status === "pending") return "已在排队中";
  if (status === "claimed") return "已被领取";
  return "正在运行";
}

function runActivityStartedAt(run) {
  const value = Number(run?.startedAt || run?.scheduledFor || run?.createdAt || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function staleRunTimeoutMs(run, task) {
  const seconds = Number(run?.timeoutSeconds || task?.timeoutSeconds || 0);
  const taskTimeoutMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  return Math.max(DEFAULT_STALE_RUN_TIMEOUT_MS, taskTimeoutMs);
}

export function isStaleActiveRun(run, task = null, now = Date.now()) {
  if (!run || !ACTIVE_RUN_STATUSES.has(run.status) || TERMINAL_RUN_STATUSES.has(run.status)) return false;
  const startedAt = runActivityStartedAt(run);
  if (!startedAt) return false;
  return Number(now) - startedAt > staleRunTimeoutMs(run, task);
}

function staleRunError(run) {
  if (run?.sessionId) return "运行超过超时时间，已自动标记为失败";
  if (run?.status === "pending") return "运行在分配执行会话前超时，已自动清理";
  return "运行状态长时间未完成，已自动清理";
}

export function normalizeCapabilityPolicy(input = {}) {
  const preset = POLICY_PRESETS.has(input?.preset) ? input.preset : "read-only";
  return {
    preset,
    allowedTools: [...new Set(normalizeAllowedTools(input?.allowedTools))],
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
      allowedTools: capability.allowedTools.includes("Bash")
        ? capability.allowedTools
        : [...capability.allowedTools, "Bash"],
      allowedCommandPrefixes: capability.allowedCommandPrefixes.length
        ? capability.allowedCommandPrefixes
        : command ? [command] : []
    });
  }
  const enabled = typeof input?.enabled === "boolean" ? input.enabled : existing?.enabled ?? true;
  const sessionTag = String(input?.sessionTag ?? existing?.sessionTag ?? "")
    .replace(/^#/, "")
    .trim();

  return {
    ...(existing || {}),
    id: String(input?.id || existing?.id || id("sched")),
    revision: Number(existing?.revision || 0) + 1,
    taskType,
    executionMode,
    title: String(input?.title ?? existing?.title ?? "").trim(),
    prompt: String(input?.prompt ?? existing?.prompt ?? "").trim(),
    sessionTag,
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
  if ((policy.allowedCommandPrefixes.length || policy.allowedTerminalSessionIds.length) && !allowed.has("Bash")) {
    return "配置了终端限制，但未允许 Bash 工具";
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
    executionMode: "service-backed",
    timeoutSeconds: remote.timeoutSeconds || localTask?.timeoutSeconds || null,
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
    this.pendingRunRequests = new Set();
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
    this.reconcileStaleRuns({ notify: false });
    const localTask = taskId ? this.getTask(taskId) : null;
    const localRuns = this.store.listRuns(taskId || null);
    let remoteRuns = [];

    if (this.service?.listRuns) {
      try {
        const remoteTaskId = localTask?.remoteTaskId || "";
        const remote = await this.service.listRuns(remoteTaskId, {
          limit: Math.max(1, Math.min(100, Number(limit) || 50))
        });
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

  async getRunDetails(runId) {
    const previous = this.store.getRun(String(runId || ""));
    if (!previous || previous.isSummary !== true || !this.service?.getRun) return previous;
    try {
      const remote = await this.service.getRun(previous.id);
      if (!remote?.id) throw new Error("运行详情不存在");
      const taskByRemoteId = new Map(
        this.listTasks()
          .filter((task) => task.remoteTaskId)
          .map((task) => [String(task.remoteTaskId), task])
      );
      const mapped = runFromRemote(remote, taskByRemoteId);
      const saved = this.store.saveRun({
        ...previous,
        ...mapped,
        isSummary: false,
        output: mapped.output || previous.output || "",
        events: mapped.events.length ? mapped.events : previous.events || []
      });
      this.onServiceStatus(true);
      this._notify();
      return saved;
    } catch (error) {
      this.onServiceStatus(false);
      throw error;
    }
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
      const staleRuns = this._markStaleRuns({ taskId: task.id });
      if (staleRuns.length) {
        await this._reportTerminalRuns(staleRuns, "timeout");
        this._notify();
      }
      const activeRun = this.store.listRuns(task.id).find((run) => ACTIVE_RUN_STATUSES.has(run.status));
      if (this.pendingRunRequests.has(task.id) || activeRun) {
        throw new Error(activeRun ? `任务${activeRunStatusText(activeRun.status)}` : "任务正在提交，请稍候");
      }
      this.pendingRunRequests.add(task.id);
      try {
        const remoteRun = await this._serviceCall(() => this.service.runNow(task));
        const remoteTaskId = String(remoteRun?.taskId || task.remoteTaskId || task.id);
        const run = runFromRemote(
          { ...remoteRun, taskId: remoteTaskId },
          new Map([[remoteTaskId, task]])
        );
        this.store.saveRun(run);
        this._notify();
        return { queued: true, run };
      } finally {
        this.pendingRunRequests.delete(task.id);
      }
    }
    if (!this.engine) throw new Error("Scheduler engine is unavailable");
    const result = await this.engine.execute(task);
    return { queued: false, result };
  }


  async cancelRun(runId, reason = "user") {
    const run = this.store.getRun(String(runId || ""));
    if (!run) throw new Error("Run not found");
    if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;
    const task = this.store.getTask(run.taskId);
    const serviceBacked = run.executionMode === "service-backed" || task?.executionMode === "service-backed";
    if (!serviceBacked && run.status === "running") {
      throw new Error("当前运行仍在本地执行，暂不支持直接取消");
    }
    const completedAt = this.now();
    const error = reason === "timeout" ? "运行超时，已取消" : "运行已取消";
    const next = this.store.saveRun({
      ...run,
      status: "aborted",
      completedAt,
      error,
      cancelReason: reason
    });
    this.updateTaskLastRun(next);
    await this._reportTerminalRun(next, reason);
    this._notify();
    return next;
  }

  async refreshServiceRuns() {
    const localStaleRuns = this._markStaleRuns();
    if (!this.service?.listRuns) {
      if (localStaleRuns.length) this._notify();
      return { online: false, runs: [] };
    }
    try {
      const remoteRuns = await this.service.listRuns("", { limit: 100 });
      const taskByRemoteId = new Map(
        this.listTasks()
          .filter((task) => task.remoteTaskId)
          .map((task) => [String(task.remoteTaskId), task])
      );
      for (const remoteRun of remoteRuns) {
        const mapped = runFromRemote(remoteRun, taskByRemoteId);
        const previous = this.store.getRun(mapped.id);
        this.store.saveRun({
          ...(previous || {}),
          ...mapped,
          isSummary: previous?.isSummary === false
            || previous?.events?.length
            || previous?.output
            ? false
            : mapped.isSummary,
          output: mapped.output || previous?.output || "",
          events: mapped.events.length ? mapped.events : previous?.events || []
        });
      }
      const staleRuns = [...localStaleRuns, ...this._markStaleRuns()];
      await this._reportTerminalRuns(staleRuns, "timeout");
      this.onServiceStatus(true);
      this._notify();
      return { online: true, runs: remoteRuns };
    } catch (error) {
      if (localStaleRuns.length) this._notify();
      this.onServiceStatus(false);
      return { online: false, runs: [], error };
    }
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

  reconcileStaleRuns({ taskId = "", notify = true } = {}) {
    const staleRuns = this._markStaleRuns({ taskId });
    if (staleRuns.length && notify) this._notify();
    return staleRuns.length > 0;
  }

  _markStaleRuns({ taskId = "" } = {}) {
    const now = this.now();
    const staleRuns = [];
    const tasks = new Map(this.store.listTasks().map((task) => [String(task.id), task]));
    for (const run of this.store.listRuns(taskId || null)) {
      const task = tasks.get(String(run.taskId || ""));
      if (!isStaleActiveRun(run, task, now)) continue;
      const next = this.store.saveRun({
        ...run,
        status: "failed",
        completedAt: now,
        error: run.error || staleRunError(run),
        stale: true
      });
      this.updateTaskLastRun(next);
      staleRuns.push(next);
    }
    return staleRuns;
  }

  updateTaskLastRun(run) {
    const task = this.store.getTask(run?.taskId);
    if (!task) return;
    this.store.saveTask({
      ...task,
      lastRun: {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt || run.scheduledFor || run.createdAt || null,
        completedAt: run.completedAt || null
      },
      updatedAt: this.now()
    });
  }

  async _reportTerminalRuns(runs, reason) {
    const byId = new Map();
    for (const run of runs || []) {
      if (run?.id) byId.set(String(run.id), run);
    }
    for (const run of byId.values()) {
      await this._reportTerminalRun(run, reason);
    }
  }

  async _reportTerminalRun(run, reason = "user") {
    const task = this.store.getTask(run?.taskId);
    const serviceBacked = run?.executionMode === "service-backed" || task?.executionMode === "service-backed";
    if (!serviceBacked || !this.service || !run?.id) return;
    if (this.service.cancel) {
      try {
        await this.service.cancel(run.id, reason);
        return;
      } catch {
        // Fall through to the legacy completion endpoint below.
      }
    }
    if (!this.service.complete) return;
    try {
      await this.service.complete(run.id, "local-cancel", {
        status: run.status,
        sessionId: run.sessionId || null,
        chatRunId: run.chatRunId || null,
        output: run.output || "",
        error: run.error || null,
        usage: run.usage || null
      });
    } catch {
      // Local cleanup must remain available even when the scheduler service is unreachable.
    }
  }
}
