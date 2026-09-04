import { describe, expect, it } from "vitest";
import {
  boundTerminalInventoryForContext,
  buildTerminalInventory,
  buildTerminalInventoryContextXml
} from "../extensions/dev.terminal-manager/terminal-inventory.js";

describe("terminal inventory context", () => {
  it("injects machines, workspaces, and a usable session id per workspace", () => {
    const inventory = buildTerminalInventory([
      { id: "local-1", type: "local", cwd: "/workspace/zion-next", active: true },
      { id: "local-2", type: "local", cwd: "/workspace/zion-next", active: true },
      {
        id: "ssh-1",
        type: "ssh",
        ssh_user: "dev",
        ssh_host: "gpu-dev",
        ssh_port: 22,
        cwd: "/data/video-generation",
        active: true
      }
    ], {
      now: 1000,
      machineProfiles: [{
        id: "machine:local",
        name: "Local Dev",
        kind: "local",
        description: "Apple Silicon development machine"
      }]
    });

    const xml = buildTerminalInventoryContextXml(inventory);

    expect(xml).toContain('machine_count="2"');
    expect(xml).toContain('workspace_count="2"');
    expect(xml).toContain('session_count="3"');
    expect(xml).toContain('name="zion-next" sessions="2"');
    expect(xml).toContain('name="video-generation" sessions="1"');
    expect(xml).toContain('sessions="1" available="1" disconnected="0"');
    expect(xml).toContain('machine_id="machine:local"');
    expect(xml).toContain('workspace_id="');
    expect(xml).toContain('preferred_session_id="local-1"');
    expect(xml).toContain('preferred_session_id="ssh-1"');
    expect(xml).toContain("<description>Apple Silicon development machine</description>");
    expect(xml).toContain("terminalManage action=list");
    expect(xml).toContain("Do not use machine_id, workspace_id, or type values such as local/ssh as session_id");
    expect(xml).not.toContain("active_session");
  });

  it("escapes workspace data and includes paths only for duplicate names", () => {
    const inventory = buildTerminalInventory([
      { id: "one", type: "local", cwd: "/one/a&b", active: true },
      { id: "two", type: "local", cwd: "/two/a&b", active: true }
    ], { now: 1000 });

    const xml = buildTerminalInventoryContextXml(inventory);

    expect(xml).toContain('name="a&amp;b"');
    expect(xml).toContain('path="/one/a&amp;b"');
    expect(xml).toContain('path="/two/a&amp;b"');
  });

  it("bounds automatic context by machine and workspace budgets", () => {
    const sessions = [];
    for (let machineIndex = 0; machineIndex < 6; machineIndex += 1) {
      for (let workspaceIndex = 0; workspaceIndex < 25; workspaceIndex += 1) {
        sessions.push({
          id: `session-${machineIndex}-${workspaceIndex}`,
          type: machineIndex === 0 ? "local" : "ssh",
          ssh_user: "dev",
          ssh_host: `host-${machineIndex}`,
          cwd: `/workspace/${machineIndex}-${workspaceIndex}`,
          active: true,
          last_activity: 10_000 - machineIndex * 100 - workspaceIndex
        });
      }
    }
    const inventory = buildTerminalInventory(sessions, { now: 20_000 });

    const projection = boundTerminalInventoryForContext(inventory);
    const workspacesPerMachine = projection.workspaces.reduce((counts, item) => {
      counts.set(item.machineId, (counts.get(item.machineId) || 0) + 1);
      return counts;
    }, new Map());
    const xml = buildTerminalInventoryContextXml(inventory);

    expect(projection.machines).toHaveLength(6);
    expect(projection.workspaces).toHaveLength(24);
    expect(Math.max(...workspacesPerMachine.values())).toBe(12);
    expect(projection.machines[0].id).toBe("machine:local");
    expect(projection.contextProjection).toMatchObject({
      truncated: true,
      totalMachineCount: 6,
      totalWorkspaceCount: 150,
      totalSessionCount: 150,
      includedMachineCount: 6,
      includedWorkspaceCount: 24
    });
    expect(xml).toContain('workspace_count="24"');
    expect(xml).toContain('truncated="true"');
    expect(xml).toContain('total_workspace_count="150"');
    expect(xml).toContain("This is a bounded summary.");
  });

  it("retains workspaces for explicitly preferred terminal sessions", () => {
    const inventory = buildTerminalInventory([
      {
        id: "local-new",
        type: "local",
        cwd: "/workspace/local",
        active: true,
        last_activity: 3000
      },
      {
        id: "remote-required",
        type: "ssh",
        ssh_user: "dev",
        ssh_host: "archive",
        cwd: "/workspace/required",
        active: true,
        last_activity: 1000
      }
    ], { now: 4000 });

    const projection = boundTerminalInventoryForContext(inventory, {
      maxMachines: 1,
      maxWorkspaces: 1,
      maxWorkspacesPerMachine: 1,
      preferredSessionIds: ["remote-required"]
    });
    const xml = buildTerminalInventoryContextXml(inventory, {
      maxMachines: 1,
      maxWorkspaces: 1,
      maxWorkspacesPerMachine: 1,
      preferredSessionIds: ["remote-required"]
    });

    expect(projection.machines.map((machine) => machine.name)).toEqual([
      "archive"
    ]);
    expect(projection.workspaces.map((workspace) => workspace.name)).toEqual([
      "required"
    ]);
    expect(xml).toContain('preferred_session_id="remote-required"');
    expect(xml).not.toContain('preferred_session_id="local-new"');
  });
});
