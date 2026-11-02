import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeBroker } from "../src/node-broker.mjs";
import { parseTerminalReference, terminalReference } from "../../../packages/node-protocol/src/resource-references.mjs";
import {
  createTerminalManagementService
} from "../src/terminal-management-service.mjs";

function jsonResponse(value, status = 200) {
  return new globalThis.Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Runtime terminal management service", () => {
  afterEach(() => vi.useRealTimers());

  function multiNodeService({ hangServer = false } = {}) {
    const broker = new NodeBroker();
    for (const name of ["mac", "server"]) {
      broker.registerNode({
        protocolVersion: 1,
        nodeId: `node:${name}`,
        instanceId: `instance:${name}`,
        label: name,
        capabilities: [{ name: "zion.internal.deviceService" }],
        resources: [{ resourceId: `workspace:${name}`, kind: "workspace", projectId: "project" }]
      });
    }
    const requests = [];
    const invoke = broker.invoke.bind(broker);
    broker.invoke = (input, signal) => {
      const result = invoke(input, signal);
      requests.push(input);
      if (hangServer && input.target?.nodeId === "node:server") return result;
      queueMicrotask(async () => {
        const node = broker.nodes.get(input.target.nodeId);
        const command = await broker.nextCommand(input.target.nodeId, node.registration.instanceId);
        if (!command) return;
        const args = command.invocation.toolCall.arguments;
        const payload = args.path === "/machines" ? { machines: [] }
          : args.method === "POST" ? { session: { id: "created", type: "local", cwd: "/workspace" } }
          : { sessions: [{ id: "same-id", type: "local", cwd: "/workspace", active: true }] };
        broker.completeInvocation(input.target.nodeId, node.registration.instanceId, input.invocationId, {
          ok: true,
          content: JSON.stringify({
            status: 200,
            bodyBase64: Buffer.from(JSON.stringify(payload)).toString("base64")
          })
        });
      });
      return result;
    };
    return {
      broker,
      requests,
      service: createTerminalManagementService({ nodeBroker: broker, inventoryTimeoutMs: 100 })
    };
  }

  it("aggregates duplicate native IDs as distinct global sessions", async () => {
    const { broker, service } = multiNodeService();
    try {
      const inventory = await service.listInventory();
      expect(inventory.sessions).toHaveLength(2);
      expect(new Set(inventory.sessions.map((s) => s.id)).size).toBe(2);
      expect(inventory.sessions.map((s) => parseTerminalReference(s.id).nodeId).sort()).toEqual(["node:mac", "node:server"]);
      expect(inventory.machines.map((m) => m.nodeId).sort()).toEqual(["node:mac", "node:server"]);
    } finally {
      broker.close();
    }
  });

  it("does not query Nodes outside the global terminal policy", async () => {
    const { broker, service, requests } = multiNodeService();
    try {
      const ref = terminalReference({
        nodeId: "node:mac", instanceId: "instance:mac",
        resourceId: "workspace:mac", sessionId: "same-id"
      });
      const inventory = await service.listInventory({
        runContext: { policy: { allowedTerminalSessionIds: [ref] } }
      });
      expect(inventory.sessions.map((s) => s.id)).toEqual([ref]);
      expect(requests.every((r) => r.target.nodeId === "node:mac")).toBe(true);
    } finally {
      broker.close();
    }
  });

  it("reports offline Nodes without preventing healthy inventory", async () => {
    const { broker, service } = multiNodeService();
    broker.disconnectNode("node:server", "instance:server");
    try {
      const inventory = await service.listInventory();
      expect(inventory.sessions).toHaveLength(1);
      expect(inventory.nodes).toContainEqual(expect.objectContaining({ nodeId: "node:server", status: "offline" }));
    } finally {
      broker.close();
    }
  });

  it("bounds a stalled Node request and cancels its queued calls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { broker, service } = multiNodeService({ hangServer: true });
    try {
      const pending = service.listInventory();
      await vi.advanceTimersByTimeAsync(101);
      const inventory = await pending;
      expect(inventory.sessions).toHaveLength(1);
      expect(inventory.nodes).toContainEqual(expect.objectContaining({ nodeId: "node:server", status: "unavailable" }));
      expect(broker.snapshot().pendingInvocations).toBe(0);
    } finally {
      broker.close();
    }
  });

  it("routes create to an explicit Node and returns a global ID", async () => {
    const { broker, service, requests } = multiNodeService();
    try {
      const session = await service.createSession({
        payload: { node_id: "node:server", type: "local" }
      });
      expect(parseTerminalReference(session.id)).toMatchObject({ nodeId: "node:server", sessionId: "created" });
      expect(JSON.parse(Buffer.from(requests[0].toolCall.arguments.bodyBase64, "base64").toString())).toEqual({ type: "local" });
    } finally {
      broker.close();
    }
  });

  it("maps terminal lifecycle operations to the local-tools API", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname,
        method: init.method || "GET",
        body: init.body ? JSON.parse(String(init.body)) : null
      });
      if (url.pathname === "/sessions" && init.method === "POST") {
        return jsonResponse({ session: { id: "created" } });
      }
      if (url.pathname.endsWith("/exec")) {
        return jsonResponse({ ok: true });
      }
      if (url.pathname === "/machines/machine%3Alocal") {
        return jsonResponse({
          machine: { id: "machine:local", kind: "local" }
        });
      }
      return jsonResponse({ sessions: [], machines: [] });
    });
    const service = createTerminalManagementService({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl
    });

    await expect(service.createSession({
      payload: { type: "local", initial_cwd: "/workspace/project" }
    })).resolves.toEqual({ id: "created" });
    await expect(service.setSessionCwd({
      sessionId: "session-1",
      cwd: "/workspace/project with spaces"
    })).resolves.toMatchObject({
      updated: true,
      session_id: "session-1"
    });
    await expect(service.getMachine({
      machineId: "machine:local"
    })).resolves.toMatchObject({
      id: "machine:local",
      kind: "local"
    });

    expect(requests).toEqual(expect.arrayContaining([
      {
        path: "/sessions",
        method: "POST",
        body: { type: "local", initial_cwd: "/workspace/project" }
      },
      {
        path: "/sessions/session-1/exec",
        method: "POST",
        body: {
          command: "cd -- '/workspace/project with spaces'"
        }
      },
      {
        path: "/machines/machine%3Alocal",
        method: "GET",
        body: null
      }
    ]));
  });
});
