import { describe, expect, it, vi } from "vitest";
import { ChatCardRuntime } from "../src/chat/card-runtime";

function createEvents() {
  const emitted: Array<{ topic: string; payload: any }> = [];
  const handlers = new Map<string, Set<(payload?: any) => void>>();
  return {
    emitted,
    emit(topic: string, payload?: any) {
      emitted.push({ topic, payload });
      handlers.get(topic)?.forEach((fn) => fn(payload));
    },
    on(topic: string, fn: (payload?: any) => void) {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(fn);
      return { dispose: () => handlers.get(topic)?.delete(fn) };
    }
  };
}

describe("ChatCardRuntime", () => {
  it("restores all registered card types through core type metadata", () => {
    const events = createEvents();
    const pending: Record<string, any[] | null> = {};
    const runtime = new ChatCardRuntime({
      events,
      getAnnotations: () => ({
        tools: [{ id: "tool-1" }],
        thinking: [{ id: "thinking-1" }]
      }),
      setPendingRestore(sessionId, kind, items) {
        pending[`${sessionId}:${kind}`] = Array.isArray(items) ? items.slice() : null;
        return pending[`${sessionId}:${kind}`];
      }
    });

    runtime.registerType({
      kind: "tools",
      annotationKey: "tools",
      restoreEvent: "toolcards/restore",
      clearEvent: "toolcards/clear"
    });
    runtime.registerType({
      kind: "thinking",
      annotationKey: "thinking",
      restoreEvent: "thinking/restore",
      clearEvent: "thinking/clear"
    });

    const result = runtime.restoreSession({ sessionId: "session-1", panelId: "panel-a" });

    expect(result.restored.tools).toEqual([{ id: "tool-1" }]);
    expect(result.restored.thinking).toEqual([{ id: "thinking-1" }]);
    expect(pending["session-1:tools"]).toEqual([{ id: "tool-1" }]);
    expect(pending["session-1:thinking"]).toEqual([{ id: "thinking-1" }]);
    expect(events.emitted.map((entry) => entry.topic)).toEqual([
      "toolcards/clear",
      "thinking/clear",
      "toolcards/restore",
      "thinking/restore"
    ]);
  });

  it("snapshots registered card types without plugin-specific branching", () => {
    const events = createEvents();
    const runtime = new ChatCardRuntime({
      events,
      getAnnotations: () => ({}),
      setPendingRestore: () => null
    });

    runtime.registerType({
      kind: "tools",
      annotationKey: "tools",
      restoreEvent: "toolcards/restore",
      clearEvent: "toolcards/clear",
      snapshotEvent: "toolcards/snapshot"
    });
    runtime.registerType({
      kind: "thinking",
      annotationKey: "thinking",
      restoreEvent: "thinking/restore",
      clearEvent: "thinking/clear",
      snapshotEvent: "thinking/snapshot"
    });

    const result = runtime.snapshotSession({ sessionId: "session-1", panelId: "panel-a" });

    expect(result.snapshotted).toEqual(["tools", "thinking"]);
    expect(events.emitted).toEqual([
      { topic: "toolcards/snapshot", payload: { panelId: "panel-a", sessionId: "session-1" } },
      { topic: "thinking/snapshot", payload: { panelId: "panel-a", sessionId: "session-1" } }
    ]);
  });

  it("defers card restoration until after the session text can paint", () => {
    vi.useFakeTimers();
    const animationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    try {
      const events = createEvents();
      const runtime = new ChatCardRuntime({
        events,
        getAnnotations: () => ({ tools: [{ id: "tool-1" }] }),
        setPendingRestore: (_sessionId, _kind, items) => items || null
      });
      runtime.registerType({
        kind: "tools",
        annotationKey: "tools",
        restoreEvent: "toolcards/restore",
        clearEvent: "toolcards/clear"
      });

      runtime.restoreSession({ sessionId: "session-1", defer: true });

      expect(events.emitted.map((entry) => entry.topic)).toEqual(["toolcards/clear"]);
      vi.runAllTimers();
      expect(events.emitted.map((entry) => entry.topic)).toEqual([
        "toolcards/clear",
        "toolcards/restore"
      ]);
    } finally {
      animationFrame.mockRestore();
      vi.useRealTimers();
    }
  });

  it("cancels a stale deferred restoration when the panel switches again", () => {
    vi.useFakeTimers();
    const animationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    try {
      const events = createEvents();
      const runtime = new ChatCardRuntime({
        events,
        getAnnotations: (sessionId) => ({ tools: [{ id: `tool-${sessionId}` }] }),
        setPendingRestore: (_sessionId, _kind, items) => items || null
      });
      runtime.registerType({
        kind: "tools",
        annotationKey: "tools",
        restoreEvent: "toolcards/restore",
        clearEvent: "toolcards/clear"
      });

      runtime.restoreSession({ sessionId: "session-1", panelId: "panel-a", defer: true });
      runtime.restoreSession({ sessionId: "session-2", panelId: "panel-a", defer: true });
      vi.runAllTimers();

      const restores = events.emitted.filter((entry) => entry.topic === "toolcards/restore");
      expect(restores).toHaveLength(1);
      expect(restores[0].payload.sessionId).toBe("session-2");
    } finally {
      animationFrame.mockRestore();
      vi.useRealTimers();
    }
  });

  it("snapshots previous session from core session lifecycle events", () => {
    const events = createEvents();
    const runtime = new ChatCardRuntime({
      events,
      getAnnotations: () => ({}),
      setPendingRestore: () => null
    });

    runtime.registerType({
      kind: "tools",
      annotationKey: "tools",
      restoreEvent: "toolcards/restore",
      clearEvent: "toolcards/clear",
      snapshotEvent: "toolcards/snapshot"
    });

    const disp = runtime.attachSessionLifecycle();
    events.emit("session/beforeSwitch", {
      panelId: "panel-a",
      previousSessionId: "session-a",
      sessionId: "session-b"
    });
    disp.dispose();

    expect(events.emitted).toEqual([
      {
        topic: "session/beforeSwitch",
        payload: { panelId: "panel-a", previousSessionId: "session-a", sessionId: "session-b" }
      },
      { topic: "toolcards/snapshot", payload: { panelId: "panel-a", sessionId: "session-a" } }
    ]);
  });
});
