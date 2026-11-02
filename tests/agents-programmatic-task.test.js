import { afterEach, describe, expect, it, vi } from "vitest";
import { activate } from "../extensions/dev.agents/main.js";
import {
  buildProgrammaticTaskBody,
  programmaticCompletionState,
  programmaticEventLogEntry
} from "../extensions/dev.agents/programmatic-task-core.js";

describe("programmatic Agent task state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    delete window.zion;
  });

  it("builds a live Agent transcript from prompt and partial output", () => {
    expect(buildProgrammaticTaskBody("research", "partial")).toBe(
      "user research\n\nassistant partial"
    );
  });

  it("converts programmatic run events into compact trace entries", () => {
    expect(programmaticEventLogEntry({
      eventId: "event-1",
      type: "tool.requested",
      ts: 10,
      data: { callId: "call-1", name: "webSearch" }
    })).toEqual({
      id: "event-1",
      type: "tool.requested",
      ts: 10,
      message: "webSearch",
      callId: "call-1"
    });
    expect(programmaticEventLogEntry({
      eventId: "event-2",
      type: "tool.denied",
      ts: 20,
      data: { name: "Bash", reason: "command is outside allowed prefixes" }
    })).toEqual({
      id: "event-2",
      type: "tool.denied",
      ts: 20,
      message: "Bash · command is outside allowed prefixes",
      callId: ""
    });
    expect(programmaticEventLogEntry({
      eventId: "event-3",
      type: "message.delta",
      ts: 30,
      data: { delta: "partial" }
    })).toBeNull();
  });

  it("normalizes completion, failure, user abort, and timeout states", () => {
    expect(programmaticCompletionState({ status: "completed" })).toEqual({
      status: "done",
      error: ""
    });
    expect(programmaticCompletionState({
      status: "failed",
      error: "provider unavailable"
    })).toEqual({
      status: "error",
      error: "provider unavailable"
    });
    expect(programmaticCompletionState({
      status: "aborted",
      reason: "user"
    })).toEqual({
      status: "aborted",
      error: ""
    });
    expect(programmaticCompletionState({
      status: "aborted",
      reason: "timeout"
    })).toEqual({
      status: "error",
      error: "运行超时"
    });
  });

  it("streams a programmatic run into the Agent body and a linked session", async () => {
    let releaseRun;
    const runGate = new Promise((resolve) => {
      releaseRun = resolve;
    });
    const state = new Map();
    const commandCalls = [];
    window.zion = {
      state: {
        get: vi.fn((key) => state.get(key)),
        set: vi.fn((key, value) => state.set(key, value))
      },
      events: { emit: vi.fn() },
      commands: {
        registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
        executeCommand: vi.fn(async (name, args) => {
          commandCalls.push({ name, args });
          if (name === "zion.sessions.new") return "agent-run-session";
          return true;
        })
      },
      chat: {
        execute: vi.fn(() => ({
          runId: "chat-run-1",
          abort: vi.fn(async () => {}),
          completion: runGate.then(() => ({
            runId: "chat-run-1",
            status: "completed",
            output: "partial result"
          })),
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                eventId: "event-start",
                runId: "chat-run-1",
                type: "run.started",
                ts: 10,
                data: {}
              };
              yield {
                eventId: "event-token",
                runId: "chat-run-1",
                type: "message.delta",
                ts: 20,
                data: { delta: "partial result" }
              };
              yield {
                eventId: "event-tool",
                runId: "chat-run-1",
                type: "tool.requested",
                ts: 30,
                data: { callId: "call-1", name: "webSearch", args: { query: "zion" } }
              };
              await runGate;
              yield {
                eventId: "event-complete",
                runId: "chat-run-1",
                type: "run.completed",
                ts: 40,
                data: { output: "partial result" }
              };
            }
          }
        }))
      }
    };

    const disposable = await activate({ subscriptions: [] });
    const task = window.zion.agents.createTask({
      id: "project-task-1",
      title: "Project research",
      prompt: "research",
      status: "idle",
      executionPolicy: { preset: "read-only", allowedTools: [] },
      events: []
    });
    const running = window.zion.agents.runTaskHeadless(task.id);

    let liveAssertionError = null;
    try {
      await vi.waitFor(() => {
        expect(String(window.zion.agents.getTask(task.id)?.body || "")).toContain(
          "assistant partial result"
        );
      });
    } catch (error) {
      liveAssertionError = error;
    } finally {
      releaseRun();
    }

    const result = await running;
    if (liveAssertionError) throw liveAssertionError;
    const completed = window.zion.agents.getTask(task.id);
    expect(result.ok).toBe(true);
    expect(completed).toMatchObject({
      linkedSessionId: "agent-run-session",
      taskSessionId: "agent-run-session",
      status: "done",
      error: ""
    });
    expect(completed.body).toContain("assistant partial result");
    expect(completed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.requested",
        message: "webSearch"
      })
    ]));
    expect(commandCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "zion.sessions.new" }),
      expect.objectContaining({ name: "zion.sessions.appendAssistantToken" }),
      expect.objectContaining({ name: "zion.sessions.patchMeta" })
    ]));
    disposable.dispose();
  });

  it("persists a failed programmatic run as an Agent error", async () => {
    const state = new Map();
    window.zion = {
      state: {
        get: vi.fn((key) => state.get(key)),
        set: vi.fn((key, value) => state.set(key, value))
      },
      events: { emit: vi.fn() },
      commands: {
        registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
        executeCommand: vi.fn(async (name) => (
          name === "zion.sessions.new" ? "failed-run-session" : true
        ))
      },
      chat: {
        execute: vi.fn(() => ({
          runId: "chat-run-failed",
          abort: vi.fn(async () => {}),
          completion: Promise.resolve({
            runId: "chat-run-failed",
            status: "failed",
            error: "provider unavailable",
            output: "partial evidence"
          }),
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                eventId: "event-start",
                runId: "chat-run-failed",
                type: "run.started",
                ts: 10,
                data: {}
              };
              yield {
                eventId: "event-token",
                runId: "chat-run-failed",
                type: "message.delta",
                ts: 20,
                data: { delta: "partial evidence" }
              };
              yield {
                eventId: "event-failed",
                runId: "chat-run-failed",
                type: "run.failed",
                ts: 30,
                data: { error: "provider unavailable" }
              };
            }
          }
        }))
      }
    };

    const disposable = await activate({ subscriptions: [] });
    const task = window.zion.agents.createTask({
      id: "project-task-failed",
      title: "Failed project research",
      prompt: "research",
      status: "idle",
      executionPolicy: { preset: "read-only", allowedTools: [] },
      events: []
    });

    const result = await window.zion.agents.runTaskHeadless(task.id);
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      task: expect.objectContaining({
        status: "error",
        error: "provider unavailable"
      })
    }));
    expect(window.zion.agents.getTask(task.id)).toEqual(expect.objectContaining({
      status: "error",
      activeRunId: "",
      linkedSessionId: "failed-run-session",
      error: "provider unavailable",
      body: expect.stringContaining("partial evidence")
    }));
    expect(window.zion.agents.isRunning(task.id)).toBe(false);
    disposable.dispose();
  });

  it("runs a newly created task when localStorage persistence is unavailable", async () => {
    const nativeSetItem = globalThis.Storage.prototype.setItem;
    vi.spyOn(globalThis.Storage.prototype, "setItem").mockImplementation(function setItem(key, value) {
      if (key === "zion.agents.tasks.v1") {
        throw new globalThis.DOMException("quota exceeded", "QuotaExceededError");
      }
      return nativeSetItem.call(this, key, value);
    });
    const state = new Map();
    window.zion = {
      state: {
        get: vi.fn((key) => state.get(key)),
        set: vi.fn((key, value) => state.set(key, value))
      },
      events: { emit: vi.fn() },
      commands: {
        registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
        executeCommand: vi.fn(async (name) => (
          name === "zion.sessions.new" ? "quota-run-session" : true
        ))
      },
      chat: {
        execute: vi.fn(() => ({
          runId: "chat-run-quota",
          abort: vi.fn(async () => {}),
          completion: Promise.resolve({
            runId: "chat-run-quota",
            status: "completed",
            output: "completed despite quota"
          }),
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                eventId: "event-start",
                runId: "chat-run-quota",
                type: "run.started",
                ts: 10,
                data: {}
              };
              yield {
                eventId: "event-complete",
                runId: "chat-run-quota",
                type: "run.completed",
                ts: 20,
                data: { output: "completed despite quota" }
              };
            }
          }
        }))
      }
    };

    const disposable = await activate({ subscriptions: [] });
    const task = window.zion.agents.createTask({
      id: "project-task-quota",
      title: "Quota-safe project task",
      prompt: "research",
      status: "idle",
      executionPolicy: { preset: "read-only", allowedTools: [] },
      events: []
    });

    await expect(window.zion.agents.runTaskHeadless(task.id)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        task: expect.objectContaining({ status: "done" })
      })
    );
    expect(state.get("agents.tasks")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: task.id,
        status: "done"
      })
    ]));
    disposable.dispose();
  });
});
