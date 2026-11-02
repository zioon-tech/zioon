import { describe, expect, it } from "vitest";
import {
  boundTerminalInventoryForContext,
  buildTerminalInventory,
  buildTerminalInventoryContextXml
} from "../extensions/dev.terminal-manager/terminal-inventory.js";

describe("terminal inventory context", () => {
  it("injects stable instructions without live terminal state", () => {
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

    expect(xml).toContain("<terminal_inventory>");
    expect(xml).toContain("<instructions>");
    expect(xml).toContain("Call terminalInventory");
    expect(xml).toContain("terminalManage action=list");
    expect(xml).toContain("Never use machine_id, workspace_id, local, or ssh as session_id");
    expect(xml).toContain("execution_outcome_unknown");
    expect(xml).not.toContain("revision=");
    expect(xml).not.toContain("<machine");
    expect(xml).not.toContain("<workspace");
    expect(xml).not.toContain("<node");
    expect(xml).not.toContain("local-1");
    expect(xml).not.toContain("zion-next");
  });

  it("returns identical context for different inventories", () => {
    const first = buildTerminalInventoryContextXml(buildTerminalInventory([
      { id: "one", type: "local", cwd: "/one", active: true }
    ], { now: 1000 }));
    const second = buildTerminalInventoryContextXml(buildTerminalInventory([
      { id: "two", type: "ssh", ssh_host: "host", cwd: "/two", active: false }
    ], { now: 9000 }));

    expect(second).toBe(first);
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
    expect(xml).not.toContain("workspace_count=");
    expect(xml).not.toContain("truncated=");
    expect(xml).not.toContain("150");
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
    expect(xml).not.toContain("remote-required");
    expect(xml).not.toContain("local-new");
  });
});
