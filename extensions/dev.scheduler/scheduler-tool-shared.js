export const SCHEDULER_TOOL_NAME = "schedulerManage";

export const SCHEDULER_HEADLESS_ACTIONS = [
  "list",
  "get",
  "list_runs",
  "create",
  "update",
  "set_enabled",
  "run_now",
  "delete"
];

export const SCHEDULER_WORKBENCH_ACTIONS = [
  ...SCHEDULER_HEADLESS_ACTIONS,
  "open_panel"
];

export function schedulerTaskSchema() {
  return {
    type: "object",
    properties: {
      taskType: {
        type: "string",
        enum: ["agent", "command"],
        description: "agent runs a prompt through the chat runtime; command runs a shell command directly and stores stdout/stderr"
      },
      title: { type: "string", maxLength: 80 },
      prompt: { type: "string", maxLength: 12000, description: "Required for agent tasks" },
      command: { type: "string", maxLength: 4000, description: "Required for command tasks, for example: bash /path/to/script.sh" },
      cwd: { type: "string", description: "Optional working directory for command tasks" },
      note: { type: "string", maxLength: 1000, description: "Optional human-readable note shown in the scheduler panel" },
      nodeId: {
        type: "string",
        description: "Execution Node id from terminalInventory nodes[].node_id. Optional for agent tasks and required for command tasks."
      },
      executionMode: { type: "string", enum: ["local-only", "service-backed"] },
      interactionProfileId: {
        type: "string",
        description: "Runtime InteractionProfile id. Defaults to scheduled.default."
      },
      modelProfileId: {
        type: "string",
        description: "Optional Runtime model profile id for this agent task. When omitted, the task inherits the model from interactionProfileId. Use modelsManage list/check to choose a configured model."
      },
      schedule: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["interval", "daily", "weekdays", "once"] },
          intervalMinutes: { type: "number", minimum: 1, maximum: 10080 },
          time: { type: "string", description: "HH:mm in the task time zone" },
          timestamp: { type: "number", description: "Unix time in milliseconds for one-time tasks" },
          timeZone: { type: "string", description: "IANA time zone, such as Asia/Shanghai" }
        },
        additionalProperties: false
      },
      capability: {
        type: "object",
        properties: {
          preset: { type: "string", enum: ["read-only", "workspace-write", "trusted-automation"] },
          allowedTools: {
            type: "array",
            items: { type: "string" },
            description: "Explicit mutating tools to expose. Use write and edit for file changes, and Bash when the task prompt asks to run shell commands."
          },
          fileRoots: { type: "array", items: { type: "string" } },
          allowedCommandPrefixes: {
            type: "array",
            items: { type: "string" },
            description: "Optional Bash command prefixes. When omitted, agent tasks may run commands permitted by the local-tools sandbox; command tasks are restricted to their configured command."
          },
          allowedTerminalSessionIds: { type: "array", items: { type: "string" } },
          allowedRecipients: { type: "array", items: { type: "string" } },
          maxMailPerRun: { type: "number", minimum: 0, maximum: 100 },
          maxToolCalls: { type: "number", minimum: 1, maximum: 500 }
        },
        additionalProperties: false
      },
      timeoutSeconds: { type: "number", minimum: 10, maximum: 3600 },
      enabled: { type: "boolean" }
    },
    additionalProperties: false
  };
}

export function schedulerManageToolSchema({
  actions = SCHEDULER_HEADLESS_ACTIONS
} = {}) {
  return {
    type: "function",
    function: {
      name: SCHEDULER_TOOL_NAME,
      description: "Manage scheduled tasks in Zion. Supports agent tasks with prompts and command tasks with shell commands. Use list/get/list_runs before changing an existing task. Create, update, enable, disable, run, or delete only when the user explicitly requested that persistent action. nodeId selects an execution Node from terminalInventory; it is optional for agent tasks and required for command tasks. For command tasks set taskType=command, executionMode=service-backed, nodeId, and command; do not hide shell commands inside prompt.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: actions, description: "Management action" },
          task_id: { type: "string", description: "Task id returned by list or create" },
          task: { ...schedulerTaskSchema(), description: "Complete task definition for create" },
          patch: { ...schedulerTaskSchema(), description: "Partial task definition for update" },
          enabled: { type: "boolean", description: "Required by set_enabled" },
          limit: { type: "number", minimum: 1, maximum: 100, description: "Maximum runs to return" }
        },
        required: ["action"],
        additionalProperties: false
      }
    }
  };
}

export function taskSummary(task) {
  if (!task) return null;
  return {
    id: task.id,
    taskType: task.taskType || "agent",
    title: task.title,
    executionMode: task.executionMode,
    nodeId: task.nodeId || null,
    interactionProfileId: task.interactionProfileId || null,
    modelProfileId: task.modelProfileId || null,
    schedule: task.schedule,
    enabled: task.enabled,
    nextRun: task.nextRun,
    lastRun: task.lastRun || null,
    remoteTaskId: task.remoteTaskId || null,
    command: task.taskType === "command" ? task.command || "" : undefined,
    updatedAt: task.updatedAt
  };
}

export function taskDetail(task) {
  if (!task) return null;
  return {
    ...taskSummary(task),
    prompt: task.prompt,
    command: task.command || "",
    cwd: task.cwd || "",
    note: task.note || "",
    capability: task.capability,
    timeoutSeconds: task.timeoutSeconds,
    createdAt: task.createdAt,
    revision: task.revision,
    remoteRevision: task.remoteRevision || null
  };
}

export function runSummary(run) {
  return {
    id: run.id,
    taskId: run.taskId,
    taskTitle: run.taskTitle || run.task?.title || "",
    status: run.status,
    trigger: run.trigger || "local",
    scheduledFor: run.scheduledFor || null,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    sessionId: run.sessionId || null,
    chatRunId: run.chatRunId || null,
    error: run.error || null
  };
}

export function ok(payload) {
  return JSON.stringify({ ok: true, ...payload }, null, 2);
}

export function failure(action, error, details = {}) {
  const message = error?.message || String(error || "Unknown error");
  const payload = {
    ok: false,
    action: action || null,
    code: details.code || "INTERNAL_ERROR",
    error: message,
    ...details
  };
  if (error?.name && error.name !== "Error") payload.name = error.name;
  if (error?.stack && payload.code === "INTERNAL_ERROR") {
    payload.stack = String(error.stack).split("\n").slice(0, 6);
  }
  return JSON.stringify(payload, null, 2);
}

export function normalizeLimit(value, fallback = 50) {
  return Math.max(1, Math.min(100, Number(value) || fallback));
}
