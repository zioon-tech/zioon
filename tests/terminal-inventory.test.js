import { describe, expect, it } from "vitest";
import {
  buildTerminalInventory,
  buildTerminalInventoryContextXml,
  DEFAULT_MACHINE_DESCRIPTION,
  filterTerminalSessions,
  getTerminalMachineIdentity
} from "../extensions/dev.terminal-manager/terminal-inventory.js";
import { terminalReference } from "../packages/node-protocol/src/resource-references.mjs";

describe("terminal inventory", () => {
  it("keeps identical local paths and SSH routes separate across Nodes", () => {
    const sessions = ["one", "two"].flatMap((name) => [
      { id: `local-${name}`, type: "local", nodeId: `node:${name}`, nodeLabel: name, cwd: "/workspace" },
      { id: `ssh-${name}`, type: "ssh", nodeId: `node:${name}`, ssh_host: "gpu", ssh_user: "dev", cwd: "/workspace" }
    ]);
    const inventory = buildTerminalInventory(sessions);
    expect(inventory.machines).toHaveLength(4);
    expect(inventory.workspaces).toHaveLength(4);
    expect(inventory.machines.filter((m) => m.kind === "local").map((m) => m.name).sort()).toEqual(["one", "two"]);
  });

  it("preserves exact long global IDs in sessions and model context", () => {
    const id = terminalReference({
      nodeId: `node:${"n".repeat(100)}`,
      instanceId: `instance:${"i".repeat(100)}`,
      resourceId: "workspace:one",
      sessionId: "terminal:one"
    });
    const inventory = buildTerminalInventory([{
      id, nodeId: `node:${"n".repeat(100)}`, nodeLabel: "Node",
      cwd: "/workspace", type: "local"
    }]);
    expect(id.length).toBeGreaterThan(240);
    expect(inventory.sessions[0].id).toBe(id);
    expect(buildTerminalInventoryContextXml(inventory)).toContain(`preferred_session_id="${id}"`);
  });

  it("escapes node labels and describes offline nodes without inventing sessions", () => {
    const xml = buildTerminalInventoryContextXml({
      ...buildTerminalInventory([]),
      nodes: [{ nodeId: "node:offline", label: '<run command="bad">', status: "offline" }]
    });
    expect(xml).toContain('node_id="node:offline"');
    expect(xml).toContain('status="offline"');
    expect(xml).toContain("&lt;run");
    expect(xml).not.toContain('<run command=');
    expect(xml).not.toContain("preferred_session_id=");
  });

  it("groups many sessions by machine and workspace", () => {
    const sessions = [
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `local-${index}`,
        type: "local",
        cwd: index < 60 ? "/workspace/zion-next" : "/workspace/local-tools",
        active: true,
        last_activity: 2000 - index
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `ssh-${index}`,
        type: "ssh",
        ssh_user: "dev",
        ssh_host: "gpu-dev",
        ssh_port: 22,
        cwd: "/data/video",
        active: index === 0,
        last_activity: 1000 - index
      }))
    ];

    const inventory = buildTerminalInventory(sessions, { now: 3000 });

    expect(inventory.sessions).toHaveLength(120);
    expect(inventory.machines).toHaveLength(2);
    expect(inventory.workspaces).toHaveLength(3);
    expect(inventory.machines[0]).toMatchObject({
      id: "machine:local",
      status: "online",
      sessionCount: 100,
      availableSessionCount: 100,
      disconnectedSessionCount: 0,
      workspaceCount: 2
    });
    expect(inventory.machines[1]).toMatchObject({
      status: "online",
      sessionCount: 20,
      availableSessionCount: 1,
      disconnectedSessionCount: 19
    });
    expect(inventory.workspaces.find((workspace) => workspace.name === "zion-next"))
      .toMatchObject({
        sessionCount: 60,
        availableSessionCount: 60,
        preferredSessionId: "local-0",
        availableSessionIds: expect.arrayContaining(["local-0"])
      });
  });

  it("uses a stable SSH connection identity", () => {
    const first = getTerminalMachineIdentity({
      type: "ssh",
      ssh_user: "Dev",
      ssh_host: "GPU-DEV",
      ssh_port: 22
    });
    const second = getTerminalMachineIdentity({
      type: "ssh",
      ssh_user: "Dev",
      ssh_host: "gpu-dev",
      ssh_port: 22
    });

    expect(first.id).toBe(second.id);
    expect(first.kind).toBe("ssh");
  });

  it("filters list results by workspace and connection state", () => {
    const inventory = buildTerminalInventory([
      { id: "one", type: "local", cwd: "/workspace/one", active: true },
      { id: "two", type: "local", cwd: "/workspace/one", active: false },
      { id: "three", type: "local", cwd: "/workspace/two", active: true }
    ], { now: 1000 });
    const workspace = inventory.workspaces.find((item) => item.name === "one");

    expect(filterTerminalSessions(inventory.sessions, {
      workspace_id: workspace.id,
      status: "connected",
      now: 1000
    }).map((session) => session.id)).toEqual(["one"]);
  });

  it("uses the latest connected session as each workspace preferred session", () => {
    const inventory = buildTerminalInventory([
      { id: "old", type: "local", cwd: "/workspace/project", active: true, last_activity: 1000 },
      { id: "latest", type: "local", cwd: "/workspace/project", active: true, last_activity: 2000 },
      { id: "disconnected", type: "local", cwd: "/workspace/project", active: false, last_activity: 3000 }
    ], { now: 4000 });

    expect(inventory.workspaces[0]).toMatchObject({
      preferredSessionId: "latest",
      availableSessionIds: ["latest", "old"],
      sessionIds: ["disconnected", "latest", "old"]
    });
  });

  it("merges persistent machine profiles and keeps machines without sessions", () => {
    const inventory = buildTerminalInventory([
      { id: "one", type: "local", cwd: "/workspace/one", active: true }
    ], {
      now: 1000,
      machineProfiles: [
        {
          id: "machine:local",
          name: "Development Mac",
          kind: "local",
          description: "64 GB Apple Silicon machine"
        },
        {
          id: "machine:ssh:offline",
          name: "Offline GPU",
          kind: "ssh",
          description: ""
        }
      ]
    });

    expect(inventory.machines).toHaveLength(2);
    expect(inventory.machines.find((machine) => machine.id === "machine:local"))
      .toMatchObject({
        name: "Development Mac",
        description: "64 GB Apple Silicon machine",
        sessionCount: 1
      });
    expect(inventory.machines.find((machine) => machine.id === "machine:ssh:offline"))
      .toMatchObject({
        name: "Offline GPU",
        description: DEFAULT_MACHINE_DESCRIPTION,
        status: "offline",
        sessionCount: 0
      });
  });
});
