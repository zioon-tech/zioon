import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMobileHttpHandler } from "../src/mobile-http-handler.mjs";

const servers = [];

async function harness({ sessions, activeRunForSession, presentationForSession }) {
  const handler = createMobileHttpHandler({
    sessions,
    activeRunForSession,
    presentationForSession
  });
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "127.0.0.1"}`
    );
    if (!await handler(request, response, url)) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("Mobile HTTP handler", () => {
  it("projects Session previews and active Runs in one request", async () => {
    const url = await harness({
      sessions: {
        async listSessions() {
          return [{
            id: "session-1",
            title: "新会话",
            status: "active",
            createdAt: 100,
            updatedAt: 200
          }];
        },
        async getSessionMessages() {
          return [
            {
              id: "message-user",
              sequence: 1,
              role: "user",
              content: "Audit the mobile experience",
              runId: "run-1",
              createdAt: 100
            },
            {
              id: "message-1",
              sequence: 2,
              role: "assistant",
              content: "A compact preview",
              runId: "run-1",
              createdAt: 200
            }
          ];
        }
      },
      activeRunForSession: async () => ({
        runId: "run-2",
        attemptId: "attempt-2",
        status: "running"
      })
    });

    const response = await fetch(`${url}/v1/mobile/sessions`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessions: [{
        id: "session-1",
        title: "Audit the mobile experience",
        lastMessage: {
          content: "A compact preview",
          role: "assistant"
        },
        activeRun: {
          runId: "run-2",
          status: "running"
        }
      }]
    });
  });

  it("filters projected Sessions by title or preview", async () => {
    const records = [
      { id: "one", title: "Alpha", status: "active", updatedAt: 2 },
      { id: "two", title: "Beta", status: "active", updatedAt: 1 }
    ];
    const url = await harness({
      sessions: {
        async listSessions() {
          return records;
        },
        async getSessionMessages(sessionId) {
          return [{
            id: `message-${sessionId}`,
            sequence: 1,
            role: "assistant",
            content: sessionId === "two" ? "needle result" : "other",
            runId: `run-${sessionId}`,
            createdAt: 1
          }];
        }
      }
    });

    const response = await fetch(`${url}/v1/mobile/sessions?query=needle`);
    const body = await response.json();
    expect(body.sessions.map((session) => session.id)).toEqual(["two"]);
  });

  it("uses the Workbench presentation title for shared Sessions", async () => {
    const url = await harness({
      sessions: {
        async listSessions() {
          return [{ id: "shared", title: "Initial prompt", status: "active" }];
        },
        async getSessionMessages() {
          return [];
        }
      },
      presentationForSession: async () => ({
        title: "Renamed in Workbench"
      })
    });

    const response = await fetch(`${url}/v1/mobile/sessions`);
    await expect(response.json()).resolves.toMatchObject({
      sessions: [{
        id: "shared",
        title: "Renamed in Workbench"
      }]
    });
  });

  it("falls back to the first user message when Workbench only has a generated title", async () => {
    const url = await harness({
      sessions: {
        async listSessions() {
          return [{
            id: "session_8cfd7337569f4d64",
            title: "session_8cfd7337569f4d64",
            status: "active"
          }];
        },
        async getSessionMessages() {
          return [{
            id: "message-user",
            sequence: 1,
            role: "user",
            content: "优化 mobile 对话自动命名",
            runId: "run-1",
            createdAt: 1
          }];
        }
      },
      presentationForSession: async () => ({
        title: "Session 12",
        titleAuto: true
      })
    });

    const response = await fetch(`${url}/v1/mobile/sessions`);
    await expect(response.json()).resolves.toMatchObject({
      sessions: [{
        id: "session_8cfd7337569f4d64",
        title: "优化 mobile 对话自动命名"
      }]
    });
  });

  it("does not expose generated ids for empty placeholder Sessions", async () => {
    const url = await harness({
      sessions: {
        async listSessions() {
          return [{
            id: "session_8cfd7337569f4d64",
            title: "session_8cfd7337569f4d64",
            status: "active"
          }];
        },
        async getSessionMessages() {
          return [];
        }
      }
    });

    const response = await fetch(`${url}/v1/mobile/sessions`);
    await expect(response.json()).resolves.toMatchObject({
      sessions: [{
        id: "session_8cfd7337569f4d64",
        title: "新会话"
      }]
    });
  });

  it("keeps scheduled conversations out of the generic Mobile chat list", async () => {
    const url = await harness({
      sessions: {
        async listSessions() {
          return [{
            id: "scheduled",
            title: "Daily report",
            status: "active",
            metadata: { source: "scheduled-task" }
          }, {
            id: "interactive",
            title: "Interactive",
            status: "active",
            metadata: { source: "interactive-chat" }
          }];
        },
        async getSessionMessages() {
          return [];
        }
      }
    });

    const response = await fetch(`${url}/v1/mobile/sessions`);
    const body = await response.json();
    expect(body.sessions.map((session) => session.id)).toEqual(["interactive"]);
  });
});
