import { describe, expect, it, vi } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { terminalReference } from "../../../packages/node-protocol/src/resource-references.mjs";
import { createPlatformNodePolicy } from "../src/accounts/platform-node-policy.mjs";
import { NodeBroker } from "../src/node-broker.mjs";
import { createTerminalManagementService } from "../src/terminal-management-service.mjs";
import { ManagedNodeToolRouter } from "../src/sandbox/managed-node-router.mjs";
import { createRuntimeServer } from "../src/server.mjs";

function fixture() {
  const accounts = {
    validateGrant: vi.fn(async (principal) => {
      if (principal.userId !== "operator") throw new Error("invalid grant");
      return { principal: { ...principal, kind: "service" } };
    })
  };
  const policy = createPlatformNodePolicy({
    nodeIds: ["node:cloud-runtime"],
    serviceGrantIds: ["grant:existing-job"],
    accounts
  });
  const broker = new NodeBroker({ authorizeTarget: policy });
  broker.registerNode({
    protocolVersion: 1,
    nodeId: "node:cloud-runtime",
    instanceId: "instance:ecs",
    capabilities: [{ name: "read" }, { name: "zion.internal.deviceService" }],
    resources: [{ resourceId: "workspace:ecs", kind: "workspace", projectId: "platform" }]
  });
  const input = {
    invocationId: "invocation:denied",
    runId: "run:user",
    attemptId: "attempt:user",
    target: { nodeId: "node:cloud-runtime" },
    principal: { version: 1, grantId: "grant:user", userId: "operator", kind: "user" },
    policy: { allowedTools: ["read"] },
    toolCall: { id: "call:read", name: "read", arguments: { path: "/etc/passwd" } }
  };
  return { accounts, policy, broker, input };
}

describe("Platform Node execution boundary", () => {
  it.each(["target", "argument", "terminal", "project", "sole-node"])(
    "rejects user execution through %s selection before dispatch",
    async (selection) => {
      const { broker, input } = fixture();
      if (selection !== "target") delete input.target;
      if (selection === "argument") input.toolCall.arguments.node_id = "node:cloud-runtime";
      if (selection === "terminal") input.toolCall.arguments.session_id = terminalReference({
        nodeId: "node:cloud-runtime", instanceId: "instance:ecs",
        resourceId: "workspace:ecs", sessionId: "terminal:ecs"
      });
      if (selection === "project") input.projectId = "platform";
      try {
        await expect(broker.invoke(input, new CancellationController().signal))
          .rejects.toMatchObject({ statusCode: 403, code: "platform_node_execution_denied" });
        expect(broker.pending.size).toBe(0);
        expect(await broker.nextCommand("node:cloud-runtime", "instance:ecs")).toBeNull();
      } finally { broker.close(); }
    }
  );

  it("does not trust a spoofed service principal or scheduler source", async () => {
    const { broker, input, accounts } = fixture();
    input.principal.kind = "service";
    input.metadata = { source: "scheduler-worker" };
    try {
      await expect(broker.invoke(input, new CancellationController().signal))
        .rejects.toMatchObject({ code: "platform_node_execution_denied" });
      expect(accounts.validateGrant).not.toHaveBeenCalled();
    } finally { broker.close(); }
  });

  it("retains only an explicitly configured, authenticated operator job grant", async () => {
    const { broker, input, accounts } = fixture();
    input.principal.grantId = "grant:existing-job";
    try {
      const completion = broker.invoke(input, new CancellationController().signal);
      await vi.waitFor(() => expect(broker.pending.size).toBe(1));
      const command = await broker.nextCommand("node:cloud-runtime", "instance:ecs");
      expect(command.invocation.invocationId).toBe(input.invocationId);
      broker.completeInvocation("node:cloud-runtime", "instance:ecs", input.invocationId, { ok: true, content: "operator" });
      await expect(completion).resolves.toMatchObject({ ok: true });
      expect(accounts.validateGrant).toHaveBeenCalledWith(input.principal);
    } finally { broker.close(); }
  });

  it("hides the platform Node from user tools and terminal inventory", async () => {
    const { broker, input } = fixture();
    try {
      expect(await broker.listTools({ ...input, target: undefined })).toEqual([]);
      const service = createTerminalManagementService({ nodeBroker: broker });
      const inventory = await service.listInventory({ runContext: { principal: input.principal } });
      expect(inventory.nodes).toEqual([]);
      expect(inventory.machines).toEqual([]);
      expect(broker.pending.size).toBe(0);
    } finally { broker.close(); }
  });

  it("requires a principal for an internal device-service relay to the platform", async () => {
    const { broker, input } = fixture();
    delete input.principal;
    input.policy.allowedTools = ["zion.internal.deviceService"];
    input.toolCall = {
      id: "relay", name: "zion.internal.deviceService",
      arguments: { service: "local-tools", method: "GET", path: "/files/read?path=/etc/passwd" }
    };
    try {
      await expect(broker.invoke(input, new CancellationController().signal))
        .rejects.toMatchObject({ code: "platform_node_execution_denied" });
    } finally { broker.close(); }
  });

  it("allows an authorized Device Node without applying the platform restriction", async () => {
    const { policy, accounts } = fixture();
    await expect(policy({}, { node: { registration: { nodeId: "node:personal" } } })).resolves.toBeUndefined();
    expect(accounts.validateGrant).not.toHaveBeenCalled();
  });

  it("never falls back from an unprovisioned account to a project or sole Device", async () => {
    const device = { invoke: vi.fn(), supportedToolNames: ["read"] };
    const router = new ManagedNodeToolRouter({
      sandbox: { invoke: vi.fn(), bindingForAccount: () => null, supportedToolNames: ["read"] },
      device
    });
    const input = {
      projectId: "platform", principal: { userId: "unprovisioned" },
      toolCall: { name: "read", arguments: { path: "/etc/passwd" } }
    };
    await expect(router.invoke(input, new CancellationController().signal))
      .rejects.toMatchObject({ code: "sandbox_account_unbound" });
    expect(device.invoke).not.toHaveBeenCalled();
    await router.invoke({ ...input, target: { nodeId: "node:personal" } }, new CancellationController().signal);
    expect(device.invoke).toHaveBeenCalledOnce();
  });

  it("prevents a user from adopting a privileged scheduled grant by resuming its Run", async () => {
    const actor = { kind: "account", user: { id: "operator" } };
    const run = { id: "run:scheduled", principal: { kind: "service", grantId: "grant:existing-job" } };
    const resume = vi.fn();
    const store = {
      get: async () => run, getEvents: async () => [],
      listSessions: vi.fn(),
      createSession: vi.fn(), forkSession: vi.fn(), getSession: vi.fn(),
      getSessionMessages: vi.fn(), getSessionTranscript: vi.fn(), appendSessionMessages: vi.fn()
    };
    const server = createRuntimeServer({
      executor: { execute: vi.fn(), resume }, runs: store,
      accessControl: {
        mode: "accounts-v1",
        authorizeRuntimeRequest: async () => actor,
        authorizeExistingRun: vi.fn()
      }
    });
    const { url } = await server.start();
    try {
      const response = await fetch(`${url}/v1/runs/${encodeURIComponent(run.id)}/resume`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}"
      });
      expect(response.status).toBe(403);
      expect(resume).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});
