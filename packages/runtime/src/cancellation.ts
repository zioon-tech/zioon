import type { CancellationSignal } from "./protocol.js";

export class RunCancelledError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Run cancelled: ${reason}`);
    this.name = "RunCancelledError";
    this.reason = reason;
  }
}

export class CancellationController {
  private state: {
    listeners: Set<(reason: string) => void>;
    reason?: string;
  } = {
    listeners: new Set()
  };
  readonly signal: CancellationSignal;

  constructor() {
    const state = this.state;
    this.signal = {
      get cancelled() {
        return state.reason !== undefined;
      },
      get reason() {
        return state.reason;
      },
      throwIfCancelled() {
        if (state.reason !== undefined) {
          throw new RunCancelledError(state.reason);
        }
      },
      onCancel(listener) {
        if (state.reason !== undefined) {
          listener(state.reason);
          return { dispose() {} };
        }
        state.listeners.add(listener);
        return {
          dispose() {
            state.listeners.delete(listener);
          }
        };
      }
    };
  }

  cancel(reason = "user"): void {
    if (this.state.reason !== undefined) return;
    this.state.reason = reason;
    for (const listener of Array.from(this.state.listeners)) {
      try {
        listener(reason);
      } catch {
        // Cancellation must reach every listener even if one listener fails.
      }
    }
    this.state.listeners.clear();
  }
}
