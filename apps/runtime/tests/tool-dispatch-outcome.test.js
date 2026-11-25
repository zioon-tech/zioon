import { describe, expect, it } from "vitest";
import { ToolInvocationLifecycle } from "../src/tool-invocation-lifecycle.mjs";
import { CancellationController } from "../../../packages/runtime/dist/index.js";

describe("tool dispatch outcome evidence", () => {
  it("returns a durable known failure when an unsafe tool was never dispatched", async () => {
    const lifecycle = new ToolInvocationLifecycle(), parent = new CancellationController();
    const result = await lifecycle.execute({
      invocation: { invocationId: "new", toolCall: { name: "Bash", arguments: { command: "mutate" } } },
      signal: parent.signal, execution: { effect: "process" },
      invoke: async () => { throw Object.assign(new Error("Sandbox recovering"), {
        code: "sandbox_recovery_pending", outcomeKnown: true, toolDispatchState: "not_sent", retryable: true
      }); },
      failureCodeFromError: () => "network_error"
    });
    expect(result).toMatchObject({ ok: false, failureCode: "sandbox_recovery_pending",
      toolDispatchState: "not_sent", retryable: true });
  });
  it("keeps an uncertain transport failure unknown for an unsafe command", async () => {
    const result = await new ToolInvocationLifecycle().execute({
      invocation: { invocationId: "old", toolCall: { name: "Bash", arguments: {} } },
      signal: new CancellationController().signal, execution: { effect: "process" },
      invoke: async () => { throw new Error("connection lost after dispatch"); },
      failureCodeFromError: () => "network_error"
    });
    expect(result).toMatchObject({ failureCode: "execution_outcome_unknown", retryable: false });
    expect(result.toolDispatchState).toBeUndefined();
  });
});
