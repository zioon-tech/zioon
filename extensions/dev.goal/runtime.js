import { randomUUID } from "node:crypto";
import { contentHash, workflowScope, workflowError } from "../../packages/plugin-sdk/src/runtime-workflow.mjs";

export const runtimePluginApiVersion = 2;

const TERMINAL = new Set(["completed", "cancelled"]);
const tokens = (usage = {}) => Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
const text = (value) => typeof value === "string" ? value : JSON.stringify(value);
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : null;

export async function activateRuntimePlugin(context) {
  const state = context.state.namespace("private");
  const runs = context.config.runStore;
  const locks = new Map();
  const live = new Map();
  const serial = async (key, operation) => {
    const previous = locks.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    locks.set(key, pending);
    try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
  };
  const read = (ctx) => state.get(workflowScope(ctx).key) || null;
  const save = async (key, record) => {
    const next = { ...record, revision: (record.revision || 0) + 1, updatedAt: Date.now() };
    await state.put(key, next);
    context.events.emit("goal.updated", { sessionId: next.sessionId, goalId: next.id, status: next.status });
    return next;
  };
  // Startup never replays work that may have completed outside the process.
  for (const [key, record] of state.entries()) {
    if (record?.status === "active") {
      await save(key, { ...record, status: "interrupted", reason: "runtime-restarted", activeRunId: null });
    }
  }

  const commandFromRequest = (request) => {
    const configured = request.metadata?.goal;
    if (configured?.action) return configured;
    const user = request.messages?.filter((message) => message.role === "user").at(-1);
    const match = text(user?.content || request.prompt || "").match(/^\/goal(?:\s+([\s\S]+))?$/);
    if (!match) return null;
    const objective = String(match[1] || "").trim();
    return ["pause", "resume", "cancel", "status"].includes(objective)
      ? { action: objective } : { action: "start", objective };
  };
  const currentForRun = (ctx) => {
    const record = read(ctx);
    return record?.activeRunId === ctx.runId ? record : null;
  };
  const instruction = (record) => `Persistent goal (authoritative user objective): ${record.objective}
Acceptance criteria: ${JSON.stringify(record.criteria)}
Status: ${record.status}; usage: ${record.tokenUsage} tokens; token budget: ${record.tokenBudget ?? "not specified"}.
Progress: ${JSON.stringify(record.progress)}
Current plan (optional): ${JSON.stringify(record.plan || [])}
Next action: ${record.nextAction || "Inspect the current state and choose the next concrete action."}
Unresolved operations: ${JSON.stringify(Object.entries(record.operations || {}).filter(([, operation]) => ["pending", "unknown"].includes(operation.status)))}
Continue working until every criterion has evidence. Use goalManage to inspect/report/complete.
Work in this cycle: inspect facts and the latest user corrections, choose the next useful action,
execute it, then verify the result. Use an optional short plan when it helps; revise it when facts change.
Report progress at meaningful milestones with concrete evidence references and a nextAction.
Changing a progress note, repeating the same read, or announcing intentions is not progress.
Before completion, audit every part of the original objective, confirm verification and deliverable links,
and explicitly state material limitations. A model report is not independent proof of success.
For long running work keep its handle, wait/poll through the available tools, and check the actual state;
never claim a running job finished. If input or authorization is required, report the concrete blocker.
Context compression may hand off older history; the objective and latest corrections remain authoritative.
Use compressionRecall for details omitted from the handoff; never invent forgotten tool results.
An ordinary final answer does not complete the goal. Do not shrink the objective or infer success from text.
If a tool outcome is unknown, inspect the existing handle/receipt; never repeat that side effect.
User corrections in the conversation apply to this objective. Budget exhaustion or missing input is not completion.`;
  const controller = {
    id: "dev.goal",
    async beforeStart(ctx) {
      if (ctx.request.principal?.kind === "service") {
        if (commandFromRequest(ctx.request)) throw workflowError("Goal activation requires an explicit user Run");
        return;
      }
      if (!ctx.request.sessionId) {
        if (commandFromRequest(ctx.request)) throw new Error("Goal mode requires a Session");
        return;
      }
      const scope = workflowScope(ctx);
      await serial(scope.key, async () => {
        let record = read(ctx);
        const command = commandFromRequest(ctx.request);
        if (command?.action === "continue" && record?.status !== "active") {
          throw workflowError("Goal continuation is no longer active");
        }
        if (command?.action === "start") {
          if (record && !TERMINAL.has(record.status)) throw workflowError("A goal already exists; resume or cancel it first");
          const objective = String(command.objective || "").trim();
          if (!objective || objective.length > 50000) throw workflowError("A goal objective of 1–50000 characters is required", 400);
          if (record) await state.put(`${scope.key}.history.${record.id}`, record);
          record = {
            id: `goal_${randomUUID()}`, ...scope, objective,
            criteria: Array.isArray(command.criteria) && command.criteria.length
              ? command.criteria.map(String).slice(0, 32) : [objective],
            status: "active", reason: "", revision: 0,
            createdAt: Date.now(), tokenBudget: positive(command.tokenBudget),
            deadline: positive(command.timeBudgetMs) ? Date.now() + positive(command.timeBudgetMs) : null,
            tokenUsage: 0, cycles: 0, stalls: 0, progress: [], evidence: [], runIds: [],
            activeRunId: null, maxCycles: 8
          };
        } else if (command?.action === "resume") {
          if (!record || TERMINAL.has(record.status)) throw workflowError("No resumable goal");
          if (command.id && command.id !== record.id) throw workflowError("Stale goal continuation");
          if (record.activeRunId && live.has(record.activeRunId)) throw workflowError("Goal already running");
          if (record.reason === "token-budget" && (!positive(command.tokenBudget) || positive(command.tokenBudget) <= record.tokenUsage)) {
            throw workflowError("Supply a larger tokenBudget to resume");
          }
          if (record.reason === "time-budget" && !positive(command.timeBudgetMs)) throw workflowError("Supply a new timeBudgetMs to resume");
          record = {
            ...record, status: "active", reason: "", stalls: 0, blocker: null,
            maxCycles: record.cycles + 8,
            ...(positive(command.tokenBudget) ? { tokenBudget: positive(command.tokenBudget) } : {}),
            ...(positive(command.timeBudgetMs) ? { deadline: Date.now() + positive(command.timeBudgetMs) } : {})
          };
        } else if (command && command.action !== "continue") {
          // Pause/cancel/status use the command endpoint so they do not start a model call.
          throw workflowError(`Use the goal ${command.action} command`);
        }
        if (!record || record.status !== "active") return;
        if (!ctx.tools?.some((tool) => tool.name === "goalManage")) {
          throw workflowError("Enable goalManage in this interaction profile before starting goal mode");
        }
        if (command?.action === "continue" && command.id !== record.id) throw workflowError("Stale goal continuation");
        if (record.activeRunId && record.activeRunId !== ctx.runId && live.has(record.activeRunId)) {
          throw workflowError("Goal already has an active Run");
        }
        record = await save(scope.key, {
          ...record, activeRunId: ctx.runId, cycles: record.cycles + 1,
          runIds: [...record.runIds, ctx.runId].slice(-32), runBaseTokens: record.tokenUsage
        });
        live.set(ctx.runId, scope.key);
      });
    },
    async beforeTurn(ctx) {
      if (!ctx.request.sessionId) return;
      const key = workflowScope(ctx).key;
      return await serial(key, async () => {
        let record = currentForRun(ctx);
        if (!record) return;
        const observedTokens = record.runBaseTokens + tokens(ctx.usage);
        if (record.tokenUsage !== observedTokens) record = await save(key, { ...record, tokenUsage: observedTokens });
        const reason = record.status !== "active" ? record.reason || record.status
          : record.tokenBudget && observedTokens >= record.tokenBudget ? "token-budget"
            : record.deadline && Date.now() >= record.deadline ? "time-budget" : "";
        if (reason) {
          if (record.status === "active") await save(key, { ...record, status: "budget_exhausted", reason });
          return `goal:${reason}`;
        }
      });
    },
    async beforeModel(ctx) {
      return await controller.beforeTurn(ctx);
    },
    async beforeStop(ctx) {
      if (!ctx.request.sessionId) return;
      const scope = workflowScope(ctx);
      return await serial(scope.key, async () => {
        let record = currentForRun(ctx);
        if (!record) return;
        if (record.status !== "active") return null;
        if (record.completionRequested) {
          const uncertain = [];
          for (const id of record.runIds) {
            const events = await runs?.getEvents(id) || [];
            uncertain.push(...events.filter((event) => event.type === "tool.completed"
              && event.data.failureCode === "execution_outcome_unknown"));
          }
          const unresolved = Object.values(record.operations || {}).some((operation) => ["pending", "unknown"].includes(operation.status));
          if (unresolved || uncertain.some((event) => !(record.reconciledCalls || []).includes(event.data.callId))) {
            await save(scope.key, { ...record, status: "paused", reason: "unknown-tool-outcome", completionRequested: false });
            return null;
          }
          await save(scope.key, { ...record, status: "completed", reason: "criteria-evidence-reported", completedAt: Date.now() });
          return null;
        }
        const progressHash = contentHash([
          [...(record.resultFingerprints || [])].sort(),
          [...new Set((record.progress || []).flatMap((entry) => (entry.evidence || []).map((item) =>
            contentHash([item.criterion, String(item.reference).trim()]))))].sort()
        ]);
        const boundary = `${ctx.runId}:${ctx.turn}`;
        if (record.lastBoundary === boundary) return instruction(record);
        const stalls = record.lastProgressHash === progressHash ? record.stalls + 1 : 0;
        const blockerCount = record.blocker && record.lastBlocker === record.blocker ? (record.blockerCount || 0) + 1 : 1;
        record = await save(scope.key, {
          ...record, lastBoundary: boundary, lastProgressHash: progressHash, stalls,
          lastBlocker: record.blocker, blockerCount,
          ...(stalls >= 3 || (record.blocker && blockerCount >= 3)
            ? { status: "blocked", reason: record.blocker || "no-observable-progress" } : {})
        });
        if (record.status === "active") return instruction(record);
        return null;
      });
    },
    async beforeTool(invocation, ctx) {
      if (!ctx.request.sessionId) return;
      const stop = await controller.beforeTurn(ctx);
      if (stop) return stop;
      const record = currentForRun(ctx);
      const execution = ctx.tools?.find((tool) => tool.name === invocation.toolCall.name)?.execution;
      if (!record || invocation.toolCall.name === "goalManage" || execution?.effect === "read" || execution?.idempotency === "safe") return;
      const key = workflowScope(ctx).key;
      const hash = contentHash([invocation.toolCall.name, invocation.target || null, invocation.toolCall.arguments]);
      return await serial(key, async () => {
        const current = currentForRun(ctx);
        if (current?.status !== "active") {
          return { ok: false, failureCode: "cancelled", retryable: false, content: "The goal has been paused or stopped." };
        }
        const previous = current.operations?.[hash];
        if (previous && ["pending", "unknown"].includes(previous.status)) {
          await save(key, { ...current, operations: { ...current.operations, [hash]: {
            ...previous, blockedCallIds: [...(previous.blockedCallIds || []), invocation.toolCall.id]
          }}});
          return { ok: false, failureCode: "execution_outcome_unknown", retryable: false,
            content: `An earlier goal operation has an unknown outcome. Inspect invocation ${previous.invocationId}; do not repeat it. Operation hash: ${hash}` };
        }
        if (Object.keys(current.operations || {}).length >= 400 && !previous) throw workflowError("Goal operation journal limit reached; pause and review this goal");
        await save(key, { ...current, operations: { ...current.operations, [hash]: {
          invocationId: invocation.invocationId, callId: invocation.toolCall.id,
          runId: ctx.runId, tool: invocation.toolCall.name, status: "pending", startedAt: Date.now()
        }}});
      });
    },
    async afterTool(invocation, result, ctx) {
      if (!ctx.request.sessionId || invocation.toolCall.name === "goalManage") return;
      const key = workflowScope(ctx).key;
      await serial(key, async () => {
        const record = currentForRun(ctx);
        if (!record) return;
        const execution = ctx.tools?.find((tool) => tool.name === invocation.toolCall.name)?.execution;
        const fingerprint = contentHash([invocation.toolCall.name, invocation.target || null,
          invocation.toolCall.arguments, result.content]);
        const resultFingerprints = result.ok && !result.failureCode
          ? [...new Set([...(record.resultFingerprints || []), fingerprint])].slice(-256)
          : record.resultFingerprints || [];
        if (execution?.effect === "read") {
          await save(key, { ...record, resultFingerprints, observations: [...(record.observations || []), {
            callId: invocation.toolCall.id, runId: ctx.runId, ok: result.ok,
            failureCode: result.failureCode, at: Date.now()
          }].slice(-128) });
          return;
        }
        const hash = contentHash([invocation.toolCall.name, invocation.target || null, invocation.toolCall.arguments]);
        const operation = record.operations?.[hash];
        if (!operation || operation.invocationId !== invocation.invocationId) {
          await save(key, { ...record, resultFingerprints });
          return;
        }
        await save(key, { ...record, resultFingerprints, operations: { ...record.operations, [hash]: {
          ...operation, status: result.failureCode === "execution_outcome_unknown" ? "unknown" : "known",
          ok: result.ok, failureCode: result.failureCode, completedAt: Date.now()
        }}});
      });
    },
    async afterRun({ runId, request, result }) {
      if (!request.sessionId) return;
      const scope = workflowScope({ request });
      return await serial(scope.key, async () => {
        const record = read({ request });
        live.delete(runId);
        if (record?.activeRunId !== runId) return;
        const totalTokens = record.runBaseTokens + tokens(result.usage);
        const budgetReason = record.tokenBudget && totalTokens >= record.tokenBudget ? "token-budget"
          : record.deadline && Date.now() >= record.deadline ? "time-budget" : "";
        const reason = result.status !== "completed" ? result.reason || result.error || result.status
          : budgetReason ? budgetReason
          : record.cycles >= record.maxCycles ? "run-limit" : "";
        const next = await save(scope.key, {
          ...record, activeRunId: null, tokenUsage: totalTokens,
          ...(record.status === "active" && reason
            ? { status: budgetReason ? "budget_exhausted" : result.status === "completed" || result.reason === "user" ? "paused" : "interrupted", reason } : {})
        });
        if (next.status === "active") return { metadata: { goal: { action: "continue", id: next.id } } };
      });
    },
    async continuationFailed({ request, error, runId }) {
      const scope = workflowScope({ request });
      await serial(scope.key, async () => {
        const record = read({ request });
        if (record?.status === "active" && (!record.activeRunId || record.activeRunId === runId)) {
          if (record.activeRunId) live.delete(record.activeRunId);
          await save(scope.key, { ...record, activeRunId: null, status: "paused", reason: error.message });
        }
      });
    }
  };
  context.runs.registerController(controller);
  context.context.registerProvider({
    id: "dev.goal.context", required: true, stage: "post", order: 80,
    async contribute(messages, ctx) {
      if (ctx.preview || !ctx.request.sessionId) return messages;
      const record = currentForRun(ctx);
      const output = messages.filter((message) => message.contextProviderId !== "dev.goal.context");
      if (!record || record.status !== "active") return output;
      return [{ role: "system", content: instruction(record), contextProviderId: "dev.goal.context" }, ...output];
    }
  });
  context.runs.registerCommands(async (args, ctx) => {
    const scope = workflowScope(ctx);
    if (args.action === "status") {
      const record = args.goalId
        ? state.get(`${scope.key}.history.${String(args.goalId)}`) || (read(ctx)?.id === args.goalId ? read(ctx) : null)
        : read(ctx);
      if (!record || !["records", "run"].includes(args.view)) return record;
      if (args.view === "records") {
        const userId = ctx.principal?.version === 1 ? ctx.principal.userId : ctx.principal?.user?.id || null;
        const records = await runs?.getGoalRunSummaries?.(record.runIds, record.sessionId, userId) || [];
        return { goalId: record.id, records: [...record.runIds].reverse().map((id) =>
          records.find((run) => run.id === id) || { id, status: "unavailable" }) };
      }
      const id = String(args.runId || "");
      if (!record.runIds.includes(id)) throw workflowError("Run does not belong to this goal", 404);
      const run = await runs?.get(id);
      if (!run || run.sessionId !== record.sessionId || workflowScope({ request: run }).key !== scope.key) {
        throw workflowError("Goal Run is unavailable", 404);
      }
      const offset = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(args.offset) || 0)));
      const output = String(run.output || "");
      return { goalId: record.id, id, status: run.status, offset, totalChars: output.length,
        output: output.slice(offset, offset + 6000), nextOffset: offset + 6000 < output.length ? offset + 6000 : null,
        reason: String(run.terminalReason || run.error || "").slice(0, 1000),
        operations: Object.values(record.operations || {}).filter((op) => op.runId === id || op.status === "unknown")
          .slice(-32).map((op) => ({ name: op.tool, status: op.status, callId: op.callId })) };
    }
    if (args.action === "resume") {
      const record = read(ctx);
      if (!record || TERMINAL.has(record.status)) throw workflowError("No resumable goal");
      if (record.status === "active" || live.has(record.activeRunId)) throw workflowError("Goal already running");
      if (record.reason === "token-budget" && (!positive(args.tokenBudget) || positive(args.tokenBudget) <= record.tokenUsage)) {
        throw workflowError("Supply a larger tokenBudget to resume");
      }
      if (record.reason === "time-budget" && !positive(args.timeBudgetMs)) throw workflowError("Supply a new timeBudgetMs to resume");
      if (!ctx.startRun) throw workflowError("Runtime does not support command continuation", 503);
      try {
        return await ctx.startRun({
          sourceRunId: record.runIds.at(-1),
          instruction: "继续当前目标；先检查已有执行结果和仍在运行的工具，遵守最新用户更正。",
          metadata: { goal: { action: "resume", id: record.id, tokenBudget: args.tokenBudget, timeBudgetMs: args.timeBudgetMs } }
        });
      } catch (error) {
        if (error.runId) await controller.continuationFailed({ request: ctx, error, runId: error.runId });
        throw error;
      }
    }
    if (args.action === "amend") {
      return await serial(scope.key, async () => {
        const record = read(ctx);
        if (!record || TERMINAL.has(record.status)) throw workflowError("No editable goal");
        if (record.status === "active" || live.has(record.activeRunId)) throw workflowError("Pause the goal and wait for the current Run to stop before editing");
        const objective = String(args.objective || "").trim();
        if (!objective || objective.length > 50000) throw workflowError("A goal objective of 1–50000 characters is required", 400);
        const criteria = Array.isArray(args.criteria) && args.criteria.length
          ? args.criteria.map(String).slice(0, 32)
          : record.criteria.length === 1 && record.criteria[0] === record.objective ? [objective] : record.criteria;
        return await save(scope.key, { ...record, objective, criteria,
          objectiveHistory: [...(record.objectiveHistory || []), { objective: record.objective, criteria: record.criteria, at: Date.now() }].slice(-32),
          evidence: [], completionRequested: false, stalls: 0, nextAction: "", plan: [],
          progress: [], lastProgressHash: null, blocker: null, reason: "user-pause", status: "paused"
        });
      });
    }
    if (!["pause", "cancel"].includes(args.action)) throw workflowError("Use /goal or /goal-resume to start execution", 400);
    const updated = await serial(scope.key, async () => {
      const record = read(ctx);
      if (!record) throw workflowError("No goal", 404);
      if (TERMINAL.has(record.status)) return record;
      return await save(scope.key, { ...record, status: args.action === "pause" ? "paused" : "cancelled", reason: `user-${args.action}` });
    });
    if (updated.activeRunId && updated.activeRunId === ctx.activeRunId) await ctx.abort?.(`goal:user-${args.action}`);
    return updated;
  });
  context.tools.registerTool({
    name: "goalManage",
    description: "Read the explicitly created persistent goal, report evidence-backed progress, request completion with evidence for every criterion, or report a stable blocker. Cannot create or alter the objective. Completion remains a model report.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["get", "progress", "complete", "block", "reconcile"] },
        note: { type: "string" }, blocker: { type: "string" },
        nextAction: { type: "string" },
        plan: { type: "array", items: { type: "string" }, maxItems: 16 },
        operationHash: { type: "string" }, observationCallId: { type: "string" },
        evidence: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["criterion", "reference"],
          properties: { criterion: { type: "integer", minimum: 0 }, reference: { type: "string" } }
        }}
      }
    },
    execution: { effect: "write", timeoutMs: 10000, maxTimeoutMs: 10000, cancellation: "cooperative", idempotency: "invocation" },
    async invoke(args, ctx) {
      const scope = workflowScope(ctx);
      return await serial(scope.key, async () => {
        const record = currentForRun(ctx);
        if (!record) throw workflowError("No goal attached to this Run");
        if (args.action === "get") return JSON.stringify(record);
        if (record.status !== "active") throw workflowError(`Goal is ${record.status}`);
        if (args.action === "complete") {
          const evidence = (args.evidence || []).filter((item) => String(item.reference || "").trim().length >= 8);
          if (!record.criteria.every((_, index) => evidence.some((item) => item.criterion === index))) {
            throw workflowError("Provide a concrete evidence reference for every criterion");
          }
          await save(scope.key, { ...record, evidence, completionRequested: true, evidenceSource: "model-report" });
        } else if (args.action === "progress") {
          const note = String(args.note || "").trim();
          if (!note) throw workflowError("A progress note is required", 400);
          const evidence = (args.evidence || []).filter((item) => Number.isInteger(item.criterion)
            && item.criterion >= 0 && item.criterion < record.criteria.length && String(item.reference || "").trim().length >= 8);
          if (!record.progress.some((entry) => entry.note === note)) {
            await save(scope.key, { ...record,
              nextAction: String(args.nextAction || record.nextAction || "").slice(0, 4000),
              plan: Array.isArray(args.plan) ? args.plan.map(String).slice(0, 16) : record.plan,
              progress: [...record.progress, { note, evidence, runId: ctx.runId }].slice(-32) });
          } else if (args.nextAction || args.plan) await save(scope.key, { ...record,
            nextAction: String(args.nextAction || record.nextAction || "").slice(0, 4000),
            plan: Array.isArray(args.plan) ? args.plan.map(String).slice(0, 16) : record.plan
          });
        } else if (args.action === "reconcile") {
          const operation = record.operations?.[args.operationHash];
          const observation = record.observations?.find((item) => item.callId === args.observationCallId
            && item.ok && !item.failureCode && item.at >= operation?.startedAt);
          if (!operation || !observation || !String(args.note || "").trim()) {
            throw workflowError("Reconciliation requires an existing operation, a subsequent successful read observation, and a concrete explanation");
          }
          await save(scope.key, { ...record, operations: { ...record.operations, [args.operationHash]: {
            ...operation, status: "reconciled", observationCallId: args.observationCallId, reconciliation: args.note
          }}, reconciledCalls: [...(record.reconciledCalls || []), operation.callId, ...(operation.blockedCallIds || [])] });
        } else {
          const blocker = String(args.blocker || "").trim();
          if (!blocker) throw workflowError("A concrete blocker is required", 400);
          await save(scope.key, { ...record, blocker });
        }
        return JSON.stringify(read(ctx));
      });
    }
  });
  return {};
}
