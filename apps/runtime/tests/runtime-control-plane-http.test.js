import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresSchedulerStore } from "../src/postgres-scheduler-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { createProjectAutomationHttpHandler } from "../src/project-automation-http-handler.mjs";
import { createRuntimeControlClient } from "../src/runtime-cli.mjs";
import { createSchedulerHttpHandler } from "../src/scheduler-http-handler.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createWorkbenchStateHttpHandler } from "../src/workbench-state-http-handler.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let resource;
let database;

beforeAll(async () => {
  database = await createPostgresTestDatabase("control_plane");
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  const spaceId = database.nextSpaceId();
  const runs = new PostgresRunStore(database.pool, { spaceId });
  const workbenchState = await new PostgresWorkbenchStateStore(
    database.pool,
    { spaceId }
  ).initialize();
  const scheduler = new PostgresSchedulerStore(database.pool, { spaceId });
  let releaseHeldRun;
  const heldRun = new Promise((resolve) => {
    releaseHeldRun = resolve;
  });
  const projectAutomationCalls = [];
  const projectAutomationService = {
    running: true,
    readDocument: () => ({ version: 1, projects: {}, requests: [] }),
    async runNow(projectKey, options) {
      projectAutomationCalls.push({ action: "run", projectKey, options });
      return { status: "running", projectKey, runId: "project-run-1" };
    },
    async stopProject(projectKey, reason) {
      projectAutomationCalls.push({ action: "stop", projectKey, reason });
      return { status: "stopped", projectKey, abortedRun: true };
    }
  };
  const executor = createAgentExecutor({
    engine: {
      id: "echo",
      async *streamTurn(request) {
        if (request.messages.at(-1)?.content === "hold") await heldRun;
        yield { type: "message.delta", delta: "ok" };
      }
    },
    tools: {
      async listTools() {
        return [];
      },
      async invoke() {
        throw new Error("No tools configured");
      }
    },
    runs
  });
  const server = createRuntimeServer({
    executor,
    runs,
    port: 0,
    sessionEventStore: workbenchState,
    serviceHttpHandlers: [
      createWorkbenchStateHttpHandler({ store: workbenchState }),
      createSchedulerHttpHandler({
        scheduler,
        availableModels: () => [{
          id: "workbench.deepseek.deepseek-v4-flash",
          credentialRequired: true,
          credentialConfigured: true
        }, {
          id: "workbench.deepseek.unconfigured",
          credentialRequired: true,
          credentialConfigured: false
        }]
      }),
      createProjectAutomationHttpHandler({ service: projectAutomationService })
    ]
  });
  const address = await server.start();
  resource = {
    spaceId,
    runs,
    workbenchState,
    scheduler,
    projectAutomationCalls,
    releaseHeldRun,
    server,
    url: address.url
  };
});

afterEach(async () => {
  resource.releaseHeldRun?.();
  await resource.server.close();
  await resource.scheduler.close();
  await resource.workbenchState.close();
  await resource.runs.close();
});

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${resource.url}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-zion-workbench-protocol": "5",
      ...(options.headers || {})
    }
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

