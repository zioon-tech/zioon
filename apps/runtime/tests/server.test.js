import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { FileInteractionProfileStore } from "../src/interaction-profile-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { SqliteRunStore } from "../src/sqlite-run-store.mjs";

const resources = [];

async function waitForRun(url, runId, expectedStatus) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${url}/v1/runs/${encodeURIComponent(runId)}`);
    const body = await response.json();
    if (body.run?.status === expectedStatus) return body.run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not reach ${expectedStatus}`);
}

async function waitForMessages(url, sessionId, expectedCount) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(
      `${url}/v1/sessions/${encodeURIComponent(sessionId)}/transcript`
    );
    const body = await response.json();
    if (body.messages?.length === expectedCount) return body.messages;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Session ${sessionId} did not reach ${expectedCount} messages`);
}

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "zion-runtime-server-"));
  const store = new SqliteRunStore(join(directory, "runtime.sqlite3"));
  resources.push({ directory, store });
  return store;
}

function createServer(engine, store, options = {}) {
  const {
    tools = {
      async listTools() {
        return [];
      },
      async invoke() {
        throw new Error("No tools configured");
      }
    },
    ...serverOptions
  } = options;
  const executor = createAgentExecutor({
    engine,
    tools,
    runs: store
  });
  return createRuntimeServer({
    executor,
    runs: store,
    port: 0,
    pollIntervalMs: 5,
    ...serverOptions
  });
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    try {
      await resource.server?.close();
    } catch {}
    try {
      resource.store.close();
    } catch {}
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("Runtime Host", () => {
  it("rejects interactive Runs from an outdated Workbench protocol", async () => {
    const store = createStore();
    const server = createServer({
      id: "outdated-workbench",
      async *streamTurn() {
        yield { type: "message.delta", delta: "should not run" };
      }
    }, store);
    resources.at(-1).server = server;
    const address = await server.start();

    const response = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "stale",
        metadata: {
          source: "interactive-chat",
          workbenchProtocolVersion: 3
        }
      })
    });

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("refresh all Workbench tabs")
    });
  });

  it("allows loopback Workbench origins without opening Runtime to arbitrary sites", async () => {
    const store = createStore();
    const server = createServer({
      id: "cors",
      async *streamTurn() {
        yield { type: "message.delta", delta: "ok" };
      }
    }, store);
    resources.at(-1).server = server;
    const address = await server.start();

    const allowed = await fetch(`${address.url}/health`, {
      headers: { origin: "http://localhost:5177" }
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5177"
    );

    const preflight = await fetch(`${address.url}/v1/runs`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5177",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:5177"
    );

    const rejected = await fetch(`${address.url}/health`, {
      headers: { origin: "https://example.com" }
    });
    expect(rejected.status).toBe(403);
  });

  it("exposes sanitized Model Registry profiles", async () => {
    const store = createStore();
    const server = createServer({
      id: "model",
      async *streamTurn() {
        yield { type: "message.delta", delta: "ok" };
      }
    }, store, {
      serviceInfo: {
        modelProfile: {
          id: "deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
          providerType: "openai",
          model: "deepseek-v4-flash"
        }
      },
      modelProfiles: [{
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        providerType: "openai",
        model: "deepseek-v4-flash",
        credentialRef: "model.deepseek"
      }]
    });
    resources.at(-1).server = server;
    const address = await server.start();

    const response = await fetch(`${address.url}/v1/models`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      activeProfileId: "deepseek-v4-flash",
      profiles: [{
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        providerType: "openai",
        model: "deepseek-v4-flash",
        credentialRef: "model.deepseek"
      }]
    });

    const createdResponse = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "use Runtime default" })
    });
    await expect(createdResponse.json()).resolves.toMatchObject({
      model: {
        profileId: "deepseek-v4-flash",
        providerId: "openai",
        modelId: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash"
      }
    });
  });

  it("rejects a model that the Runtime cannot resolve", async () => {
    const store = createStore();
    const server = createServer({
      id: "strict-model",
      async *streamTurn() {
        yield { type: "message.delta", delta: "unexpected" };
      }
    }, store, {
      resolveModel(requested) {
        if (requested?.profileId !== "available") {
          const error = new Error("Runtime model profile not found");
          error.statusCode = 409;
          throw error;
        }
        return requested;
      }
    });
    resources.at(-1).server = server;
    const address = await server.start();

    const response = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "hello",
        model: {
          profileId: "missing",
          providerId: "missing",
          modelId: "missing"
        }
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Runtime model profile not found"
    });
  });

  it("imports a model profile without returning its credential", async () => {
    const store = createStore();
    const imported = [];
    const deleted = [];
    const server = createServer({
      id: "profiles",
      async *streamTurn() {
        yield { type: "message.delta", delta: "ok" };
      }
    }, store, {
      importModelProfile: vi.fn(async (input) => {
        imported.push(input);
        return {
          profile: {
            ...input.profile,
            credentialConfigured: !!input.credential
          }
        };
      }),
      deleteModelProfile: vi.fn(async (profileId) => {
        deleted.push(profileId);
        return {
          profile: {
            id: profileId,
            model: "flash",
            credentialConfigured: false
          }
        };
      })
    });
    resources.at(-1).server = server;
    const address = await server.start();

    const response = await fetch(
      `${address.url}/v1/model-profiles/workbench%3Adeepseek%3Aflash`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: {
            providerId: "deepseek",
            providerType: "openai",
            endpoint: "https://models.example/chat",
            model: "flash"
          },
          credential: "secret-value"
        })
      }
    );
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(imported).toEqual([{
      profile: expect.objectContaining({
        id: "workbench:deepseek:flash",
        model: "flash"
      }),
      credential: "secret-value"
    }]);
    expect(payload.profile).toMatchObject({
      id: "workbench:deepseek:flash",
      credentialConfigured: true
    });
    expect(JSON.stringify(payload)).not.toContain("secret-value");

    const deletedResponse = await fetch(
      `${address.url}/v1/model-profiles/workbench%3Adeepseek%3Aflash`,
      { method: "DELETE" }
    );
    expect(deletedResponse.status).toBe(200);
    expect(deleted).toEqual(["workbench:deepseek:flash"]);
    await expect(deletedResponse.json()).resolves.toMatchObject({
      profile: {
        id: "workbench:deepseek:flash",
        credentialConfigured: false
      }
    });
  });

  it("resolves Runtime interaction profiles for Sessions and exposes capabilities", async () => {
    const store = createStore();
    const interactionProfiles = new FileInteractionProfileStore();
    interactionProfiles.upsert({
      id: "interactive.default",
      label: "Workbench-like default",
      modelProfileId: "workbench.user.dynamic.kimi-k2.5",
      policy: {
        preset: "trusted-automation",
        allowedTools: ["read", "Bash", "todoWrite"],
        maxToolCalls: 30
      },
      contextProviders: {
        enabled: ["memory", "terminal-inventory"],
        disabled: []
      },
      metadata: {
        includeTerminalContext: true
      }
    });
    const server = createServer({
      id: "interaction-profile",
      async *streamTurn() {
        yield { type: "message.delta", delta: "ok" };
      }
    }, store, {
      interactionProfiles,
      capabilityTools: [{
        name: "read",
        description: "Read files",
        inputSchema: { type: "object" },
        hostKinds: ["local-tools"]
      }, {
        name: "Bash",
        description: "Run commands",
        inputSchema: { type: "object" },
        hostKinds: ["local-tools"]
      }, {
        name: "schedulerManage",
        description: "Manage scheduled tasks",
        inputSchema: { type: "object" },
        hostKinds: ["runtime-plugin", "plugin:dev.scheduler"],
        pluginId: "dev.scheduler",
        policy: { minimumPreset: "trusted-automation" }
      }],
      resolveModel(requested) {
        expect(requested).toEqual({
          profileId: "workbench.user.dynamic.kimi-k2.5"
        });
        return {
          profileId: "workbench.user.dynamic.kimi-k2.5",
          providerId: "moonshot",
          modelId: "kimi-k2.5",
          label: "Kimi K2.5"
        };
      }
    });
    resources.at(-1).server = server;
    const address = await server.start();

    const catalog = await fetch(`${address.url}/v1/capabilities/tools`);
    await expect(catalog.json()).resolves.toEqual({
      tools: [{
        name: "read",
        description: "Read files",
        inputSchema: { type: "object" },
        hostKinds: ["local-tools"],
        owner: {
          kind: "device",
          id: "local-tools"
        },
        availability: {
          headless: true,
          requiresWorkbench: false,
          requiresDevice: true,
          requiresNetwork: false
        },
        policy: {
          minimumPreset: "read-only"
        }
      }, {
        name: "Bash",
        description: "Run commands",
        inputSchema: { type: "object" },
        hostKinds: ["local-tools"],
        owner: {
          kind: "device",
          id: "local-tools"
        },
        availability: {
          headless: true,
          requiresWorkbench: false,
          requiresDevice: true,
          requiresNetwork: false
        },
        policy: {
          minimumPreset: "trusted-automation"
        }
      }, {
        name: "schedulerManage",
        description: "Manage scheduled tasks",
        inputSchema: { type: "object" },
        hostKinds: ["runtime-plugin", "plugin:dev.scheduler"],
        pluginId: "dev.scheduler",
        owner: {
          kind: "plugin",
          id: "dev.scheduler"
        },
        availability: {
          headless: true,
          requiresWorkbench: false,
          requiresDevice: false,
          requiresNetwork: false
        },
        policy: {
          minimumPreset: "trusted-automation"
        }
      }]
    });

    const profiles = await fetch(`${address.url}/v1/interaction-profiles`);
    await expect(profiles.json()).resolves.toMatchObject({
      profiles: [{
        id: "interactive.default",
        modelProfileId: "workbench.user.dynamic.kimi-k2.5",
        policy: {
          preset: "trusted-automation",
          allowedTools: ["read", "Bash", "todoWrite"]
        }
      }]
    });

    const createdResponse = await fetch(`${address.url}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Profile session",
        interactionProfileId: "interactive.default",
        policy: {
          allowedTools: ["read"],
          maxToolCalls: 3
        },
        metadata: {
          includeTerminalContext: false,
          surface: "cli"
        }
      })
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.session).toMatchObject({
      title: "Profile session",
      model: {
        profileId: "workbench.user.dynamic.kimi-k2.5",
        providerId: "moonshot",
        modelId: "kimi-k2.5",
        label: "Kimi K2.5"
      },
      policy: {
        preset: "trusted-automation",
        allowedTools: ["read"],
        maxToolCalls: 3
      },
      metadata: {
        interactionProfileId: "interactive.default",
        interactionProfileLabel: "Workbench-like default",
        includeTerminalContext: false,
        surface: "cli"
      }
    });
    expect(created.interactionProfile).toMatchObject({
      id: "interactive.default"
    });

    const updateResponse = await fetch(
      `${address.url}/v1/sessions/${encodeURIComponent(created.session.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Renamed session",
          model: {
            profileId: "workbench.user.dynamic.kimi-k2.5"
          },
          policy: {
            allowedTools: ["read", "Bash"],
            maxToolCalls: 12
          },
          skills: {
            enabled: ["writer", "reviewer", "writer"]
          }
        })
      }
    );
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      session: {
        id: created.session.id,
        title: "Renamed session",
        model: {
          profileId: "workbench.user.dynamic.kimi-k2.5"
        },
        policy: {
          preset: "trusted-automation",
          allowedTools: ["read", "Bash"],
          maxToolCalls: 12
        },
        metadata: {
          interactionProfileId: "interactive.default",
          skills: {
            enabled: ["writer", "reviewer"]
          }
        }
      }
    });

    const refreshedSession = await fetch(
      `${address.url}/v1/sessions/${encodeURIComponent(created.session.id)}`
    );
    await expect(refreshedSession.json()).resolves.toMatchObject({
      session: {
        title: "Renamed session",
        policy: {
          allowedTools: ["read", "Bash"]
        },
        metadata: {
          skills: {
            enabled: ["writer", "reviewer"]
          }
        }
      }
    });
  });

  it("exposes Runtime todo lists for Workbench projection", async () => {
    const store = createStore();
    store.saveTodoList("session-1", [{
      id: "todo-1",
      content: "Run Runtime tests",
      status: "in_progress",
      activeForm: "Running Runtime tests"
    }], 1234, {
      taskId: "task-1",
      sessionId: "session-1",
      runId: "run-1"
    });
    const server = createServer({
      id: "todos",
      async *streamTurn() {
        yield { type: "message.delta", delta: "ok" };
      }
    }, store);
    resources.at(-1).server = server;
    const address = await server.start();

    const listResponse = await fetch(`${address.url}/v1/todo-lists`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      todoLists: [{
        ownerId: "session-1",
        taskId: "task-1",
        sessionId: "session-1",
        runId: "run-1",
        updatedAt: 1234,
        todos: [{
          id: "todo-1",
          content: "Run Runtime tests",
          status: "in_progress",
          activeForm: "Running Runtime tests"
        }]
      }]
    });

    const directResponse = await fetch(`${address.url}/v1/todo-lists/session-1`);
    expect(directResponse.status).toBe(200);
    await expect(directResponse.json()).resolves.toMatchObject({
      todoList: {
        ownerId: "session-1",
        taskId: "task-1"
      }
    });

    const sessionResponse = await fetch(`${address.url}/v1/sessions/session-1/todos`);
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      todoList: {
        ownerId: "session-1",
        todos: [expect.objectContaining({ id: "todo-1" })]
      }
    });

    const missingResponse = await fetch(`${address.url}/v1/todo-lists/missing`);
    expect(missingResponse.status).toBe(404);
  });

  it("accepts a Run request and exposes persisted events over HTTP and SSE", async () => {
    const store = createStore();
    let receivedModelOptions;
    const engine = {
      id: "echo",
      async *streamTurn(request) {
        receivedModelOptions = request.modelOptions;
        const prompt = request.messages.at(-1)?.content || "";
        yield { type: "message.delta", delta: `echo:${prompt}` };
      }
    };
    const server = createServer(engine, store);
    resources.at(-1).server = server;
    const address = await server.start();

    const createdResponse = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "hello",
        modelOptions: {
          thinkingMode: "on",
          thinkingEffort: "high",
          unsupported: "ignored"
        }
      })
    });
    expect(createdResponse.status).toBe(202);
    const created = await createdResponse.json();
    const run = await waitForRun(address.url, created.runId, "completed");
    expect(run).toMatchObject({
      id: created.runId,
      attemptId: created.attemptId,
      status: "completed",
      modelOptions: {
        thinkingMode: "on",
        thinkingEffort: "high"
      }
    });
    expect(receivedModelOptions).toEqual({
      thinkingMode: "on",
      thinkingEffort: "high"
    });

    const eventResponse = await fetch(`${address.url}/v1/runs/${created.runId}/events?after=0`);
    const eventBody = await eventResponse.json();
    expect(eventBody.events.map((event) => event.type)).toEqual([
      "run.started",
      "turn.started",
      "message.delta",
      "message.completed",
      "turn.completed",
      "run.completed"
    ]);

    const streamResponse = await fetch(
      `${address.url}/v1/runs/${created.runId}/events/stream?after=4`
    );
    const streamBody = await streamResponse.text();
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    expect(streamBody).toContain("event: turn.completed");
    expect(streamBody).toContain("event: run.completed");
  });

  it("serves a cursor-preserving client projection stream", async () => {
    const store = createStore();
    const server = createServer({
      id: "projection-stream",
      async *streamTurn() {
        yield {
          type: "model.request",
          request: {
            url: "https://model.test/v1/chat/completions",
            modelId: "projection-model",
            stream: true,
            payload: {
              messages: [{ role: "user", content: "p".repeat(20_000) }],
              tools: [{ name: "read" }]
            }
          }
        };
        for (let index = 0; index < 100; index += 1) {
          yield { type: "reasoning.delta", delta: "r" };
        }
        for (let index = 0; index < 20; index += 1) {
          yield { type: "message.delta", delta: "x" };
        }
      }
    }, store);
    resources.at(-1).server = server;
    const address = await server.start();
    const accepted = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "project" })
    }).then((response) => response.json());
    await waitForRun(address.url, accepted.runId, "completed");

    const raw = await fetch(
      `${address.url}/v1/runs/${accepted.runId}/events?after=0`
    ).then((response) => response.json());
    const projected = await fetch(
      `${address.url}/v1/runs/${accepted.runId}/projection`
        + "?after=0&max_chunk_chars=4096"
    ).then((response) => response.json());

    expect(raw.events.filter((event) =>
      event.type === "reasoning.delta"
    )).toHaveLength(100);
    expect(projected.events.filter((event) =>
      event.type === "reasoning.delta"
    )).toHaveLength(1);
    expect(projected.events.filter((event) =>
      event.type === "message.delta"
    )).toHaveLength(1);
    const projectedRequest = projected.events.find((event) =>
      event.type === "model.request"
    );
    expect(projectedRequest).toMatchObject({
      data: {
        messageCount: 1,
        toolCount: 1,
        detailAvailable: true,
        rawEventSequence: expect.any(Number)
      }
    });
    expect(projectedRequest.data.payload).toBeUndefined();
    const eventDetail = await fetch(
      `${address.url}/v1/runs/${accepted.runId}/events/`
      + projectedRequest.data.rawEventSequence
    ).then((response) => response.json());
    expect(eventDetail.event).toMatchObject({
      type: "model.request",
      data: {
        payload: {
          messages: [{ role: "user", content: "p".repeat(20_000) }]
        }
      }
    });
    expect(projected.events.find((event) =>
      event.type === "reasoning.delta"
    )).toMatchObject({
      data: {
        delta: "r".repeat(100),
        projection: {
          sourceEventCount: 100
        }
      }
    });
    expect(projected.events.find((event) =>
      event.type === "message.delta"
    )).toMatchObject({
      data: {
        delta: "x".repeat(20),
        projection: {
          sourceEventCount: 20
        }
      }
    });
    expect(projected.sourceCursor).toBe(raw.events.at(-1).sequence);

    const streamResponse = await fetch(
      `${address.url}/v1/runs/${accepted.runId}/projection/stream`
        + "?after=0&reasoning=none&max_chunk_chars=4096"
    );
    const streamBody = await streamResponse.text();
    expect(streamResponse.headers.get("x-zion-stream-mode"))
      .toBe("projection");
    expect(streamBody).toContain("event: projection.cursor");
    expect(streamBody).not.toContain("event: reasoning.delta");
    expect(streamBody).toContain("event: message.delta");
    expect(streamBody).toContain("event: run.completed");

    const firstMessageDelta = raw.events.find((event) =>
      event.type === "message.delta"
    );
    const resumeAfter = Number(firstMessageDelta.sequence) - 1;
    const resumedResponse = await fetch(
      `${address.url}/v1/runs/${accepted.runId}/projection/stream`,
      {
        headers: {
          "last-event-id": String(resumeAfter)
        }
      }
    );
    const resumedBody = await resumedResponse.text();
    expect(resumedBody).not.toContain("event: reasoning.delta");
    expect(resumedBody).toContain("event: message.delta");
    expect(resumedBody).toContain("event: run.completed");
  });

  it("exposes persisted artifacts by Run and Session", async () => {
    const store = createStore();
    await store.createSession({
      id: "artifact-session",
      status: "active",
      title: "Artifacts",
      policy: { preset: "read-only", allowedTools: [] },
      metadata: {},
      createdAt: 1000,
      updatedAt: 1000
    });
    await store.create({
      id: "artifact-run",
      attemptId: "artifact-attempt",
      status: "completed",
      title: "Write",
      sessionId: "artifact-session",
      policy: { preset: "workspace-write", allowedTools: ["write"] },
      metadata: {},
      createdAt: 1000,
      updatedAt: 1001
    });
    await store.appendSessionMessages("artifact-session", [{
      schemaVersion: 1,
      id: "artifact-user",
      sessionId: "artifact-session",
      role: "user",
      content: "write",
      runId: "artifact-run",
      createdAt: 1000
    }]);
    store.saveRunArtifacts({
      runId: "artifact-run",
      invocationId: "artifact-invocation",
      artifacts: [{
        id: "artifact-1",
        runId: "artifact-run",
        uri: "/workspace/a.md",
        createdAt: 1001
      }],
      changes: [{
        id: "change-1",
        artifactId: "artifact-1",
        runId: "artifact-run",
        path: "/workspace/a.md",
        operation: "created",
        createdAt: 1001
      }]
    });
    const server = createServer({
      id: "artifact-api",
      async *streamTurn() {
        yield { type: "message.delta", delta: "ok" };
      }
    }, store);
    resources.at(-1).server = server;
    const address = await server.start();

    const byRun = await fetch(
      `${address.url}/v1/runs/artifact-run/artifacts`
    ).then((response) => response.json());
    expect(byRun).toMatchObject({
      runId: "artifact-run",
      artifacts: [expect.objectContaining({ id: "artifact-1" })],
      changes: [expect.objectContaining({ id: "change-1" })]
    });

    const bySession = await fetch(
      `${address.url}/v1/sessions/artifact-session/artifacts`
    ).then((response) => response.json());
    expect(bySession).toMatchObject({
      sessionId: "artifact-session",
      artifacts: [expect.objectContaining({ uri: "/workspace/a.md" })],
      changes: [expect.objectContaining({ path: "/workspace/a.md" })]
    });
  });

  it("aborts an active Run through the external API", async () => {
    let signal;
    const store = createStore();
    const engine = {
      id: "waiting",
      async *streamTurn(request) {
        yield* [];
        signal = request.signal;
        await new Promise((resolve) => request.signal.onCancel(resolve));
        request.signal.throwIfCancelled();
      }
    };
    const server = createServer(engine, store);
    resources.at(-1).server = server;
    const address = await server.start();

    const created = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "wait" })
    }).then((response) => response.json());
    while (!signal) await Promise.resolve();

    const abortResponse = await fetch(`${address.url}/v1/runs/${created.runId}/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "mobile-user" })
    });
    expect(abortResponse.status).toBe(202);

    const run = await waitForRun(address.url, created.runId, "aborted");
    expect(run).toMatchObject({
      status: "aborted",
      terminalReason: "mobile-user"
    });
    expect(signal.cancelled).toBe(true);
  });

  it("waits for active Runs to persist shutdown interruption before closing", async () => {
    let signal;
    const store = createStore();
    const engine = {
      id: "waiting",
      async *streamTurn(request) {
        yield* [];
        signal = request.signal;
        await new Promise((resolve) => request.signal.onCancel(resolve));
        request.signal.throwIfCancelled();
      }
    };
    const server = createServer(engine, store);
    resources.at(-1).server = server;
    const address = await server.start();
    const created = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "wait" })
    }).then((response) => response.json());
    while (!signal) await Promise.resolve();

    await server.close();

    await expect(store.get(created.runId)).resolves.toMatchObject({
      status: "aborted",
      terminalReason: "runtime-shutdown"
    });
    await expect(store.getEvents(created.runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.aborted",
          data: { reason: "runtime-shutdown" }
        })
      ])
    );
  });

  it("resumes a checkpointed Run through a new Attempt", async () => {
    const store = createStore();
    await store.create({
      id: "run-resume",
      attemptId: "attempt-old",
      status: "interrupted",
      title: "resume",
      policy: {
        allowedTools: [],
        maxToolCalls: 4,
        fileRoots: [],
        allowedTerminalSessionIds: []
      },
      metadata: {},
      createdAt: 1000,
      updatedAt: 1000
    });
    await store.append({
      schemaVersion: 1,
      eventId: "event-old",
      runId: "run-resume",
      attemptId: "attempt-old",
      sequence: 1,
      type: "run.interrupted",
      timestamp: 1000,
      data: { reason: "runtime-restart" }
    }, {
      status: "interrupted",
      updatedAt: 1000,
      completedAt: 1000,
      terminalReason: "runtime-restart"
    });
    await store.saveCheckpoint({
      schemaVersion: 1,
      runId: "run-resume",
      attemptId: "attempt-old",
      sequence: 1,
      nextTurn: 2,
      messages: [{ role: "user", content: "resume me" }],
      output: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      },
      counters: { toolCalls: 0 },
      maxTurns: 4,
      createdAt: 1000
    });
    const engine = {
      id: "resume-engine",
      async *streamTurn(request) {
        expect(request.turn).toBe(2);
        yield { type: "message.delta", delta: "resumed" };
      }
    };
    const server = createServer(engine, store);
    resources.at(-1).server = server;
    const address = await server.start();

    const response = await fetch(`${address.url}/v1/runs/run-resume/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    expect(accepted.attemptId).not.toBe("attempt-old");

    await expect(waitForRun(address.url, "run-resume", "completed")).resolves.toMatchObject({
      attemptId: accepted.attemptId,
      status: "completed"
    });
    const events = await store.getEvents("run-resume");
    expect(events[1]).toMatchObject({
      sequence: 2,
      type: "attempt.started",
      attemptId: accepted.attemptId,
      data: {
        previousAttemptId: "attempt-old",
        resumedFromSequence: 1
      }
    });
  });

  it("persists a Session transcript and supplies it to each new Run", async () => {
    const observedMessages = [];
    const store = createStore();
    const engine = {
      id: "conversation",
      async *streamTurn(request) {
        observedMessages.push(request.messages);
        const lastUser = request.messages.at(-1)?.content || "";
        yield {
          type: "message.delta",
          delta: `reply-${observedMessages.length}:${lastUser}`
        };
      }
    };
    const server = createServer(engine, store);
    resources.at(-1).server = server;
    const address = await server.start();

    const createdResponse = await fetch(`${address.url}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Persistent chat",
        policy: {
          preset: "workspace-write",
          allowedTools: ["write"],
          fileRoots: ["/workspace/project"],
          allowedCommandPrefixes: ["npm test"],
          allowedRecipients: ["TEAM@example.com"],
          maxMailPerRun: 2
        }
      })
    });
    expect(createdResponse.status).toBe(201);
    const { session } = await createdResponse.json();
    expect(session.policy).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["write"],
      fileRoots: ["/workspace/project"],
      allowedCommandPrefixes: ["npm test"],
      allowedRecipients: ["team@example.com"],
      maxMailPerRun: 2
    });
    const listedSessions = await fetch(
      `${address.url}/v1/sessions?limit=10`
    ).then((response) => response.json());
    expect(listedSessions.sessions).toEqual([
      expect.objectContaining({
        id: session.id,
        title: "Persistent chat",
        status: "active"
      })
    ]);

    const firstResponse = await fetch(
      `${address.url}/v1/sessions/${session.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "first" })
      }
    );
    expect(firstResponse.status).toBe(202);
    const first = await firstResponse.json();
    await waitForRun(address.url, first.runId, "completed");
    await waitForMessages(address.url, session.id, 2);

    const secondResponse = await fetch(
      `${address.url}/v1/sessions/${session.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "second" })
      }
    );
    expect(secondResponse.status).toBe(202);
    const second = await secondResponse.json();
    await waitForRun(address.url, second.runId, "completed");
    const transcript = await waitForMessages(address.url, session.id, 4);

    expect(observedMessages).toEqual([
      [{ role: "user", content: "first" }],
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply-1:first" },
        { role: "user", content: "second" }
      ]
    ]);
    expect(transcript.map(({ sequence, role, content }) => ({
      sequence,
      role,
      content
    }))).toEqual([
      { sequence: 1, role: "user", content: "first" },
      { sequence: 2, role: "assistant", content: "reply-1:first" },
      { sequence: 3, role: "user", content: "second" },
      { sequence: 4, role: "assistant", content: "reply-2:second" }
    ]);
    expect(new Set(transcript.map((message) => message.runId))).toEqual(
      new Set([first.runId, second.runId])
    );

    const forkResponse = await fetch(
      `${address.url}/v1/sessions/${session.id}/fork`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "session-fork", title: "Persistent chat fork" })
      }
    );
    expect(forkResponse.status).toBe(201);
    const forked = await forkResponse.json();
    expect(forked).toMatchObject({
      session: {
        id: "session-fork",
        title: "Persistent chat fork",
        metadata: {
          forkedFrom: {
            sessionId: session.id,
            transcriptSequence: 4
          }
        }
      },
      copiedMessages: 4,
      copiedTranscriptEntries: 4
    });
    await expect(waitForMessages(address.url, "session-fork", 4)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "first" }),
        expect.objectContaining({ role: "assistant", content: "reply-2:second" })
      ])
    );

    const forkMessage = await fetch(
      `${address.url}/v1/sessions/session-fork/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "forked" })
      }
    ).then((response) => response.json());
    await waitForRun(address.url, forkMessage.runId, "completed");
    await waitForMessages(address.url, "session-fork", 6);
    expect(observedMessages[2]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply-1:first" },
      { role: "user", content: "second" },
      { role: "assistant", content: "reply-2:second" },
      { role: "user", content: "forked" }
    ]);
  });

  it("binds direct Workbench Runs to Runtime-owned Session history", async () => {
    const store = createStore();
    const engine = {
      id: "workbench-session",
      async *streamTurn() {
        yield { type: "message.delta", delta: "runtime reply" };
      }
    };
    const server = createServer(engine, store);
    resources.at(-1).server = server;
    const address = await server.start();

    const accepted = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Workbench chat",
        sessionId: "workbench-session-1",
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: "hello from Workbench"
          }, {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA", detail: "high" }
          }]
        }],
        sessionHistory: [{
          role: "user",
          content: "earlier question"
        }, {
          role: "assistant",
          content: "earlier answer"
        }, {
          role: "user",
          content: [{
            type: "text",
            text: "hello from Workbench"
          }, {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA", detail: "high" }
          }]
        }],
        policy: { preset: "read-only", allowedTools: [] },
        metadata: {
          source: "interactive-chat",
          workbenchProtocolVersion: 4
        }
      })
    }).then((response) => response.json());
    await waitForRun(address.url, accepted.runId, "completed");

    const transcript = await waitForMessages(
      address.url,
      "workbench-session-1",
      4
    );
    expect(transcript).toEqual([
      expect.objectContaining({
        sequence: 1,
        role: "user",
        content: "earlier question"
      }),
      expect.objectContaining({
        sequence: 2,
        role: "assistant",
        content: "earlier answer"
      }),
      expect.objectContaining({
        sequence: 3,
        role: "user",
        content: [{
          type: "text",
          text: "hello from Workbench"
        }, {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA", detail: "high" }
        }],
        runId: accepted.runId
      }),
      expect.objectContaining({
        sequence: 4,
        role: "assistant",
        content: "runtime reply",
        runId: accepted.runId
      })
    ]);
    const session = await fetch(
      `${address.url}/v1/sessions/workbench-session-1`
    ).then((response) => response.json());
    expect(session.session).toMatchObject({
      id: "workbench-session-1",
      title: "Workbench chat",
      metadata: { source: "interactive-chat" }
    });
    const display = await fetch(
      `${address.url}/v1/sessions/workbench-session-1/messages`
    ).then((response) => response.json());
    expect(display.messages[0]).toMatchObject({
      role: "user",
      content: "hello from Workbench\n[image:data:image/png;base64,AAAA]"
    });
  });

  it("preserves tool calls, tool results, and reasoning in the canonical Session transcript", async () => {
    const observedMessages = [];
    let turn = 0;
    const store = createStore();
    const engine = {
      id: "canonical-transcript",
      async *streamTurn(request) {
        turn += 1;
        observedMessages.push(request.messages);
        if (turn === 1) {
          yield { type: "message.delta", delta: "working..." };
          yield { type: "reasoning.delta", delta: "inspect first" };
          yield {
            type: "tool.call",
            call: {
              id: "call-1",
              name: "read",
              arguments: { path: "project.md" }
            }
          };
          return;
        }
        yield {
          type: "message.delta",
          delta: turn === 2 ? "first answer" : "second answer"
        };
      }
    };
    const server = createServer(engine, store, {
      tools: {
        async listTools() {
          return [{ name: "read", inputSchema: { type: "object" } }];
        },
        async invoke() {
          return { ok: true, content: "project contents" };
        }
      }
    });
    resources.at(-1).server = server;
    const address = await server.start();
    const created = await fetch(`${address.url}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Canonical transcript",
        policy: { preset: "read-only", allowedTools: ["read"] }
      })
    }).then((response) => response.json());

    const first = await fetch(
      `${address.url}/v1/sessions/${created.session.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "inspect project" })
      }
    ).then((response) => response.json());
    await waitForRun(address.url, first.runId, "completed");
    const firstTranscript = await waitForMessages(address.url, created.session.id, 4);
    expect(firstTranscript).toEqual([
      expect.objectContaining({ sequence: 1, role: "user", content: "inspect project" }),
      expect.objectContaining({
        sequence: 2,
        role: "assistant",
        content: "working...",
        reasoningContent: "inspect first",
        toolCalls: [expect.objectContaining({ id: "call-1" })]
      }),
      expect.objectContaining({
        sequence: 3,
        role: "tool",
        toolCallId: "call-1",
        content: "project contents"
      }),
      expect.objectContaining({
        sequence: 4,
        role: "assistant",
        content: "first answer"
      })
    ]);
    const runTranscript = await fetch(
      `${address.url}/v1/runs/${first.runId}/transcript`
    ).then((response) => response.json());
    expect(runTranscript.messages).toHaveLength(3);

    const second = await fetch(
      `${address.url}/v1/sessions/${created.session.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "continue" })
      }
    ).then((response) => response.json());
    await waitForRun(address.url, second.runId, "completed");
    await waitForMessages(address.url, created.session.id, 6);

    expect(observedMessages[2]).toEqual([
      { role: "user", content: "inspect project" },
      expect.objectContaining({
        role: "assistant",
        reasoningContent: "inspect first",
        toolCalls: [expect.objectContaining({ id: "call-1" })]
      }),
      { role: "tool", content: "project contents", toolCallId: "call-1" },
      expect.objectContaining({ role: "assistant", content: "first answer" }),
      { role: "user", content: "continue" }
    ]);
    const displayMessages = await fetch(
      `${address.url}/v1/sessions/${created.session.id}/messages`
    ).then((response) => response.json());
    expect(displayMessages.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
    expect(displayMessages.messages[1].content).toBe("first answer");
  });

  it("runs post-processors after completed session Runs without blocking transcript projection", async () => {
    const processed = [];
    const failures = [];
    const store = createStore();
    const engine = {
      id: "post-process",
      async *streamTurn() {
        yield { type: "message.delta", delta: "runtime answer" };
      }
    };
    const server = createServer(engine, store, {
      runPostProcessors: [
        {
          id: "failing",
          order: 1,
          async process() {
            throw new Error("post failed");
          }
        },
        {
          id: "capture",
          order: 2,
          async process(run) {
            processed.push(run);
          }
        }
      ],
      onPostProcessorError(error, meta) {
        failures.push({ error, meta });
      }
    });
    resources.at(-1).server = server;
    const address = await server.start();

    const created = await fetch(`${address.url}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Runtime biography source",
        metadata: { sessionTitle: "Runtime biography source" }
      })
    }).then((response) => response.json());

    const response = await fetch(
      `${address.url}/v1/sessions/${created.session.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "capture this result" })
      }
    );
    expect(response.status).toBe(202);
    const accepted = await response.json();
    await waitForRun(address.url, accepted.runId, "completed");
    const messages = await waitForMessages(address.url, created.session.id, 2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "runtime answer"
    });

    for (let attempt = 0; attempt < 50 && !processed.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(failures).toHaveLength(1);
    expect(failures[0].meta).toMatchObject({
      processorId: "failing",
      runId: accepted.runId,
      sessionId: created.session.id
    });
    expect(processed).toHaveLength(1);
    expect(processed[0]).toMatchObject({
      runId: accepted.runId,
      sessionId: created.session.id,
      status: "completed",
      metadata: { sessionTitle: "Runtime biography source" }
    });
    expect(processed[0].messages.map((message) => `${message.role}:${message.content}`))
      .toEqual([
        "user:capture this result",
        "assistant:runtime answer"
      ]);
  });

  it("refuses unauthenticated non-loopback binding by default", () => {
    const store = createStore();
    const engine = {
      id: "echo",
      async *streamTurn() {
        yield { type: "message.delta", delta: "ok" };
      }
    };
    const executor = createAgentExecutor({
      engine,
      tools: {
        async listTools() {
          return [];
        },
        async invoke() {
          return { ok: true, content: "" };
        }
      },
      runs: store
    });

    expect(() => createRuntimeServer({
      executor,
      runs: store,
      host: "0.0.0.0"
    })).toThrow("may only bind to loopback");
  });
});
