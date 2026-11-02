import {
  buildSchedulerTask,
  mergeSchedulerTask,
  validateSchedulerTask
} from "./controller.js";
import {
  SCHEDULER_TOOL_NAME,
  SCHEDULER_WORKBENCH_ACTIONS,
  failure,
  ok,
  runSummary,
  schedulerManageToolSchema,
  taskDetail,
  taskSummary
} from "./scheduler-tool-shared.js";

const TOOL_NAME = SCHEDULER_TOOL_NAME;
const ACTIONS = SCHEDULER_WORKBENCH_ACTIONS;
const TOOL = schedulerManageToolSchema({ actions: ACTIONS });

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

export function registerSchedulerTool({ controller, openPanel, getSessionTag = () => "" }) {
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
        const input = args.task || {};
        const task = buildSchedulerTask({
          ...input,
          sessionTag: (input.taskType || "agent") === "command"
            ? ""
            : String(getSessionTag() || "")
        });
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