describe("Runtime control plane HTTP", () => {
  it("rejects document writes from an outdated Workbench protocol", async () => {
    await resource.workbenchState.createSession({
      id: "protected-session",
      title: "Protected",
      text: "user complete\nassistant complete"
    });

    const response = await fetch(
      `${resource.url}/v1/workbench-state/sessions/protected-session`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "assistant partial" })
      }
    );

    expect(response.status).toBe(426);
    expect(response.headers.get("x-zion-workbench-protocol")).toBe("5");
    expect(response.headers.get("clear-site-data")).toBe(
      "\"executionContexts\""
    );
    await expect(response.json()).resolves.toMatchObject({
      expectedProtocol: "5"
    });
    expect((await resource.workbenchState.readSession("protected-session")).text)
      .toBe("user complete\nassistant complete");
  });

  it("owns durable Workbench state", async () => {
    const written = await jsonRequest("/v1/workbench-state/snapshot", {
      method: "PUT",
      body: JSON.stringify({
        snapshot: {
          docs: [{ id: "session-1", text: "hello" }],
          metas: [{ id: "session-1", meta: { title: "Hello" } }]
        }
      })
    });
    expect(written.response.status).toBe(200);
    expect(written.body).toMatchObject({ ok: true, revision: "runtime:1" });

    const status = await jsonRequest("/v1/workbench-state/status");
    expect(status.body).toMatchObject({
      service: "zion-runtime",
      documents: 1,
      metadata: 1
    });
    const session = await jsonRequest(
      "/v1/workbench-state/sessions/session-1"
    );
    expect(session.body).toMatchObject({
      id: "session-1",
      text: "hello",
      meta: { id: "session-1", title: "Hello" }
    });
    const events = await jsonRequest("/v1/workbench-state/events?after=0");
    expect(events.body.events).toEqual([
      expect.objectContaining({
        type: "session.updated",
        sessionId: "session-1"
      }),
      expect.objectContaining({
        type: "tree.updated"
      })
    ]);
  });

  it("streams durable Workbench events with Last-Event-ID catch-up", async () => {
    await resource.workbenchState.createSession({
      id: "streamed",
      title: "Streamed",
      text: "before"
    });
    const firstCursor = (await resource.workbenchState.readStatus()).event_cursor;
    await resource.workbenchState.updateSession("streamed", {
      text: "after",
      expected_session_revision: 1
    });

    const controller = new AbortController();
    const response = await fetch(
      `${resource.url}/v1/workbench-state/events/stream`,
      {
        headers: { "last-event-id": String(firstCursor) },
        signal: controller.signal
      }
    );
    expect(response.status).toBe(200);
    const reader = response.body.getReader();
    const decoded = new TextDecoder();
    const { value } = await reader.read();
    controller.abort();
    const frame = decoded.decode(value);
    expect(frame).toContain("event: session.updated");
    expect(frame).toContain("\"sessionId\":\"streamed\"");
  });

  it("asks SSE clients to reload when their cursor has expired", async () => {
    const first = await resource.workbenchState.appendEvent("session.updated", {
      sessionId: "expired",
      payload: { changed: ["document"] }
    });
    const second = await resource.workbenchState.appendEvent("session.updated", {
      sessionId: "expired",
      payload: { changed: ["document"] }
    });
    const latest = await resource.workbenchState.appendEvent("session.updated", {
      sessionId: "expired",
      payload: { changed: ["document"] }
    });
    await database.pool.query(
      `DELETE FROM runtime_workbench_events
       WHERE space_id = $1 AND sequence <= $2`,
      [resource.spaceId, second.sequence]
    );

    const response = await fetch(
      `${resource.url}/v1/workbench-state/events/stream?after=${first.sequence}`
    );

    expect(response.status).toBe(200);
    const frame = await response.text();
    expect(frame).toContain("event: reset");
    expect(frame).toContain("\"reason\":\"cursor_expired\"");
    expect(frame).toContain(`"oldestSequence":${latest.sequence}`);
    expect(frame).toContain(`"latestSequence":${latest.sequence}`);
  });

  it("lets CLI clients watch a Session through the shared event protocol", async () => {
    const client = createRuntimeControlClient({
      baseUrl: resource.url,
      pollIntervalMs: 5
    });
    const controller = new AbortController();
    const events = client.streamSessionEvents("cli-watched", {
      signal: controller.signal
    })[Symbol.asyncIterator]();
    const nextEvent = events.next();

    resource.workbenchState.createSession({
      id: "cli-watched",
      title: "Watched",
      text: "hello"
    });

    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: expect.objectContaining({
        type: "session.created",
        sessionId: "cli-watched"
      })
    });
    controller.abort();
  });

  it("publishes active Session Runs to the shared event feed", async () => {
    const created = await jsonRequest("/v1/runs", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "live-session",
        messages: [{ role: "user", content: "hold" }]
      })
    });
    expect(created.response.status).toBe(202);

    const active = await jsonRequest(
      "/v1/sessions/live-session/active-run"
    );
    expect(active.body.activeRun).toMatchObject({
      runId: created.body.runId,
      status: "running"
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const events = (await resource.workbenchState.listEvents(0)).events;
      if (events.some((event) =>
        event.type === "run.started"
        && event.runId === created.body.runId
      )) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await resource.workbenchState.listEvents(0)).events).toContainEqual(
      expect.objectContaining({
        type: "run.started",
        sessionId: "live-session",
        runId: created.body.runId
      })
    );

    resource.releaseHeldRun();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const events = (await resource.workbenchState.listEvents(0)).events;
      if (events.some((event) =>
        event.type === "run.completed"
        && event.runId === created.body.runId
      )) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const inactive = await jsonRequest(
      "/v1/sessions/live-session/active-run"
    );
    expect(inactive.body.activeRun).toBeNull();
    expect((await resource.workbenchState.listEvents(0)).events).toContainEqual(
      expect.objectContaining({
        type: "run.completed",
        sessionId: "live-session",
        runId: created.body.runId
      })
    );
  });

  it("deduplicates Session message commands by clientRequestId", async () => {
    const session = await jsonRequest("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Mobile message" })
    });
    const path = `/v1/sessions/${session.body.session.id}/messages`;
    const first = await jsonRequest(path, {
      method: "POST",
      body: JSON.stringify({
        content: "hello from mobile",
        clientRequestId: "mobile-request-1"
      })
    });
    expect(first.response.status).toBe(202);
    expect(first.body).toMatchObject({
      clientRequestId: "mobile-request-1",
      status: "accepted"
    });

    const replay = await jsonRequest(path, {
      method: "POST",
      body: JSON.stringify({
        content: "hello from mobile",
        clientRequestId: "mobile-request-1"
      })
    });
    expect(replay.response.status).toBe(202);
    expect(replay.body).toMatchObject({
      runId: first.body.runId,
      message: { id: first.body.message.id },
      clientRequestId: "mobile-request-1",
      replayed: true
    });
  });

  it("owns Scheduler task and Run state", async () => {
    const created = await jsonRequest("/v1/scheduler/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "Runtime task",
        prompt: "Run independently",
        modelProfileId: "workbench.deepseek.deepseek-v4-flash",
        schedule: {
          kind: "interval",
          intervalMinutes: 10,
          timeZone: "UTC"
        },
        capability: {
          preset: "read-only",
          allowedTools: []
        },
        enabled: false
      })
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      executionMode: "service-backed",
      interactionProfileId: "scheduled.default",
      modelProfileId: "workbench.deepseek.deepseek-v4-flash",
      revision: 1
    });

    const queued = await jsonRequest(
      `/v1/scheduler/tasks/${created.body.id}/run`,
      { method: "POST", body: "{}" }
    );
    expect(queued.body).toMatchObject({ status: "pending" });

    const stored = await jsonRequest(
      `/v1/scheduler/runs/${queued.body.id}`
    );
    expect(stored.body).toMatchObject({
      id: queued.body.id,
      status: "pending"
    });

    await resource.scheduler.claim({
      workerId: "detail-test",
      workerKind: "runtime",
      availableTools: []
    });
    for (let index = 0; index < 60; index++) {
      await resource.scheduler.appendEvent(queued.body.id, "detail-test", {
        type: "tool.completed",
        sequence: index + 1,
        data: { name: `tool-${index}` }
      });
    }
    const limited = await jsonRequest(
      `/v1/scheduler/runs/${queued.body.id}?event_limit=10`
    );
    expect(limited.body).toMatchObject({
      eventCount: 60,
      eventsTruncated: true
    });
    expect(limited.body.events).toHaveLength(10);

    const claim = await jsonRequest("/v1/scheduler/runs/claim", {
      method: "POST",
      body: "{}"
    });
    expect(claim.response.status).toBe(404);
  });

  it("rejects Scheduler task model profiles without Runtime credentials", async () => {
    const rejected = await jsonRequest("/v1/scheduler/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "Unavailable model task",
        prompt: "Run independently",
        modelProfileId: "workbench.deepseek.unconfigured",
        schedule: {
          kind: "interval",
          intervalMinutes: 10,
          timeZone: "UTC"
        },
        capability: {
          preset: "read-only",
          allowedTools: []
        },
        enabled: false
      })
    });

    expect(rejected.response.status).toBe(422);
    expect(rejected.body.error).toContain("model credential is not configured");
  });

  it("advertises all control-plane CORS methods", async () => {
    const response = await fetch(`${resource.url}/v1/workbench-state/tree`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5177",
        "access-control-request-method": "PUT"
      }
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods"))
      .toBe("GET, POST, PUT, PATCH, DELETE, OPTIONS");
    expect(response.headers.get("access-control-allow-headers"))
      .toContain("authorization");
  });

  it("controls Runtime-owned Project Automation runs", async () => {
    const status = await jsonRequest("/v1/project-automation");
    expect(status.body).toMatchObject({
      running: true,
      automation: { version: 1 }
    });

    const started = await jsonRequest(
      "/v1/project-automation/projects/zion-next/run",
      {
        method: "POST",
        body: JSON.stringify({ interaction_profile_id: "interactive.default" })
      }
    );
    expect(started.body).toEqual({
      status: "running",
      projectKey: "zion-next",
      runId: "project-run-1"
    });

    const stopped = await jsonRequest(
      "/v1/project-automation/projects/zion-next/stop",
      {
        method: "POST",
        body: JSON.stringify({ reason: "user" })
      }
    );
    expect(stopped.body).toEqual({
      status: "stopped",
      projectKey: "zion-next",
      abortedRun: true
    });
    expect(resource.projectAutomationCalls).toEqual([
      {
        action: "run",
        projectKey: "zion-next",
        options: { interactionProfileId: "interactive.default" }
      },
      {
        action: "stop",
        projectKey: "zion-next",
        reason: "user"
      }
    ]);
  });
});
