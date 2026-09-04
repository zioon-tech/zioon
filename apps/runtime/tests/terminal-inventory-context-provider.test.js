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
  it("injects the existing terminal inventory format after system messages", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.pathname === "/sessions") {
        return response({
          sessions: [{
            id: "local-allowed",
            type: "local",
            cwd: "/workspace/zion-next",
            active: true,
            last_activity: 2
          }, {
            id: "local-hidden",
            type: "local",
            cwd: "/workspace/secret",
            active: true,
            last_activity: 3
          }]
        });
      }
      return response({
        machines: [{
          id: "machine:local",
          name: "Development Mac",
          kind: "local",
          description: "Apple Silicon development machine"
        }]
      });
    });
    const provider = new LocalToolsTerminalInventoryContextProvider({
      fetchImpl,
      now: () => 4_000
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
    expect(result[1].content).toContain('name="Development Mac"');
    expect(result[1].content).toContain('name="zion-next"');
    expect(result[1].content).toContain('preferred_session_id="local-allowed"');
    expect(result[1].content).not.toContain("local-hidden");
    expect(result[1].content).not.toContain("secret");
    expect(fetchImpl.mock.calls.map(([url]) => url.pathname).sort()).toEqual([
      "/machines",
      "/sessions"
    ]);
  });

  it("injects every visible terminal when the Run allowlist is empty", async () => {
    const fetchImpl = vi.fn(async (url) => url.pathname === "/sessions"
      ? response({
          sessions: [{
            id: "local-visible",
            type: "local",
            cwd: "/workspace/visible",
            active: true
          }]
        })
      : response({ machines: [] }));
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
        content: expect.stringContaining('preferred_session_id="local-visible"')
      }),
      messages[0]
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

  it("continues without machine profiles but surfaces a session-list failure", async () => {
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
        content: expect.stringContaining('machine_id="machine:local"')
      })
    ]);

    const failing = new LocalToolsTerminalInventoryContextProvider({
      fetchImpl: async (url) => url.pathname === "/sessions"
        ? response({ detail: "unavailable" }, 503)
        : response({ machines: [] })
    });
    await expect(failing.contribute([], context())).rejects.toThrow(
      "local-tools /sessions failed"
    );
  });

  it("registers the terminal inventory provider and Runtime tool through API v2", () => {
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
    expect(tools).toEqual([
      expect.objectContaining({
        name: "terminalInventory",
        policy: { minimumPreset: "read-only" }
      })
    ]);

    contribution.dispose();
    expect(providers).toEqual([]);
    expect(tools).toEqual([]);
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

    expect(contributed[0].content).toContain('workspace_count="12"');
    expect(contributed[0].content).toContain('total_workspace_count="30"');
    expect(contributed[0].content).toContain('truncated="true"');
    expect(toolInventory.workspaces).toHaveLength(30);
    expect(toolInventory.sessions).toHaveLength(30);
  });
});
