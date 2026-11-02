import { describe, expect, it, vi } from "vitest";
import {
  buildAgentTaskMessages,
  createAgentRunnerPluginService,
  deriveAgentTaskPolicy
} from "../src/agent-runner-plugin-service.mjs";

function task(overrides = {}) {
  return {
    id: "task_1",
    title: "Inspect Runtime",
    agentId: "implementer",
    permissionMode: "accept-edits",
    tools: ["read", "search", "edit", "test"],
    disallowedTools: ["Bash"],
    prompt: "Check the Runtime boundary",
    anchorText: "Runtime migration notes",
    maxTurns: 5,
    ...overrides
  };
}

describe("Agent runner plugin service", () => {
  it("derives sub-agent policy from task hints without exceeding parent policy", () => {
    expect(deriveAgentTaskPolicy(task(), {
      profilePolicy: {
        preset: "trusted-automation",
        allowedTools: ["read", "grep", "glob", "webSearch", "edit", "write", "Bash", "agentsManage"],
        maxToolCalls: 50
      },
      parentPolicy: {
        preset: "workspace-write",
        allowedTools: ["agentsManage", "read", "grep", "edit", "Bash"],
        maxToolCalls: 20,
        fileRoots: ["/workspace/project"]
      }
    })).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["read", "grep", "edit"],
      maxToolCalls: 20,
      fileRoots: ["/workspace/project"],
      allowedCommandPrefixes: [],
      allowedTerminalSessionIds: []
    });

    expect(deriveAgentTaskPolicy(task({
      agentId: "researcher",
      permissionMode: "read-only",
      tools: ["read", "web"]
    }), {
      profilePolicy: {
        preset: "trusted-automation",
        allowedTools: ["read", "webSearch", "webFetch", "write"],
        maxToolCalls: 50
      },
      parentPolicy: {
        preset: "trusted-automation",
        allowedTools: ["read", "webSearch", "write"],
        maxToolCalls: 50
      }
    })).toMatchObject({
      preset: "read-only",
      allowedTools: ["read", "webSearch"]
    });
  });

  it("starts and aborts Runtime Runs through the injected executor", async () => {
    const abort = vi.fn(async () => {});
    const completion = Promise.resolve({
      runId: "runtime-run-1",
      status: "completed",
      output: "done",
      usage: null
    });
    const executor = {
      execute: vi.fn(() => ({
        runId: "runtime-run-1",
        attemptId: "attempt-1",
        completion,
        abort,
        events: {
          async *[Symbol.asyncIterator]() {}
        }
      }))
    };
    const service = createAgentRunnerPluginService({
      getExecutor: () => executor,
      interactionProfiles: {
        get: vi.fn((id) => id === "interactive.default" ? {
          id,
          modelProfileId: "profile-1",
          policy: {
            preset: "trusted-automation",
            allowedTools: ["read", "grep", "edit", "agentsManage"],
            maxToolCalls: 50
          }
        } : null)
      },
      resolveModel: vi.fn((ref) => ({
        profileId: ref.profileId,
        providerId: "test",
        modelId: "model"
      }))
    });

    const handle = service.startTaskRun(task(), {
      parentRunId: "parent-run",
      parentAttemptId: "parent-attempt",
      projectId: "project-1",
      policy: {
        preset: "workspace-write",
        allowedTools: ["agentsManage", "read", "grep", "edit"],
        maxToolCalls: 12
      }
    });

    expect(handle).toMatchObject({
      runId: "runtime-run-1",
      attemptId: "attempt-1",
      sessionId: "agent-task:task_1",
      policy: {
        preset: "workspace-write",
        allowedTools: ["read", "grep", "edit"],
        maxToolCalls: 12
      }
    });
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      title: "Inspect Runtime",
      interactionProfileId: "interactive.default",
      sessionId: "agent-task:task_1",
      projectId: "project-1",
      model: {
        profileId: "profile-1",
        providerId: "test",
        modelId: "model"
      },
      metadata: expect.objectContaining({
        source: "agent-task",
        agentTaskId: "task_1",
        parentRunId: "parent-run"
      })
    }));
    expect(executor.execute.mock.calls[0][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: expect.stringContaining("headless Runtime Host") }),
        expect.objectContaining({ role: "user", content: "Check the Runtime boundary" })
      ])
    );

    await expect(service.abortRun("runtime-run-1", "user")).resolves.toBe(true);
    expect(abort).toHaveBeenCalledWith("user");
    await completion;
    await Promise.resolve();
    await expect(service.abortRun("runtime-run-1", "user")).resolves.toBe(false);
  });

  it("builds a usable prompt from task body fallback", () => {
    expect(buildAgentTaskMessages({
      id: "task_body",
      body: "user fallback body"
    }).at(-1)).toEqual({
      role: "user",
      content: "fallback body"
    });
  });
});
