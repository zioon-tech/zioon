import { describe, expect, it } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { NodeBroker } from "../src/node-broker.mjs";

function registration(overrides = {}) {
  return {
    protocolVersion: 1,
    nodeId: "node:macbook",
    instanceId: "instance:one",
    label: "MacBook",
    platform: "darwin",
    capabilities: [{
      name: "read",
      version: "1",
      risk: "read",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"],
        additionalProperties: false
      },
      hostKind: "local-tools"
    }],
    resources: [{
      resourceId: "workspace:zion-next",
      kind: "workspace",
      projectId: "zion-next",
      label: "Zion Next",
      localRoot: "/private/project"
    }],
    ...overrides
  };
}

function invocation(overrides = {}) {
  return {
    invocationId: "invocation:one",
    runId: "run:one",
    attemptId: "attempt:one",
    projectId: "zion-next",
    policy: {
      allowedTools: ["read"],
      fileRoots: ["/workspace/zion-next"],
      allowedTerminalSessionIds: ["terminal:one"]
    },
    toolCall: {
      id: "call:one",
      name: "read",
      arguments: {
        path: "/workspace/zion-next/README.md",
        session_id: "terminal:one"
      }
    },
    ...overrides
  };
}

describe("NodeBroker", () => {
  it("registers capabilities without exposing local-only resource fields", async () => {
    const broker = new NodeBroker();

    const node = broker.registerNode(registration());
    const tools = await broker.listTools({
      projectId: "zion-next",
      policy: {
        allowedTools: ["read", "write"],
        fileRoots: ["/workspace/zion-next"],
        allowedTerminalSessionIds: ["terminal:one"]
      }
    });

    expect(node).toMatchObject({
      nodeId: "node:macbook",
      status: "online",
      capabilities: [{
        name: "read",
        risk: "read"
      }],
      resources: [{
        resourceId: "workspace:zion-next",
        projectId: "zion-next"
      }]
    });
    expect(node.resources[0]).not.toHaveProperty("localRoot");
    expect(broker.supportedToolNames).toEqual(["read"]);
    expect(broker.getToolDefinitions()).toEqual([
      expect.objectContaining({
        name: "read",
        risk: "read",
        hostKinds: ["local-tools"],
        inputSchema: expect.objectContaining({
          required: ["path"]
        })
      })
    ]);
    expect(tools).toEqual([
      expect.objectContaining({
        name: "read",
        description:
          "Read a file\n"
          + "Allowed absolute file roots for this Run: /workspace/zion-next\n"
          + "Allowed session_id values for this Run: terminal:one",
        hostKinds: ["local-tools"]
      })
    ]);
  });

  it("aggregates authorized capabilities across matching online Nodes", async () => {
    const broker = new NodeBroker();
    broker.registerNode(registration());
    broker.registerNode(registration({
      nodeId: "node:server",
      instanceId: "instance:server",
      capabilities: [{
        name: "grep",
        version: "1",
        risk: "read",
        description: "Search files",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" }
          },
          required: ["pattern"],
          additionalProperties: false
        },
        hostKind: "local-tools"
      }],
      resources: [{
        resourceId: "workspace:server-zion-next",
        kind: "workspace",
        projectId: "zion-next"
      }]
    }));

    const tools = await broker.listTools({
      projectId: "zion-next",
      policy: { allowedTools: ["read", "grep"] }
    });

    expect(tools.map((tool) => tool.name).sort()).toEqual(["grep", "read"]);
  });

  it("routes an invocation to its project Node and accepts one result", async () => {
    let leaseDisposed = false;
    const broker = new NodeBroker({
      scheduleTimeout() {
        return {
          dispose() {
            leaseDisposed = true;
          }
        };
      }
    });
    broker.registerNode(registration());
    const cancellation = new CancellationController();

    const completion = broker.invoke(invocation(), cancellation.signal);
    const command = await broker.nextCommand(
      "node:macbook",
      "instance:one"
    );

    expect(command).toMatchObject({
      schemaVersion: 1,
      type: "tool.invoke",
      invocationId: "invocation:one",
      resourceId: "workspace:zion-next",
      invocation: {
        runId: "run:one",
        projectId: "zion-next"
      }
    });
    expect(broker.completeInvocation(
      "node:macbook",
      "instance:one",
      "invocation:one",
      { ok: true, content: "remote result" }
    )).toMatchObject({
      accepted: true,
      duplicate: false
    });
    await expect(completion).resolves.toEqual({
      ok: true,
      content: "remote result"
    });
    expect(leaseDisposed).toBe(true);
    expect(broker.completeInvocation(
      "node:macbook",
      "instance:one",
      "invocation:one",
      { ok: true, content: "ignored duplicate" }
    )).toMatchObject({
      accepted: true,
      duplicate: true,
      result: {
        ok: true,
        content: "remote result"
      }
    });
  });

  it("does not queue an invocation when its signal is already cancelled", async () => {
    const broker = new NodeBroker();
    broker.registerNode(registration());
    const cancellation = new CancellationController();
    cancellation.cancel("user");

    const completion = broker.invoke(invocation(), cancellation.signal);
    const rejected = expect(completion).rejects.toThrow("Run cancelled: user");

    expect(broker.snapshot().pendingInvocations).toBe(0);
    await rejected;
    await expect(broker.nextCommand(
      "node:macbook",
      "instance:one"
    )).resolves.toBeNull();
  });

  it("expires a queued invocation when its lease elapses", async () => {
    let expire;
    let leaseDisposed = false;
    const broker = new NodeBroker({
      now: () => 1_000,
      invocationLeaseMs: 100,
      scheduleTimeout(callback, timeoutMs) {
        expect(timeoutMs).toBe(100);
        expire = callback;
        return {
          dispose() {
            leaseDisposed = true;
          }
        };
      }
    });
    broker.registerNode(registration());
    const completion = broker.invoke(
      invocation(),
      new CancellationController().signal
    );
    const observed = completion.catch((error) => error);

    try {
      expect(broker.snapshot().pendingInvocations).toBe(1);
      expire();

      await expect(observed).resolves.toMatchObject({
        message: "Tool invocation lease expired: invocation:one"
      });
      expect(broker.snapshot().pendingInvocations).toBe(0);
      expect(leaseDisposed).toBe(true);
      await expect(broker.nextCommand(
        "node:macbook",
        "instance:one"
      )).resolves.toBeNull();
      expect(() => broker.completeInvocation(
        "node:macbook",
        "instance:one",
        "invocation:one",
        { ok: true, content: "late result" }
      )).toThrow("Invocation not found");
    } finally {
      broker.close();
    }
  });

  it("cancels Device work when a delivered invocation lease expires", async () => {
    let expire;
    const broker = new NodeBroker({
      now: () => 1_000,
      invocationLeaseMs: 100,
      scheduleTimeout(callback) {
        expire = callback;
        return { dispose() {} };
      }
    });
    broker.registerNode(registration());
    const completion = broker.invoke(
      invocation(),
      new CancellationController().signal
    );
    const observed = completion.catch((error) => error);

    try {
      await expect(broker.nextCommand(
        "node:macbook",
        "instance:one"
      )).resolves.toMatchObject({
        type: "tool.invoke",
        invocationId: "invocation:one",
        leaseExpiresAt: 1_100
      });

      expire();

      await expect(observed).resolves.toMatchObject({
        message: "Tool invocation lease expired: invocation:one"
      });
      await expect(broker.nextCommand(
        "node:macbook",
        "instance:one"
      )).resolves.toEqual({
        schemaVersion: 1,
        type: "tool.cancel",
        invocationId: "invocation:one",
        reason: "invocation-lease-expired"
      });
    } finally {
      broker.close();
    }
  });

  it("redelivers an unfinished invocation after a new Node instance registers", async () => {
    const broker = new NodeBroker();
    broker.registerNode(registration());
    const completion = broker.invoke(
      invocation(),
      new CancellationController().signal
    );

    await expect(broker.nextCommand(
      "node:macbook",
      "instance:one"
    )).resolves.toMatchObject({
      type: "tool.invoke",
      invocationId: "invocation:one"
    });

    broker.registerNode(registration({ instanceId: "instance:two" }));
    await expect(broker.nextCommand(
      "node:macbook",
      "instance:two"
    )).resolves.toMatchObject({
      type: "tool.invoke",
      invocationId: "invocation:one"
    });
    broker.completeInvocation(
      "node:macbook",
      "instance:two",
      "invocation:one",
      { ok: true, content: "after reconnect" }
    );

    await expect(completion).resolves.toMatchObject({
      content: "after reconnect"
    });
  });

  it("routes cancellation to a Node that already accepted the invocation", async () => {
    const broker = new NodeBroker();
    broker.registerNode(registration());
    const cancellation = new CancellationController();
    const completion = broker.invoke(invocation(), cancellation.signal);

    await broker.nextCommand("node:macbook", "instance:one");
    const rejected = expect(completion).rejects.toThrow(
      "Tool invocation cancelled: user"
    );
    cancellation.cancel("user");

    await expect(broker.nextCommand(
      "node:macbook",
      "instance:one"
    )).resolves.toEqual({
      schemaVersion: 1,
      type: "tool.cancel",
      invocationId: "invocation:one",
      reason: "user"
    });
    await rejected;
  });

  it("does not advertise offline or unauthorized capabilities", async () => {
    let time = 1_000;
    const broker = new NodeBroker({
      now: () => time,
      offlineAfterMs: 100
    });
    broker.registerNode(registration());

    await expect(broker.listTools({
      projectId: "zion-next",
      policy: { allowedTools: [] }
    })).resolves.toEqual([]);

    time += 101;
    expect(broker.supportedToolNames).toEqual([]);
    await expect(broker.listTools({
      projectId: "zion-next",
      policy: { allowedTools: ["read"] }
    })).resolves.toEqual([]);
  });
});
