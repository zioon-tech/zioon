import { describe, expect, it } from "vitest";
import { NodeBroker } from "../src/node-broker.mjs";
import { CancellationController } from "../../../packages/runtime/src/index";
import { terminalReference } from "../../../packages/node-protocol/src/resource-references.mjs";

const registration = (instanceId) => ({
  protocolVersion: 1,
  nodeId: "node:churn",
  instanceId,
  capabilities: [{ name: "Bash", version: "1", hostKind: "local-tools", execution: { effect: "process" } }],
  resources: [{ resourceId: "workspace:churn", projectId: "churn", kind: "workspace", localRoot: "/tmp" }]
});

describe("terminal invocation instance replacement", () => {
  it.each(["queued", "delivered"])("classifies a %s invocation and prevents redispatch of its ID", async (state) => {
    const saved = new Map();
    const broker = new NodeBroker({
      scheduleTimeout: () => ({ dispose() {} }),
      stateStore: {
        saveReceipt: async (receipt) => { saved.set(receipt.invocationId, receipt); return receipt; },
        getReceipt: async (id) => saved.get(id)
      }
    });
    await broker.registerNode(registration("one"));
    const ref = terminalReference({ nodeId: "node:churn", instanceId: "one", resourceId: "workspace:churn", sessionId: "terminal" });
    const input = {
      invocationId: "churn:one", projectId: "churn",
      policy: { allowedTools: ["Bash"], allowedTerminalSessionIds: [ref] },
      toolCall: { id: "call", name: "Bash", arguments: { command: "echo ok", session_id: ref } }
    };
    try {
      const completion = broker.invoke(input, new CancellationController().signal);
      const failureCode = state === "delivered" ? "execution_outcome_unknown" : "stale_terminal_reference";
      const rejected = expect(completion).rejects.toMatchObject({ statusCode: 409, failureCode, retryable: false });
      await Promise.resolve();
      await Promise.resolve();
      expect(broker.snapshot().pendingInvocations).toBe(1);
      if (state === "delivered") await broker.nextCommand("node:churn", "one");
      await broker.registerNode(registration("two"));
      await rejected;
      expect(saved.get(input.invocationId).result).toMatchObject({ ok: false, failureCode, retryable: false });
      expect(await broker.nextCommand("node:churn", "two")).toBeNull();
      const result = await broker.invoke(input, new CancellationController().signal);
      expect(result.failureCode).toBe(failureCode);
      expect(await broker.nextCommand("node:churn", "two")).toBeNull();
    } finally {
      broker.close();
    }
  });
});
