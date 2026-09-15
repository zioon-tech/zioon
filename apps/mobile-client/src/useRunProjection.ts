import { useEffect, useReducer, useRef } from "react";
import { subscribeRun } from "./api";
import { initialRunProjection, reduceRunProjection, type ProjectionAction, type RunProjectionState } from "./run-projection";
export type { RunProjectionState } from "./run-projection";

function reduce(state: RunProjectionState, action: ProjectionAction): RunProjectionState {
  const next = reduceRunProjection(state, action);
  // #region debug-point A:mobile-turn-order
  try { const probe = (globalThis as typeof globalThis & { __mobileTurnOrderProbe?: { url: string; phase: string } }).__mobileTurnOrderProbe; if (probe && action.type === "event") void fetch(probe.url, { method: "POST", body: JSON.stringify({ sessionId: "mobile-turn-order", runId: probe.phase, hypothesisId: "A", location: "useRunProjection:reduce", msg: "[DEBUG] Projection event", data: { type: action.event.type, turn: next.turn, blocks: next.blocks.map((block) => ({ kind: block.kind, id: block.id })) }, ts: Date.now() }) }).catch(() => {}); } catch {}
  // #endregion
  return next;
}

export function useRunProjection(
  runId: string,
  onTerminal?: (state: RunProjectionState) => void,
): RunProjectionState {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialRunProjection(runId));
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
    // #region debug-point D:mobile-run-subscription
    try { const probe = (globalThis as any).__zionScheduledSurfaceProbe; if (probe?.url) void fetch(probe.url, { method: "POST", body: JSON.stringify({ sessionId: "scheduled-session-surfaces", runId: probe.phase || "pre-fix", hypothesisId: "D", location: "apps/mobile-client/src/useRunProjection.ts:subscribe", msg: "[DEBUG] Mobile started Run projection subscription", data: { projectedRunId: runId }, ts: Date.now() }) }).catch(() => {}); } catch {}
    // #endregion
    dispatch({ type: "reset", runId });
    void (async () => {
      try {
        for await (const event of subscribeRun(runId, {
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          dispatch({ type: "event", event });
          if (
            ["run.completed", "run.failed", "run.aborted", "run.interrupted"]
              .includes(event.type)
          ) {
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
      controller.abort();
    };
  }, [runId]);

  useEffect(() => {
    if (
      runId
      && state.runId === runId
      && ["completed", "failed", "aborted", "interrupted"].includes(state.status)
    ) {
      onTerminalRef.current?.(state);
    }
  }, [runId, state.status]);

  return state.runId === runId ? state : initialRunProjection(runId);
}
