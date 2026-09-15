import { conversationBlockId, finalAnswerBlockId, type ConversationBlock, type ConversationProjection } from "./conversation";
import type { RunEvent } from "./types";

export type RunProjectionState = ConversationProjection & { cursor: number; turn: number };
export type ProjectionAction =
  | { type: "reset"; runId: string }
  | { type: "event"; event: RunEvent }
  | { type: "error"; error: string };

export function initialRunProjection(runId = ""): RunProjectionState {
  return { runId, status: "connecting", blocks: [], cursor: 0, turn: 1, error: "" };
}

function resultText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
}

export function reduceRunProjection(state: RunProjectionState, action: ProjectionAction): RunProjectionState {
  if (action.type === "reset") return initialRunProjection(action.runId);
  if (action.type === "error") return { ...state, error: action.error };
  const { event } = action;
  if (event.runId !== state.runId || event.sequence <= state.cursor) return state;
  const data = event.data || {};
  const turn = Number(data.turn) || state.turn;
  let next: RunProjectionState = { ...state, cursor: event.sequence, turn, error: "" };
  const upsert = (block: ConversationBlock) => {
    const index = next.blocks.findIndex((entry) => entry.id === block.id);
    next.blocks = index < 0 ? [...next.blocks, block] : next.blocks.map((entry, i) => i === index ? block : entry);
  };
  const settleReasoning = (onlyTurn?: number) => {
    next.blocks = next.blocks.map((block) => block.kind === "reasoning" && (onlyTurn == null || block.turn === onlyTurn)
      ? { ...block, running: false } : block);
  };
  const textBlock = (kind: "text" | "reasoning", content: string, replace = false) => {
    const id = conversationBlockId(state.runId, turn, kind);
    const existing = next.blocks.find((block) => block.id === id);
    const previous = existing && existing.kind !== "tool" ? existing.content : "";
    upsert({ id, turn, kind, content: replace ? content : previous + content, ...(kind === "reasoning" ? { running: true } : {}) });
  };
  if (event.type === "run.started" || event.type === "run.resumed" || event.type === "turn.started") {
    next.status = "running";
    next.finalBlockId = undefined;
  } else if (event.type === "message.delta") {
    settleReasoning(turn);
    if (data.delta) textBlock("text", String(data.delta));
  } else if (event.type === "message.completed") {
    settleReasoning(turn);
    if (typeof data.content === "string" && data.content) textBlock("text", data.content, true);
    // Runtime emits this only for the final assistant turn with no tool calls.
    next.finalBlockId = finalAnswerBlockId(next.blocks);
  } else if (["reasoning.started", "reasoning.progress", "reasoning.delta"].includes(event.type)) {
    textBlock("reasoning", event.type === "reasoning.delta" ? String(data.delta || "") : "");
  } else if (event.type === "reasoning.completed" || event.type === "turn.completed") {
    settleReasoning(turn);
  } else if (["tool.requested", "tool.completed", "tool.failed", "tool.denied"].includes(event.type)) {
    next.finalBlockId = undefined;
    settleReasoning(turn);
    const callId = String(data.toolCallId || data.callId || data.id || event.eventId);
    const id = conversationBlockId(state.runId, turn, `tool:${callId}`);
    const existing = next.blocks.find((block) => block.id === id);
    const tool = existing?.kind === "tool" ? existing : undefined;
    const requested = event.type === "tool.requested";
    const failed = event.type === "tool.failed" || event.type === "tool.denied" || data.ok === false;
    const argumentsValue = data.arguments ?? data.args;
    const call = {
      id: callId,
      type: "function" as const,
      function: {
        name: tool?.call.function.name || String(data.name || data.toolName || "tool"),
        arguments: argumentsValue == null ? tool?.call.function.arguments || "{}" : resultText(argumentsValue),
      },
    };
    upsert({
      id, turn, kind: "tool", call,
      status: requested ? "running" : failed ? "failed" : "completed",
      result: requested ? tool?.result : {
        id: `${id}:result`, sequence: event.sequence, runId: state.runId,
        role: "tool", toolCallId: callId,
        content: failed
          ? JSON.stringify({ ok: false, error: data.error || data.reason || data.result || "Tool failed" })
          : resultText(data.resultPreview ?? data.result ?? data.content ?? ""),
      },
    });
  } else if (["run.completed", "run.failed", "run.aborted", "run.interrupted"].includes(event.type)) {
    next.status = event.type.slice(4) as RunProjectionState["status"];
    settleReasoning();
    next.blocks = next.blocks.map((block) => block.kind === "tool" && block.status === "running"
      ? { ...block, status: "interrupted" } : block);
    // run.output aggregates ALL turns. It must not replace or duplicate them.
    if (!next.blocks.some((block) => block.kind === "text") && data.output) {
      textBlock("text", String(data.output), true);
    }
    next.finalBlockId = event.type === "run.completed" ? finalAnswerBlockId(next.blocks) : undefined;
    if (event.type === "run.failed" || event.type === "run.interrupted") {
      next.error = String(data.error || data.reason || "Run interrupted");
    }
  }
  return next;
}
