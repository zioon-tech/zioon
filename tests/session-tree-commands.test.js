import { describe, expect, it, vi } from "vitest";
import { registerSessionTreeCommands } from "../extensions/dev.session-manager/commands/tree-apis.js";

function createFixture(overrides = {}) {
  const commands = new Map();
  const state = { set: vi.fn() };
  const zion = {
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      }
    },
    state
  };
  const deps = {
    zion,
    loadTree: () => ({
      id: "root",
      type: "folder",
      children: [{
        id: "folder-1",
        type: "folder",
        title: "Folder",
        children: [{ id: "session-1", type: "session", title: "Session" }]
      }]
    }),
    insertFolder: vi.fn(() => "folder-new"),
    moveNode: vi.fn(() => true),
    getIndex: () => [{ id: "session-1" }],
    refreshSessionsSidebarViewIfOpen: vi.fn(),
    ...overrides
  };
  const disposable = registerSessionTreeCommands(deps);
  return { commands, deps, disposable, state };
}

describe("session tree commands", () => {
  it("returns a defensive tree snapshot", () => {
    const tree = { id: "root", type: "folder", children: [] };
    const { commands } = createFixture({ loadTree: () => tree });

    const snapshot = commands.get("zion.sessions.getTreeSnapshot")();
    snapshot.children.push({ id: "mutated", type: "session" });

    expect(tree.children).toEqual([]);
  });

  it("creates a folder without changing session UI state", () => {
    const insertFolder = vi.fn(() => "folder-scheduled");
    const { commands, state } = createFixture({ insertFolder });

    expect(commands.get("zion.sessions.createFolder")({
      parentId: "root",
      title: "Scheduled Tasks"
    })).toBe("folder-scheduled");
    expect(insertFolder).toHaveBeenCalledWith("root", "Scheduled Tasks");
    expect(state.set).not.toHaveBeenCalled();
  });

  it("treats moving a node to its current parent as a no-op", () => {
    const moveNode = vi.fn(() => true);
    const refresh = vi.fn();
    const { commands, state } = createFixture({
      moveNode,
      refreshSessionsSidebarViewIfOpen: refresh
    });

    expect(commands.get("zion.sessions.moveNode")({
      id: "session-1",
      targetFolderId: "folder-1"
    })).toBe(true);
    expect(moveNode).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("moves a node and refreshes mounted session lists", () => {
    const moveNode = vi.fn(() => true);
    const refresh = vi.fn();
    const index = [{ id: "session-1" }];
    const { commands, state } = createFixture({
      moveNode,
      getIndex: () => index,
      refreshSessionsSidebarViewIfOpen: refresh
    });

    expect(commands.get("zion.sessions.moveNode")({
      id: "session-1",
      targetFolderId: "root"
    })).toBe(true);
    expect(moveNode).toHaveBeenCalledWith("session-1", "root");
    expect(state.set).toHaveBeenCalledWith("sessions.catalog", index);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
