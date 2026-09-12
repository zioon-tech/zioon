import { useEffect, useReducer, useRef } from "react";
import { subscribeRun } from "./api";
import type { RunEvent, RunStatus } from "./types";

export type ToolProjection = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  arguments?: unknown;
  detail?: string;
};

export type RunProjectionState = {
  runId: string;
  status: RunStatus | "connecting";
  output: string;
  reasoning: string;
  tools: ToolProjection[];
  cursor: number;
  error: string;
};

type Action =
  | { type: "reset"; runId: string }
  | { type: "event"; event: RunEvent }
  | { type: "error"; error: string };

const initialState: RunProjectionState = {
  runId: "",
  status: "connecting",
  output: "",
  reasoning: "",
  tools: [],
  cursor: 0,
  error: "",
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return value == null ? "" : JSON.stringify(value, null, 2);
  } catch {
    return String(value || "");
  }
}

function reduce(state: RunProjectionState, action: Action): RunProjectionState {
  if (action.type === "reset") {
    return { ...initialState, runId: action.runId };
  }
  if (action.type === "error") {
    return { ...state, error: action.error };
  }
  const event = action.event;
  const data = event.data || {};
  let next: RunProjectionState = {
    ...state,
    runId: event.runId,
    cursor: Math.max(state.cursor, Number(event.sequence) || 0),
    error: "",
  };
  if (event.type === "run.started" || event.type === "run.resumed") {
    next.status = "running";
  } else if (event.type === "message.delta") {
    next.status = "running";
    next.output += String(data.delta || "");
  } else if (event.type === "reasoning.delta") {
    next.status = "running";
    next.reasoning += String(data.delta || "");
  } else if (event.type === "reasoning.progress") {
    next.status = "running";
    if (!next.reasoning) next.reasoning = "模型正在分析上下文";
  } else if (event.type === "tool.requested") {
    const id = String(data.toolCallId || data.callId || data.id || event.eventId);
    const name = String(data.name || data.toolName || "tool");
    next.tools = [
      ...next.tools.filter((tool) => tool.id !== id),
      { id, name, status: "running", arguments: data.arguments },
    ];
  } else if (event.type === "tool.completed" || event.type === "tool.failed") {
    const id = String(data.toolCallId || data.callId || data.id || event.eventId);
    const existing = next.tools.find((tool) => tool.id === id);
    next.tools = [
      ...next.tools.filter((tool) => tool.id !== id),
      {
        id,
        name: existing?.name || String(data.name || data.toolName || "tool"),
        status: event.type === "tool.completed" ? "completed" : "failed",
        arguments: existing?.arguments,
        detail: text(data.resultPreview || data.error || data.result || ""),
      },
    ];
  } else if (event.type === "run.completed") {
    next.status = "completed";
    const output = String(data.output || "");
    if (output) next.output = output;
  } else if (event.type === "run.failed") {
    next.status = "failed";
    next.error = String(data.error || "Run failed");
  } else if (event.type === "run.aborted") {
    next.status = "aborted";
  } else if (event.type === "run.interrupted") {
    next.status = "interrupted";
    next.error = String(data.reason || "Runtime interrupted");
  }
  return next;
}

export function useRunProjection(
  runId: string,
  onTerminal?: (state: RunProjectionState) => void,
): RunProjectionState {
  const [state, dispatch] = useReducer(reduce, initialState);
  const onTerminalRef = useRef(onTerminal);

  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);

  useEffect(() => {
    if (!runId) {
      dispatch({ type: "reset", runId: "" });
      return;
    }
    const controller = new AbortController();
    let terminalReceived = false;
    // #region debug-point D:mobile-run-subscription
    try { const probe = (globalThis as any).__zionScheduledSurfaceProbe; if (probe?.url) void fetch(probe.url, { method: "POST", body: JSON.stringify({ sessionId: "scheduled-session-surfaces", runId: probe.phase || "pre-fix", hypothesisId: "D", location: "apps/mobile-client/src/useRunProjection.ts:subscribe", msg: "[DEBUG] Mobile started Run projection subscription", data: { projectedRunId: runId }, ts: Date.now() }) }).catch(() => {}); } catch {}
    // #endregion
    dispatch({ type: "reset", runId });
    void (async () => {
      try {
        for await (const event of subscribeRun(runId, {
          signal: controller.signal,
        })) {
          dispatch({ type: "event", event });
          if (
            ["run.completed", "run.failed", "run.aborted", "run.interrupted"]
              .includes(event.type)
          ) {
            terminalReceived = true;
            // #region debug-point D:mobile-run-terminal
            try { const probe = (globalThis as any).__zionScheduledSurfaceProbe; if (probe?.url) void fetch(probe.url, { method: "POST", body: JSON.stringify({ sessionId: "scheduled-session-surfaces", runId: probe.phase || "pre-fix", hypothesisId: "D", location: "apps/mobile-client/src/useRunProjection.ts:terminal", msg: "[DEBUG] Mobile projection received terminal event", data: { projectedRunId: runId, eventType: event.type, sequence: event.sequence }, ts: Date.now() }) }).catch(() => {}); } catch {}
            // #endregion
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          dispatch({
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      if (!terminalReceived) controller.abort();
    };
  }, [runId]);

  useEffect(() => {
    if (
      runId
      && ["completed", "failed", "aborted", "interrupted"].includes(state.status)
    ) {
      onTerminalRef.current?.(state);
    }
  }, [runId, state.status]);

  return state;
}
