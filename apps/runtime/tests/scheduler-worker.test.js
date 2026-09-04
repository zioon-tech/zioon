import { describe, expect, it, vi } from "vitest";
import { RuntimeSchedulerWorker } from "../src/scheduler-worker.mjs";

describe("RuntimeSchedulerWorker", () => {
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
          interactionProfileId: "scheduled.default",
          timeoutSeconds: 60,
          capability: {
            preset: "read-only",
            allowedTools: ["read"]
          }
        }
      })),
      appendEvent: vi.fn(),
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
    const worker = new RuntimeSchedulerWorker({
      executor,
      workerId: "runtime-worker-1",
      scheduler,
      tools: { invoke: vi.fn() }
    });

    await expect(worker.pollOnce()).resolves.toMatchObject({
      id: "scheduler-run-1"
    });

    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      title: "Daily report",
      prompt: "Summarize",
      interactionProfileId: "scheduled.default",
      timeoutMs: 60_000,
      policy: {
        preset: "read-only",
        allowedTools: ["read"]
      },
      metadata: {
        source: "scheduler-worker",
        interactionProfileId: "scheduled.default",
        schedulerRunId: "scheduler-run-1",
        schedulerTaskId: "scheduler-task-1",
        scheduledFor: 123
      }
    }));
    expect(scheduler.tick).toHaveBeenCalledOnce();
    expect(scheduler.claim).toHaveBeenCalledWith({
      workerId: "runtime-worker-1",
      workerKind: "runtime",
      leaseSeconds: 600,
      availableTools: ["read", "glob", "grep", "tree"]
    });
    expect(scheduler.appendEvent).toHaveBeenCalledTimes(2);
    expect(scheduler.complete).toHaveBeenCalledWith(
      "scheduler-run-1",
      "runtime-worker-1",
      expect.objectContaining({
        status: "success",
        chatRunId: "runtime-run-1",
        output: "done"
      })
    );
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
