import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  createRuntimeChatClient,
  runChatCli
} from "../src/chat-cli.mjs";
import {
  createCliDeviceHost,
  createRuntimeControlClient,
  resolveRuntimeCliTarget,
  runRuntimeCli
} from "../src/runtime-cli.mjs";

function jsonResponse(status, value) {
  return new globalThis.Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function sseResponse(events) {
  const body = events.map((event) => [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    ""
  ].join("\n")).join("");
  return new globalThis.Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

describe("Runtime chat client", () => {
  it("creates a Session, sends a message, and follows Run deltas", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, {
        session: { id: "session-1", title: "CLI conversation" }
      }))
      .mockResolvedValueOnce(jsonResponse(202, {
        sessionId: "session-1",
        runId: "run-1",
        attemptId: "attempt-1",
        status: "accepted"
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        run: { id: "run-1", status: "completed" }
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        runId: "run-1",
        events: [{
          sequence: 1,
          type: "message.delta",
          data: { delta: "hello " }
        }, {
          sequence: 2,
          type: "message.delta",
          data: { delta: "world" }
        }]
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        sessionId: "session-1",
        messages: [
          { sequence: 1, role: "user", content: "hi" },
          { sequence: 2, role: "assistant", content: "hello world" }
        ]
      }));
    const client = createRuntimeChatClient({
      baseUrl: "http://runtime.test/",
      fetchImpl,
      pollIntervalMs: 0
    });

    const session = await client.createSession();
    const accepted = await client.sendMessage(session.id, "hi");
    let output = "";
    const run = await client.followRun(accepted.runId, (delta) => {
      output += delta;
    });
    const transcript = await client.getTranscript(session.id);

    expect(run.status).toBe("completed");
    expect(output).toBe("hello world");
    expect(transcript).toHaveLength(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://runtime.test/v1/sessions/session-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "hi" })
      })
    );
  });

  it("surfaces Runtime API errors", async () => {
    const client = createRuntimeChatClient({
      baseUrl: "http://runtime.test",
      fetchImpl: async () => jsonResponse(409, {
        error: "Session already has an active Run"
      })
    });

    await expect(client.sendMessage("session-1", "again"))
      .rejects.toThrow("Session already has an active Run");
  });

  it("creates a project-scoped Session from CLI authorization flags", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, {
      session: {
        id: "session-remote",
        title: "Remote project",
        projectId: "zion-next"
      }
    }));

    await runChatCli({
      argv: [
        "--url", "http://runtime.test",
        "--title", "Remote project",
        "--project", "zion-next",
        "--tool", "read",
        "--tool", "glob,grep",
        "--file-root", "/workspace/zion-next",
        "--terminal-session", "terminal:one",
        "--max-tool-calls", "8"
      ],
      input: Readable.from([]),
      output: new PassThrough(),
      fetchImpl,
      environment: {}
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://runtime.test/v1/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Remote project",
          interactionProfileId: "interactive.default",
          projectId: "zion-next",
          policy: {
            allowedTools: ["read", "glob", "grep"],
            fileRoots: ["/workspace/zion-next"],
            allowedTerminalSessionIds: ["terminal:one"],
            maxToolCalls: 8
          }
        })
      })
    );
  });

  it("creates a Session with a requested Runtime model profile", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, {
      session: {
        id: "session-model",
        title: "Model session"
      }
    }));

    await runChatCli({
      argv: [
        "--url", "http://runtime.test",
        "--title", "Model session",
        "--model-profile", "workbench.user.dynamic.kimi-k3",
        "--no-terminal-context"
      ],
      input: Readable.from([]),
      output: new PassThrough(),
      fetchImpl,
      environment: {}
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://runtime.test/v1/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Model session",
          interactionProfileId: "interactive.default",
          model: { profileId: "workbench.user.dynamic.kimi-k3" },
          metadata: { includeTerminalContext: false }
        })
      })
    );
  });

  it("can create a Session with no tools for bare-model diagnostics", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, {
      session: {
        id: "session-no-tools",
        title: "No tools"
      }
    }));

    await runChatCli({
      argv: [
        "--url", "http://runtime.test",
        "--title", "No tools",
        "--no-tools"
      ],
      input: Readable.from([]),
      output: new PassThrough(),
      fetchImpl,
      environment: {}
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://runtime.test/v1/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "No tools",
          interactionProfileId: "interactive.default",
          policy: {
            allowedTools: []
          }
        })
      })
    );
  });

  it("prints CLI authorization options without contacting Runtime", async () => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk.toString();
    });
    const fetchImpl = vi.fn();

    await expect(runChatCli({
      argv: ["--help"],
      input: Readable.from([]),
      output,
      fetchImpl,
      environment: {}
    })).resolves.toBeNull();

    expect(text).toContain("--project <id>");
    expect(text).toContain("--profile <id>");
    expect(text).toContain("--model-profile <id>");
    expect(text).toContain("--preset <preset>");
    expect(text).toContain("--no-tools");
    expect(text).toContain("--no-terminal-context");
    expect(text).toContain("--terminal-session <id>");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Runtime control CLI", () => {
  it("runs a prompt and emits the canonical RunEvent stream as JSONL", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, {
        runId: "run-cli",
        attemptId: "attempt-cli",
        status: "accepted"
      }))
      .mockResolvedValueOnce(sseResponse([{
          eventId: "event-1",
          runId: "run-cli",
          attemptId: "attempt-cli",
          sequence: 1,
          type: "message.delta",
          timestamp: 1000,
          data: { delta: "hello" }
      }]))
      .mockResolvedValueOnce(jsonResponse(200, {
        runId: "run-cli",
        events: []
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        run: {
          id: "run-cli",
          status: "completed",
          output: "hello"
        }
      }));
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk.toString();
    });

    await expect(runRuntimeCli({
      argv: [
        "run",
        "inspect",
        "the",
        "repo",
        "--url", "http://runtime.test",
        "--jsonl",
        "--profile", "interactive.default",
        "--tool", "read,grep"
      ],
      output,
      fetchImpl,
      environment: {},
      pollIntervalMs: 0
    })).resolves.toMatchObject({
      id: "run-cli",
      status: "completed"
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://runtime.test/v1/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "inspect the repo",
          title: "inspect the repo",
          interactionProfileId: "interactive.default",
          policy: { allowedTools: ["read", "grep"] },
          metadata: { source: "runtime-cli" }
        })
      })
    );
    expect(String(fetchImpl.mock.calls[1][0]))
      .toContain("/v1/runs/run-cli/projection/stream");
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual([
      "run.accepted",
      "run.attached",
      "run.event",
      "run.snapshot"
    ]);
    expect(records[2].event.type).toBe("message.delta");
  });

  it("exposes Session and Scheduler control-plane operations", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        sessions: [{ id: "session-1", status: "active" }]
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        id: "scheduled-run-1",
        taskId: "task-1",
        status: "queued"
      }));
    const output = new PassThrough();

    await runRuntimeCli({
      argv: ["session", "list", "--url", "http://runtime.test", "--limit", "5"],
      output,
      fetchImpl,
      environment: {}
    });
    await runRuntimeCli({
      argv: ["task", "run", "task-1", "--url", "http://runtime.test", "--jsonl"],
      output,
      fetchImpl,
      environment: {}
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://runtime.test/v1/sessions?limit=5",
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://runtime.test/v1/scheduler/tasks/task-1/run",
      expect.objectContaining({
        method: "POST",
        body: "{}"
      })
    );
  });

  it("supports attach, resume, and abort through the same client", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, {
        runId: "run-1",
        attemptId: "attempt-2",
        status: "accepted"
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        runId: "run-1"
      }));
    const client = createRuntimeControlClient({
      baseUrl: "http://runtime.test",
      fetchImpl,
      pollIntervalMs: 0
    });

    await expect(client.resumeRun("run-1")).resolves.toMatchObject({
      attemptId: "attempt-2"
    });
    await expect(client.abortRun("run-1", "operator")).resolves.toEqual({
      ok: true,
      runId: "run-1"
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://runtime.test/v1/runs/run-1/abort",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "operator" })
      })
    );
  });

  it("prints the multi-command CLI help without contacting Runtime", async () => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk.toString();
    });
    const fetchImpl = vi.fn();

    await expect(runRuntimeCli({
      argv: ["run", "--help"],
      output,
      fetchImpl,
      environment: {}
    })).resolves.toBeNull();
    expect(text).toContain("run <prompt>");
    expect(text).toContain("session transcript <id>");
    expect(text).toContain("task cancel <run-id>");
    expect(text).toContain("--jsonl");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves local/cloud endpoint profiles without storing or printing secrets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-runtime-cli-profile-"));
    const configPath = join(directory, "cli.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      defaultProfile: "cloud",
      profiles: {
        local: { url: "http://127.0.0.1:8766" },
        cloud: {
          url: "https://runtime.example.test",
          auth: {
            type: "bearer",
            env: "ZION_TEST_CLOUD_TOKEN"
          }
        }
      }
    }));
    try {
      const target = resolveRuntimeCliTarget({
        argv: [],
        environment: {
          ZION_RUNTIME_CLI_CONFIG: configPath,
          ZION_TEST_CLOUD_TOKEN: "secret-token"
        }
      });
      expect(target).toMatchObject({
        baseUrl: "https://runtime.example.test",
        profileName: "cloud",
        headers: { authorization: "Bearer secret-token" }
      });
      expect(JSON.stringify(target.profiles)).not.toContain("secret-token");

      const fetchImpl = vi.fn(async (_url, options) => {
        expect(options.headers).toMatchObject({
          authorization: "Bearer secret-token"
        });
        return jsonResponse(200, {
          session: { id: "cloud-session", status: "active" }
        });
      });
      await runRuntimeCli({
        argv: ["session", "get", "cloud-session"],
        output: new PassThrough(),
        fetchImpl,
        environment: {
          ZION_RUNTIME_CLI_CONFIG: configPath,
          ZION_TEST_CLOUD_TOKEN: "secret-token"
        }
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://runtime.example.test/v1/sessions/cloud-session",
        expect.any(Object)
      );

      const workloadTokenPath = join(directory, "workload.jwt");
      writeFileSync(workloadTokenPath, "projected-workload-token\n");
      writeFileSync(configPath, JSON.stringify({
        version: 1,
        defaultProfile: "workload",
        profiles: {
          workload: {
            url: "https://workload.runtime.test",
            auth: {
              type: "workload",
              tokenFileEnv: "ZION_TEST_TOKEN_FILE"
            }
          }
        }
      }));
      expect(resolveRuntimeCliTarget({
        argv: [],
        environment: {
          ZION_RUNTIME_CLI_CONFIG: configPath,
          ZION_TEST_TOKEN_FILE: workloadTokenPath
        }
      })).toMatchObject({
        baseUrl: "https://workload.runtime.test",
        headers: {
          authorization: "Bearer projected-workload-token"
        }
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts a Device Tool Host from CLI scope without Workbench", async () => {
    const toolHost = {
      assertHealthy: vi.fn(async () => {}),
      invoke: vi.fn()
    };
    const connector = {
      start: vi.fn(async () => ({
        state: "running",
        nodeId: "node:test",
        activeInvocations: 0
      })),
      stop: vi.fn(async () => {})
    };
    const createConnector = vi.fn(() => connector);

    const host = await createCliDeviceHost({
      argv: [
        "--project", "zion-next",
        "--resource-id", "workspace:zion-next",
        "--workspace-root", "/workspace/zion-next",
        "--terminal-sessions", "terminal-1,terminal-2",
        "--node-id", "node:test",
        "--local-tools-url", "http://local-tools.test"
      ],
      runtimeUrl: "https://runtime.test",
      environment: {
        ZION_DEVICE_TOKEN: "device-secret"
      },
      output: new PassThrough(),
      toolHost,
      createConnector
    });

    expect(toolHost.assertHealthy).toHaveBeenCalledOnce();
    expect(createConnector).toHaveBeenCalledWith(expect.objectContaining({
      runtimeUrl: "https://runtime.test",
      token: "device-secret",
      toolHost,
      registration: expect.objectContaining({
        nodeId: "node:test",
        resources: [{
          resourceId: "workspace:zion-next",
          kind: "workspace",
          projectId: "zion-next",
          label: "zion-next"
        }]
      })
    }));
    expect(host.snapshot).toMatchObject({ state: "running" });
  });

  it("uses a Keychain-backed OAuth device credential for cloud requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-runtime-cli-device-auth-"));
    const configPath = join(directory, "cli.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      defaultProfile: "cloud",
      profiles: {
        cloud: {
          url: "https://runtime.example.test",
          auth: {
            type: "device_code",
            deviceAuthorizationUrl: "https://id.example.test/device",
            tokenUrl: "https://id.example.test/token",
            clientId: "zion-cli"
          }
        }
      }
    }));
    const credentialStore = {
      get: vi.fn(async () => ({
        tokenType: "Bearer",
        accessToken: "keychain-access-token",
        expiresAt: Date.now() + 60_000
      }))
    };
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.headers.authorization).toBe(
        "Bearer keychain-access-token"
      );
      return jsonResponse(200, {
        session: { id: "cloud-session", status: "active" }
      });
    });
    try {
      await runRuntimeCli({
        argv: ["session", "get", "cloud-session"],
        output: new PassThrough(),
        fetchImpl,
        credentialStore,
        environment: {
          ZION_RUNTIME_CLI_CONFIG: configPath
        }
      });
      expect(credentialStore.get).toHaveBeenCalledWith("cloud");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs OAuth device login through the CLI without printing tokens", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-runtime-cli-login-"));
    const configPath = join(directory, "cli.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      profiles: {
        cloud: {
          url: "https://runtime.example.test",
          auth: {
            type: "device_code",
            deviceAuthorizationUrl: "https://id.example.test/device",
            tokenUrl: "https://id.example.test/token",
            clientId: "zion-cli"
          }
        }
      }
    }));
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk.toString();
    });
    const credentialStore = {
      set: vi.fn(async () => {})
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        device_code: "device-secret",
        user_code: "ABCD",
        verification_uri: "https://id.example.test/activate",
        expires_in: 60,
        interval: 1
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600
      }));
    try {
      await runRuntimeCli({
        argv: ["auth", "login", "cloud", "--jsonl"],
        output,
        fetchImpl,
        credentialStore,
        sleep: async () => {},
        environment: {
          ZION_RUNTIME_CLI_CONFIG: configPath
        }
      });
      const records = text.trim().split("\n").map((line) => JSON.parse(line));
      expect(records.map((record) => record.type)).toEqual([
        "auth.deviceCode",
        "auth.completed"
      ]);
      expect(text).not.toContain("access-secret");
      expect(text).not.toContain("refresh-secret");
      expect(credentialStore.set).toHaveBeenCalledWith(
        "cloud",
        expect.objectContaining({ accessToken: "access-secret" })
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
