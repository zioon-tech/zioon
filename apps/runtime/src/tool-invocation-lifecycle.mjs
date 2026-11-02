import { clearTimeout, setTimeout } from "node:timers";
import {
  normalizeToolExecution,
  resolveToolExecutionTimeoutMs
} from "../../../packages/plugin-sdk/src/tool-execution.mjs";

const TRANSIENT_FAILURE_CODES = new Set([
  "dns_error",
  "http_5xx",
  "network_error",
  "rate_limit",
  "timeout"
]);

class InvocationCancellationController {
  constructor() {
    const listeners = new Set();
    let reason;
    this.signal = {
      get cancelled() {
        return reason !== undefined;
      },
      get reason() {
        return reason;
      },
      throwIfCancelled() {
        if (reason !== undefined) {
          throw new Error(`Tool invocation cancelled: ${reason}`);
        }
      },
      onCancel(listener) {
        if (reason !== undefined) {
          listener(reason);
          return { dispose() {} };
        }
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    };
    this.cancel = (nextReason = "cancelled") => {
      if (reason !== undefined) return;
      reason = String(nextReason);
      for (const listener of [...listeners]) {
        try {
          listener(reason);
        } catch {
          // Cancellation must reach every host listener.
        }
      }
      listeners.clear();
    };
  }
}

function defaultScheduleTimeout(callback, timeoutMs) {
  const timer = setTimeout(callback, timeoutMs);
  return { dispose: () => clearTimeout(timer) };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

export function unknownToolOutcomeResult(invocation, reason = "cancelled") {
  const toolName = String(invocation?.toolCall?.name || "tool");
  const invocationId = String(invocation?.invocationId || "unknown");
  const message = [
    `${toolName} execution outcome is unknown: ${invocationId}.`,
    `The invocation was interrupted (${reason}) after execution started.`,
    "It may still be running or may already have completed.",
    "Inspect or reconcile its effects before issuing a new operation."
  ].join(" ");
  return {
    ok: false,
    content: message,
    error: message,
    failureCode: "execution_outcome_unknown",
    retryable: false
  };
}

function timeoutResult(invocation, timeoutMs) {
  const toolName = String(invocation?.toolCall?.name || "tool");
  const message = `${toolName} timed out after ${timeoutMs}ms`;
  return {
    ok: false,
    content: message,
    error: message,
    failureCode: "timeout",
    retryable: true
  };
}

export function applyToolRetryClassification(result, execution) {
  if (result?.ok !== false || Object.hasOwn(result, "retryable")) return result;
  const failureCode = String(result.failureCode || "");
  if (failureCode === "execution_outcome_unknown") {
    return {
      ...result,
      retryable: execution.idempotency === "safe"
    };
  }
  if (
    execution.idempotency === "safe"
    && TRANSIENT_FAILURE_CODES.has(failureCode)
  ) {
    return { ...result, retryable: true };
  }
  return result;
}

export class ToolInvocationLifecycle {
  constructor({
    scheduleTimeout = defaultScheduleTimeout,
    timeoutGraceMs = 30_000
  } = {}) {
    if (
      !Number.isSafeInteger(timeoutGraceMs)
      || timeoutGraceMs < 0
    ) {
      throw new Error("Tool timeout grace must be a non-negative integer");
    }
    this.scheduleTimeout = scheduleTimeout;
    this.timeoutGraceMs = timeoutGraceMs;
  }

  async execute({
    invocation,
    signal,
    execution: input,
    invoke,
    failureCodeFromError = () => "tool_error"
  }) {
    const execution = normalizeToolExecution(input);
    signal.throwIfCancelled();

    const controller = new InvocationCancellationController();
    let cancellationSource = "";
    const parentCancellation = signal.onCancel((reason) => {
      cancellationSource = "parent";
      controller.cancel(reason);
    });
    const executionTimeoutMs = resolveToolExecutionTimeoutMs(
      execution,
      invocation.toolCall?.arguments || {}
    );
    const deadlineMs = Math.min(
      2_147_000_000,
      executionTimeoutMs + this.timeoutGraceMs
    );
    const deadline = this.scheduleTimeout(() => {
      cancellationSource = "timeout";
      controller.cancel("tool-timeout");
    }, deadlineMs);

    let cancellationListener;
    const cancellation = new Promise((resolve) => {
      cancellationListener = controller.signal.onCancel((reason) => {
        resolve({
          type: "cancelled",
          reason,
          source: cancellationSource || "host"
        });
      });
    });
    const operation = Promise.resolve()
      .then(() => invoke(controller.signal))
      .then(
        (value) => ({ type: "result", value }),
        (error) => ({ type: "error", error })
      );

    try {
      const outcome = await Promise.race([operation, cancellation]);
      if (outcome.type === "cancelled") {
        if (execution.idempotency !== "safe") {
          return unknownToolOutcomeResult(invocation, outcome.reason);
        }
        if (outcome.source === "timeout") {
          return timeoutResult(invocation, executionTimeoutMs);
        }
        signal.throwIfCancelled();
        throw new Error(`Tool invocation cancelled: ${outcome.reason}`);
      }
      if (outcome.type === "error") {
        if (signal.cancelled) {
          if (execution.idempotency !== "safe") {
            return unknownToolOutcomeResult(invocation, signal.reason);
          }
          signal.throwIfCancelled();
        }
        const failureCode = failureCodeFromError(outcome.error);
        if (
          execution.idempotency !== "safe"
          && TRANSIENT_FAILURE_CODES.has(failureCode)
        ) {
          return unknownToolOutcomeResult(
            invocation,
            errorMessage(outcome.error)
          );
        }
        throw outcome.error;
      }
      return applyToolRetryClassification(outcome.value, execution);
    } finally {
      deadline.dispose();
      parentCancellation.dispose();
      cancellationListener?.dispose();
    }
  }
}
