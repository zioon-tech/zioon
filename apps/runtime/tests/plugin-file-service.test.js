import { describe, expect, it, vi } from "vitest";
import { createPluginFileService } from "../src/plugin-file-service.mjs";

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
});
