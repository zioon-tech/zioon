import { describe, expect, it, vi } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import {
  activateRuntimePlugin,
  LocalToolsTerminalInventoryContextProvider
} from "../../../extensions/dev.terminal-manager/runtime.js";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function context(overrides = {}) {
  return {
    runId: "run-1",
    attemptId: "attempt-1",
    request: {
      policy: {
        allowedTerminalSessionIds: ["local-allowed"]
      },
      metadata: {}
    },
    signal: new CancellationController().signal,
    ...overrides
  };
}

describe("LocalToolsTerminalInventoryContextProvider", () => {
  it("injects stable terminal guidance after system messages without loading inventory", async () => {
    const fetchImpl = vi.fn();
    const provider = new LocalToolsTerminalInventoryContextProvider({
      fetchImpl
    });

    const result = await provider.contribute([
      { role: "system", content: "base" },
      { role: "user", content: "inspect the project" }
    ], context());

    expect(result.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user"
    ]);
    expect(result[1].content).toContain("<terminal_inventory");
    expect(result[1].content).toContain("Call terminalInventory");
    expect(result[1].content).toContain("terminal_session_busy");
    expect(result[1].content).toContain("stale_terminal_reference");
    expect(result[1].content).toContain("execution_outcome_unknown");
    expect(result[1].content).not.toContain("revision=");
    expect(result[1].content).not.toContain("local-hidden");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("injects the same guidance when the Run allowlist is empty", async () => {
    const fetchImpl = vi.fn();
    const provider = new LocalToolsTerminalInventoryContextProvider({
      fetchImpl,
      now: () => 4_000
    });
    const messages = [{ role: "user", content: "hello" }];

    await expect(provider.contribute(messages, context({
      request: {
        policy: { allowedTerminalSessionIds: [] },
        metadata: {}
      }
    }))).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Call terminalInventory")
      }),
      messages[0]
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not query the Device service while contributing guidance", async () => {
    const service = {
      listInventory: vi.fn(async () => ({
        sessions: [],
        machines: [],
        nodes: [{
          nodeId: "node:cloud-runtime",
          label: "Cloud Runtime",
          status: "online"
        }]
      }))
    };
    const provider = new LocalToolsTerminalInventoryContextProvider({
      service
    });

    const result = await provider.contribute([], context({
      request: {
        target: { nodeId: "node:cloud-runtime" },
        policy: { allowedTerminalSessionIds: [] },
        metadata: {}
      }
    }));

    expect(result[0].content).not.toContain("node:cloud-runtime");
    expect(service.listInventory).not.toHaveBeenCalled();
  });

  it("does not query terminal inventory when explicitly disabled", async () => {
    const fetchImpl = vi.fn();
    const provider = new LocalToolsTerminalInventoryContextProvider({ fetchImpl });
    const messages = [{ role: "user", content: "hello" }];

    await expect(provider.contribute(messages, context({
      request: {
        policy: { allowedTerminalSessionIds: ["local-allowed"] },
        metadata: { includeTerminalContext: false }
      }
    }))).resolves.toBe(messages);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps guidance available when the inventory service is unavailable", async () => {
    const sessions = [{
      id: "local-allowed",
      type: "local",
      cwd: "/workspace/zion-next",
      active: true
    }];
    const provider = new LocalToolsTerminalInventoryContextProvider({
      fetchImpl: async (url) => url.pathname === "/sessions"
        ? response({ sessions })
        : response({ detail: "unavailable" }, 503),
      now: () => 4_000
    });

    await expect(provider.contribute([], context())).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Call terminalInventory")
      })
    ]);

    const failing = new LocalToolsTerminalInventoryContextProvider({
      fetchImpl: async (url) => url.pathname === "/sessions"
        ? response({ detail: "unavailable" }, 503)
        : response({ machines: [] })
    });
    await expect(failing.contribute([], context())).resolves.toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Call terminalInventory")
      })
    ]);
    await expect(failing.invokeInventoryTool({}, {
      policy: { allowedTerminalSessionIds: [] },
      signal: new CancellationController().signal
    })).rejects.toThrow(
      "local-tools /sessions failed"
    );
  });

  it("registers terminal inventory and management through API v2", () => {
    const providers = [];
    const tools = [];
    const contribution = activateRuntimePlugin({
      apiVersion: 2,
      config: { baseUrl: "http://127.0.0.1:8765" },
      context: {
        registerProvider(provider) {
          providers.push(provider);
          return { dispose() { providers.splice(providers.indexOf(provider), 1); } };
        }
      },
      tools: {
        registerTool(tool) {
          tools.push(tool);
          return { dispose() { tools.splice(tools.indexOf(tool), 1); } };
        }
      }
    });

    expect(providers.map((provider) => provider.id)).toEqual([
      "dev.terminal-manager.inventory"
    ]);
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "terminalInventory",
        policy: { minimumPreset: "read-only" }
      }),
      expect.objectContaining({
        name: "terminalManage",
        policy: { minimumPreset: "trusted-automation" }
      })
    ]));
    expect(tools).toHaveLength(2);

    contribution.dispose();
    expect(providers).toEqual([]);
    expect(tools).toEqual([]);
  });

  it("routes terminalManage through the Device service and enforces session scope", async () => {
    const tools = [];
    const service = {
      listSessions: vi.fn(async () => [{
        id: "allowed",
        type: "local",
        cwd: "/workspace/allowed",
        active: true
      }, {
        id: "hidden",
        type: "local",
        cwd: "/workspace/hidden",
        active: true
      }]),
      listMachines: vi.fn(async () => []),
      closeSession: vi.fn(async ({ sessionId }) => ({
        closed: true,
        session_id: sessionId
      }))
    };
    activateRuntimePlugin({
      apiVersion: 2,
      config: { terminalManagementService: service },
      context: {
        registerProvider() {
          return { dispose() {} };
        }
      },
      tools: {
        registerTool(tool) {
          tools.push(tool);
          return { dispose() {} };
        }
      }
    });
    const terminalManage = tools.find((tool) => tool.name === "terminalManage");
    const runContext = {
      signal: new CancellationController().signal,
      policy: { allowedTerminalSessionIds: ["allowed"] }
    };

    const listed = await terminalManage.invoke({ action: "list" }, runContext);
    expect(JSON.parse(listed.content).sessions).toEqual([
      expect.objectContaining({ session_id: "allowed" })
    ]);

    await expect(terminalManage.invoke({
      action: "close",
      session_id: "hidden"
    }, runContext)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("outside the active policy")
    });
    expect(service.closeSession).not.toHaveBeenCalled();

    await expect(terminalManage.invoke({
      action: "close",
      session_id: "allowed"
    }, runContext)).resolves.toMatchObject({ ok: true });
    expect(service.closeSession).toHaveBeenCalledWith({
      sessionId: "allowed",
      runContext
    });
  });

  it("returns filtered terminal inventory as a Runtime tool result", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.pathname === "/sessions") {
        return response({
          sessions: [{
            id: "local-one",
            type: "local",
            cwd: "/workspace/one",
            active: true
          }, {
            id: "local-two",
            type: "local",
            cwd: "/workspace/two",
            active: false,
            connectionStatus: "disconnected"
          }]
        });
      }
      return response({
        machines: [{
          id: "machine:local",
          name: "Development Mac",
          kind: "local"
        }]
      });
    });
    const provider = new LocalToolsTerminalInventoryContextProvider({
      fetchImpl,
      now: () => 4_000
    });

    const result = await provider.invokeInventoryTool({
      status: "connected"
    }, {
      policy: { allowedTerminalSessionIds: [] },
      signal: new CancellationController().signal
    });
    const payload = JSON.parse(result.content);

    expect(result.ok).toBe(true);
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]).toMatchObject({
      id: "local-one",
      workspaceId: expect.any(String),
      connectionStatus: "connected"
    });
    expect(payload.machines[0]).toMatchObject({
      id: "machine:local",
      name: "Development Mac"
    });
  });

  it("bounds automatic context without truncating the inventory tool", async () => {
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      id: `local-${index}`,
      type: "local",
      cwd: `/workspace/project-${index}`,
      active: true,
      last_activity: 1000 - index
    }));
    const provider = new LocalToolsTerminalInventoryContextProvider({
      fetchImpl: async (url) => url.pathname === "/sessions"
        ? response({ sessions })
        : response({ machines: [] }),
      now: () => 2_000
    });
    const runContext = context({
      request: {
        policy: { allowedTerminalSessionIds: [] },
        metadata: {}
      }
    });

    const contributed = await provider.contribute([], runContext);
    const toolResult = await provider.invokeInventoryTool({}, {
      policy: { allowedTerminalSessionIds: [] },
      signal: runContext.signal
    });
    const toolInventory = JSON.parse(toolResult.content);

    expect(contributed[0].content).toContain("Call terminalInventory");
    expect(contributed[0].content).not.toContain("workspace_count=");
    expect(contributed[0].content).not.toContain("local-0");
    expect(toolInventory.workspaces).toHaveLength(30);
    expect(toolInventory.sessions).toHaveLength(30);
  });
});
