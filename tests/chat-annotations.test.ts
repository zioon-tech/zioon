import { describe, expect, it } from "vitest";
import { createChatAnnotationsApi } from "../src/chat/annotations";

function createState(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T = unknown>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    set<T = unknown>(key: string, value: T): void {
      map.set(key, value);
    }
  };
}

function createCommands() {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    registerCommand(id: string, fn: (...args: any[]) => any) {
      handlers.set(id, fn);
      return { dispose: () => handlers.delete(id) };
    },
    executeCommand(id: string, ...args: any[]) {
      return handlers.get(id)?.(...args);
    }
  };
}

function createEvents() {
  const handlers = new Map<string, Set<(payload?: any) => void>>();
  return {
    emit(topic: string, payload?: any) {
      handlers.get(topic)?.forEach((fn) => fn(payload));
    },
    on(topic: string, fn: (payload?: any) => void) {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(fn);
      return { dispose: () => handlers.get(topic)?.delete(fn) };
    }
  };
}

describe("chat annotations api", () => {
  it("keeps existing edit/write args when a snapshot writes back an empty args object", () => {
    const state = createState({
      "sessions.annotations.s-edit": {
        tools: [
          { id: "edit-1", name: "edit", args: { path: "a.ts", old_string: "foo", new_string: "bar" }, result: "edit ok: a.ts", ok: true, expanded: false }
        ]
      }
    });
    const api = createChatAnnotationsApi({
      state,
      commands: createCommands(),
      events: createEvents()
    });

    // Simulate a post-wake snapshot re-synthesising the card from the doc anchor:
    // the mounted widget only knows its id/name, so it writes back an empty args object.
    api.mergeSessionAnnotations("s-edit", {
      tools: [{ id: "edit-1", name: "edit", args: {}, result: null, ok: null, expanded: false }]
    });

    const ann = api.getSessionAnnotations("s-edit");
    expect(ann.tools?.[0]).toMatchObject({
      id: "edit-1",
      args: { path: "a.ts", old_string: "foo", new_string: "bar" },
      result: "edit ok: a.ts",
      ok: true
    });
    api.dispose();
  });

  it("keeps explicit empty state arrays instead of falling back to stale meta or pending restore", () => {
    const state = createState({
      "sessions.annotations.s1": { tools: [], thinking: [] },
      "sessions.pendingRestore.tools.s1": [{ id: "pending-tool" }],
      "sessions.pendingRestore.thinking.s1": [{ id: "pending-thinking" }]
    });
    const commands = createCommands();
    const api = createChatAnnotationsApi({
      state,
      commands,
      events: { emit() {} },
      getSessionMeta: () => ({
        annotations: {
          tools: [{ id: "meta-tool" }],
          thinking: [{ id: "meta-thinking" }]
        }
      })
    });

    expect(api.getSessionAnnotations("s1").tools).toEqual([]);
    expect(api.getSessionAnnotations("s1").thinking).toEqual([]);
    api.dispose();
  });

  it("emits scoped clear and restore events for the target panel and session", () => {
    const emitted: Array<{ topic: string; payload: any }> = [];
    const state = createState();
    const commands = createCommands();
    const api = createChatAnnotationsApi({
      state,
      commands,
      events: {
        emit(topic, payload) {
          emitted.push({ topic, payload });
        }
      }
    });

    api.restoreSession({
      sessionId: "s2",
      panelId: "panel-2",
      annotations: {
        tools: [{ id: "tool-1" }],
        thinking: [{ id: "thinking-1" }]
      },
      clearFirst: true
    });

    expect(emitted).toEqual([
      { topic: "toolcards/clear", payload: { panelId: "panel-2", sessionId: "s2" } },
      { topic: "thinking/clear", payload: { panelId: "panel-2", sessionId: "s2" } },
      { topic: "toolcards/restore", payload: { items: [{ id: "tool-1" }], panelId: "panel-2", sessionId: "s2" } },
      { topic: "thinking/restore", payload: { items: [{ id: "thinking-1" }], panelId: "panel-2", sessionId: "s2" } }
    ]);
    api.dispose();
  });

  it("keeps richer live card payloads when restore receives stale persisted annotations", () => {
    const state = createState({
      "sessions.annotations.s2": {
        tools: [{ id: "tool-1", name: "read", args: { path: "fresh.txt" }, result: "fresh result", ok: true }],
        thinking: [{ id: "thinking-1", text: "fresh thinking", expanded: true }]
      }
    });
    const emitted: Array<{ topic: string; payload: any }> = [];
    const commands = createCommands();
    const api = createChatAnnotationsApi({
      state,
      commands,
      events: {
        emit(topic, payload) {
          emitted.push({ topic, payload });
        }
      }
    });

    api.restoreSession({
      sessionId: "s2",
      panelId: "panel-2",
      annotations: {
        tools: [{ id: "tool-1", name: "read", args: { path: "old.txt" }, result: null, ok: null }],
        thinking: [{ id: "thinking-1", text: "", expanded: false }]
      },
      clearFirst: false
    });

    const ann = api.getSessionAnnotations("s2");
    expect(ann.tools?.[0]).toMatchObject({
      id: "tool-1",
      args: { path: "fresh.txt" },
      result: "fresh result",
      ok: true
    });
    expect(ann.thinking?.[0]).toMatchObject({
      id: "thinking-1",
      text: "fresh thinking",
      expanded: true
    });
    expect(emitted).toContainEqual({
      topic: "toolcards/restore",
      payload: {
        items: [expect.objectContaining({ id: "tool-1", result: "fresh result" })],
        panelId: "panel-2",
        sessionId: "s2"
      }
    });
    api.dispose();
  });

  it("preserves existing widget payloads when an annotation update only patches sibling fields", () => {
    const state = createState({
      "sessions.annotations.s-patch": {
        tools: [{ id: "tool-1", name: "read", result: "kept", ok: true }],
        thinking: [{ id: "thinking-1", text: "kept thinking", expanded: true }]
      }
    });
    const api = createChatAnnotationsApi({
      state,
      commands: createCommands(),
      events: createEvents()
    });

    api.updateSessionAnnotations("s-patch", (prev) => ({
      ...prev,
      toolActions: { "tool-1": { action: "accept", at: 1 } }
    }));

    const ann = api.getSessionAnnotations("s-patch");
    expect(ann.tools?.[0]).toMatchObject({ id: "tool-1", result: "kept", ok: true });
    expect(ann.thinking?.[0]).toMatchObject({ id: "thinking-1", text: "kept thinking", expanded: true });
    expect(ann.toolActions?.["tool-1"]).toEqual({ action: "accept", at: 1 });
    api.dispose();
  });

  it("keeps tool card model in core from chat tool events before plugin snapshots", () => {
    const state = createState();
    const commands = createCommands();
    const events = createEvents();
    const api = createChatAnnotationsApi({ state, commands, events });

    events.emit("chat/toolCall", {
      sessionId: "s3",
      panelId: "panel-3",
      toolCall: { id: "call-1", name: "read", args: { path: "a.txt" } }
    });
    expect(api.getSessionAnnotations("s3").tools).toEqual([
      { id: "call-1", name: "read", args: { path: "a.txt" }, result: null, ok: null, expanded: false }
    ]);

    events.emit("chat/toolResult", {
      sessionId: "s3",
      toolCallId: "call-1",
      result: "ok",
      ok: true
    });
    expect(api.getSessionAnnotations("s3").tools?.[0]).toMatchObject({
      id: "call-1",
      result: "ok",
      ok: true
    });
    api.dispose();
  });

  it("keeps tool card updates scoped to the event session", () => {
    const state = createState();
    const commands = createCommands();
    const events = createEvents();
    const api = createChatAnnotationsApi({ state, commands, events });

    events.emit("chat/toolCall", {
      sessionId: "session-a",
      panelId: "panel-a",
      toolCall: { id: "shared-id", name: "read", args: { path: "a.txt" } }
    });
    events.emit("chat/toolCall", {
      sessionId: "session-b",
      panelId: "panel-b",
      toolCall: { id: "shared-id", name: "write", args: { path: "b.txt" } }
    });
    events.emit("chat/toolResult", {
      sessionId: "session-b",
      panelId: "panel-b",
      toolCallId: "shared-id",
      result: "b result",
      ok: true
    });

    expect(api.getSessionAnnotations("session-a").tools?.[0]).toMatchObject({
      id: "shared-id",
      name: "read",
      result: null,
      ok: null
    });
    expect(api.getSessionAnnotations("session-b").tools?.[0]).toMatchObject({
      id: "shared-id",
      name: "write",
      result: "b result",
      ok: true
    });
    api.dispose();
  });

  it("keeps thinking card model in core from reasoning events before plugin snapshots", () => {
    const state = createState({ "chat.thinkingVisible": true });
    const commands = createCommands();
    const events = createEvents();
    const api = createChatAnnotationsApi({ state, commands, events });

    events.emit("chat/runStarted", { sessionId: "s4", runId: "r1" });
    events.emit("chat/reasoningStart", { sessionId: "s4", runId: "r1" });
    events.emit("chat/reasoningToken", { sessionId: "s4", runId: "r1", token: "hello" });
    events.emit("chat/reasoningToken", { sessionId: "s4", runId: "r1", token: " world" });
    events.emit("chat/reasoningEnd", { sessionId: "s4", runId: "r1" });

    expect(api.getSessionAnnotations("s4").thinking).toEqual([
      { id: "thinking:r1:1", runId: "r1", segmentKey: "r1", text: "hello world", expanded: false }
    ]);
    api.dispose();
  });

  it("keeps reasoning buffers isolated by session even when run ids overlap", () => {
    const state = createState({ "chat.thinkingVisible": true });
    const commands = createCommands();
    const events = createEvents();
    const api = createChatAnnotationsApi({ state, commands, events });

    events.emit("chat/runStarted", { sessionId: "session-a", runId: "run-1" });
    events.emit("chat/runStarted", { sessionId: "session-b", runId: "run-1" });
    events.emit("chat/reasoningStart", { sessionId: "session-a", runId: "run-1" });
    events.emit("chat/reasoningStart", { sessionId: "session-b", runId: "run-1" });
    events.emit("chat/reasoningToken", { sessionId: "session-a", runId: "run-1", token: "A" });
    events.emit("chat/reasoningToken", { sessionId: "session-b", runId: "run-1", token: "B" });

    expect(api.getSessionAnnotations("session-a").thinking).toEqual([
      { id: "thinking:run-1:1", runId: "run-1", segmentKey: "run-1", text: "A", expanded: false }
    ]);
    expect(api.getSessionAnnotations("session-b").thinking).toEqual([
      { id: "thinking:run-1:1", runId: "run-1", segmentKey: "run-1", text: "B", expanded: false }
    ]);
    api.dispose();
  });
});
