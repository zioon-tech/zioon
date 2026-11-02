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

  it("does not start a second lifecycle write during an intentional reload", () => {
    const saved = [];
    const listeners = new Map();
    const zion = {
      state: { get: vi.fn(() => "session-a") },
      commands: {
        executeCommand: vi.fn(() => ({ tools: [], thinking: [] }))
      }
    };
    const originalAddEventListener = window.addEventListener;
    const subscriptions = [];
    window.addEventListener = vi.fn((name, handler) => {
      listeners.set(name, handler);
    });
    const lifecycle = createAnnotationsLifecycle({
      loadMeta: (id) => ({ id }),
      loadMetaAsync: async (id) => ({ id }),
      saveMeta: (id, meta) => saved.push({ id, meta }),
      shouldSkipLifecyclePersistence: () => true,
      getZion: () => zion
    });

    try {
      lifecycle.attachLifecyclePersistence({ subscriptions });
      listeners.get("beforeunload")?.();
      expect(saved).toEqual([]);
    } finally {
      subscriptions.forEach((item) => item.dispose?.());
      window.addEventListener = originalAddEventListener;
    }
  });
});
