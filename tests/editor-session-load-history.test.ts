import { describe, expect, it } from "vitest";
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { EditorCore } from "../src/editor/EditorCore";

function createEditor(initialText = "") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const core = new EditorCore(host, initialText, "panel-a");
  return {
    core,
    cleanup() {
      try { core.view.destroy(); } catch {}
      try { host.remove(); } catch {}
    }
  };
}

describe("EditorCore session-load history", () => {
  it("does not let undo revert a loaded session back to the previous document", () => {
    const { core, cleanup } = createEditor("");
    try {
      core.setValue("loaded session text", { source: "session-load" });

      expect(undoDepth(core.view.state)).toBe(0);
      expect(undo(core.view)).toBe(false);
      expect(core.getValue()).toBe("loaded session text");
      expect(redoDepth(core.view.state)).toBe(0);
      expect(redo(core.view)).toBe(false);
      expect(core.getValue()).toBe("loaded session text");
    } finally {
      cleanup();
    }
  });

  it("keeps ordinary setValue replacements undoable", () => {
    const { core, cleanup } = createEditor("before");
    try {
      core.setValue("after");

      expect(undoDepth(core.view.state)).toBe(1);
      expect(undo(core.view)).toBe(true);
      expect(core.getValue()).toBe("before");
      expect(redoDepth(core.view.state)).toBe(1);
      expect(redo(core.view)).toBe(true);
      expect(core.getValue()).toBe("after");
    } finally {
      cleanup();
    }
  });

  it("does not expose stale undo entries after replacing a previous document with a session load", () => {
    const { core, cleanup } = createEditor("previous doc");
    try {
      core.setValue("previous doc edited");
      expect(undoDepth(core.view.state)).toBe(1);

      core.setValue("loaded session text", { source: "session-load" });

      expect(undoDepth(core.view.state)).toBe(0);
      expect(undo(core.view)).toBe(false);
      expect(core.getValue()).toBe("loaded session text");
    } finally {
      cleanup();
    }
  });

  it("rejects late session snapshots after collaboration owns the document", () => {
    const { core, cleanup } = createEditor("current collaborative text");
    try {
      core.view.dom.dataset.zionCollaborationBound = "true";

      core.setValue("stale HTTP snapshot", { source: "session-load" });
      core.setValue("stale seed", { source: "session-seed" });

      expect(core.getValue()).toBe("current collaborative text");
      core.setValue("hydrated Yjs text", {
        source: "collaboration-hydration"
      });
      expect(core.getValue()).toBe("hydrated Yjs text");
      expect(undoDepth(core.view.state)).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("allows the synchronized Yjs document to hydrate a bound editor", () => {
    const { core, cleanup } = createEditor("stale local text");
    try {
      core.view.dom.dataset.zionCollaborationBound = "true";

      core.setValue("authoritative Yjs text", {
        source: "collaboration-hydration"
      });

      expect(core.getValue()).toBe("authoritative Yjs text");
      expect(undoDepth(core.view.state)).toBe(0);
    } finally {
      cleanup();
    }
  });
});
