import { describe, expect, it, vi } from "vitest";
import {
  authorizeToolCall,
  createProgrammaticExecutor,
  filterReadOnlyTools,
  filterToolsForPolicy,
  isReadOnlyToolCall,
  isReadOnlyToolName,
  normalizeToolCall
} from "../extensions/dev.langchain-chat/programmatic-runner.js";
import { resolveModelContextWindowTokens } from "../extensions/dev.langchain-chat/context-health.js";

describe("programmatic chat runner", () => {
  it("uses explicit model context window metadata before output token fallbacks", () => {
    expect(resolveModelContextWindowTokens(
      { max_tokens: 4096 },
      { providerId: "custom", modelId: "local", contextWindowTokens: 64_000 }
    )).toBe(64_000);
  });

  it("filters mutating tools from local-only runs", () => {
    expect(isReadOnlyToolName("memory.search")).toBe(true);
    expect(isReadOnlyToolName("fs.write")).toBe(false);
    expect(isReadOnlyToolName("write")).toBe(false);
    expect(isReadOnlyToolName("terminal_run")).toBe(false);
    expect(isReadOnlyToolCall({ name: "memoryManage", args: { action: "search" } })).toBe(true);
    expect(isReadOnlyToolCall({ name: "memoryManage", args: { action: "delete" } })).toBe(false);
    expect(normalizeToolCall({ name: "webFetch", args: { url: " `https://example.com/` ", prompt: "keep `code`" } })).toMatchObject({
      args: { url: "https://example.com/", prompt: "keep `code`" }
    });
    expect(filterReadOnlyTools([
      { function: { name: "webSearch" } },
      { function: { name: "fs.write" } },
      { function: { name: "schedulerManage" } }
    ])).toEqual([{ function: { name: "webSearch" } }]);
    expect(authorizeToolCall(
      { name: "schedulerManage", args: { action: "create" } },
      { preset: "trusted-automation", allowedTools: ["schedulerManage"] }
    ).allowed).toBe(false);
  });

  it("enforces scoped write, terminal and mail capabilities", () => {
    const tools = [
      { function: { name: "webSearch" } },
      { function: { name: "write" } },
      { function: { name: "fsWrite" } },
      { function: { name: "Bash" } },
      { function: { name: "terminalExecute" } }
    ];
    expect(filterToolsForPolicy(tools, {
      preset: "workspace-write",
      allowedTools: ["write"],
      fileRoots: ["/workspace/project"]
    }).map((tool) => tool.function.name)).toEqual(["webSearch", "write"]);
    expect(authorizeToolCall(
      { name: "write", args: { path: "/workspace/project/src/a.ts" } },
      { preset: "workspace-write", allowedTools: ["write"], fileRoots: ["/workspace/project"] }
    ).allowed).toBe(true);
    expect(authorizeToolCall(
      { name: "write", args: { path: "/workspace/project/../secret.txt" } },
      { preset: "workspace-write", allowedTools: ["write"], fileRoots: ["/workspace/project"] }
    ).allowed).toBe(false);
    expect(filterToolsForPolicy([{ function: { name: "write" } }], {
      preset: "workspace-write",
      allowedTools: ["fsWrite"],
      fileRoots: ["/workspace/project"]
    }).map((tool) => tool.function.name)).toEqual(["write"]);

    const trusted = {
      preset: "trusted-automation",
      allowedTools: ["Bash", "sendMail"],
      allowedCommandPrefixes: ["npm test"],
      allowedTerminalSessionIds: ["term-1"],
      allowedRecipients: ["team@example.com"],
      maxMailPerRun: 1
    };
    expect(filterToolsForPolicy(tools, trusted).map((tool) => tool.function.name)).toEqual(["webSearch", "Bash"]);
    expect(authorizeToolCall(
      { name: "Bash", args: { command: "npm test -- --run", session_id: "term-1" } },
      trusted
    ).allowed).toBe(true);
    expect(authorizeToolCall(
      { name: "Bash", args: { command: "rm -rf /", session_id: "term-1" } },
      trusted
    ).allowed).toBe(false);
    expect(authorizeToolCall(
      { name: "Bash", args: { command: "npm test", session_id: "term-1" } },
      { preset: "trusted-automation", allowedTools: ["terminalExecute"], allowedCommandPrefixes: ["npm test"] }
    ).allowed).toBe(true);
    expect(authorizeToolCall(
      { name: "Bash", args: { command: "python3 /workspace/project/task.py" } },
      { preset: "trusted-automation", allowedTools: ["Bash"] }
    ).allowed).toBe(true);
    expect(authorizeToolCall(
      { name: "sendMail", args: { to: ["outside@example.com"] } },
      trusted,
      { mail: 0 }
    ).allowed).toBe(false);
    expect(authorizeToolCall(
      { name: "sendMail", args: { to: ["team@example.com"] } },
      trusted,
      { mail: 1 }
    ).reason).toBe("mail quota exceeded");
  });

  it("returns a handle and emits an ordered transcript", async () => {
    const globalEvents = [];
    const runs = {
      start: vi.fn(),
      recordEvent: vi.fn(),
      recordUsage: vi.fn()
    };
    const execute = createProgrammaticExecutor({
      getActiveModel: () => ({ providerId: "test", modelId: "test" }),
      resolveModelConfig: async () => ({ contextWindowTokens: 1000, charsPerToken: 4 }),
      getTools: () => [],
      runContributors: async (messages) => messages,
      emit: (topic, event) => globalEvents.push({ topic, event }),
      runs,
        runStream: async ({ onToken, sessionId }) => {
          expect(sessionId).toBe("scheduled-session");
        onToken("hello ");
        onToken("world");
        return { usage: { input_tokens: 4, output_tokens: 2 } };
      },
      executeTool: vi.fn()
    });

    const handle = execute({
      prompt: "say hello",
      executionMode: "local-only",
      sessionId: "scheduled-session",
      title: "Scheduled hello",
      source: { pluginId: "dev.scheduler", kind: "scheduled-task", id: "task-1" },
      trigger: "schedule",
      policy: { preset: "read-only" }
    });
    const result = await handle.completion;
    const events = [];
    for await (const event of handle.events) events.push(event);

    expect(result).toMatchObject({ runId: handle.runId, status: "completed", output: "hello world" });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "turn.started",
      "context.window",
      "message.delta",
      "message.delta",
      "message.completed",
      "turn.completed",
      "run.completed"
    ]);
    expect(events[0].data.model).toEqual({ providerId: "test", modelId: "test" });
    expect(events[1].data.model).toEqual({ providerId: "test", modelId: "test" });
    expect(events[2].data).toMatchObject({
      model: { providerId: "test", modelId: "test" },
      modelContextWindow: 1000,
      severity: "ok",
      recommendation: "continue"
    });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(globalEvents).toHaveLength(events.length);
    expect(runs.start).toHaveBeenCalledWith(expect.objectContaining({
      id: handle.runId,
      title: "Scheduled hello",
      source: { pluginId: "dev.scheduler", kind: "scheduled-task", id: "task-1" },
      trigger: "schedule",
      sessionId: "scheduled-session"
    }));
    expect(runs.recordEvent.mock.calls.map(([event]) => event.type)).toEqual(events.map((event) => event.type));
    expect(runs.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      runId: handle.runId,
      stepIndex: 1,
      usage: { input_tokens: 4, output_tokens: 2 }
    }));
  });

  it("executes only exposed read-only tools and continues the turn", async () => {
    let step = 0;
    const toolExecutor = vi.fn(async () => "three results");
    const execute = createProgrammaticExecutor({
      getTools: () => [
        { function: { name: "webSearch" } },
        { function: { name: "fs.write" } }
      ],
      getActiveModel: () => null,
      runContributors: async (messages) => messages,
      runStream: async ({ tools, onToolCall, onToken, onEnd }) => {
        expect(tools.map((tool) => tool.function.name)).toEqual(["webSearch"]);
        step += 1;
        if (step === 1) onToolCall({ id: "call-1", name: "webSearch", args: { query: "x", url: " `https://example.com` " } });
        else onToken("done");
        onEnd();
        return {};
      },
      executeTool: toolExecutor
    });

    const handle = execute({ prompt: "search", executionMode: "local-only" });
    await expect(handle.completion).resolves.toMatchObject({ status: "completed", output: "done" });
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor.mock.calls[0][0].args.url).toBe("https://example.com");

    const events = [];
    for await (const event of handle.events) events.push(event.type);
    expect(events).toContain("tool.requested");
    expect(events).toContain("tool.completed");
  });

  it("records returned Bash failures as tool.completed errors", async () => {
    let step = 0;
    const runs = {
      start: vi.fn(),
      recordEvent: vi.fn(),
      recordUsage: vi.fn()
    };
    const toolExecutor = vi.fn(async () => JSON.stringify({
      command: "ssh host.example.com",
      ok: false,
      exit_code: 255,
      stdout: "",
      stderr: "Error reading SSH protocol banner"
    }));
    const execute = createProgrammaticExecutor({
      getTools: () => [{ function: { name: "Bash" } }],
      getActiveModel: () => null,
      runStream: async ({ onToolCall, onToken, onEnd }) => {
        step += 1;
        if (step === 1) {
          onToolCall({ id: "call-ssh", name: "Bash", args: { command: "ssh host.example.com" } });
        } else {
          onToken("done");
        }
        onEnd();
        return {};
      },
      executeTool: toolExecutor,
      runs
    });

    const handle = execute({
      prompt: "check ssh",
      executionMode: "local-only",
      policy: { preset: "trusted-automation", allowedTools: ["Bash"] }
    });
    await expect(handle.completion).resolves.toMatchObject({ status: "completed", output: "done" });

    const completed = runs.recordEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "tool.completed");
    expect(completed).toMatchObject({
      data: {
        callId: "call-ssh",
        name: "Bash",
        error: "Error reading SSH protocol banner"
      }
    });
  });

  it("aborts the active provider request", async () => {
    let controller;
    const execute = createProgrammaticExecutor({
      getTools: () => [],
      getActiveModel: () => null,
      runStream: ({ getController }) => new Promise((resolve, reject) => {
        controller = new AbortController();
        getController(controller);
        controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
      executeTool: vi.fn()
    });

    const handle = execute({ prompt: "wait", executionMode: "local-only" });
    await Promise.resolve();
    await handle.abort("timeout");
    expect(controller.signal.aborted).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ status: "aborted", reason: "timeout" });
  });
});
