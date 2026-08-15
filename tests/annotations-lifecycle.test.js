import { describe, expect, it, vi } from "vitest";
import { createAnnotationsLifecycle } from "../extensions/dev.session-manager/features/annotations-lifecycle.js";

describe("session annotations lifecycle", () => {
  it("persists the explicitly named panel session instead of the global current session", () => {
    const saved = [];
    const snapshots = [];
    const annotations = new Map([
      ["session-a", { tools: [{ id: "tool-a", result: "done" }], thinking: [] }],
      ["session-b", { tools: [], thinking: [] }]
    ]);
    const zion = {
      state: { get: vi.fn(() => "session-b") },
      commands: {
        executeCommand(name, arg) {
          if (name === "zion.chatCards.snapshotSession") {
            snapshots.push(arg);
            return true;
          }
          if (name === "zion.chatCards.getSessionAnnotations") {
            return annotations.get(arg) || null;
          }
          return null;
        }
      }
    };
    const lifecycle = createAnnotationsLifecycle({
      loadMeta: (id) => ({ id, title: id }),
      saveMeta: (id, meta) => saved.push({ id, meta }),
      getZion: () => zion
    });

    lifecycle.persistAnnotations("session-a", "panel-a");

    expect(snapshots).toEqual([{ sessionId: "session-a", panelId: "panel-a" }]);
    expect(saved).toEqual([{
      id: "session-a",
      meta: {
        id: "session-a",
        title: "session-a",
        annotations: annotations.get("session-a")
      }
    }]);
  });
});
