import { describe, expect, it } from "vitest";
import {
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
});
