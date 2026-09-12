import { describe, expect, it, vi } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { RuntimeToolBroker } from "../src/runtime-tool-broker.mjs";

function receiptStore() {
  const receipts = new Map();
  const todos = new Map();
  const runArtifacts = new Map();
  return {
    getToolReceipt(id) {
      return receipts.get(id) || null;
    },
    saveToolReceipt(input) {
      const receipt = {
        invocationId: input.invocationId,
        runId: input.runId,
        toolName: input.toolName,
        requestHash: input.requestHash,
        result: input.result,
        completedAt: input.completedAt
      };
      if (!receipts.has(input.invocationId)) receipts.set(input.invocationId, receipt);
      return { ...receipts.get(input.invocationId), duplicate: receipts.has(input.invocationId) };
    },
    countToolReceipts(runId, toolName) {
      return [...receipts.values()].filter(
        (item) => item.runId === runId && (!toolName || item.toolName === toolName)
      ).length;
    },
    saveTodoList(ownerId, values, updatedAt, metadata = {}) {
      const result = {
        ownerId,
        ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
        ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
        ...(metadata.runId ? { runId: metadata.runId } : {}),
        todos: values,
        updatedAt
      };
      todos.set(ownerId, result);
      return result;
    },
    getTodoList(ownerId) {
      return todos.get(ownerId) || null;
    },
    saveRunArtifacts(input) {
      runArtifacts.set(input.runId, {
        runId: input.runId,
        artifacts: input.artifacts,
        changes: input.changes
      });
      return runArtifacts.get(input.runId);
    },
    listRunArtifacts(runId) {
      return runArtifacts.get(runId) || { runId, artifacts: [], changes: [] };
    }
  };
}

function invocation(name, args = {}, policy = {}) {
  return {
    invocationId: `invocation:${name}`,
    runId: "run-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    policy: {
      preset: "read-only",
      allowedTools: [name],
      maxToolCalls: 10,
      fileRoots: [],
      allowedCommandPrefixes: [],
      allowedTerminalSessionIds: [],
      allowedRecipients: [],
      maxMailPerRun: 0,
      ...policy
    },
    toolCall: { id: `call:${name}`, name, arguments: args }
  };
}

