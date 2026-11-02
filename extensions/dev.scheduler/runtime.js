import {
  SCHEDULER_HEADLESS_ACTIONS,
  SCHEDULER_TOOL_NAME,
  failure,
  normalizeLimit,
  ok,
  runSummary,
  schedulerManageToolSchema,
  taskDetail,
  taskSummary
} from "./scheduler-tool-shared.js";

export const runtimePluginApiVersion = 2;

function requireSchedulerService(context) {
  const service = context.config?.schedulerService;
  if (!service || typeof service !== "object") {
    throw new Error("Runtime Scheduler service is unavailable");
  }
  return service;
}

export function activateRuntimePlugin(context) {
  const service = requireSchedulerService(context);
  const schema = schedulerManageToolSchema({
    actions: SCHEDULER_HEADLESS_ACTIONS
  }).function;
  const toolRegistration = context.tools.registerTool({
    name: SCHEDULER_TOOL_NAME,
    description: `${schema.description} This Runtime headless tool does not support open_panel.`,
    inputSchema: schema.parameters,
    execution: { effect: "write" },
    policy: {
      minimumPreset: "trusted-automation"
    },
    async invoke(args = {}, meta = {}) {
      let action = "";
      try {
        action = String(args.action || "").trim();
        if (!SCHEDULER_HEADLESS_ACTIONS.includes(action)) {
          return {
            ok: false,
            content: failure(action, `Unknown action: ${action}`, {
              code: "UNKNOWN_ACTION",
              allowedActions: SCHEDULER_HEADLESS_ACTIONS
            })
          };
        }
        if (action === "list") {
          return {
            ok: true,
            content: ok({ tasks: (await service.listTasks()).map(taskSummary) })
          };
        }
        if (action === "get") {
          return {
            ok: true,
            content: ok({ task: taskDetail(await service.getTask(args.task_id)) })
          };
        }
        if (action === "list_runs") {
          const runs = await service.listRuns({
            taskId: String(args.task_id || ""),
            limit: normalizeLimit(args.limit),
            includeDetails: false
          });
          return { ok: true, content: ok({ runs: runs.map(runSummary) }) };
        }
        if (action === "create") {
          const created = await service.createTask(args.task || {}, meta);
          return { ok: true, content: ok({ created: taskSummary(created) }) };
        }
        if (action === "update") {
          const updated = await service.updateTask(
            String(args.task_id || ""),
            args.patch || {},
            meta
          );
          return { ok: true, content: ok({ updated: taskSummary(updated) }) };
        }
        if (action === "set_enabled") {
          if (typeof args.enabled !== "boolean") {
            return {
              ok: false,
              content: failure(action, "Missing enabled", { code: "VALIDATION_FAILED" })
            };
          }
          const updated = await service.setEnabled(
            String(args.task_id || ""),
            args.enabled,
            meta
          );
          return { ok: true, content: ok({ updated: taskSummary(updated) }) };
        }
        if (action === "run_now") {
          return {
            ok: true,
            content: ok({ run: await service.runNow(String(args.task_id || "")) })
          };
        }
        if (action === "delete") {
          const id = String(args.task_id || "");
          await service.deleteTask(id);
          return { ok: true, content: ok({ id, deleted: true }) };
        }
        return {
          ok: false,
          content: failure(action, `Unknown action: ${action}`, {
            code: "UNKNOWN_ACTION",
            allowedActions: SCHEDULER_HEADLESS_ACTIONS
          })
        };
      } catch (error) {
        context.log?.("error", `${SCHEDULER_TOOL_NAME}:${action || "unknown"} failed: ${error?.message || error}`);
        return {
          ok: false,
          content: failure(action, error)
        };
      }
    }
  });

  return {
    dispose() {
      toolRegistration.dispose();
    }
  };
}
