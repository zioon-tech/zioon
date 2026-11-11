import { useEffect, useReducer, useRef } from "react";
import { subscribeRun } from "./api";
import { initialRunProjection, reduceRunProjection, type ProjectionAction, type RunProjectionState } from "./run-projection";
export type { RunProjectionState } from "./run-projection";

function reduce(state: RunProjectionState, action: ProjectionAction): RunProjectionState {
  const next = reduceRunProjection(state, action);
  return next;
}

export function useRunProjection(
  runId: string,
  onTerminal?: (state: RunProjectionState) => void,
  observationKey = 0,
): RunProjectionState {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialRunProjection(runId));
  const stateRef = useRef(state);
  stateRef.current = state;
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
    if (stateRef.current.runId !== runId) {
      stateRef.current = initialRunProjection(runId);
      dispatch({ type: "reset", runId });
    }
    void (async () => {
      try {
        for await (const event of subscribeRun(runId, {
          signal: controller.signal,
          afterSequence: stateRef.current.cursor,
        })) {
          if (controller.signal.aborted) break;
          stateRef.current = reduceRunProjection(stateRef.current, { type: "event", event });
          dispatch({ type: "event", event });
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
  }, [runId, observationKey]);

  useEffect(() => {
    if (
      runId
      && state.runId === runId
      && ["completed", "failed", "aborted", "interrupted", "waiting"].includes(state.status)
    ) {
      onTerminalRef.current?.(state);
    }
  }, [runId, state.status]);

  return state.runId === runId ? state : initialRunProjection(runId);
}
