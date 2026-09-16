import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRunStore } from "../src/sqlite-run-store.mjs";

const temporaryDirectories = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "zion-runtime-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime.sqlite3");
}

function runRecord(id = "run-1") {
  return {
    id,
    attemptId: "attempt-1",
    status: "queued",
    title: "test",
    policy: { allowedTools: [], maxToolCalls: 10 },
    metadata: {},
    createdAt: 1000,
    updatedAt: 1000
  };
}

function runEvent(sequence, type, data = {}) {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    runId: "run-1",
    attemptId: "attempt-1",
    sequence,
    type,
    timestamp: 1000 + sequence,
    data
  };
}

function sessionRecord(id = "session-1") {
  return {
    id,
    status: "active",
    title: "Conversation",
    policy: {
      allowedTools: [],
      maxToolCalls: 10,
      fileRoots: [],
      allowedTerminalSessionIds: []
    },
    metadata: {},
    createdAt: 1000,
    updatedAt: 1000
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteRunStore", () => {
  it("lists recent Runs by status with a stable bound", async () => {
    const store = new SqliteRunStore(databasePath());
    await store.create({
      ...runRecord("run-old"),
      status: "failed",
      updatedAt: 1000
    });
    await store.create({
      ...runRecord("run-completed"),
      status: "completed",
      updatedAt: 3000
    });
    await store.create({
      ...runRecord("run-failed"),
      status: "failed",
      updatedAt: 4000
    });

    await expect(store.listRuns({
      since: 2000,
      statuses: ["failed", "completed"],
      limit: 1
    })).resolves.toEqual([
      expect.objectContaining({ id: "run-failed", status: "failed" })
    ]);
    expect(store.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'runtime_runs_status_updated'
    `).get()).toEqual({ name: "runtime_runs_status_updated" });
    store.close();
  });

  it("updates mutable Session configuration without replacing identity", async () => {
    const store = new SqliteRunStore(databasePath());
    await store.createSession(sessionRecord());

    await expect(store.updateSession("session-1", {
      model: {
        profileId: "model-next",
        providerId: "provider",
        modelId: "next"
      },
      policy: {
        allowedTools: ["read"],
        maxToolCalls: 20,
        fileRoots: [],
        allowedTerminalSessionIds: []
      },
      metadata: {
        skills: {
          enabled: ["writer"]
        }
      }
    }, 2000)).resolves.toMatchObject({
      id: "session-1",
      createdAt: 1000,
      updatedAt: 2000,
      model: {
        profileId: "model-next"
      },
      policy: {
        allowedTools: ["read"]
      },
      metadata: {
        skills: {
          enabled: ["writer"]
        }
      }
    });

    const path = store.path;
    store.close();
    const reopened = new SqliteRunStore(path);
    await expect(reopened.getSession("session-1")).resolves.toMatchObject({
      id: "session-1",
      model: {
        profileId: "model-next"
      },
      policy: {
        allowedTools: ["read"]
      }
    });
    reopened.close();
  });

  it("notifies subscribers after persisted Runtime events", async () => {
    const store = new SqliteRunStore(databasePath());
    const observed = [];
    const subscription = store.subscribeEvents((event) => {
      observed.push(event);
    });
    await store.create(runRecord());

    await store.append(runEvent(1, "model.request", {
      payload: {
        messages: [{ role: "user", content: "observe" }]
      }
    }));

    expect(observed).toEqual([
      expect.objectContaining({
        eventId: "event-1",
        runId: "run-1",
        type: "model.request"
      })
    ]);
    subscription.dispose();
    await store.append(runEvent(2, "message.delta", { delta: "done" }));
    expect(observed).toHaveLength(1);
    store.close();
  });

  it("persists tool invocation receipts and Runtime todo state", () => {
    const store = new SqliteRunStore(databasePath());
    const result = { ok: true, content: "done" };
    const saved = store.saveToolReceipt({
      invocationId: "invocation-1",
      runId: "run-1",
      toolName: "write",
      requestHash: "hash-1",
      result,
      completedAt: 123
    });
    const duplicate = store.saveToolReceipt({
      invocationId: "invocation-1",
      runId: "run-1",
      toolName: "write",
      requestHash: "hash-1",
      result: { ok: false, content: "must not replace" },
      completedAt: 456
    });

    expect(saved).toMatchObject({
      duplicate: false,
      requestHash: "hash-1",
      result
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      completedAt: 123,
      result
    });
    expect(store.countToolReceipts("run-1", "write")).toBe(1);

    store.saveTodoList("session-1", [{
      id: "todo-1",
      content: "Run tests",
      status: "in_progress",
      activeForm: "Running tests"
    }], 789, {
      taskId: "task-1",
      sessionId: "session-1",
      runId: "run-1"
    });
    expect(store.getTodoList("session-1")).toMatchObject({
      taskId: "task-1",
      sessionId: "session-1",
      runId: "run-1",
      updatedAt: 789,
      todos: [{ id: "todo-1", content: "Run tests", status: "in_progress" }]
    });
    expect(store.listTodoLists()).toEqual([
      expect.objectContaining({
        ownerId: "session-1",
        taskId: "task-1"
      })
    ]);
    store.close();
  });

  it("persists runs and ordered events across process-like reopen", async () => {
    const path = databasePath();
    const first = new SqliteRunStore(path);
    await first.create(runRecord());
    await first.append(runEvent(1, "run.started"));
    await first.append(runEvent(2, "run.completed", { output: "done" }), {
      status: "completed",
      updatedAt: 1002,
      completedAt: 1002,
      terminalReason: "completed"
    });
    first.close();

    const reopened = new SqliteRunStore(path);
    await expect(reopened.get("run-1")).resolves.toMatchObject({
      id: "run-1",
      status: "completed",
      completedAt: 1002
    });
    await expect(reopened.getEvents("run-1", 1)).resolves.toEqual([
      expect.objectContaining({
        sequence: 2,
        type: "run.completed",
        data: { output: "done" }
      })
    ]);
    reopened.close();
  });

  it("rejects sequence gaps without partially updating the Run", async () => {
    const store = new SqliteRunStore(databasePath());
    await store.create(runRecord());

    await expect(store.append(runEvent(2, "run.completed"), {
      status: "completed",
      updatedAt: 1002,
      completedAt: 1002
    })).rejects.toThrow("expected 1, received 2");
    await expect(store.getEvents("run-1")).resolves.toEqual([]);
    await expect(store.get("run-1")).resolves.toMatchObject({
      status: "queued",
      updatedAt: 1000
    });
    store.close();
  });

  it("marks orphaned active Runs interrupted exactly once after restart", async () => {
    const path = databasePath();
    const first = new SqliteRunStore(path);
    await first.create(runRecord());
    await first.append(runEvent(1, "run.started"));
    first.close();

    const reopened = new SqliteRunStore(path);
    let nextId = 0;
    const interrupted = await reopened.reconcileActiveRuns({
      reason: "runtime-restart",
      now: () => 2000,
      createId: () => `recovery-event-${++nextId}`
    });

    expect(interrupted).toEqual([
      expect.objectContaining({
        id: "run-1",
        status: "interrupted",
        terminalReason: "runtime-restart",
        completedAt: 2000
      })
    ]);
    await expect(reopened.getEvents("run-1")).resolves.toEqual([
      expect.objectContaining({ sequence: 1, type: "run.started" }),
      expect.objectContaining({
        eventId: "recovery-event-1",
        sequence: 2,
        type: "run.interrupted",
        data: { reason: "runtime-restart" }
      })
    ]);
    await expect(reopened.reconcileActiveRuns({
      now: () => 3000,
      createId: () => "unexpected"
    })).resolves.toEqual([]);
    reopened.close();
  });

  it("persists the latest checkpoint across reopen", async () => {
    const path = databasePath();
    const first = new SqliteRunStore(path);
    await first.create(runRecord());
    await first.append(runEvent(1, "run.started"));
    await first.saveCheckpoint({
      schemaVersion: 1,
      runId: "run-1",
      attemptId: "attempt-1",
      sequence: 1,
      nextTurn: 2,
      messages: [
        { role: "user", content: "search" },
        {
          role: "tool",
          toolCallId: "call-1",
          content: "result"
        }
      ],
      output: "",
      usage: {
        inputTokens: 3,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      },
      counters: { toolCalls: 1 },
      maxTurns: 8,
      createdAt: 1001
    });
    first.close();

    const reopened = new SqliteRunStore(path);
    await expect(reopened.getLatestCheckpoint("run-1")).resolves.toMatchObject({
      attemptId: "attempt-1",
      sequence: 1,
      nextTurn: 2,
      counters: { toolCalls: 1 },
      messages: [
        { role: "user", content: "search" },
        { role: "tool", toolCallId: "call-1", content: "result" }
      ]
    });
    reopened.close();
  });

  it("persists ordered Session messages idempotently across reopen", async () => {
    const path = databasePath();
    const first = new SqliteRunStore(path);
    await first.createSession(sessionRecord());
    await first.create({
      ...runRecord(),
      sessionId: "session-1"
    });
    const userMessage = {
      schemaVersion: 1,
      id: "message-user",
      sessionId: "session-1",
      role: "user",
      content: "hello",
      runId: "run-1",
      createdAt: 1001
    };
    await first.appendSessionMessages("session-1", [userMessage]);
    await first.appendSessionMessages("session-1", [userMessage]);
    await first.appendSessionMessages("session-1", [{
      schemaVersion: 1,
      id: "message-assistant",
      sessionId: "session-1",
      role: "assistant",
      content: "hi",
      runId: "run-1",
      createdAt: 1002
    }]);
    await first.appendTranscript({
      schemaVersion: 1,
      id: "transcript-assistant-tool",
      runId: "run-1",
      attemptId: "attempt-1",
      turn: 1,
      ordinal: 0,
      role: "assistant",
      content: "",
      reasoningContent: "inspect",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"a.md\"}" }
      }],
      createdAt: 1001
    });
    await first.appendTranscript({
      schemaVersion: 1,
      id: "transcript-tool-result",
      runId: "run-1",
      attemptId: "attempt-1",
      turn: 1,
      ordinal: 1,
      role: "tool",
      content: "file contents",
      toolCallId: "call-1",
      createdAt: 1001
    });
    await first.appendTranscript({
      schemaVersion: 1,
      id: "transcript-assistant-final",
      runId: "run-1",
      attemptId: "attempt-1",
      turn: 2,
      ordinal: 0,
      role: "assistant",
      content: "hi",
      createdAt: 1002
    });
    first.close();

    const reopened = new SqliteRunStore(path);
    await expect(reopened.getSession("session-1")).resolves.toMatchObject({
      id: "session-1",
      updatedAt: 1002
    });
    await expect(reopened.getSessionMessages("session-1")).resolves.toEqual([
      expect.objectContaining({
        id: "message-user",
        sequence: 1,
        role: "user",
        content: "hello"
      }),
      expect.objectContaining({
        id: "message-assistant",
        sequence: 2,
        role: "assistant",
        content: "hi"
      })
    ]);
    await expect(reopened.getTranscript("run-1")).resolves.toEqual([
      expect.objectContaining({
        id: "transcript-assistant-tool",
        turn: 1,
        ordinal: 0,
        reasoningContent: "inspect"
      }),
      expect.objectContaining({
        id: "transcript-tool-result",
        turn: 1,
        ordinal: 1,
        toolCallId: "call-1"
      }),
      expect.objectContaining({
        id: "transcript-assistant-final",
        turn: 2,
        ordinal: 0,
        content: "hi"
      })
    ]);
    await expect(reopened.getSessionTranscript("session-1")).resolves.toEqual([
      expect.objectContaining({
        sequence: 1,
        role: "user",
        content: "hello"
      }),
      expect.objectContaining({
        sequence: 2,
        role: "assistant",
        reasoningContent: "inspect"
      }),
      expect.objectContaining({
        sequence: 3,
        role: "tool",
        toolCallId: "call-1",
        content: "file contents"
      }),
      expect.objectContaining({
        sequence: 4,
        role: "assistant",
        content: "hi"
      })
    ]);
    reopened.close();
  });

  it("persists idempotent Session message command receipts", async () => {
    const path = databasePath();
    const store = new SqliteRunStore(path);
    await store.createSession(sessionRecord());

    expect(store.reserveSessionMessageCommand(
      "session-1",
      "mobile-request-1",
      1100
    )).toMatchObject({
      reserved: true,
      command: {
        status: "submitting",
        clientRequestId: "mobile-request-1"
      }
    });
    expect(store.reserveSessionMessageCommand(
      "session-1",
      "mobile-request-1",
      1200
    )).toMatchObject({
      reserved: false,
      command: { status: "submitting" }
    });

    store.completeSessionMessageCommand(
      "session-1",
      "mobile-request-1",
      { runId: "run-1", status: "accepted" },
      1300
    );
    store.close();

    const reopened = new SqliteRunStore(path);
    expect(reopened.getSessionMessageCommand(
      "session-1",
      "mobile-request-1"
    )).toMatchObject({
      status: "accepted",
      response: {
        runId: "run-1",
        status: "accepted"
      },
      createdAt: 1100,
      updatedAt: 1300
    });
    reopened.close();
  });

  it("forks a Session while sharing immutable Run transcript history", async () => {
    const store = new SqliteRunStore(databasePath());
    await store.createSession(sessionRecord());
    await store.create({
      ...runRecord(),
      sessionId: "session-1"
    });
    await store.saveSessionSeedTranscript("session-1", [{
      role: "user",
      content: "earlier"
    }, {
      role: "assistant",
      content: "earlier reply"
    }], 900);
    await store.saveSessionSeedTranscript("session-1", [{
      role: "user",
      content: "must not replace"
    }], 950);
    expect(store.getSessionSeedTranscript("session-1")).toEqual([
      expect.objectContaining({ role: "user", content: "earlier" }),
      expect.objectContaining({ role: "assistant", content: "earlier reply" })
    ]);
    await store.appendSessionMessages("session-1", [{
      schemaVersion: 1,
      id: "source-user",
      sessionId: "session-1",
      role: "user",
      content: "inspect",
      runId: "run-1",
      createdAt: 1001
    }, {
      schemaVersion: 1,
      id: "source-assistant",
      sessionId: "session-1",
      role: "assistant",
      content: "done",
      runId: "run-1",
      createdAt: 1002
    }]);
    await store.appendTranscript({
      schemaVersion: 1,
      id: "source-run-transcript",
      runId: "run-1",
      attemptId: "attempt-1",
      turn: 1,
      ordinal: 0,
      role: "assistant",
      content: "done",
      reasoningContent: "checked",
      createdAt: 1002
    });
    let messageId = 0;

    await expect(store.forkSession("session-1", {
      id: "session-fork",
      title: "Forked",
      createdAt: 2000,
      createId: () => `fork-message-${++messageId}`
    })).resolves.toMatchObject({
      session: {
        id: "session-fork",
        title: "Forked",
        metadata: {
          forkedFrom: {
            sessionId: "session-1",
            transcriptSequence: 4,
            forkedAt: 2000
          }
        }
      },
      copiedSeedTranscriptEntries: 2,
      copiedMessages: 2,
      copiedTranscriptEntries: 4
    });
    await expect(store.getSessionTranscript("session-fork")).resolves.toEqual([
      expect.objectContaining({
        id: "seed:session-fork:1",
        sessionId: "session-fork",
        role: "user",
        content: "earlier"
      }),
      expect.objectContaining({
        id: "seed:session-fork:2",
        sessionId: "session-fork",
        role: "assistant",
        content: "earlier reply"
      }),
      expect.objectContaining({
        id: "fork-message-1",
        sessionId: "session-fork",
        role: "user",
        content: "inspect"
      }),
      expect.objectContaining({
        id: "source-run-transcript",
        sessionId: "session-fork",
        role: "assistant",
        reasoningContent: "checked"
      })
    ]);
    store.close();
  });

  it("persists artifacts and changes by Run and Session", async () => {
    const path = databasePath();
    const store = new SqliteRunStore(path);
    await store.createSession(sessionRecord());
    await store.create({
      ...runRecord(),
      sessionId: "session-1"
    });
    await store.appendSessionMessages("session-1", [{
      schemaVersion: 1,
      id: "artifact-user",
      sessionId: "session-1",
      role: "user",
      content: "write a file",
      runId: "run-1",
      createdAt: 1001
    }]);
    store.saveRunArtifacts({
      runId: "run-1",
      invocationId: "invocation-1",
      artifacts: [{
        schemaVersion: 1,
        id: "artifact-1",
        runId: "run-1",
        invocationId: "invocation-1",
        toolCallId: "call-1",
        toolName: "write",
        kind: "file",
        uri: "/workspace/a.md",
        mediaType: "text/plain",
        createdAt: 1002
      }],
      changes: [{
        schemaVersion: 1,
        id: "change-1",
        artifactId: "artifact-1",
        runId: "run-1",
        invocationId: "invocation-1",
        toolCallId: "call-1",
        toolName: "write",
        operation: "created",
        path: "/workspace/a.md",
        after: "hello",
        addedLines: 1,
        removedLines: 0,
        createdAt: 1002
      }]
    });
    store.close();

    const reopened = new SqliteRunStore(path);
    expect(reopened.listRunArtifacts("run-1")).toMatchObject({
      artifacts: [expect.objectContaining({ id: "artifact-1" })],
      changes: [expect.objectContaining({ id: "change-1", after: "hello" })]
    });
    expect(reopened.listSessionArtifacts("session-1")).toMatchObject({
      artifacts: [expect.objectContaining({ uri: "/workspace/a.md" })],
      changes: [expect.objectContaining({ path: "/workspace/a.md" })]
    });
    reopened.close();
  });

  it("reconciles a completed Run into its Session exactly once", async () => {
    const path = databasePath();
    const store = new SqliteRunStore(path);
    await store.createSession(sessionRecord());
    await store.create({
      ...runRecord(),
      sessionId: "session-1"
    });
    await store.appendSessionMessages("session-1", [{
      schemaVersion: 1,
      id: "message-user",
      sessionId: "session-1",
      role: "user",
      content: "hello",
      runId: "run-1",
      createdAt: 1001
    }]);
    await store.append(runEvent(1, "run.completed", { output: "recovered" }), {
      status: "completed",
      updatedAt: 1002,
      completedAt: 1002,
      terminalReason: "completed",
      output: "recovered"
    });

    let nextId = 0;
    await expect(store.reconcileCompletedSessionMessages({
      now: () => 2000,
      createId: () => `message-recovered-${++nextId}`
    })).resolves.toEqual([
      expect.objectContaining({
        id: "message-recovered-1",
        sequence: 2,
        role: "assistant",
        content: "recovered"
      })
    ]);
    await expect(store.reconcileCompletedSessionMessages()).resolves.toEqual([]);
    store.close();
  });

  it("finds an active Run by canonical Session id", async () => {
    const store = new SqliteRunStore(databasePath());
    await store.create({
      ...runRecord("run-session"),
      sessionId: "session-1"
    });
    await expect(store.getActiveRunForSession("session-1")).resolves.toMatchObject({
      id: "run-session",
      sessionId: "session-1",
      status: "queued"
    });
    await expect(store.getActiveRunForSession("other")).resolves.toBeNull();
    store.close();
  });
});
