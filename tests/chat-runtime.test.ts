import { describe, expect, it, vi } from "vitest";
import { createChatRuntime } from "../src/chat/runtime";

function createState(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Map<string, Set<(next: unknown, prev: unknown) => void>>();
  return {
    get<T = unknown>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    set<T = unknown>(key: string, value: T): void {
      const prev = values.get(key);
      values.set(key, value);
      listeners.get(key)?.forEach((listener) => listener(value, prev));
    },
    onDidChange(key: string, listener: (next: unknown, prev: unknown) => void) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(listener);
      return { dispose: () => listeners.get(key)?.delete(listener) };
    }
  };
}

describe("createChatRuntime", () => {
  it("prevents an interrupted run from completing or clearing a newer run", () => {
    const state = createState({ "sessions.currentId": "session-1" });
    const runtime = createChatRuntime({
      state,
      events: { emit: vi.fn() },
      getSessionId: () => "session-1"
    });
    const oldController = { abort: vi.fn() };
    const newController = { abort: vi.fn() };

    runtime.beginRun("session-1", "run-old");
    runtime.setController("session-1", oldController, "run-old");
    runtime.stopSession("session-1");
    runtime.beginRun("session-1", "run-new");
    runtime.setController("session-1", newController, "run-new");

    expect(runtime.markAwaiting("session-1", "run-old")).toBe(false);
    expect(runtime.markError("session-1", new Error("late"), "run-old")).toBe(false);
    expect(runtime.setController("session-1", oldController, "run-old")).toBe(false);

    expect(runtime.getRunState("session-1")).toMatchObject({
      runId: "run-new",
      streaming: true,
      aborted: false,
      awaiting: false,
      error: false
    });
    expect(runtime.getController("session-1")).toBe(newController);
    expect(newController.abort).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("aborts and reports only the current run", () => {
    const state = createState({ "sessions.currentId": "session-1" });
    const emit = vi.fn();
    const runtime = createChatRuntime({
      state,
      events: { emit },
      getSessionId: () => "session-1"
    });
    const controller = { abort: vi.fn() };

    runtime.beginRun("session-1", "run-current");
    runtime.setController("session-1", controller, "run-current");
    runtime.stopSession("session-1");

    expect(controller.abort).toHaveBeenCalledOnce();
    expect(runtime.isRunActive("session-1", "run-current")).toBe(false);
    expect(runtime.getRunState("session-1")).toMatchObject({
      streaming: false,
      aborted: true,
      awaiting: true,
      error: false
    });
    expect(emit).toHaveBeenCalledWith("chat/aborted", {
      runId: "run-current",
      sessionId: "session-1"
    });

    state.set("chat.runs.session-1", {
      ...runtime.getRunState("session-1"),
      awaiting: false
    });
    expect(runtime.markAborted("session-1", "run-current")).toBe(true);
    expect(runtime.getRunState("session-1")?.awaiting).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("marks failed runs as unread terminal results", () => {
    const state = createState({ "sessions.currentId": "session-1" });
    const runtime = createChatRuntime({
      state,
      events: { emit: vi.fn() },
      getSessionId: () => "session-1"
    });

    runtime.beginRun("session-1", "run-failed");
    expect(runtime.markError("session-1", new Error("failed"), "run-failed")).toBe(true);

    expect(runtime.getRunState("session-1")).toMatchObject({
      streaming: false,
      aborted: false,
      awaiting: true,
      error: true
    });
    runtime.dispose();
  });

  it("aborts the previous controller when a newer run replaces it", () => {
    const state = createState({ "sessions.currentId": "session-1" });
    const runtime = createChatRuntime({
      state,
      events: { emit: vi.fn() },
      getSessionId: () => "session-1"
    });
    const previousController = { abort: vi.fn() };

    runtime.beginRun("session-1", "run-old");
    runtime.setController("session-1", previousController, "run-old");
    runtime.beginRun("session-1", "run-new");

    expect(previousController.abort).toHaveBeenCalledOnce();
    expect(runtime.getRunState("session-1")).toMatchObject({
      runId: "run-new",
      streaming: true,
      aborted: false
    });
    runtime.dispose();
  });
});
