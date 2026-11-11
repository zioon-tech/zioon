import { CancellationController, RunCancelledError } from "./cancellation.js";
import type {
  RunController, RunHookContext, RunHookDecision, RunHookStage, ToolResult
} from "./protocol.js";

const allowed: Record<RunHookStage, string[]> = {
  beforeStart: ["pass", "deny", "pause"],
  beforeTurn: ["pass", "deny", "pause"],
  beforeModel: ["pass", "deny", "pause"],
  beforeTool: ["pass", "deny", "pause", "replace-tool-result"],
  afterTool: ["pass"],
  beforeStop: ["pass", "deny", "pause", "continue", "accept-stop"],
  afterRun: ["pass", "continue-run"]
};

export function validateRunHookDecision(value: unknown, stage: RunHookStage, maximumBytes = 64 * 1024): RunHookDecision {
  if (value === undefined) return { action: "pass" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hook must return a structured decision");
  }
  const decision = value as RunHookDecision;
  if (!allowed[stage].includes(decision.action)) throw new Error(`Invalid hook action for ${stage}`);
  if (["deny", "pause"].includes(decision.action)
    && (typeof (value as { reason?: unknown }).reason !== "string"
      || !(value as { reason: string }).reason.trim())) throw new Error("Hook decision requires a reason");
  if (["continue", "continue-run"].includes(decision.action)
    && (typeof (value as { instruction?: unknown }).instruction !== "string"
      || !(value as { instruction: string }).instruction.trim())) throw new Error("Hook continuation requires an instruction");
  if (decision.action === "replace-tool-result"
    && (typeof decision.result?.ok !== "boolean" || typeof decision.result.content !== "string")) {
    throw new Error("Hook returned an invalid tool result");
  }
  const encoded = JSON.stringify(decision);
  if (new TextEncoder().encode(encoded).length > maximumBytes) throw new Error("Hook decision exceeds size limit");
  return JSON.parse(encoded) as RunHookDecision;
}

async function legacy(controller: RunController, context: RunHookContext): Promise<RunHookDecision> {
  const stage = context.stage;
  if (stage === "afterRun") {
    const next = await controller.afterRun?.({
      runId: context.runId, request: context.request,
      result: context.result as import("./protocol.js").RunResult
    });
    return next ? { action: "continue-run", instruction: next.instruction || "继续当前已授权的持续工作", metadata: next.metadata } : { action: "pass" };
  }
  if (stage === "afterTool") {
    await controller.afterTool?.(context.invocation!, context.result as ToolResult, context);
    return { action: "pass" };
  }
  if (stage === "beforeTool") {
    const result = await controller.beforeTool?.(context.invocation!, context);
    return typeof result === "string" ? { action: "deny", reason: result }
      : result ? { action: "replace-tool-result", result } : { action: "pass" };
  }
  if (stage === "beforeStop") {
    const result = await controller.beforeStop?.(context);
    return result === null ? { action: "accept-stop" }
      : result ? { action: "continue", instruction: result } : { action: "pass" };
  }
  const result = await controller[stage]?.(context);
  return typeof result === "string" && result ? { action: "deny", reason: result } : { action: "pass" };
}

/** Bounded, sequential policy execution. Observers cannot rewrite execution results. */
export async function dispatchRunHook(
  controller: RunController,
  context: RunHookContext,
  observe?: (type: string, data: Record<string, unknown>) => void | Promise<void>
): Promise<RunHookDecision> {
  if (controller.handle ? !controller.stages?.includes(context.stage) : !controller[context.stage]) {
    return { action: "pass" };
  }
  const timeoutMs = Math.min(60_000, Math.max(1, Math.floor(controller.timeoutMs ?? 10_000)));
  if (!Number.isFinite(timeoutMs)) throw new Error(`Invalid hook timeout: ${controller.id}`);
  const started = Date.now();
  const facts = { controllerId: controller.id, stage: context.stage, turn: context.turn };
  const cancellation = new CancellationController();
  const linked = context.signal.onCancel((reason) => cancellation.cancel(reason));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelListener: { dispose(): void } | undefined;
  await observe?.("hook.started", facts);
  try {
    context.signal.throwIfCancelled();
    // A late/failed hook cannot mutate the executor's input or policy.
    const { signal: _signal, ...data } = context;
    const isolated: RunHookContext = { ...JSON.parse(JSON.stringify(data)), signal: cancellation.signal };
    const result = await Promise.race([
      Promise.resolve().then(() => controller.handle ? controller.handle(isolated) : legacy(controller, isolated)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cancellation.cancel("hook-timeout");
          reject(new Error(`Hook timed out: ${controller.id}/${context.stage}`));
        }, timeoutMs);
        cancelListener = context.signal.onCancel((reason) => reject(new RunCancelledError(reason)));
      })
    ]);
    // Preserve the existing accepted input ranges of built-in legacy controllers.
    const decision = validateRunHookDecision(result, context.stage, controller.handle ? 64 * 1024 : Infinity);
    await observe?.("hook.completed", { ...facts, action: decision.action, durationMs: Date.now() - started });
    return decision;
  } catch (error) {
    if (context.signal.cancelled) throw new RunCancelledError(context.signal.reason || "user");
    await observe?.("hook.failed", {
      ...facts, durationMs: Date.now() - started,
      failurePolicy: controller.failurePolicy || "fail-closed",
      // Hook errors may contain external secrets. Keep durable facts bounded.
      failureCode: cancellation.signal.reason === "hook-timeout" ? "timeout" : "hook_error"
    });
    if (controller.failurePolicy === "fail-open") return { action: "pass" };
    // Built-in legacy policies retain their existing actionable error contract.
    if (!controller.handle && cancellation.signal.reason !== "hook-timeout") throw error;
    throw new Error(`Hook failed: ${controller.id}/${context.stage}`);
  } finally {
    clearTimeout(timer);
    linked.dispose();
    cancelListener?.dispose();
  }
}
