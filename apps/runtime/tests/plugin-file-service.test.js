import { describe, expect, it, vi } from "vitest";
import { createPluginFileService } from "../src/plugin-file-service.mjs";
import { terminalReference } from "../../../packages/node-protocol/src/resource-references.mjs";

describe("plugin file service", () => {
  it("reads text files through a file_root-scoped tool policy", async () => {
    const toolHost = {
      invoke: vi.fn(async (invocation) => ({
        ok: true,
        content: JSON.stringify({
          path: invocation.toolCall.arguments.path,
          content: `content:${invocation.toolCall.arguments.path}`
        })
      }))
    };
    const service = createPluginFileService({
      toolHost,
      invocationPrefix: "test.identity"
    });

    await expect(service.readTextFiles({
      fileRoot: "/workspace/.zion-next/memory",
      files: {
        identity: "identity.md",
        user: "user.md"
      },
      sessionId: "terminal-1",
      runContext: {
        runId: "run-1",
        attemptId: "attempt-1",
        policy: {
          fileRoots: ["/workspace"],
          allowedTerminalSessionIds: ["terminal-1"]
        }
      }
    })).resolves.toEqual({
      fileRoot: "/workspace/.zion-next/memory",
      files: {
        identity: "content:/workspace/.zion-next/memory/identity.md",
        user: "content:/workspace/.zion-next/memory/user.md"
      }
    });
    expect(toolHost.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        attemptId: "attempt-1",
        policy: expect.objectContaining({
          preset: "read-only",
          allowedTools: ["read"],
          fileRoots: ["/workspace/.zion-next/memory"],
          allowedTerminalSessionIds: ["terminal-1"]
        }),
        toolCall: expect.objectContaining({
          name: "read",
          arguments: expect.objectContaining({
            path: "/workspace/.zion-next/memory/identity.md",
            session_id: "terminal-1"
          })
        })
      }),
      expect.any(Object)
    );
  });

  it("writes only inside the requested file_root and reports local-tools failures", async () => {
    const toolHost = {
      invoke: vi.fn(async (invocation) => {
        if (invocation.toolCall.arguments.path.includes("blocked")) {
          return { ok: false, error: "blocked" };
        }
        return { ok: true, content: JSON.stringify({ ok: true }) };
      })
    };
    const service = createPluginFileService({ toolHost });

    await expect(service.writeTextFiles({
      fileRoot: "/workspace/memory",
      files: {
        user: {
          relativePath: "user.md",
          content: "# User"
        }
      },
      runContext: {
        policy: {
          fileRoots: ["/workspace"]
        }
      }
    })).resolves.toEqual({
      fileRoot: "/workspace/memory",
      written: [{ key: "user", path: "/workspace/memory/user.md" }]
    });
    expect(toolHost.invoke.mock.calls[0][0].policy).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["write"],
      fileRoots: ["/workspace/memory"]
    });

    await expect(service.writeTextFiles({
      fileRoot: "/private/memory",
      files: {
        user: {
          relativePath: "user.md",
          content: "# User"
        }
      },
      runContext: {
        policy: {
          fileRoots: ["/workspace"]
        }
      }
    })).rejects.toThrow("file_root is outside allowed Runtime policy roots");

    await expect(service.writeTextFiles({
      fileRoot: "/workspace/memory",
      files: {
        blocked: {
          relativePath: "blocked.md",
          content: "# Blocked"
        }
      },
      runContext: {
        policy: {
          fileRoots: ["/workspace"]
        }
      }
    })).rejects.toThrow("blocked");
  });

  it("treats missing reads as empty files", async () => {
    const toolHost = {
      invoke: vi.fn(async () => ({
        ok: false,
        error: "ENOENT: no such file"
      }))
    };
    const service = createPluginFileService({ toolHost });

    await expect(service.readTextFiles({
      fileRoot: "/workspace/memory",
      files: { identity: "identity.md" },
      runContext: { policy: { fileRoots: [] } }
    })).resolves.toEqual({
      fileRoot: "/workspace/memory",
      files: { identity: "" }
    });
  });

  it("does not treat a chat session id as a terminal session id", async () => {
    const toolHost = {
      invoke: vi.fn(async () => ({
        ok: true,
        content: JSON.stringify({ content: "# Identity" })
      }))
    };
    const service = createPluginFileService({ toolHost });

    await service.readTextFiles({
      fileRoot: "/Users/test/.zion-next/memory",
      files: { identity: "identity.md" },
      runContext: {
        sessionId: "chat-session-1",
        policy: {
          fileRoots: ["/Users/test/.zion-next/memory"]
        }
      }
    });

    expect(toolHost.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "chat-session-1",
        policy: expect.objectContaining({
          allowedTerminalSessionIds: []
        }),
        toolCall: expect.objectContaining({
          arguments: {
            path: "/Users/test/.zion-next/memory/identity.md",
            session_id: ""
          }
        })
      }),
      expect.any(Object)
    );
  });

  describe.each(["readTextFiles", "writeTextFiles"])("%s terminal scope", (method) => {
    const terminalId = (nodeId) => terminalReference({
      nodeId,
      instanceId: `instance:${nodeId}`,
      resourceId: `workspace:${nodeId}`,
      sessionId: "same-terminal"
    });
    const cloud = terminalId("cloud");
    const mac = terminalId("mac");
    const files = method === "readTextFiles"
      ? { identity: "identity.md" }
      : { identity: { relativePath: "identity.md", content: "# Identity" } };
    const options = { fileRoot: "/workspace/memory", files };
    const create = () => {
      const toolHost = { invoke: vi.fn(async () => ({
        ok: true,
        content: JSON.stringify({ content: "# Identity" })
      })) };
      return { toolHost, service: createPluginFileService({ toolHost }) };
    };

    it.each(["argument", "context"])("rejects an unauthorized %s terminal", async (source) => {
      const { toolHost, service } = create();
      const runContext = {
        policy: { allowedTerminalSessionIds: [cloud] },
        ...(source === "context" ? { terminalSessionId: mac } : {})
      };
      await expect(service[method]({
        ...options,
        ...(source === "argument" ? { sessionId: mac } : {}),
        runContext
      })).rejects.toThrow(/terminal.*(outside|not allowed)/i);
      expect(toolHost.invoke).not.toHaveBeenCalled();
      expect(runContext.policy.allowedTerminalSessionIds).toEqual([cloud]);
    });

    it("uses the sole authorized terminal without dropping the parent scope", async () => {
      const { toolHost, service } = create();
      await service[method]({
        ...options,
        runContext: { policy: { allowedTerminalSessionIds: [cloud] } }
      });
      expect(toolHost.invoke).toHaveBeenCalledWith(expect.objectContaining({
        policy: expect.objectContaining({ allowedTerminalSessionIds: [cloud] }),
        toolCall: expect.objectContaining({
          arguments: expect.objectContaining({ session_id: cloud })
        })
      }), expect.any(Object));
    });

    it("requires an explicit terminal when the parent permits several", async () => {
      const { toolHost, service } = create();
      await expect(service[method]({
        ...options,
        runContext: { policy: { allowedTerminalSessionIds: [cloud, mac] } }
      })).rejects.toThrow(/session_id.*required/i);
      expect(toolHost.invoke).not.toHaveBeenCalled();
    });

    it("narrows an authorized selection without changing the parent policy", async () => {
      const { toolHost, service } = create();
      const runContext = { policy: { allowedTerminalSessionIds: [cloud, mac] } };
      await service[method]({ ...options, sessionId: cloud, runContext });
      expect(toolHost.invoke.mock.calls[0][0].policy.allowedTerminalSessionIds)
        .toEqual([cloud]);
      expect(runContext.policy.allowedTerminalSessionIds).toEqual([cloud, mac]);
    });
  });

  it("preserves the parent target for nested file calls", async () => {
    const toolHost = { invoke: vi.fn(async () => ({
      ok: true,
      content: JSON.stringify({ content: "# Identity" })
    })) };
    const service = createPluginFileService({ toolHost });
    const runContext = {
      projectId: "project-1",
      target: {
        nodeId: "node:cloud",
        instanceId: "instance:cloud",
        resourceId: "workspace:cloud"
      }
    };
    const original = structuredClone(runContext);
    await service.readTextFiles({
      fileRoot: "/workspace/memory",
      files: { identity: "identity.md" },
      runContext
    });
    expect(toolHost.invoke.mock.calls[0][0]).toMatchObject(original);
    expect(runContext).toEqual(original);
  });

  it("selects the matching Node by file_root platform when several project Nodes are online", async () => {
    const toolHost = {
      invoke: vi.fn(async () => ({
        ok: true,
        content: JSON.stringify({ content: "# Identity" })
      })),
      registeredTargets: vi.fn(() => [
        {
          node: {
            registration: {
              nodeId: "node:cloud",
              instanceId: "instance:cloud",
              platform: "linux"
            }
          },
          resource: { resourceId: "workspace:cloud" }
        },
        {
          node: {
            registration: {
              nodeId: "node:mac",
              instanceId: "instance:mac",
              platform: "darwin"
            }
          },
          resource: { resourceId: "workspace:mac" }
        }
      ]),
      isOnline: vi.fn(() => true)
    };
    const service = createPluginFileService({ toolHost });

    await service.readTextFiles({
      fileRoot: "/Users/test/.zion-next/memory",
      files: { identity: "identity.md" },
      runContext: {
        projectId: "zion-next",
        policy: { fileRoots: ["/Users/test/.zion-next/memory"] }
      }
    });

    expect(toolHost.invoke).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "zion-next",
      target: {
        nodeId: "node:mac",
        instanceId: "instance:mac",
        resourceId: "workspace:mac"
      }
    }), expect.any(Object));
  });

  it("does not infer a Node when a global terminal session id already routes the call", async () => {
    const explicitSession = terminalReference({
      nodeId: "node:cloud",
      instanceId: "instance:cloud",
      resourceId: "workspace:cloud",
      sessionId: "terminal-1"
    });
    const toolHost = {
      invoke: vi.fn(async () => ({
        ok: true,
        content: JSON.stringify({ content: "# Identity" })
      })),
      registeredTargets: vi.fn(() => [
        {
          node: {
            registration: {
              nodeId: "node:mac",
              instanceId: "instance:mac",
              platform: "darwin"
            }
          },
          resource: { resourceId: "workspace:mac" }
        }
      ]),
      isOnline: vi.fn(() => true)
    };
    const service = createPluginFileService({ toolHost });

    await service.readTextFiles({
      fileRoot: "/Users/test/.zion-next/memory",
      files: { identity: "identity.md" },
      sessionId: explicitSession,
      runContext: {
        projectId: "zion-next",
        policy: { fileRoots: ["/Users/test/.zion-next/memory"] }
      }
    });

    expect(toolHost.invoke.mock.calls[0][0].target).toBeUndefined();
    expect(toolHost.invoke.mock.calls[0][0].toolCall.arguments.session_id)
      .toBe(explicitSession);
  });
});
