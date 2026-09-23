import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { createPluginDataFileHost } from "../../../packages/local-tools-client/src/plugin-data-files.mjs";
import {
  LocalToolsBroker,
  LocalToolsDeviceHost,
  LocalToolsReadOnlyBroker
} from "../src/local-tools-readonly-broker.mjs";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    }
  };
}

function invocation(overrides = {}) {
  return {
    invocationId: "invocation-1",
    runId: "run-1",
    attemptId: "attempt-1",
    policy: {
      allowedTools: ["read"],
      maxToolCalls: 10,
      fileRoots: ["/workspace/project"],
      allowedTerminalSessionIds: ["terminal-1"]
    },
    toolCall: {
      id: "call-1",
      name: "read",
      arguments: {
        path: "/workspace/project/src/main.ts",
        session_id: "terminal-1",
        offset: 2,
        limit: 10
      }
    },
    ...overrides
  };
}

describe("LocalToolsReadOnlyBroker", () => {
  it("advertises only allowed read-only tools after a health check", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true }));
    const broker = new LocalToolsReadOnlyBroker({ fetchImpl });

    const tools = await broker.listTools({
      policy: {
        allowedTools: ["read", "write", "grep"]
      }
    });

    expect(tools.map((tool) => tool.name)).toEqual(["read", "grep"]);
    const grep = tools.find((tool) => tool.name === "grep");
    expect(grep.inputSchema.required).toEqual(["pattern"]);
    expect(grep.inputSchema.properties).toMatchObject({
      B: { type: "number" },
      A: { type: "number" },
      C: { type: "number" },
      n: { type: "boolean" },
      i: { type: "boolean" },
      type: { type: "string" }
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8765/health"),
      expect.objectContaining({ method: "GET" })
    );
  });

  it("executes an explicitly scoped read and forwards the invocation id", async () => {
    const fetchImpl = vi.fn(async () => response({
      path: "/workspace/project/src/main.ts",
      content: "line 2"
    }));
    const broker = new LocalToolsReadOnlyBroker({ fetchImpl });
    const cancellation = new CancellationController();

    const result = await broker.invoke(invocation(), cancellation.signal);

    expect(result).toMatchObject({ ok: true });
    expect(result.content).toContain("line 2");
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe("/files/read");
    expect(url.searchParams.get("path")).toBe("/workspace/project/src/main.ts");
    expect(url.searchParams.get("session_id")).toBe("terminal-1");
    expect(url.searchParams.get("offset")).toBe("2");
    expect(options.headers["x-zion-invocation-id"]).toBe("invocation-1");
  });

  it("treats empty read and terminal allowlists as unrestricted", async () => {
    const fetchImpl = vi.fn(async () => response({
      path: "/workspace/project/.git",
      entries: [{ name: "refs", type: "directory" }]
    }));
    const broker = new LocalToolsReadOnlyBroker({ fetchImpl });

    await expect(broker.invoke(invocation({
      policy: {
        preset: "read-only",
        allowedTools: ["tree"],
        fileRoots: [],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call-tree",
        name: "tree",
        arguments: {
          path: "/workspace/project/.git",
          session_id: "terminal-existing",
          max_depth: 2
        }
      }
    }), new CancellationController().signal)).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("refs")
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe("/files/entries");
    expect(url.searchParams.get("path")).toBe("/workspace/project/.git");
    expect(url.searchParams.get("session_id")).toBe("terminal-existing");
  });

  it("treats the filesystem root as an unrestricted file root", async () => {
    const fetchImpl = vi.fn(async () => response({
      content: "ok",
      path: "/Users/test/gits/app/file.txt"
    }));
    const broker = new LocalToolsBroker({ fetchImpl });

    await expect(broker.invoke(invocation({
      policy: {
        preset: "workspace-write",
        allowedTools: ["read"],
        fileRoots: ["/"],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call-root-file",
        name: "read",
        arguments: {
          path: "/Users/test/gits/app/file.txt"
        }
      }
    }), new CancellationController().signal)).resolves.toMatchObject({
      ok: true
    });

    expect(fetchImpl.mock.calls[0][0].searchParams.get("path"))
      .toBe("/Users/test/gits/app/file.txt");
  });

  it("rejects tools, paths, and terminal sessions outside the Run policy", async () => {
    const fetchImpl = vi.fn();
    const broker = new LocalToolsReadOnlyBroker({ fetchImpl });
    const signal = new CancellationController().signal;

    await expect(broker.invoke(invocation({
      policy: {
        allowedTools: [],
        maxToolCalls: 10,
        fileRoots: ["/workspace/project"],
        allowedTerminalSessionIds: ["terminal-1"]
      }
    }), signal)).rejects.toThrow("tool is not allowed");

    await expect(broker.invoke(invocation({
      toolCall: {
        id: "call-1",
        name: "read",
        arguments: {
          path: "/workspace/project/../secret.txt",
          session_id: "terminal-1"
        }
      }
    }), signal)).rejects.toThrow(
      'file path "/workspace/project/../secret.txt" '
      + "is outside allowed roots: /workspace/project"
    );

    await expect(broker.invoke(invocation({
      toolCall: {
        id: "call-1",
        name: "read",
        arguments: {
          path: "/workspace/project/src/main.ts",
          session_id: "terminal-2"
        }
      }
    }), signal)).rejects.toThrow("terminal session is not allowed");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns local-tools application errors as failed tool results", async () => {
    const broker = new LocalToolsReadOnlyBroker({
      fetchImpl: async () => response({ error: "session not found" })
    });

    const result = await broker.invoke(
      invocation(),
      new CancellationController().signal
    );

    expect(result).toMatchObject({
      ok: false,
      error: "session not found"
    });
  });

  it("defaults optional search paths to the sole allowed root", async () => {
    const fetchImpl = vi.fn(async () => response({ matches: [] }));
    const broker = new LocalToolsReadOnlyBroker({ fetchImpl });
    const call = invocation({
      policy: {
        allowedTools: ["grep"],
        maxToolCalls: 10,
        fileRoots: ["/workspace/project"],
        allowedTerminalSessionIds: ["terminal-1"]
      },
      toolCall: {
        id: "call-grep",
        name: "grep",
        arguments: {
          pattern: "Runtime",
          session_id: "terminal-1",
          B: 2,
          A: 3,
          n: true,
          i: true,
          type: "ts"
        }
      }
    });

    await expect(broker.invoke(
      call,
      new CancellationController().signal
    )).resolves.toMatchObject({ ok: true });

    const [url] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe("/files/grep");
    expect(url.searchParams.get("path")).toBe("/workspace/project");
    expect(url.searchParams.get("B")).toBe("2");
    expect(url.searchParams.get("A")).toBe("3");
    expect(url.searchParams.get("n")).toBe("true");
    expect(url.searchParams.get("i")).toBe("true");
    expect(url.searchParams.get("type")).toBe("ts");
  });

  it("intersects Runtime policy with Device-local resource policy", async () => {
    const fetchImpl = vi.fn(async () => response({
      content: "locally authorized"
    }));
    const host = new LocalToolsDeviceHost({
      fetchImpl,
      resourceBindings: {
        "workspace:project": {
          root: "/workspace/project",
          allowedTerminalSessionIds: ["terminal-1"]
        }
      }
    });
    const remoteInvocation = invocation({
      policy: {
        allowedTools: ["read"],
        fileRoots: ["/workspace"],
        allowedTerminalSessionIds: ["terminal-1", "terminal-2"]
      }
    });

    await expect(host.invoke(
      remoteInvocation,
      new CancellationController().signal,
      { resourceId: "workspace:project" }
    )).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("locally authorized")
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(url.searchParams.get("path")).toBe(
      "/workspace/project/src/main.ts"
    );
  });

  it("narrows an unrestricted Runtime policy to Device-local bindings", async () => {
    const fetchImpl = vi.fn(async () => response({
      content: "device scoped"
    }));
    const host = new LocalToolsDeviceHost({
      fetchImpl,
      resourceBindings: {
        "workspace:project": {
          root: "/workspace/project",
          allowedTerminalSessionIds: ["terminal-1"]
        }
      }
    });

    await expect(host.invoke(invocation({
      policy: {
        allowedTools: ["read"],
        fileRoots: [],
        allowedTerminalSessionIds: []
      }
    }), new CancellationController().signal, {
      resourceId: "workspace:project"
    })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("device scoped")
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url.searchParams.get("session_id")).toBe("terminal-1");
  });

  it("applies a hot Device access policy before the Runtime policy", async () => {
    const fetchImpl = vi.fn(async () => response({
      content: "dynamic project access"
    }));
    const accessPolicyProvider = vi.fn(async () => ({
      fileRoots: ["/projects/dynamic"],
      allowedTerminalSessionIds: ["terminal-dynamic"]
    }));
    const host = new LocalToolsDeviceHost({
      fetchImpl,
      accessPolicyProvider,
      resourceBindings: {
        "workspace:project": {
          root: "/workspace/project",
          allowedTerminalSessionIds: ["terminal-1"]
        }
      }
    });

    await expect(host.invoke(invocation({
      policy: {
        allowedTools: ["read"],
        fileRoots: [],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call:dynamic",
        name: "read",
        arguments: {
          path: "/projects/dynamic/README.md",
          session_id: "terminal-dynamic"
        }
      }
    }), new CancellationController().signal, {
      resourceId: "workspace:project"
    })).resolves.toMatchObject({ ok: true });

    expect(accessPolicyProvider).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: "workspace:project",
      invocation: expect.objectContaining({
        toolCall: expect.objectContaining({ name: "read" })
      })
    }));
    const [url] = fetchImpl.mock.calls[0];
    expect(url.searchParams.get("path")).toBe("/projects/dynamic/README.md");
    expect(url.searchParams.get("session_id")).toBe("terminal-dynamic");
  });

  it("allows explicitly configured Skill roots without exposing the whole home directory", async () => {
    const fetchImpl = vi.fn(async () => response({
      content: "skill instructions"
    }));
    const host = new LocalToolsDeviceHost({
      fetchImpl,
      additionalRoots: ["/Users/test/.zion-next/skills"],
      resourceBindings: {
        "workspace:project": {
          root: "/workspace/project",
          allowedTerminalSessionIds: ["terminal-1"]
        }
      }
    });

    await expect(host.invoke(invocation({
      policy: {
        allowedTools: ["read"],
        fileRoots: [],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call:skill",
        name: "read",
        arguments: {
          path: "/Users/test/.zion-next/skills/example/SKILL.md"
        }
      }
    }), new CancellationController().signal, {
      resourceId: "workspace:project"
    })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("skill instructions")
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url.searchParams.get("path")).toBe(
      "/Users/test/.zion-next/skills/example/SKILL.md"
    );
  });

  it("expands home-relative paths before authorizing and forwarding them", async () => {
    const fetchImpl = vi.fn(async () => response({
      content: "home-relative skill instructions"
    }));
    const host = new LocalToolsDeviceHost({
      fetchImpl,
      additionalRoots: ["~/.zion-next/skills"],
      resourceBindings: {
        "workspace:project": {
          root: "/workspace/project",
          allowedTerminalSessionIds: ["terminal-1"]
        }
      }
    });

    await expect(host.invoke(invocation({
      policy: {
        allowedTools: ["read"],
        fileRoots: [],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call:home-relative",
        name: "read",
        arguments: {
          path: "~/.zion-next/skills/example/SKILL.md"
        }
      }
    }), new CancellationController().signal, {
      resourceId: "workspace:project"
    })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("home-relative skill instructions")
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url.searchParams.get("path")).toBe(
      `${homedir()}/.zion-next/skills/example/SKILL.md`
    );
  });

  it("rejects remote scopes that are not authorized by the Device", async () => {
    const fetchImpl = vi.fn();
    const host = new LocalToolsDeviceHost({
      fetchImpl,
      resourceBindings: {
        "workspace:project": {
          root: "/workspace/project",
          allowedTerminalSessionIds: ["terminal-1"]
        }
      }
    });
    const signal = new CancellationController().signal;

    await expect(host.invoke(invocation({
      policy: {
        allowedTools: ["read"],
        fileRoots: ["/private/other"],
        allowedTerminalSessionIds: ["terminal-1"]
      }
    }), signal, {
      resourceId: "workspace:project"
    })).rejects.toThrow("do not intersect");

    await expect(host.invoke(invocation({
      policy: {
        allowedTools: ["read"],
        fileRoots: ["/workspace/project"],
        allowedTerminalSessionIds: ["terminal-2"]
      }
    }), signal, {
      resourceId: "workspace:project"
    })).rejects.toThrow("terminal sessions do not intersect");

    await expect(host.invoke(invocation(), signal, {
      resourceId: "workspace:missing"
    })).rejects.toThrow("Device resource is not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("LocalToolsBroker", () => {
  it("routes plugin data files through the adapter before forwarding auto-selected terminal sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "zion-plugin-data-route-"));
    try {
      const fetchImpl = vi.fn(async () => response({ ok: true }));
      const broker = new LocalToolsBroker({
        fetchImpl,
        dataFiles: createPluginDataFileHost({ root })
      });
      const signal = new CancellationController().signal;
      const path = join(root, "dev.identity/projects/example/project.md");
      const result = await broker.invoke(invocation({
        policy: {
          preset: "workspace-write",
          allowedTools: ["write", "edit", "read"],
          fileRoots: [root],
          allowedTerminalSessionIds: ["terminal-1"]
        },
        toolCall: {
          id: "call-plugin-data-write",
          name: "write",
          arguments: {
            path,
            content: "cloud profile"
          }
        }
      }), signal);

      expect(result).toMatchObject({ ok: true });
      expect(await readFile(path, "utf8")).toBe("cloud profile");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects explicit terminal sessions for plugin data file tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "zion-plugin-data-session-"));
    try {
      const broker = new LocalToolsBroker({
        fetchImpl: vi.fn(async () => response({ ok: true })),
        dataFiles: createPluginDataFileHost({ root })
      });
      await expect(broker.invoke(invocation({
        policy: {
          preset: "workspace-write",
          allowedTools: ["write"],
          fileRoots: [root],
          allowedTerminalSessionIds: ["terminal-1"]
        },
        toolCall: {
          id: "call-plugin-data-explicit-session",
          name: "write",
          arguments: {
            path: join(root, "dev.identity/user.md"),
            content: "profile",
            session_id: "terminal-1"
          }
        }
      }), new CancellationController().signal)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("omit session_id")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes writes only inside workspace-write roots", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true, bytes: 7 }));
    const broker = new LocalToolsBroker({ fetchImpl });
    const signal = new CancellationController().signal;
    const writeInvocation = invocation({
      policy: {
        preset: "workspace-write",
        allowedTools: ["write"],
        fileRoots: ["/workspace/project"],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call-write",
        name: "write",
        arguments: {
          path: "/workspace/project/out.txt",
          content: "updated"
        }
      }
    });

    await expect(broker.invoke(writeInvocation, signal))
      .resolves.toMatchObject({ ok: true });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe("/files/write");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toMatchObject({
      path: "/workspace/project/out.txt",
      content: "updated"
    });

    await expect(broker.invoke({
      ...writeInvocation,
      invocationId: "outside",
      toolCall: {
        ...writeInvocation.toolCall,
        arguments: {
          path: "/private/out.txt",
          content: "blocked"
        }
      }
    }, signal)).rejects.toThrow("outside allowed roots");
  });

  it("allows explicitly enabled writes to any absolute path when roots are unrestricted", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true, bytes: 7 }));
    const broker = new LocalToolsBroker({ fetchImpl });

    await expect(broker.invoke(invocation({
      policy: {
        preset: "workspace-write",
        allowedTools: ["write"],
        fileRoots: [],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call-unscoped-write",
        name: "write",
        arguments: {
          path: "/workspace/other/out.txt",
          content: "updated",
          session_id: "terminal-existing"
        }
      }
    }), new CancellationController().signal)).resolves.toMatchObject({
      ok: true
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      path: "/workspace/other/out.txt",
      session_id: "terminal-existing"
    });
  });

  it("enforces trusted Bash prefixes and keeps the sandbox by default", async () => {
    const fetchImpl = vi.fn(async () => response({
      ok: true,
      exit_code: 0,
      stdout: "passed"
    }));
    const broker = new LocalToolsBroker({ fetchImpl });
    const signal = new CancellationController().signal;
    const bashInvocation = invocation({
      policy: {
        preset: "trusted-automation",
        allowedTools: ["Bash"],
        fileRoots: ["/workspace/project"],
        allowedCommandPrefixes: ["npm test"],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call-bash",
        name: "Bash",
        arguments: {
          command: "npm test -- --run",
          cwd: "/workspace/project"
        }
      }
    });

    await broker.invoke(bashInvocation, signal);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe("/bash");
    expect(JSON.parse(options.body)).toMatchObject({
      command: "npm test -- --run",
      cwd: "/workspace/project",
      dangerouslyDisableSandbox: false
    });

    await expect(broker.invoke({
      ...bashInvocation,
      invocationId: "unsafe",
      toolCall: {
        ...bashInvocation.toolCall,
        arguments: { command: "rm -rf /" }
      }
    }, signal)).rejects.toThrow("outside allowed prefixes");
  });

  it("disables the local-tools sandbox only when explicitly configured", async () => {
    const fetchImpl = vi.fn(async () => response({
      ok: true,
      exit_code: 0,
      stdout: "passed"
    }));
    const broker = new LocalToolsBroker({
      fetchImpl,
      allowDangerousCommands: true
    });
    await broker.invoke(invocation({
      policy: {
        preset: "trusted-automation",
        allowedTools: ["Bash"],
        fileRoots: ["/"],
        allowedCommandPrefixes: [],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call-dangerous-bash",
        name: "Bash",
        arguments: {
          command: "rm -f /tmp/zion-permissive-test",
          cwd: "/tmp"
        }
      }
    }), new CancellationController().signal);

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      command: "rm -f /tmp/zion-permissive-test",
      dangerouslyDisableSandbox: true
    });
  });

  it("routes Bash through the sole terminal allowed by the Run policy", async () => {
    const fetchImpl = vi.fn(async () => response({
      ok: true,
      exit_code: 0,
      stdout: "/workspace/project\n"
    }));
    const broker = new LocalToolsBroker({ fetchImpl });

    await expect(broker.invoke(invocation({
      policy: {
        preset: "trusted-automation",
        allowedTools: ["Bash"],
        fileRoots: ["/workspace/project"],
        allowedCommandPrefixes: [],
        allowedTerminalSessionIds: ["terminal-1"]
      },
      toolCall: {
        id: "call-bash-default-session",
        name: "Bash",
        arguments: {
          command: "pwd"
        }
      }
    }), new CancellationController().signal)).resolves.toMatchObject({
      ok: true
    });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe("/sessions/terminal-1/exec");
    expect(JSON.parse(options.body)).toEqual({
      command: "pwd",
      dangerouslyDisableSandbox: false
    });
  });

  it("enforces the Runtime recipient allowlist before sending mail", async () => {
    const fetchImpl = vi.fn(async () => response({ success: true }));
    const broker = new LocalToolsBroker({ fetchImpl });
    const signal = new CancellationController().signal;
    const base = invocation({
      policy: {
        preset: "trusted-automation",
        allowedTools: ["sendMail"],
        allowedRecipients: ["allowed@example.com"],
        maxMailPerRun: 1
      },
      toolCall: {
        id: "call-mail",
        name: "sendMail",
        arguments: {
          to: ["allowed@example.com"],
          subject: "Report",
          body: "Done"
        }
      }
    });

    await expect(broker.invoke(base, signal)).resolves.toMatchObject({ ok: true });
    expect(fetchImpl.mock.calls[0][0].pathname).toBe("/mail/send");

    await expect(broker.invoke({
      ...base,
      invocationId: "blocked-mail",
      toolCall: {
        ...base.toolCall,
        arguments: {
          ...base.toolCall.arguments,
          to: ["other@example.com"]
        }
      }
    }, signal)).rejects.toThrow("recipient is not allowed");

    await expect(broker.invoke({
      ...base,
      invocationId: "wildcard-mail",
      policy: {
        ...base.policy,
        allowedRecipients: ["*"]
      },
      toolCall: {
        ...base.toolCall,
        arguments: {
          ...base.toolCall.arguments,
          to: ["other@example.com"]
        }
      }
    }, signal)).resolves.toMatchObject({ ok: true });
  });

  it("maps scoped MCP calls through JSON-RPC", async () => {
    const fetchImpl = vi.fn(async () => response({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "README" }],
        isError: false
      }
    }));
    const broker = new LocalToolsBroker({ fetchImpl });
    const result = await broker.invoke(invocation({
      policy: {
        preset: "read-only",
        allowedTools: ["mcpCall"],
        fileRoots: ["/workspace/project"],
        allowedTerminalSessionIds: []
      },
      toolCall: {
        id: "call-mcp",
        name: "mcpCall",
        arguments: {
          name: "read_file",
          arguments: { path: "/workspace/project/README.md" }
        }
      }
    }), new CancellationController().signal);

    expect(result).toMatchObject({
      ok: true,
      content: expect.stringContaining("README")
    });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe("/mcp");
    expect(JSON.parse(options.body)).toMatchObject({
      method: "tools/call",
      params: {
        name: "read_file",
        arguments: { path: "/workspace/project/README.md" }
      }
    });
  });
});
