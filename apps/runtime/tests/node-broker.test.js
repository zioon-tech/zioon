import { describe, expect, it } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { NodeBroker } from "../src/node-broker.mjs";
import {
  terminalReference
} from "../../../packages/node-protocol/src/resource-references.mjs";

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
  function setupNodes() {
    const broker = new NodeBroker({ scheduleTimeout: () => ({ dispose() {} }) });
    broker.registerNode(registration());
    broker.registerNode(registration({
      nodeId: "node:server",
      instanceId: "instance:server"
    }));
    const ref = terminalReference({
      nodeId: "node:server",
      instanceId: "instance:server",
      resourceId: "workspace:zion-next",
      sessionId: "terminal:one"
    });
    return { broker, ref };
  }

  it("routes a global session ID to its Node and translates only its policy", async () => {
    const { broker, ref } = setupNodes();
    const input = invocation({
      policy: { allowedTools: ["read"], allowedTerminalSessionIds: [ref] },
      toolCall: { id: "call:one", name: "read", arguments: { path: "/a", session_id: ref } }
    });
    const completion = broker.invoke(input, new CancellationController().signal);
    const command = await broker.nextCommand("node:server", "instance:server");
    expect(command.invocation.toolCall.arguments.session_id).toBe("terminal:one");
    expect(command.invocation.policy.allowedTerminalSessionIds).toEqual(["terminal:one"]);
    expect(input.toolCall.arguments.session_id).toBe(ref);
    expect(await broker.nextCommand("node:macbook", "instance:one")).toBeNull();
    broker.completeInvocation("node:server", "instance:server", input.invocationId, { ok: true, content: "server" });
    await expect(completion).resolves.toMatchObject({ content: "server" });
    broker.close();
  });

  it("uses the sole allowed global session when the tool omits a target", async () => {
    const { broker, ref } = setupNodes();
    const input = invocation({
      policy: { allowedTools: ["read"], allowedTerminalSessionIds: [ref] },
      toolCall: {
        id: "call:one",
        name: "read",
        arguments: { path: "/a" }
      }
    });

    const completion = broker.invoke(
      input,
      new CancellationController().signal
    );
    const command = await broker.nextCommand(
      "node:server",
      "instance:server"
    );

    expect(command.invocation.toolCall.arguments.session_id).toBe(
      "terminal:one"
    );
    expect(command.invocation.policy.allowedTerminalSessionIds).toEqual([
      "terminal:one"
    ]);
    await expect(
      broker.nextCommand("node:macbook", "instance:one")
    ).resolves.toBeNull();
    broker.completeInvocation(
      "node:server",
      "instance:server",
      input.invocationId,
      { ok: true, content: "server" }
    );
    await expect(completion).resolves.toMatchObject({ content: "server" });
    broker.close();
  });

  it("routes by Node without requiring a resource or terminal id", async () => {
    const { broker } = setupNodes();
    const input = invocation({
      target: { nodeId: "node:server" },
      policy: { allowedTools: ["read"], allowedTerminalSessionIds: [] },
      toolCall: {
        id: "call:one",
        name: "read",
        arguments: { path: "/a" }
      }
    });

    const completion = broker.invoke(
      input,
      new CancellationController().signal
    );
    const command = await broker.nextCommand(
      "node:server",
      "instance:server"
    );

    expect(command.resourceId).toBe("workspace:zion-next");
    expect(command.invocation.toolCall.arguments).toEqual({ path: "/a" });
    await expect(
      broker.nextCommand("node:macbook", "instance:one")
    ).resolves.toBeNull();
    broker.completeInvocation(
      "node:server",
      "instance:server",
      input.invocationId,
      { ok: true, content: "server" }
    );
    await expect(completion).resolves.toMatchObject({ content: "server" });
    broker.close();
  });

  it("does not fail over an offline or stale reference", async () => {
    const { broker, ref } = setupNodes();
    const input = invocation({
      policy: { allowedTools: ["read"] },
      toolCall: { name: "read", arguments: { session_id: ref } }
    });
    broker.disconnectNode("node:server", "instance:server");
    await expect(broker.invoke(input, new CancellationController().signal)).rejects.toThrow("offline");
    broker.registerNode(registration({ nodeId: "node:server", instanceId: "instance:new" }));
    await expect(broker.invoke(input, new CancellationController().signal)).rejects.toThrow("Stale");
    expect(broker.snapshot().pendingInvocations).toBe(0);
    broker.close();
  });

  it("keeps offline registrations in legacy ambiguity checks", async () => {
    const { broker } = setupNodes();
    broker.disconnectNode("node:server", "instance:server");
    await expect(broker.invoke(invocation(), new CancellationController().signal)).rejects.toThrow("Ambiguous");
    broker.close();
  });

  it("rejects a reference outside the Run terminal policy", async () => {
    const { broker, ref } = setupNodes();
    const other = terminalReference({
      nodeId: "node:macbook", instanceId: "instance:one",
      resourceId: "workspace:zion-next", sessionId: "terminal:one"
    });
    await expect(broker.invoke(invocation({
      policy: { allowedTools: ["read"], allowedTerminalSessionIds: [other] },
      toolCall: { name: "read", arguments: { session_id: ref } }
    }), new CancellationController().signal)).rejects.toThrow("outside");
    expect(broker.snapshot().pendingInvocations).toBe(0);
    broker.close();
  });

  it("rejects conflicting resource constraints before dispatch", async () => {
    const { broker, ref } = setupNodes();
    broker.registerNode(registration({
      nodeId: "node:server", instanceId: "instance:server",
      resources: [...registration().resources, { resourceId: "workspace:other", kind: "workspace", projectId: "zion-next" }]
    }));
    const outcome = broker.invoke(invocation({
      target: { nodeId: "node:server", resourceId: "workspace:other" },
      policy: { allowedTools: ["read"] },
      toolCall: { name: "read", arguments: { session_id: ref } }
    }), new CancellationController().signal).catch((error) => error);
    const pending = broker.snapshot().pendingInvocations;
    broker.close();
    expect(pending).toBe(0);
    expect((await outcome).message).toMatch(/conflict/i);
  });

  it("does not infer native session ownership from capability availability", async () => {
    const { broker } = setupNodes();
    broker.registerNode(registration({
      nodeId: "node:server", instanceId: "instance:server",
      capabilities: [{ name: "Bash" }]
    }));
    const outcome = broker.invoke(invocation({
      policy: { allowedTools: ["read"] }
    }), new CancellationController().signal).catch((error) => error);
    const pending = broker.snapshot().pendingInvocations;
    broker.close();
    expect(pending).toBe(0);
    expect((await outcome).message).toMatch(/ambiguous/i);
  });

  it("never redelivers a reference-bound operation to a replacement instance", async () => {
    const { broker, ref } = setupNodes();
    const outcome = broker.invoke(invocation({
      policy: { allowedTools: ["read"] },
      toolCall: { name: "read", arguments: { session_id: ref } }
    }), new CancellationController().signal).catch((error) => error);
    await broker.nextCommand("node:server", "instance:server");
    broker.registerNode(registration({ nodeId: "node:server", instanceId: "instance:new" }));
    expect((await outcome).message).toContain("may have executed");
    expect(await broker.nextCommand("node:server", "instance:new")).toBeNull();
    broker.close();
  });

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

  it("keeps internal Device service capabilities out of the model catalog", () => {
    const broker = new NodeBroker();
    broker.registerNode(registration({
      capabilities: [
        ...registration().capabilities,
        {
          name: "zion.internal.deviceService",
          version: "1",
          risk: "execute",
          description: "Internal service relay",
          inputSchema: { type: "object" },
          hostKind: "device-service"
        }
      ]
    }));

    expect(broker.supportedToolNames).toEqual(["read"]);
    expect(broker.getToolDefinitions().map((tool) => tool.name)).toEqual([
      "read"
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

  it("limits advertised tools to the selected Node", async () => {
    const broker = new NodeBroker();
    broker.registerNode(registration());
    broker.registerNode(registration({
      nodeId: "node:server",
      instanceId: "instance:server",
      capabilities: [{
        name: "grep",
        version: "1",
        risk: "read",
        inputSchema: { type: "object" },
        hostKind: "local-tools"
      }]
    }));

    await expect(broker.listTools({
      target: { nodeId: "node:server" },
      policy: { allowedTools: ["read", "grep"] }
    })).resolves.toEqual([
      expect.objectContaining({ name: "grep" })
    ]);
    await expect(broker.listTools({
      target: { nodeId: "node:missing" },
      policy: { allowedTools: ["read"] }
    })).rejects.toThrow("not registered");
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
        message: "Tool invocation lease expired before Device execution: invocation:one"
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

      await expect(completion).resolves.toMatchObject({
        ok: false,
        failureCode: "timeout",
        retryable: true,
        content: expect.stringContaining("safe to retry")
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
      expect(broker.completeInvocation(
        "node:macbook",
        "instance:one",
        "invocation:one",
        { ok: true, content: "late result" }
      )).toMatchObject({
        accepted: true,
        duplicate: true,
        result: {
          ok: false,
          failureCode: "timeout",
          retryable: true
        }
      });
    } finally {
      broker.close();
    }
  });

  it.each([
    [undefined, 150_000],
    [600_000, 630_000]
  ])("extends the Device lease past the Bash timeout %s", async (
    timeout,
    expectedLeaseMs
  ) => {
    let scheduledMs;
    const broker = new NodeBroker({
      now: () => 1_000,
      invocationLeaseMs: 120_000,
      invocationDeliveryGraceMs: 30_000,
      scheduleTimeout(_callback, timeoutMs) {
        scheduledMs = timeoutMs;
        return { dispose() {} };
      }
    });
    broker.registerNode(registration({
      capabilities: [{
        name: "Bash",
        version: "1",
        risk: "execute",
        description: "Run a command",
        inputSchema: { type: "object" },
        hostKind: "local-tools"
      }]
    }));
    const input = invocation({
      policy: { allowedTools: ["Bash"], allowedTerminalSessionIds: [] },
      toolCall: {
        id: "call:bash",
        name: "Bash",
        arguments: {
          command: "sleep 1",
          ...(timeout === undefined ? {} : { timeout })
        }
      }
    });
    const completion = broker.invoke(
      input,
      new CancellationController().signal
    );

    try {
      await expect(broker.nextCommand(
        "node:macbook",
        "instance:one"
      )).resolves.toMatchObject({
        leaseExpiresAt: 1_000 + expectedLeaseMs
      });
      expect(scheduledMs).toBe(expectedLeaseMs);
      broker.completeInvocation(
        "node:macbook",
        "instance:one",
        input.invocationId,
        { ok: true, content: "done" }
      );
      await expect(completion).resolves.toMatchObject({ ok: true });
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
