import {
  AGENTS_MANAGE_RUNTIME_ACTIONS,
  AGENTS_MANAGE_READONLY_ACTIONS,
  AGENTS_MANAGE_WRITE_ACTIONS,
  AGENTS_MANAGE_TOOL_NAME,
  AGENTS_RUNTIME_SNAPSHOT_KEY,
  AGENTS_RUNTIME_STATE_NAMESPACE,
  DEFAULT_AGENTS,
  agentsManageToolDefinition,
  createAgentTask,
  deleteAgentTask,
  finishAgentTaskRun,
  getAgentTask,
  listAgentTasks,
  normalizeAgentsSnapshot,
  selectAgentTask,
  startAgentTaskRun,
  stopAgentTaskRun,
  summarizeAgent
} from "./agents-runtime-shared.js";

export const runtimePluginApiVersion = 2;

function allowsWorkspaceWrite(policy = {}) {
  return ["workspace-write", "trusted-automation"].includes(String(policy?.preset || "read-only"));
}

export function activateRuntimePlugin(context) {
  const state = context.state.namespace(AGENTS_RUNTIME_STATE_NAMESPACE);
  const runnerService = context.config?.agentRunnerService || null;
  const activeRuns = new Map();
  const snapshot = () => normalizeAgentsSnapshot(
    state.get(AGENTS_RUNTIME_SNAPSHOT_KEY) || {}
  );
  const saveSnapshot = (value) => state.set(
    AGENTS_RUNTIME_SNAPSHOT_KEY,
    normalizeAgentsSnapshot(value)
  );
  const definition = agentsManageToolDefinition({
    actions: AGENTS_MANAGE_RUNTIME_ACTIONS
  });
  const registration = context.tools.registerTool({
    name: AGENTS_MANAGE_TOOL_NAME,
    description: definition.description,
    inputSchema: definition.inputSchema,
    policy: { minimumPreset: "read-only" },
    async invoke(args = {}, meta = {}) {
      const action = String(args.action || "").trim();
      const current = snapshot();
      if (!AGENTS_MANAGE_RUNTIME_ACTIONS.includes(action)) {
        return {
          ok: false,
          content: `Unsupported Runtime agentsManage action: ${action}`,
          error: `Unsupported Runtime agentsManage action: ${action}`
        };
      }
      if (
        AGENTS_MANAGE_WRITE_ACTIONS.includes(action)
        && !allowsWorkspaceWrite(meta?.policy)
      ) {
        return {
          ok: false,
          content: `agentsManage action ${action} requires workspace-write capability`,
          error: `agentsManage action ${action} requires workspace-write capability`
        };
      }
      if (action === "list_agents") {
        return {
          ok: true,
          content: JSON.stringify(DEFAULT_AGENTS.map(summarizeAgent), null, 2)
        };
      }
      if (action === "list_tasks") {
        return {
          ok: true,
          content: JSON.stringify({
            activeTaskId: current.activeTaskId,
            tasks: listAgentTasks(current, {
              sessionId: args.session_id
            })
          }, null, 2)
        };
      }
      if (action === "get_task") {
        const taskId = String(args.task_id || "").trim();
        if (!taskId) {
          return { ok: false, content: "Missing task_id", error: "Missing task_id" };
        }
        return {
          ok: true,
          content: JSON.stringify(getAgentTask(current, taskId), null, 2)
        };
      }
      if (action === "create_task" || action === "create_research_task") {
        const result = createAgentTask(current, args);
        saveSnapshot(result.snapshot);
        return {
          ok: true,
          content: JSON.stringify({
            created: result.task,
            snapshot: result.snapshot,
            next: "Task created in Runtime. Use agentsManage action=run_task to start a Runtime Host background Agent Run."
          }, null, 2)
        };
      }
      if (action === "delete_task") {
        const result = deleteAgentTask(current, args.task_id);
        saveSnapshot(result.snapshot);
        return {
          ok: true,
          content: JSON.stringify(result, null, 2)
        };
      }
      if (action === "select_task") {
        const result = selectAgentTask(current, args.task_id);
        saveSnapshot(result.snapshot);
        return {
          ok: true,
          content: JSON.stringify(result, null, 2)
        };
      }
      if (action === "run_task") {
        if (!runnerService?.startTaskRun) {
          return {
            ok: false,
            content: "Runtime Agent runner service is unavailable",
            error: "Runtime Agent runner service is unavailable"
          };
        }
        const taskId = String(args.task_id || "").trim();
        if (!taskId) return { ok: false, content: "Missing task_id", error: "Missing task_id" };
        const task = current.tasks.find((item) => item.id === taskId);
        if (!task) {
          return { ok: false, content: `Agent Task not found: ${taskId}`, error: `Agent Task not found: ${taskId}` };
        }
        if (activeRuns.has(taskId) || (task.status === "running" && task.activeRunId)) {
          return {
            ok: true,
            content: JSON.stringify({
              running: true,
              task: getAgentTask(current, taskId),
              runId: task.activeRunId || activeRuns.get(taskId)?.runId || ""
            }, null, 2)
          };
        }
        const handle = runnerService.startTaskRun(task, {
          interactionProfileId: args.interaction_profile_id,
          parentRunId: meta.runId,
          parentAttemptId: meta.attemptId,
          principal: meta.principal,
          projectId: meta.projectId,
          policy: meta.policy
        });
        activeRuns.set(taskId, handle);
        const started = startAgentTaskRun(current, taskId, {
          runId: handle.runId,
          attemptId: handle.attemptId,
          sessionId: handle.sessionId
        });
        saveSnapshot(started.snapshot);
        void (async () => {
          if (!handle.events?.[Symbol.asyncIterator]) return;
          for await (const _event of handle.events) {
            // Runtime Run events are already persisted by the RunStore. Drain the queue here.
          }
        })().catch((error) => {
          context.log?.("warn", `Failed to drain Agent Task ${taskId} events: ${error.message}`);
        });
        void handle.completion
          .then((completion) => {
            try {
              const finished = finishAgentTaskRun(snapshot(), taskId, completion);
              saveSnapshot(finished.snapshot);
            } catch (error) {
              context.log?.("warn", `Failed to finish Agent Task ${taskId}: ${error.message}`);
            }
          })
          .catch((error) => {
            try {
              const finished = finishAgentTaskRun(snapshot(), taskId, {
                runId: handle.runId,
                status: "failed",
                error: error?.message || String(error),
                output: ""
              });
              saveSnapshot(finished.snapshot);
            } catch (innerError) {
              context.log?.("warn", `Failed to record Agent Task ${taskId} failure: ${innerError.message}`);
            }
          })
          .finally(() => {
            activeRuns.delete(taskId);
          });
        return {
          ok: true,
          content: JSON.stringify({
            started: started.task,
            runId: handle.runId,
            attemptId: handle.attemptId,
            sessionId: handle.sessionId || ""
          }, null, 2)
        };
      }
      if (action === "stop_task") {
        const taskId = String(args.task_id || "").trim();
        if (!taskId) return { ok: false, content: "Missing task_id", error: "Missing task_id" };
        const task = current.tasks.find((item) => item.id === taskId);
        if (!task) {
          return { ok: false, content: `Agent Task not found: ${taskId}`, error: `Agent Task not found: ${taskId}` };
        }
        const active = activeRuns.get(taskId);
        const stopped = active
          ? await Promise.resolve(active.abort?.("user")).then(() => true, () => false)
          : await Promise.resolve(runnerService?.abortRun?.(task.activeRunId, "user")).then(Boolean, () => false);
        const result = stopAgentTaskRun(snapshot(), taskId, "user");
        saveSnapshot(result.snapshot);
        activeRuns.delete(taskId);
        return {
          ok: true,
          content: JSON.stringify({
            stopped: taskId,
            abortedRun: stopped,
            task: result.task
          }, null, 2)
        };
      }
      return {
        ok: false,
        content: `Unknown action: ${action}`,
        error: `Unknown action: ${action}`
      };
    }
  });

  return {
    dispose() {
      for (const handle of activeRuns.values()) {
        try { void handle.abort?.("runtime-plugin-dispose"); } catch {}
      }
      activeRuns.clear();
      registration.dispose();
    }
  };
}
