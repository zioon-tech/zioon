// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSchedulerTask,
  createSession,
  exchangePairing,
  getSchedulerRun,
  getSchedulerTask,
  getSessionMessages,
  listFiles,
  listPlugins,
  listSchedulerRuns,
  listSessionSummaries,
  listSessions,
  sendSessionMessage,
  updateSessionConfiguration,
} from "../src/api";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Mobile Runtime API", () => {
  it("loads sessions and canonical transcript with same-origin credentials", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        sessions: [{ id: "session-1", title: "Hello" }],
      }))
      .mockResolvedValueOnce(response({
        messages: [{ id: "message-1", role: "user", content: "hello" }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "session-1" }),
    ]);
    await expect(getSessionMessages("session-1")).resolves.toEqual([
      expect.objectContaining({ id: "message-1" }),
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "include",
    });
    expect(fetchMock.mock.calls[1][0]).toContain(
      "/v1/sessions/session-1/transcript",
    );
  });

  it("loads aggregated Session summaries with encoded pagination and search", async () => {
    const summary = {
      id: "session-1",
      title: "Release review",
      lastMessage: {
        id: "message-1",
        sequence: 3,
        role: "assistant",
        content: "Ready to deploy",
      },
      activeRun: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(response({
      sessions: [summary],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSessionSummaries(25, 10, "  release notes  "))
      .resolves.toEqual([summary]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/mobile/sessions?limit=25&offset=10&query=release+notes",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("omits blank summary searches and treats a missing list as empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSessionSummaries(50, 0, "   ")).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/v1/mobile/sessions?limit=50&offset=0",
    );
  });

  it("accepts the Plugin Service data envelope", async () => {
    const plugins = [{
      id: "dev.identity",
      metadata: {
        name: "Identity",
        description: "Runtime identity context",
      },
    }];
    const fetchMock = vi.fn().mockResolvedValue(response({
      success: true,
      data: plugins,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPlugins()).resolves.toEqual(plugins);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/v1/device-services/plugin-service/plugins",
    );
  });

  it("parses the Local Tools text tree into file entries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      path: "/workspace/project",
      results: [
        "project/",
        "- src/",
        "- package.json",
        "  - nested.ts",
      ].join("\n"),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listFiles("terminal-1", "/workspace/project")).resolves.toEqual([
      {
        name: "src",
        path: "/workspace/project/src",
        type: "directory",
      },
      {
        name: "package.json",
        path: "/workspace/project/package.json",
        type: "file",
      },
    ]);
  });

  it("creates Sessions with the default interactive profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      session: {
        id: "session-1",
        title: "New session",
      },
    }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSession({ title: "New session" })).resolves.toMatchObject({
      id: "session-1",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      title: "New session",
      interactionProfileId: "interactive.default",
    });
  });

  it("updates model, tools, and Skills for the current Session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      session: {
        id: "session/1",
        model: { profileId: "model-next" },
        policy: { allowedTools: ["read"] },
        metadata: { skills: { enabled: ["writer"] } },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateSessionConfiguration("session/1", {
      model: { profileId: "model-next" },
      policy: { allowedTools: ["read"] },
      skills: { enabled: ["writer"] },
    })).resolves.toMatchObject({
      id: "session/1",
      model: { profileId: "model-next" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/sessions/session%2F1",
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: { profileId: "model-next" },
      policy: { allowedTools: ["read"] },
      skills: { enabled: ["writer"] },
    });
  });

  it("loads one Scheduler task and its filtered run history", async () => {
    const task = { id: "task/1", title: "Daily brief" };
    const run = { id: "run/1", taskId: "task/1", status: "success" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(task))
      .mockResolvedValueOnce(response({ runs: [run] }))
      .mockResolvedValueOnce(response({ ...run, output: "Done" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSchedulerTask("task/1")).resolves.toEqual(task);
    await expect(listSchedulerRuns("task/1", 25)).resolves.toEqual([run]);
    await expect(getSchedulerRun("run/1")).resolves.toMatchObject({
      output: "Done",
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/scheduler/tasks/task%2F1",
      "/v1/scheduler/runs?limit=25&task_id=task%2F1",
      "/v1/scheduler/runs/run%2F1?event_limit=50",
    ]);
  });

  it("sends a Scheduler task-level model override", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      id: "task-1",
      title: "Cheap report",
      modelProfileId: "workbench.local.free",
      schedule: { kind: "daily", time: "09:00" },
      enabled: true,
    }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await createSchedulerTask({
      title: "Cheap report",
      taskType: "agent",
      executionMode: "service-backed",
      prompt: "Summarize",
      modelProfileId: "workbench.local.free",
      schedule: { kind: "daily", time: "09:00" },
      enabled: true,
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      modelProfileId: "workbench.local.free",
    });
  });

  it("sends an idempotent Session message command", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      sessionId: "session-1",
      message: {
        id: "message-1",
        role: "user",
        content: "hello",
      },
      runId: "run-1",
      attemptId: "attempt-1",
      status: "accepted",
    }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await sendSessionMessage("session-1", {
      content: "hello",
      clientRequestId: "request-1",
    });

    const request = fetchMock.mock.calls[0];
    expect(request[0]).toContain("/v1/sessions/session-1/messages");
    expect(JSON.parse(request[1].body)).toMatchObject({
      content: "hello",
      clientRequestId: "request-1",
    });
  });

  it("exchanges a pairing code without exposing the returned credential", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ paired: true }))
      .mockResolvedValueOnce(response({
        authenticated: true,
        expiresAt: Date.now() + 60_000,
        device: {
          deviceId: "client:test",
          kind: "client",
          label: "Mobile",
          scopes: ["runtime.read"],
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangePairing({ userCode: "AAAA-BBBB-CCCC" }))
      .resolves.toMatchObject({ authenticated: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      userCode: "AAAA-BBBB-CCCC",
      device: expect.objectContaining({
        deviceId: expect.stringMatching(/^client:/),
      }),
    });
  });
});
