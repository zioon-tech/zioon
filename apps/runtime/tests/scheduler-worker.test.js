import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresSchedulerStore } from "../src/postgres-scheduler-store.mjs";
import { RuntimeSchedulerWorker } from "../src/scheduler-worker.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let database;

beforeAll(async () => {
  database = await createPostgresTestDatabase("scheduler_worker");
});

afterAll(async () => {
  await database.close();
});

describe("RuntimeSchedulerWorker", () => {
  it("persists a scheduled Agent as a canonical Session conversation", async () => {
    const spaceId = database.nextSpaceId();
    const runs = new PostgresRunStore(database.pool, { spaceId });
    const scheduler = new PostgresSchedulerStore(database.pool, { spaceId });
    try {
      scheduler.setAvailableTools([]);
      const task = await scheduler.createTask({
        taskType: "agent",
        title: "Daily report",
        prompt: "Summarize",
        enabled: false,
        schedule: { kind: "daily", time: "09:00" },
        capability: { preset: "read-only", allowedTools: [] }
      });
      const queued = await scheduler.runNow(task.id);
      const executor = createAgentExecutor({
        engine: {
          id: "scheduler-session-test",
          async *streamTurn() {
            yield { type: "message.delta", delta: "scheduled answer" };
          }
        },
        tools: {
          async listTools() { return []; },
          async invoke() { throw new Error("No tools configured"); }
        },
        runs,
        scheduleTimeout(callback, timeoutMs) {
          const timer = setTimeout(callback, timeoutMs);
          return { dispose: () => clearTimeout(timer) };
        }
      });
      const worker = new RuntimeSchedulerWorker({
        executor,
        scheduler,
        sessions: runs,
        tools: { invoke: vi.fn() },
        workerId: "runtime-worker"
      });

      await worker.pollOnce();

      const completed = await scheduler.getRun(queued.id);
      expect(completed.error).toBeNull();
      expect(completed).toMatchObject({
        status: "success",
        sessionId: expect.stringMatching(/^scheduler_session_/),
        chatRunId: expect.stringMatching(/^run_/)
      });
      await expect(runs.getSession(completed.sessionId)).resolves.toMatchObject({
        title: "Daily report",
        metadata: expect.objectContaining({
          source: "scheduled-task",
          schedulerRunId: queued.id
        })
      });
      await expect(runs.getSessionTranscript(completed.sessionId)).resolves.toEqual([
        expect.objectContaining({ role: "user", content: "Summarize" }),
        expect.objectContaining({ role: "assistant", content: "scheduled answer" })
      ]);
    } finally {
      await scheduler.close();
      await runs.close();
    }
  });

  it("claims and completes an Agent task without a Workbench", async () => {
    const scheduler = {
      tick: vi.fn(),
      claim: vi.fn(() => ({
        id: "scheduler-run-1",
        taskId: "scheduler-task-1",
        scheduledFor: 123,
        task: {
          taskType: "agent",
          title: "Daily report",
          prompt: "Summarize",
          nodeId: "node:cloud-runtime",
          interactionProfileId: "scheduled.default",
          modelProfileId: "workbench.deepseek.deepseek-v4-flash",
          timeoutSeconds: 60,
          capability: {
            preset: "read-only",
            allowedTools: ["read"]
          }
        }
      })),
      appendEvent: vi.fn(),
      linkSession: vi.fn(),
      complete: vi.fn()
    };
    const executor = {
      execute: vi.fn(() => ({
        runId: "runtime-run-1",
        attemptId: "runtime-attempt-1",
        abort: vi.fn(),
        completion: Promise.resolve({
          runId: "runtime-run-1",
          attemptId: "runtime-attempt-1",
          status: "completed",
          output: "done",
          usage: { inputTokens: 4, outputTokens: 2 }
        }),
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "run.started", timestamp: 10, sequence: 1 };
            yield { type: "message.delta", timestamp: 11, sequence: 2 };
            yield { type: "run.completed", timestamp: 12, sequence: 3 };
          }
        }
      }))
    };
    const resolveRequest = vi.fn((request) => ({
      model: {
        profileId: "workbench.deepseek.deepseek-v4-flash",
        providerId: "deepseek",
        modelId: "deepseek-v4-flash"
      },
      policy: {
        ...request.policy,
        maxToolCalls: 30
      },
      metadata: {
        ...request.metadata,
        contextProviders: {
          enabled: ["dev.identity.context"],
          disabled: []
        }
      }
    }));
    const sessions = {
      createSession: vi.fn(async () => {}),
      appendSessionMessages: vi.fn(async () => []),
      reconcileCompletedSessionMessages: vi.fn(async () => [])
    };
    const worker = new RuntimeSchedulerWorker({
      executor,
      workerId: "runtime-worker-1",
      scheduler,
      sessions,
      tools: { invoke: vi.fn() },
      resolveRequest
    });

    await expect(worker.pollOnce()).resolves.toMatchObject({
      id: "scheduler-run-1"
    });

    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      title: "Daily report",
      prompt: "Summarize",
      sessionId: expect.stringMatching(/^scheduler_session_/),
      interactionProfileId: "scheduled.default",
      timeoutMs: 60_000,
      target: { nodeId: "node:cloud-runtime" },
      model: {
        profileId: "workbench.deepseek.deepseek-v4-flash",
        providerId: "deepseek",
        modelId: "deepseek-v4-flash"
      },
      policy: {
        preset: "read-only",
        allowedTools: ["read"],
        maxToolCalls: 30
      },
      metadata: {
        source: "scheduler-worker",
        interactionProfileId: "scheduled.default",
        schedulerRunId: "scheduler-run-1",
        schedulerTaskId: "scheduler-task-1",
        scheduledFor: 123,
        contextProviders: {
          enabled: ["dev.identity.context"],
          disabled: []
        }
      }
    }));
    expect(resolveRequest).toHaveBeenCalledWith(expect.objectContaining({
      interactionProfileId: "scheduled.default",
      model: {
        profileId: "workbench.deepseek.deepseek-v4-flash"
      },
      policy: {
        preset: "read-only",
        allowedTools: ["read"]
      },
      metadata: expect.objectContaining({
        source: "scheduler-worker",
        schedulerTaskId: "scheduler-task-1"
      }),
      target: { nodeId: "node:cloud-runtime" }
    }));
    expect(scheduler.tick).toHaveBeenCalledOnce();
    expect(scheduler.claim).toHaveBeenCalledWith({
      workerId: "runtime-worker-1",
      workerKind: "runtime",
      leaseSeconds: 600,
      availableTools: ["read", "glob", "grep", "tree"]
    });
    expect(scheduler.appendEvent).toHaveBeenCalledTimes(2);
    expect(scheduler.linkSession).toHaveBeenCalledWith(
      "scheduler-run-1",
      "runtime-worker-1",
      {
        sessionId: expect.stringMatching(/^scheduler_session_/),
        chatRunId: "runtime-run-1"
      }
    );
    expect(scheduler.complete).toHaveBeenCalledWith(
      "scheduler-run-1",
      "runtime-worker-1",
      expect.objectContaining({
        status: "success",
        chatRunId: "runtime-run-1",
        sessionId: expect.stringMatching(/^scheduler_session_/),
        output: "done"
      })
    );
    expect(sessions.createSession).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^scheduler_session_/),
      title: "Daily report",
      metadata: expect.objectContaining({
        source: "scheduled-task",
        schedulerTaskId: "scheduler-task-1",
        schedulerRunId: "scheduler-run-1"
      })
    }));
    expect(sessions.appendSessionMessages).toHaveBeenCalledWith(
      expect.stringMatching(/^scheduler_session_/),
      [expect.objectContaining({
        role: "user",
        content: "Summarize",
        runId: "runtime-run-1"
      })]
    );
    expect(sessions.reconcileCompletedSessionMessages).toHaveBeenCalledOnce();
  });

  it("fails an Agent task when every attempted tool call fails", async () => {
    const scheduler = {
      tick: vi.fn(),
      claim: vi.fn(() => ({
        id: "scheduler-run-failed-tools",
        taskId: "scheduler-task-failed-tools",
        task: {
          taskType: "agent",
          title: "Daily report",
          prompt: "Write the report",
          capability: {
            preset: "trusted-automation",
            allowedTools: ["Bash"]
          }
        }
      })),
      appendEvent: vi.fn(),
      complete: vi.fn()
    };
    const executor = {
      execute: vi.fn(() => ({
        runId: "runtime-run-failed-tools",
        completion: Promise.resolve({
          runId: "runtime-run-failed-tools",
          status: "completed",
          output: "The task could not be executed."
        }),
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "tool.requested",
              sequence: 1,
              data: { name: "Bash" }
            };
            yield {
              type: "tool.completed",
              sequence: 2,
              data: {
                name: "Bash",
                ok: false,
                error: "Ambiguous Node/resource target"
              }
            };
            yield { type: "run.completed", sequence: 3 };
          }
        }
      }))
    };
    const worker = new RuntimeSchedulerWorker({
      executor,
      scheduler,
      tools: { invoke: vi.fn() },
      workerId: "runtime-worker-1"
    });

    await worker.pollOnce();

    expect(scheduler.complete).toHaveBeenCalledWith(
      "scheduler-run-failed-tools",
      "runtime-worker-1",
      expect.objectContaining({
        status: "failed",
        output: "The task could not be executed.",
        error: "All 1 tool calls failed: Ambiguous Node/resource target"
      })
    );
  });

  it("inherits the scheduled interaction profile model when no task override exists", async () => {
    const scheduler = {
      tick: vi.fn(),
      claim: vi.fn(() => ({
        id: "scheduler-run-default-model",
        taskId: "scheduler-task-default-model",
        scheduledFor: 456,
        task: {
          taskType: "agent",
          title: "Default model report",
          prompt: "Summarize",
          timeoutSeconds: 60,
          capability: {
            preset: "read-only",
            allowedTools: []
          }
        }
      })),
      appendEvent: vi.fn(),
      complete: vi.fn()
    };
    const executor = {
      execute: vi.fn(() => ({
        runId: "runtime-run-default-model",
        completion: Promise.resolve({
          runId: "runtime-run-default-model",
          status: "completed",
          output: "done"
        }),
        events: {
          async *[Symbol.asyncIterator]() {}
        }
      }))
    };
    const resolveRequest = vi.fn((request) => ({
      model: {
        profileId: "workbench.default",
        providerId: "openai",
        modelId: "default-model"
      },
      policy: request.policy,
      metadata: request.metadata
    }));
    const worker = new RuntimeSchedulerWorker({
      executor,
      scheduler,
      tools: { invoke: vi.fn() },
      resolveRequest
    });

    await worker.pollOnce();

    expect(resolveRequest).toHaveBeenCalledWith(expect.objectContaining({
      interactionProfileId: "scheduled.default"
    }));
    expect(resolveRequest.mock.calls[0][0]).not.toHaveProperty("model");
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      model: {
        profileId: "workbench.default",
        providerId: "openai",
        modelId: "default-model"
      }
    }));
  });

  it("executes a claimed command task through the Runtime Tool Broker", async () => {
    const scheduler = {
      tick: vi.fn(),
      claim: vi.fn(() => ({
        id: "scheduler-command-1",
        taskId: "task-command-1",
        task: {
          taskType: "command",
          title: "Project check",
          nodeId: "node:cloud-runtime",
          command: "npm test",
          cwd: "/workspace/project",
          timeoutSeconds: 60,
          capability: {
            preset: "trusted-automation",
            allowedTools: ["Bash"],
            allowedCommandPrefixes: ["npm test"]
          }
        }
      })),
      appendEvent: vi.fn(),
      complete: vi.fn()
    };
    const executor = { execute: vi.fn() };
    const tools = {
      invoke: vi.fn(async () => ({
        ok: true,
        content: JSON.stringify({
          ok: true,
          exit_code: 0,
          stdout: "passed\n",
          stderr: ""
        })
      }))
    };
    const worker = new RuntimeSchedulerWorker({
      executor,
      scheduler,
      tools,
      workerId: "runtime-worker-1"
    });

    await worker.pollOnce();

    expect(executor.execute).not.toHaveBeenCalled();
    expect(tools.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: "scheduler:scheduler-command-1:command",
        target: { nodeId: "node:cloud-runtime" },
        policy: expect.objectContaining({
          preset: "trusted-automation",
          allowedTools: ["Bash"]
        }),
        toolCall: expect.objectContaining({
          name: "Bash",
          arguments: expect.objectContaining({
            command: "npm test",
            cwd: "/workspace/project",
            timeout: 60_000
          })
        })
      }),
      expect.objectContaining({ cancelled: false })
    );
    expect(scheduler.complete).toHaveBeenCalledWith(
      "scheduler-command-1",
      "runtime-worker-1",
      expect.objectContaining({
        status: "success",
        output: "passed\n"
      })
    );
  });

  it("refreshes advertised tools before every Scheduler claim", async () => {
    let available = ["read"];
    const scheduler = {
      tick: vi.fn(),
      claim: vi.fn(() => null),
      complete: vi.fn()
    };
    const worker = new RuntimeSchedulerWorker({
      executor: { execute: vi.fn() },
      scheduler,
      tools: { invoke: vi.fn() },
      workerId: "runtime-worker-1",
      availableTools: () => available
    });

    await worker.claim();
    available = ["read", "grep"];
    await worker.claim();

    expect(scheduler.claim.mock.calls.map(([input]) => input.availableTools))
      .toEqual([["read"], ["read", "grep"]]);
  });
});
