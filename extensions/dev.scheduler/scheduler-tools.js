import {
  buildSchedulerTask,
  mergeSchedulerTask,
  validateSchedulerTask
} from "./controller.js";

const TOOL_NAME = "schedulerManage";
const ACTIONS = [
  "list",
  "get",
  "list_runs",
  "create",
  "update",
  "set_enabled",
  "run_now",
  "delete",
  "open_panel"
];

function taskSchema() {
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
      executionMode: { type: "string", enum: ["local-only", "service-backed"] },
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
            description: "Explicit mutating tools to expose. Include terminalExecute when the task prompt asks to run shell/bash commands."
          },
          fileRoots: { type: "array", items: { type: "string" } },
          allowedCommandPrefixes: {
            type: "array",
            items: { type: "string" },
            description: "Allowed terminal command prefixes. Only valid when allowedTools includes terminalExecute."
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

const TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description: "Manage scheduled tasks in Zion. Supports agent tasks with prompts and command tasks with shell commands. Use list/get/list_runs before changing an existing task. Create, update, enable, disable, run, or delete only when the user explicitly requested that persistent action. For command tasks set taskType=command and command; do not hide shell commands inside prompt.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ACTIONS, description: "Management action" },
        task_id: { type: "string", description: "Task id returned by list or create" },
        task: { ...taskSchema(), description: "Complete task definition for create" },
        patch: { ...taskSchema(), description: "Partial task definition for update" },
        enabled: { type: "boolean", description: "Required by set_enabled" },
        limit: { type: "number", minimum: 1, maximum: 100, description: "Maximum runs to return" }
      },
      required: ["action"],
      additionalProperties: false
    }
  }
};

function taskSummary(task) {
  if (!task) return null;
  return {
    id: task.id,
    taskType: task.taskType || "agent",
    title: task.title,
    executionMode: task.executionMode,
    schedule: task.schedule,
    enabled: task.enabled,
    nextRun: task.nextRun,
    lastRun: task.lastRun || null,
    remoteTaskId: task.remoteTaskId || null,
    command: task.taskType === "command" ? task.command || "" : undefined,
    updatedAt: task.updatedAt
  };
}

function taskDetail(task) {
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

function runSummary(run) {
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
    error: run.error || null
  };
}

function syncToolAvailability() {
  const names = (window.zion?.state?.get("chat.tools") || [])
    .map((item) => item?.function?.name)
    .filter(Boolean);
  window.zion?.state?.set("chat.toolsKnownNames", names);

  const enabled = window.zion?.state?.get("chat.enabledTools");
  if (!Array.isArray(enabled) || enabled.length === 0) {
    window.zion?.state?.set("chat.enabledTools", names);
    return;
  }

  let customized = false;
  try {
    customized = localStorage.getItem("zion.enabledTools.userCustomized") === "1";
  } catch {}
  const available = enabled.filter((name) => names.includes(name));
  if (!customized && names.includes(TOOL_NAME) && !available.includes(TOOL_NAME)) {
    available.push(TOOL_NAME);
  }
  window.zion?.state?.set("chat.enabledTools", available);
}

function requireTask(controller, taskId) {
  const task = controller.getTask(String(taskId || ""));
  if (!task) throw new Error("Task not found");
  return task;
}

function ok(payload) {
  return JSON.stringify({ ok: true, ...payload }, null, 2);
}

function failure(action, error, details = {}) {
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

export function registerSchedulerTool({ controller, openPanel }) {
  const existing = window.zion?.state?.get("chat.tools") || [];
  window.zion?.state?.set("chat.tools", [
    ...existing.filter((item) => item?.function?.name !== TOOL_NAME),
    TOOL
  ]);

  const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
  const handler = async (args = {}) => {
    let action = "";
    try {
      action = String(args.action || "").trim();
      if (!ACTIONS.includes(action)) {
        return failure(action, `Unknown action: ${action}`, {
          code: "UNKNOWN_ACTION",
          allowedActions: ACTIONS
        });
      }

      if (action === "list") {
        await controller.refreshServiceTasks();
        return ok({ tasks: controller.listTasks().map(taskSummary) });
      }
      if (action === "get") {
        return ok({ task: taskDetail(requireTask(controller, args.task_id)) });
      }
      if (action === "list_runs") {
        if (args.task_id) requireTask(controller, args.task_id);
        const runs = await controller.listRuns({ taskId: String(args.task_id || ""), limit: args.limit });
        return ok({ runs: runs.map(runSummary) });
      }
      if (action === "create") {
        const task = buildSchedulerTask(args.task || {});
        const error = validateSchedulerTask(task);
        if (error) return failure(action, error, { code: "VALIDATION_FAILED" });
        const saved = await controller.saveTask(task);
        return ok({ created: taskSummary(saved) });
      }
      if (action === "update") {
        const existingTask = requireTask(controller, args.task_id);
        const task = mergeSchedulerTask(existingTask, args.patch || {});
        const error = validateSchedulerTask(task);
        if (error) return failure(action, error, { code: "VALIDATION_FAILED" });
        const saved = await controller.saveTask(task);
        return ok({ updated: taskSummary(saved) });
      }
      if (action === "set_enabled") {
        if (typeof args.enabled !== "boolean") return failure(action, "Missing enabled", { code: "VALIDATION_FAILED" });
        const saved = await controller.setEnabled(String(args.task_id || ""), args.enabled);
        return ok({ updated: taskSummary(saved) });
      }
      if (action === "run_now") {
        const result = await controller.runNow(String(args.task_id || ""));
        return ok({ run: result });
      }
      if (action === "delete") {
        return ok(await controller.deleteTask(String(args.task_id || "")));
      }
      if (action === "open_panel") {
        openPanel?.();
        return ok({ opened: true });
      }
      return failure(action, `Unknown action: ${action}`, { code: "UNKNOWN_ACTION", allowedActions: ACTIONS });
    } catch (error) {
      console.error(`[${TOOL_NAME}] ${action || "unknown"} failed`, error);
      return failure(action, error);
    }
  };
  handlers[TOOL_NAME] = handler;
  window.zion?.state?.set("chat.toolHandlers", handlers);
  syncToolAvailability();

  return {
    dispose() {
      try {
        const nextTools = (window.zion?.state?.get("chat.tools") || [])
          .filter((item) => item?.function?.name !== TOOL_NAME);
        window.zion?.state?.set("chat.tools", nextTools);
        const current = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
        if (current[TOOL_NAME] === handler) {
          delete current[TOOL_NAME];
          window.zion?.state?.set("chat.toolHandlers", current);
        }
        syncToolAvailability();
      } catch {}
    }
  };
}
