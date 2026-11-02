import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginFileService } from "../src/plugin-file-service.mjs";
import { workspaceFileCommand } from "../src/sandbox/workspace-file-command.mjs";
import { terminalReference } from "../../../packages/node-protocol/src/resource-references.mjs";

describe("plugin file service", () => {
  it("serializes parallel managed file calls and waits only for a proven non-dispatched busy result", async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const toolHost = {
      invoke: vi.fn(async (invocation) => {
        calls += 1;
        if (calls === 1) return {
          ok: false,
          content: "Workspace lifecycle maintenance is in progress",
          failureCode: "sandbox_workspace_busy",
          dispatched: false,
          retryable: true
        };
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          ok: true,
          content: JSON.stringify({ content: invocation.toolCall.arguments.path })
        };
      })
    };
    const service = createPluginFileService({
      toolHost,
      dataLocation: { nodeId: "managed:one", root: "/workspace/identity" },
      serializeInvocations: true
    });
    const runContext = {
      principal: { userId: "user:one", spaceId: "space:one" }
    };
    const loaded = await Promise.all(["identity.md", "user.md", "digest.md"].map((relativePath) =>
      service.readTextFile({ relativePath, runContext })
    ));
    expect(maximum).toBe(1);
    expect(toolHost.invoke).toHaveBeenCalledTimes(4);
    expect(loaded.map((item) => item.content)).toEqual([
      "/workspace/identity/identity.md",
      "/workspace/identity/user.md",
      "/workspace/identity/digest.md"
    ]);
  });

  it("preserves unknown outcomes and never retries a possibly dispatched file write", async () => {
    const toolHost = {
      invoke: vi.fn(async () => ({
        ok: false,
        content: "Write outcome is unknown",
        failureCode: "execution_outcome_unknown",
        dispatched: true,
        retryable: false
      }))
    };
    const service = createPluginFileService({
      toolHost,
      dataLocation: { nodeId: "managed:one", root: "/workspace/identity" },
      serializeInvocations: true
    });
    await expect(service.writeTextFile({
      relativePath: "user.md",
      content: "Updated"
    })).rejects.toMatchObject({
      failureCode: "execution_outcome_unknown",
      retryable: false
    });
    expect(toolHost.invoke).toHaveBeenCalledTimes(1);
  });

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

  it("reads through a legacy fallback but writes only to the scoped location", async () => {
    const requests = [];
    const scopedRoot = "/srv/data/scopes/space%3Aone/accounts/user%3Aowner/dev.identity";
    const legacyRoot = "/srv/data/dev.identity";
    const fileClient = {
      async request(endpoint, options = {}) {
        requests.push({ endpoint, options });
        const path = options.body?.path
          || new URL(endpoint, "http://runtime").searchParams.get("path");
        if (endpoint.startsWith("/files/read") && path.startsWith(scopedRoot)) {
          const error = new Error("ENOENT");
          error.statusCode = 404;
          throw error;
        }
        if (endpoint.startsWith("/files/read") && path.startsWith(legacyRoot)) {
          return {
            plugin_data_version: 1,
            content: "# User\nLegacy profile"
          };
        }
        return { plugin_data_version: 1, ok: true };
      }
    };
    const service = createPluginFileService({
      toolHost: { invoke: vi.fn() },
      dataLocation: (_runContext, { access }) => ({
        data: { nodeId: "", root: scopedRoot },
        readFallbacks: access === "read"
          ? [{ nodeId: "", root: legacyRoot }]
          : []
      }),
      fileClient
    });

    await expect(service.readTextFiles({
      files: { user: "user.md" },
      runContext: {
        principal: { spaceId: "space:one", userId: "user:owner" },
        policy: { fileRoots: [] }
      }
    })).resolves.toEqual({
      fileRoot: scopedRoot,
      files: { user: "# User\nLegacy profile" },
      missing: []
    });
    await service.writeTextFiles({
      files: {
        user: { relativePath: "user.md", content: "# User\nScoped profile" }
      },
      runContext: {
        principal: { spaceId: "space:one", userId: "user:owner" },
        policy: { fileRoots: [] }
      }
    });

    const write = requests.find(({ endpoint }) => endpoint.startsWith("/files/write"));
    expect(write.options.body.path).toBe(`${scopedRoot}/user.md`);
    expect(requests.filter(({ endpoint }) => endpoint.startsWith("/files/write")))
      .toHaveLength(1);
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

  it("supports managed file hashes, directory entries and JSONL pages without a terminal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zion-managed-plugin-http-"));
    const root = join(directory, "dev.identity");
    const toolHost = {
      invoke: vi.fn(async (invocation) => {
        const command = workspaceFileCommand(
          invocation.toolCall.name,
          invocation.toolCall.arguments,
          { fileRoots: invocation.policy.fileRoots }
        );
        try {
          return {
            ok: true,
            content: execFileSync("/bin/bash", ["-c", command], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"]
            })
          };
        } catch (error) {
          const message = String(error.stderr || error.message);
          return { ok: false, content: message, error: message };
        }
      })
    };
    const service = createPluginFileService({
      toolHost,
      dataLocation: { nodeId: "managed:test", root }
    });
    const runContext = {
      principal: { userId: "user:test", spaceId: "space:test" },
      policy: { preset: "workspace-write", fileRoots: [root] }
    };
    try {
      const first = await service.writeTextFile({
        relativePath: "projects/zion-next/project.md",
        content: "# Zion Next\n",
        runContext
      });
      await expect(service.readTextFile({
        relativePath: "projects/zion-next/project.md",
        runContext
      })).resolves.toMatchObject({
        content: "# Zion Next\n",
        contentHash: first.contentHash,
        missing: false
      });
      await expect(service.writeTextFile({
        relativePath: "projects/zion-next/project.md",
        content: "# Zion Next\n\nUpdated\n",
        expectedHash: first.contentHash,
        runContext
      })).resolves.toMatchObject({ written: true });

      const listed = await service.listEntries({
        relativePath: "projects",
        runContext
      });
      expect(listed).toMatchObject({
        missing: false,
        entries: [{
          name: "zion-next",
          type: "directory"
        }]
      });
      expect(listed.entries[0].path).toMatch(/\/projects\/zion-next$/);

      await service.appendJsonl({
        relativePath: "biography/events.jsonl",
        records: [
          { id: "event:1" },
          { id: "event:2" },
          { id: "event:3" }
        ],
        runContext
      });
      await expect(service.readJsonlPage({
        relativePath: "biography/events.jsonl",
        tail: 2,
        limit: 2,
        runContext
      })).resolves.toMatchObject({
        content: '{"id":"event:2"}\n{"id":"event:3"}',
        startLine: 2,
        endLine: 3,
        hasPrevious: true,
        hasMore: false
      });

      expect(toolHost.invoke.mock.calls.every(([invocation]) =>
        !invocation.toolCall.arguments.session_id
      )).toBe(true);
      expect(toolHost.invoke.mock.calls.some(([invocation]) =>
        invocation.toolCall.name === "tree"
        && invocation.toolCall.arguments._plugin_entries === true
      )).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("atomically appends JSONL through managed filesystem tools visible to Bash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zion-managed-plugin-data-"));
    const root = join(directory, "dev.identity");
    const toolHost = {
      async invoke(invocation) {
        const command = workspaceFileCommand(
          invocation.toolCall.name,
          invocation.toolCall.arguments,
          { fileRoots: invocation.policy.fileRoots }
        );
        try {
          return {
            ok: true,
            content: execFileSync("/bin/bash", ["-c", command], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"]
            })
          };
        } catch (error) {
          const message = String(error.stderr || error.message);
          return { ok: false, content: message, error: message };
        }
      }
    };
    const service = createPluginFileService({
      toolHost,
      dataLocation: { nodeId: "managed:test", root }
    });
    const runContext = {
      principal: { userId: "user:test", spaceId: "space:test" },
      policy: { preset: "workspace-write", fileRoots: [root] }
    };
    try {
      const [first, second] = await Promise.all([
        service.appendJsonl({
          relativePath: "biography/events.jsonl",
          records: [{ id: "event:one", summary: "first" }],
          runContext
        }),
        service.appendJsonl({
          relativePath: "biography/events.jsonl",
          records: [{ id: "event:two", summary: "second" }],
          runContext
        })
      ]);
      expect([...first.appended, ...second.appended].sort()).toEqual([
        "event:one",
        "event:two"
      ]);
      const path = join(root, "biography/events.jsonl");
      const records = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      expect(records.map((item) => item.id).sort()).toEqual([
        "event:one",
        "event:two"
      ]);
      expect(execFileSync("/bin/bash", [
        "-c",
        `grep -c '^{' '${path}'`
      ], { encoding: "utf8" }).trim()).toBe("2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