describe("RuntimeToolBroker", () => {
  it("persists invocation receipts and replays duplicates", async () => {
    const localTools = {
      listTools: vi.fn(async () => [{ name: "write" }]),
      invoke: vi.fn(async () => ({ ok: true, content: "written" }))
    };
    const receipts = receiptStore();
    const broker = new RuntimeToolBroker({
      localTools,
      receipts
    });
    const call = invocation("write", {
      path: "/workspace/out.txt",
      content: "hello"
    }, {
      preset: "workspace-write",
      fileRoots: ["/workspace"]
    });
    const signal = new CancellationController().signal;

    await expect(broker.invoke(call, signal)).resolves.toMatchObject({
      ok: true,
      content: "written",
      artifactIds: ["invocation:write:artifact:0"],
      artifacts: [expect.objectContaining({
        kind: "file",
        uri: "/workspace/out.txt"
      })],
      changes: [expect.objectContaining({
        operation: "created",
        path: "/workspace/out.txt",
        after: "hello"
      })]
    });
    await expect(broker.invoke(call, signal)).resolves.toMatchObject({
      ok: true,
      content: "written",
      artifactIds: ["invocation:write:artifact:0"]
    });
    expect(localTools.invoke).toHaveBeenCalledTimes(1);
    expect(receipts.listRunArtifacts("run-1")).toMatchObject({
      artifacts: [expect.objectContaining({ uri: "/workspace/out.txt" })],
      changes: [expect.objectContaining({ operation: "created" })]
    });

    await expect(broker.invoke({
      ...call,
      toolCall: {
        ...call.toolCall,
        arguments: { ...call.toolCall.arguments, content: "different" }
      }
    }, signal)).rejects.toThrow("reused with different arguments");
  });

  it("blocks private web targets before fetching", async () => {
    const fetchImpl = vi.fn();
    const broker = new RuntimeToolBroker({
      localTools: {
        listTools: async () => [],
        invoke: vi.fn()
      },
      receipts: receiptStore(),
      fetchImpl
    });

    await expect(broker.invoke(
      invocation("webFetch", { url: "http://127.0.0.1/private" }),
      new CancellationController().signal
    )).rejects.toThrow("private network");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches public pages through the bounded markdown proxy", async () => {
    const fetchImpl = vi.fn(async () => new globalThis.Response("# Page\ncontent", {
      status: 200,
      headers: { "content-type": "text/plain" }
    }));
    const broker = new RuntimeToolBroker({
      localTools: {
        listTools: async () => [],
        invoke: vi.fn()
      },
      receipts: receiptStore(),
      fetchImpl,
      lookupImpl: vi.fn(async () => [{ address: "93.184.216.34" }])
    });

    const result = await broker.invoke(
      invocation("webFetch", { url: "https://example.com/page" }),
      new CancellationController().signal
    );

    expect(result).toMatchObject({
      ok: true,
      content: expect.stringContaining("# Fetched: https://example.com/page")
    });
    expect(String(fetchImpl.mock.calls[0][0]))
      .toBe("https://r.jinaai.cn/https://example.com/page");
  });

  it("falls back to the alternate markdown proxy after a network failure", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "UND_ERR_CONNECT_TIMEOUT" }
        })
      )
      .mockResolvedValueOnce(new globalThis.Response("# Page\nfallback", {
        status: 200,
        headers: { "content-type": "text/plain" }
      }));
    const broker = new RuntimeToolBroker({
      localTools: {
        listTools: async () => [],
        invoke: vi.fn()
      },
      receipts: receiptStore(),
      fetchImpl,
      lookupImpl: vi.fn(async () => [{ address: "93.184.216.34" }])
    });

    await expect(broker.invoke(
      invocation("webFetch", { url: "https://example.com/page" }),
      new CancellationController().signal
    )).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("fallback")
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://r.jinaai.cn/https://example.com/page",
      "https://r.jina.ai/https://example.com/page"
    ]);
  });

  it("returns actionable diagnostics when every web proxy fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" }
      });
    });
    const broker = new RuntimeToolBroker({
      localTools: {
        listTools: async () => [],
        invoke: vi.fn()
      },
      receipts: receiptStore(),
      fetchImpl,
      lookupImpl: vi.fn(async () => [{ address: "93.184.216.34" }])
    });

    await expect(broker.invoke(
      invocation("webFetch", { url: "https://example.com/page" }),
      new CancellationController().signal
    )).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "r.jinaai.cn: fetch failed (UND_ERR_CONNECT_TIMEOUT)"
      ),
      content: expect.stringContaining("r.jina.ai: fetch failed")
    });
  });

  it("stores todo state in Runtime rather than local-tools", async () => {
    const receipts = receiptStore();
    const localTools = {
      listTools: async () => [],
      invoke: vi.fn()
    };
    const broker = new RuntimeToolBroker({ localTools, receipts });
    const result = await broker.invoke(invocation("todoWrite", {
      taskId: "task-1",
      todos: [{
        id: "todo-1",
        content: "Run tests",
        status: "in_progress",
        activeForm: "Running tests"
      }]
    }, {
      preset: "trusted-automation"
    }), new CancellationController().signal);

    expect(result.ok).toBe(true);
    expect(receipts.getTodoList("session-1")).toMatchObject({
      taskId: "task-1",
      sessionId: "session-1",
      runId: "run-1",
      todos: [{ id: "todo-1", content: "Run tests", status: "in_progress" }]
    });
    expect(localTools.invoke).not.toHaveBeenCalled();
  });

  it("reflects delegated capability changes without rebuilding the broker", () => {
    const localTools = {
      supportedToolNames: ["read"],
      listTools: vi.fn(async () => []),
      invoke: vi.fn()
    };
    const broker = new RuntimeToolBroker({
      localTools,
      receipts: receiptStore()
    });

    expect(broker.supportedToolNames).toEqual([
      "read",
      "webFetch",
      "todoWrite"
    ]);
    localTools.supportedToolNames = ["read", "grep", "webFetch"];
    expect(broker.supportedToolNames).toEqual([
      "read",
      "grep",
      "webFetch",
      "todoWrite"
    ]);
  });

  it("exposes and invokes Runtime plugin tools through the unified broker", async () => {
    const pluginTools = {
      supportedToolNames: ["plugin.echo"],
      hasTool: (name) => name === "plugin.echo",
      listTools: vi.fn(async () => [{
        name: "plugin.echo",
        description: "Echo from plugin",
        inputSchema: { type: "object" },
        hostKinds: ["runtime-plugin"]
      }]),
      invoke: vi.fn(async (call) => ({
        ok: true,
        content: `plugin:${call.toolCall.arguments.text}`
      }))
    };
    const localTools = {
      listTools: vi.fn(async () => []),
      invoke: vi.fn()
    };
    const broker = new RuntimeToolBroker({
      localTools,
      pluginTools,
      receipts: receiptStore(),
      delegatedToolNames: []
    });
    const policy = {
      preset: "read-only",
      allowedTools: ["plugin.echo"],
      maxToolCalls: 10,
      fileRoots: [],
      allowedCommandPrefixes: [],
      allowedTerminalSessionIds: [],
      allowedRecipients: [],
      maxMailPerRun: 0
    };

    await expect(broker.listTools({ policy })).resolves.toEqual([
      expect.objectContaining({
        name: "plugin.echo",
        hostKinds: ["runtime-plugin"]
      })
    ]);
    await expect(broker.invoke(
      invocation("plugin.echo", { text: "hello" }, policy),
      new CancellationController().signal
    )).resolves.toEqual({
      ok: true,
      content: "plugin:hello"
    });
    expect(pluginTools.invoke).toHaveBeenCalledOnce();
    expect(localTools.invoke).not.toHaveBeenCalled();
  });

  it("enforces the durable mail quota before delegating", async () => {
    const receipts = receiptStore();
    const localTools = {
      listTools: async () => [{ name: "sendMail" }],
      invoke: vi.fn(async () => ({ ok: true, content: "sent" }))
    };
    const broker = new RuntimeToolBroker({ localTools, receipts });
    const base = invocation("sendMail", {
      to: ["allowed@example.com"],
      subject: "Report",
      body: "Done"
    }, {
      preset: "trusted-automation",
      allowedRecipients: ["allowed@example.com"],
      maxMailPerRun: 1
    });
    const signal = new CancellationController().signal;

    await broker.invoke(base, signal);
    await expect(broker.invoke({
      ...base,
      invocationId: "invocation:sendMail:2"
    }, signal)).rejects.toThrow("mail quota exceeded");
    expect(localTools.invoke).toHaveBeenCalledTimes(1);
  });
});
