import { describe, expect, it, vi } from "vitest";
import { createProjectAutomationRuntimeService } from "../extensions/dev.identity/project-automation-runtime-service.js";
import { normalizeAutomationDocument } from "../extensions/dev.identity/project-automation-core.js";
import { normalizeAgentsSnapshot } from "../extensions/dev.agents/agents-runtime-shared.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function enabledDocument(overrides = {}) {
  return normalizeAutomationDocument({
    projects: {
      "zion-next": {
        enabled: true,
        mode: "execute",
        cadenceMinutes: 30,
        maxToolCalls: 24,
        timeoutMinutes: 10,
        updatedAt: 1000,
        ...overrides
      }
    }
  });
}

function readyProject() {
  return [
    "---",
    "project: Zion Next",
    "status: active",
    "---",
    "",
    "# Zion Next",
    "",
    "## 目标",
    "",
    "完成 Runtime 自动推进。",
    "",
    "## 调研",
    "",
    "- Runtime 已具备 Agent runner。",
    "",
    "## 计划",
    "",
    "- [ ] 接入 Runtime coordinator"
  ].join("\n");
}

describe("Runtime Project Automation coordinator", () => {
  it("starts a bounded Agent Run and persists completion state", async () => {
    let document = enabledDocument();
    let agentsDocument = normalizeAgentsSnapshot();
    let clock = 2000;
    const completion = deferred();
    const handle = {
      runId: "run-project-1",
      attemptId: "attempt-project-1",
      sessionId: "agent-project:zion-next",
      abort: vi.fn(async () => {}),
      completion: completion.promise,
      events: {
        async *[Symbol.asyncIterator]() {}
      }
    };
    const fileService = {
      resolvePath: vi.fn((root, relativePath) => `${root}/${relativePath}`),
      readTextFiles: vi.fn(async ({ fileRoot, files }) => ({
        fileRoot,
        files: Object.fromEntries(Object.entries(files).map(([key]) => [
          key,
          key === "project" ? readyProject() : "# 项目索引\n"
        ]))
      })),
      writeTextFiles: vi.fn(async () => ({ written: [] }))
    };
    const runnerService = {
      startTaskRun: vi.fn(() => handle),
      abortRun: vi.fn(async () => false)
    };
    const service = createProjectAutomationRuntimeService({
      readDocument: () => document,
      writeDocument: (value) => {
        document = value;
      },
      readAgentsDocument: () => agentsDocument,
      writeAgentsDocument: (value) => {
        agentsDocument = value;
      },
      fileService,
      runnerService,
      memoryRoot: "/Users/test/.zion-next/memory",
      now: () => clock,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn()
    });

    await expect(service.runNow("zion-next", {
      parentRunId: "parent-run",
      parentAttemptId: "parent-attempt"
    })).resolves.toMatchObject({
      status: "running",
      projectKey: "zion-next",
      taskId: "project-auto-zion-next-1jk",
      runId: "run-project-1"
    });
    expect(document.projects["zion-next"]).toMatchObject({
      activeTaskId: "project-auto-zion-next-1jk",
      lastStatus: "running",
      lastPhase: "executing"
    });
    expect(agentsDocument.tasks[0]).toMatchObject({
      id: "project-auto-zion-next-1jk",
      status: "running",
      activeRunId: "run-project-1"
    });
    expect(runnerService.startTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "implementer",
        permissionMode: "accept-edits",
        prompt: expect.stringContaining("接入 Runtime coordinator")
      }),
      expect.objectContaining({
        parentRunId: "parent-run",
        policy: expect.objectContaining({
          preset: "workspace-write",
          allowedTools: expect.arrayContaining(["read", "write", "edit"]),
          fileRoots: expect.arrayContaining([
            "/Users/test/.zion-next/memory/projects/zion-next/project.md"
          ])
        })
      })
    );

    clock = 3000;
    completion.resolve({
      runId: "run-project-1",
      status: "completed",
      output: "done"
    });
    await completion.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(document.projects["zion-next"]).toMatchObject({
      activeTaskId: "",
      lastStatus: "success",
      lastCompletedAt: 3000,
      failureCount: 0
    });
    expect(agentsDocument.tasks[0]).toMatchObject({
      status: "done",
      activeRunId: "",
      result: { workResult: "done" }
    });
  });

  it("stops an active Runtime project run", async () => {
    let document = enabledDocument({
      activeTaskId: "project-task-2",
      lastStatus: "running"
    });
    let agentsDocument = normalizeAgentsSnapshot({
      activeTaskId: "project-task-2",
      tasks: [{
        id: "project-task-2",
        agentId: "implementer",
        status: "running",
        activeRunId: "run-project-2",
        prompt: "Continue",
        createdAt: 1000,
        updatedAt: 1000
      }]
    });
    const runnerService = {
      startTaskRun: vi.fn(),
      abortRun: vi.fn(async () => true)
    };
    const service = createProjectAutomationRuntimeService({
      readDocument: () => document,
      writeDocument: (value) => {
        document = value;
      },
      readAgentsDocument: () => agentsDocument,
      writeAgentsDocument: (value) => {
        agentsDocument = value;
      },
      fileService: {
        resolvePath: (root, relativePath) => `${root}/${relativePath}`,
        readTextFiles: vi.fn(),
        writeTextFiles: vi.fn()
      },
      runnerService,
      memoryRoot: "/Users/test/.zion-next/memory",
      now: () => 4000
    });

    await expect(service.stopProject("zion-next")).resolves.toEqual({
      status: "stopped",
      projectKey: "zion-next",
      abortedRun: true
    });
    expect(runnerService.abortRun).toHaveBeenCalledWith("run-project-2", "user");
    expect(document.projects["zion-next"]).toMatchObject({
      activeTaskId: "",
      lastStatus: "idle",
      updatedAt: 4000
    });
    expect(agentsDocument.tasks[0]).toMatchObject({
      status: "aborted",
      activeRunId: ""
    });
  });

  it("keeps a stopped task aborted when its Run settles later", async () => {
    let document = enabledDocument();
    let agentsDocument = normalizeAgentsSnapshot();
    const completion = deferred();
    const handle = {
      runId: "run-late",
      attemptId: "attempt-late",
      sessionId: "agent-project:zion-next",
      abort: vi.fn(async () => {}),
      completion: completion.promise,
      events: {
        async *[Symbol.asyncIterator]() {}
      }
    };
    const service = createProjectAutomationRuntimeService({
      readDocument: () => document,
      writeDocument: (value) => {
        document = value;
      },
      readAgentsDocument: () => agentsDocument,
      writeAgentsDocument: (value) => {
        agentsDocument = value;
      },
      fileService: {
        resolvePath: (root, relativePath) => `${root}/${relativePath}`,
        readTextFiles: vi.fn(async ({ fileRoot, files }) => ({
          fileRoot,
          files: Object.fromEntries(Object.entries(files).map(([key]) => [
            key,
            key === "project" ? readyProject() : "# 项目索引\n"
          ]))
        })),
        writeTextFiles: vi.fn(async () => ({ written: [] }))
      },
      runnerService: {
        startTaskRun: vi.fn(() => handle),
        abortRun: vi.fn()
      },
      memoryRoot: "/Users/test/.zion-next/memory",
      now: () => 6000
    });

    const started = await service.runNow("zion-next");
    await service.stopProject("zion-next");
    completion.resolve({
      runId: "run-late",
      status: "completed",
      output: "late result"
    });
    await completion.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.abort).toHaveBeenCalledWith("user");
    expect(document.projects["zion-next"]).toMatchObject({
      activeTaskId: "",
      lastStatus: "idle"
    });
    expect(agentsDocument.tasks.find((task) => task.id === started.taskId)).toMatchObject({
      status: "aborted",
      activeRunId: ""
    });
  });

  it("owns the periodic heartbeat lifecycle in Runtime", async () => {
    let document = enabledDocument({
      enabled: false,
      activeTaskId: "stale-task",
      lastStatus: "running"
    });
    let agentsDocument = normalizeAgentsSnapshot({
      tasks: [{
        id: "stale-task",
        agentId: "implementer",
        status: "running",
        activeRunId: "stale-run",
        prompt: "Continue"
      }]
    });
    const timers = [];
    const service = createProjectAutomationRuntimeService({
      readDocument: () => document,
      writeDocument: (value) => {
        document = value;
      },
      readAgentsDocument: () => agentsDocument,
      writeAgentsDocument: (value) => {
        agentsDocument = value;
      },
      fileService: {
        resolvePath: (root, relativePath) => `${root}/${relativePath}`,
        readTextFiles: vi.fn(),
        writeTextFiles: vi.fn()
      },
      runnerService: {
        startTaskRun: vi.fn(),
        abortRun: vi.fn()
      },
      memoryRoot: "/Users/test/.zion-next/memory",
      pollIntervalMs: 5000,
      setTimer: vi.fn((callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      }),
      clearTimer: vi.fn()
    });

    service.start();
    expect(service.running).toBe(true);
    expect(timers[0].delay).toBe(0);
    timers.shift().callback();
    await vi.waitFor(() => {
      expect(timers[0]?.delay).toBe(5000);
      expect(document.projects["zion-next"]).toMatchObject({
        activeTaskId: "",
        lastStatus: "failed"
      });
      expect(agentsDocument.tasks[0]).toMatchObject({
        status: "error",
        activeRunId: ""
      });
    });
    await service.stop();
    expect(service.running).toBe(false);
  });

  it("records attention instead of starting when the project needs user input", async () => {
    let document = enabledDocument({ mode: "explore" });
    const writes = [];
    const service = createProjectAutomationRuntimeService({
      readDocument: () => document,
      writeDocument: (value) => {
        document = value;
      },
      fileService: {
        resolvePath: (root, relativePath) => `${root}/${relativePath}`,
        readTextFiles: vi.fn(async ({ fileRoot, files }) => ({
          fileRoot,
          files: Object.fromEntries(Object.entries(files).map(([key]) => [
            key,
            key === "project"
              ? readyProject()
              : key === "attention"
                ? "# 待处理事项\n"
                : "# 项目索引\n"
          ]))
        })),
        writeTextFiles: vi.fn(async (input) => {
          writes.push(input);
          return { written: [] };
        })
      },
      runnerService: {
        startTaskRun: vi.fn(),
        abortRun: vi.fn()
      },
      memoryRoot: "/Users/test/.zion-next/memory",
      now: () => 5000
    });

    await expect(service.runNow("zion-next")).resolves.toMatchObject({
      status: "attention",
      reason: "plan-review"
    });
    expect(writes[0].files.attention.content).toContain("等待批准进入执行");
    expect(document.projects["zion-next"].lastStatus).toBe("attention");
  });
});
