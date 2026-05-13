import { describe, expect, it } from "vitest";
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
