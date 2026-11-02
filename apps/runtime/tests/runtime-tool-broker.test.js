import { describe, expect, it, vi } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { RuntimeToolBroker } from "../src/runtime-tool-broker.mjs";
import { ToolInvocationLifecycle } from "../src/tool-invocation-lifecycle.mjs";

function receiptStore() {
  const receipts = new Map();
  const todos = new Map();
  const runArtifacts = new Map();
  return {
    getToolReceipt(id) {
      return receipts.get(id) || null;
    },
    findToolReceiptByRequestHash(runId, toolName, requestHash) {
      return [...receipts.values()]
        .filter((item) =>
          item.runId === runId
          && item.toolName === toolName
          && item.requestHash === requestHash
        )
        .sort((left, right) => right.completedAt - left.completedAt)[0] || null;
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

function controlledLifecycle() {
  const scheduled = [];
  return {
    lifecycle: new ToolInvocationLifecycle({
      timeoutGraceMs: 0,
      scheduleTimeout(callback, timeoutMs) {
        const timer = {
          callback,
          timeoutMs,
          disposed: false,
          dispose() {
            this.disposed = true;
          }
        };
        scheduled.push(timer);
        return timer;
      }
    }),
    scheduled
  };
}

describe("RuntimeToolBroker", () => {
  it("disables MCP discovery and invocation before consulting durable receipts", async () => {
    const localDefinitions = ["Bash", "mcpListTools", "mcpCall"].map((name) => ({
      name, inputSchema: { type: "object" }
    }));
    const nativeDefinitions = [{ name: "mcp__agentfs__cat", inputSchema: { type: "object" } }];
    const localTools = {
      supportedToolNames: localDefinitions.map((tool) => tool.name),
      getToolDefinitions: () => localDefinitions,
      listTools: vi.fn(async () => localDefinitions),
      invoke: vi.fn()
    };
    const pluginTools = {
      supportedToolNames: nativeDefinitions.map((tool) => tool.name),
      getToolDefinitions: () => nativeDefinitions,
      listTools: vi.fn(async () => nativeDefinitions)
    };
    const receipts = { ...receiptStore(), getToolReceipt: vi.fn() };
    const broker = new RuntimeToolBroker({ localTools, pluginTools, receipts, mcpEnabled: false });
    expect(broker.supportedToolNames.filter((name) => name.startsWith("mcp"))).toEqual([]);
    expect(broker.getToolDefinitions().filter((tool) => tool.name.startsWith("mcp"))).toEqual([]);
    const definitions = await broker.listTools({
      policy: { allowedTools: [...localDefinitions, ...nativeDefinitions].map((tool) => tool.name) }
    });
    expect(definitions.map((tool) => tool.name)).toEqual(["Bash"]);
    for (const name of ["mcpListTools", "mcpCall", "mcp__agentfs__cat"]) {
      await expect(broker.invoke(invocation(name), new CancellationController().signal))
        .rejects.toThrow("MCP tools are disabled");
    }
    expect(receipts.getToolReceipt).not.toHaveBeenCalled();
    expect(localTools.invoke).not.toHaveBeenCalled();
  });

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

  it("resolves execution targets before hashing receipts and active requests", async () => {
    let nodeId = "managed:a";
    const localTools = {
      resolveInvocation: (call) => ({
        ...call,
        target: { nodeId, resourceId: "workspace:managed" }
      }),
      listTools: vi.fn(async () => [{ name: "Bash" }]),
      invoke: vi.fn(async () => ({
        ok: false,
        content: "outcome unknown",
        error: "outcome unknown",
        failureCode: "execution_outcome_unknown"
      }))
    };
    const broker = new RuntimeToolBroker({
      localTools,
      receipts: receiptStore()
    });
    const signal = new CancellationController().signal;
    const first = invocation("Bash", { command: "deploy" }, {
      preset: "trusted-automation"
    });
    await broker.invoke(first, signal);

    nodeId = "managed:b";
    await expect(broker.invoke(first, signal)).rejects.toThrow(
      "reused with different arguments"
    );
    await broker.invoke({
      ...first,
      invocationId: "invocation:Bash:other-target"
    }, signal);
    expect(localTools.invoke).toHaveBeenCalledTimes(2);
  });

  it("blocks an identical retry after an unknown execution outcome", async () => {
    const localTools = {
      listTools: vi.fn(async () => [{ name: "Bash" }]),
      invoke: vi.fn(async () => ({
        ok: false,
        content: "The command may still be running. Do not retry.",
        error: "The command may still be running. Do not retry.",
        failureCode: "execution_outcome_unknown"
      }))
    };
    const broker = new RuntimeToolBroker({
      localTools,
      receipts: receiptStore()
    });
    const signal = new CancellationController().signal;
    const first = invocation("Bash", {
      command: "deploy"
    }, {
      preset: "trusted-automation"
    });

    await expect(broker.invoke(first, signal)).resolves.toMatchObject({
      failureCode: "execution_outcome_unknown"
    });
    await expect(broker.invoke({
      ...first,
      invocationId: "invocation:Bash:retry",
      toolCall: {
        ...first.toolCall
      }
    }, signal)).resolves.toMatchObject({
      failureCode: "execution_outcome_unknown",
      content: expect.stringContaining("Duplicate Bash execution was blocked")
    });
    expect(localTools.invoke).toHaveBeenCalledTimes(1);
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
      failureCode: "timeout",
      error: expect.stringContaining(
        "r.jinaai.cn: fetch failed (UND_ERR_CONNECT_TIMEOUT)"
      ),
      content: expect.stringContaining("r.jina.ai: fetch failed")
    });
  });

  it("classifies mixed webFetch proxy failures without exposing details in the code", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new globalThis.Response("blocked", { status: 403 }))
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "UND_ERR_CONNECT_TIMEOUT" }
        })
      );
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
      failureCode: "http_4xx",
      error: expect.stringContaining("HTTP 403")
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
      "webSearch",
      "webFetch",
      "todoWrite"
    ]);
    localTools.supportedToolNames = ["read", "grep", "webFetch"];
    expect(broker.supportedToolNames).toEqual([
      "read",
      "grep",
      "webSearch",
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

  it("times out read tools as retryable and permits a fresh invocation", async () => {
    const { lifecycle, scheduled } = controlledLifecycle();
    const localTools = {
      supportedToolNames: ["catalog.read"],
      getToolDefinitions: () => [{
        name: "catalog.read",
        execution: {
          effect: "read",
          timeoutMs: 10,
          maxTimeoutMs: 10
        }
      }],
      listTools: async () => [],
      invoke: vi.fn()
        .mockImplementationOnce(async () => await new Promise(() => {}))
        .mockResolvedValueOnce({ ok: true, content: "fresh" })
    };
    const broker = new RuntimeToolBroker({
      localTools,
      receipts: receiptStore(),
      invocationLifecycle: lifecycle
    });
    const first = broker.invoke(
      invocation("catalog.read", { key: "one" }),
      new CancellationController().signal
    );
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    expect(scheduled[0].timeoutMs).toBe(10);
    scheduled[0].callback();

    await expect(first).resolves.toMatchObject({
      failureCode: "timeout",
      retryable: true
    });
    await expect(broker.invoke({
      ...invocation("catalog.read", { key: "one" }),
      invocationId: "invocation:catalog.read:retry"
    }, new CancellationController().signal)).resolves.toMatchObject({
      ok: true,
      content: "fresh"
    });
    expect(localTools.invoke).toHaveBeenCalledTimes(2);
  });

  it.each(["write", "process", "external"])(
    "records %s interruption as an unknown outcome and blocks retry",
    async (effect) => {
      const { lifecycle, scheduled } = controlledLifecycle();
      const name = `contract.${effect}`;
      const localTools = {
        supportedToolNames: [name],
        getToolDefinitions: () => [{
          name,
          execution: {
            effect,
            timeoutMs: 10,
            maxTimeoutMs: 10
          }
        }],
        listTools: async () => [],
        invoke: vi.fn(async () => await new Promise(() => {}))
      };
      const broker = new RuntimeToolBroker({
        localTools,
        receipts: receiptStore(),
        invocationLifecycle: lifecycle
      });
      const base = invocation(name, { operation: "one" }, {
        preset: effect === "write" ? "workspace-write" : "trusted-automation"
      });
      const first = broker.invoke(base, new CancellationController().signal);
      await vi.waitFor(() => expect(scheduled).toHaveLength(1));
      scheduled[0].callback();

      await expect(first).resolves.toMatchObject({
        failureCode: "execution_outcome_unknown",
        retryable: false
      });
      await expect(broker.invoke({
        ...base,
        invocationId: `${base.invocationId}:retry`
      }, new CancellationController().signal)).resolves.toMatchObject({
        failureCode: "execution_outcome_unknown",
        content: expect.stringContaining("Duplicate")
      });
      expect(localTools.invoke).toHaveBeenCalledOnce();
    }
  );

  it("coalesces an exact in-flight invocation and fences concurrent side effects", async () => {
    let finish;
    const completion = new Promise((resolve) => {
      finish = resolve;
    });
    const localTools = {
      supportedToolNames: ["external.publish"],
      getToolDefinitions: () => [{
        name: "external.publish",
        execution: { effect: "external" }
      }],
      listTools: async () => [],
      invoke: vi.fn(async () => await completion)
    };
    const broker = new RuntimeToolBroker({
      localTools,
      receipts: receiptStore(),
      invocationLifecycle: new ToolInvocationLifecycle({
        scheduleTimeout: () => ({ dispose() {} })
      })
    });
    const base = invocation("external.publish", { message: "hello" }, {
      preset: "trusted-automation"
    });
    const first = broker.invoke(base, new CancellationController().signal);
    const duplicate = broker.invoke(base, new CancellationController().signal);
    await vi.waitFor(() => expect(localTools.invoke).toHaveBeenCalledOnce());
    const concurrent = broker.invoke({
      ...base,
      invocationId: `${base.invocationId}:concurrent`
    }, new CancellationController().signal);

    await expect(concurrent).resolves.toMatchObject({
      failureCode: "execution_outcome_unknown",
      retryable: false
    });
    finish({ ok: true, content: "published" });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(duplicate).resolves.toMatchObject({ ok: true });
    expect(localTools.invoke).toHaveBeenCalledOnce();
  });

  it("holds the side-effect fence until the durable receipt is saved", async () => {
    const receipts = receiptStore();
    const persist = receipts.saveToolReceipt.bind(receipts);
    let announceSave;
    let releaseSave;
    const saveStarted = new Promise((resolve) => {
      announceSave = resolve;
    });
    const saveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    receipts.saveToolReceipt = async (input) => {
      if (input.invocationId === "invocation:external.commit") {
        announceSave();
        await saveGate;
      }
      return persist(input);
    };
    const localTools = {
      supportedToolNames: ["external.commit"],
      getToolDefinitions: () => [{
        name: "external.commit",
        execution: { effect: "external" }
      }],
      listTools: async () => [],
      invoke: vi.fn(async () => ({ ok: true, content: "committed" }))
    };
    const broker = new RuntimeToolBroker({
      localTools,
      receipts,
      invocationLifecycle: new ToolInvocationLifecycle({
        scheduleTimeout: () => ({ dispose() {} })
      })
    });
    const base = invocation("external.commit", { operation: "one" }, {
      preset: "trusted-automation"
    });
    const first = broker.invoke(base, new CancellationController().signal);
    await saveStarted;

    await expect(broker.invoke({
      ...base,
      invocationId: `${base.invocationId}:concurrent`
    }, new CancellationController().signal)).resolves.toMatchObject({
      failureCode: "execution_outcome_unknown"
    });
    expect(localTools.invoke).toHaveBeenCalledOnce();

    releaseSave();
    await expect(first).resolves.toMatchObject({
      ok: true,
      content: "committed"
    });
  });

  it("reauthorizes before sharing an in-flight invocation result", async () => {
    let finish;
    let checks = 0;
    const hostCompletion = new Promise((resolve) => {
      finish = resolve;
    });
    const localTools = {
      supportedToolNames: ["external.secure"],
      getToolDefinitions: () => [{
        name: "external.secure",
        execution: { effect: "external" }
      }],
      listTools: async () => [],
      invoke: vi.fn(async () => await hostCompletion)
    };
    const broker = new RuntimeToolBroker({
      localTools,
      receipts: receiptStore(),
      authorizeInvocation: async (input) => {
        checks += 1;
        if (checks > 1) throw new Error("grant_inactive");
        return input;
      },
      invocationLifecycle: new ToolInvocationLifecycle({
        scheduleTimeout: () => ({ dispose() {} })
      })
    });
    const base = invocation("external.secure", {}, {
      preset: "trusted-automation"
    });
    const first = broker.invoke(base, new CancellationController().signal);
    await vi.waitFor(() => expect(localTools.invoke).toHaveBeenCalledOnce());

    await expect(broker.invoke(
      base,
      new CancellationController().signal
    )).rejects.toThrow("grant_inactive");
    finish({ ok: true, content: "done" });
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(localTools.invoke).toHaveBeenCalledOnce();
  });
});
