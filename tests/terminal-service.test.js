import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureTerminalSessions,
  getTerminalMachine,
  listTerminalSessions,
  publishTerminalSessions,
  resolveTerminalCreatePayload,
  setTerminalSessionCwd,
  updateTerminalMachine
} from "../extensions/dev.terminal-manager/terminal-service.js";

function setupState(initial = {}) {
  const values = new Map(Object.entries(initial));
  window.zion = {
    state: {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value)
    }
  };
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.zion;
});

describe("terminal service", () => {
  it("publishes sessions and their derived inventory together", () => {
    const values = setupState();

    publishTerminalSessions([
      { id: "one", type: "local", cwd: "/workspace/project", active: true }
    ]);

    expect(values.get("terminal.sessions")).toHaveLength(1);
    expect(values.get("terminal.inventory")).toMatchObject({
      version: 1,
      machines: [{ id: "machine:local", sessionCount: 1 }],
      workspaces: [{ name: "project", sessionCount: 1 }]
    });
  });

  it("republishes cached sessions when inventory lacks preferred session hints", async () => {
    const values = setupState({
      "terminal.sessions": [
        { id: "one", type: "local", cwd: "/workspace/project", active: true }
      ],
      "terminal.inventory": {
        version: 1,
        machines: [{ id: "machine:local", sessionCount: 1 }],
        workspaces: [{ name: "project", sessionCount: 1, availableSessionCount: 1 }]
      }
    });

    await expect(ensureTerminalSessions()).resolves.toHaveLength(1);
    expect(values.get("terminal.inventory").workspaces[0]).toMatchObject({
      name: "project",
      preferredSessionId: "one"
    });
  });

  it("resolves create parameters from machine and workspace IDs", () => {
    const values = setupState();
    publishTerminalSessions([
      {
        id: "ssh-one",
        type: "ssh",
        ssh_host: "gpu-dev",
        ssh_user: "dev",
        ssh_port: 2222,
        cwd: "/workspace/video",
        active: true
      }
    ]);
    const inventory = values.get("terminal.inventory");

    expect(resolveTerminalCreatePayload({
      machine_id: inventory.machines[0].id,
      workspace_id: inventory.workspaces[0].id
    })).toEqual({
      type: "ssh",
      initial_cwd: "/workspace/video",
      ssh_host: "gpu-dev",
      ssh_user: "dev",
      ssh_port: 2222
    });
  });

  it("quotes cwd values before using the compatibility exec endpoint", async () => {
    setupState({
      "terminal.sessions": [
        { id: "one", type: "local", cwd: "/workspace/project", active: true }
      ]
    });
    const fetchMock = vi.fn(async () => new globalThis.Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await setTerminalSessionCwd("one", "/tmp/a'b");

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.command).toBe("cd -- '/tmp/a'\"'\"'b'");
  });

  it("refreshes sessions through the single service client", async () => {
    const values = setupState();
    vi.stubGlobal("fetch", vi.fn(async () => new globalThis.Response(JSON.stringify({
      sessions: [{ id: "one", type: "local", cwd: "/workspace/project", active: true }]
    }), { status: 200 })));

    await expect(listTerminalSessions()).resolves.toHaveLength(1);
    expect(values.get("terminal.inventory")?.workspaceCount).toBeUndefined();
    expect(values.get("terminal.inventory")?.workspaces).toHaveLength(1);
  });

  it("updates a machine profile and republishes the inventory", async () => {
    const values = setupState();
    publishTerminalSessions([
      { id: "one", type: "local", cwd: "/workspace/project", active: true }
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      expect(url).toContain("/machines/machine%3Alocal");
      expect(options.method).toBe("PATCH");
      return new globalThis.Response(JSON.stringify({
        machine: {
          id: "machine:local",
          name: "Build Mac",
          kind: "local",
          description: "32 GB build machine",
          updated_at: 123
        }
      }), { status: 200 });
    }));

    await updateTerminalMachine("machine:local", {
      name: "Build Mac",
      description: "32 GB build machine"
    });

    await expect(getTerminalMachine("machine:local")).resolves.toMatchObject({
      name: "Build Mac",
      description: "32 GB build machine"
    });
    expect(values.get("terminal.machineProfiles")).toHaveLength(1);
  });
});
