import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.session-manager/runtime.js";
import {
  listSessionsFromSnapshot,
  sessionCreateToolDefinition,
  sessionDeleteToolDefinition,
  sessionGetToolDefinition,
  sessionListToolDefinition,
  sessionUpdateToolDefinition
} from "../extensions/dev.session-manager/session-runtime-shared.js";

function activateWithService(service) {
  const tools = [];
  activateRuntimePlugin({
    apiVersion: 2,
    plugin: { id: "dev.session-manager", version: "test" },
    config: { sessionService: service },
    log: vi.fn(),
    tools: {
      registerTool(tool) {
        tools.push(tool);
        return { dispose() {} };
      }
    },
    context: { registerProvider: vi.fn() },
    documents: {
      registerProjector: vi.fn(() => ({ dispose() {} }))
    },
    state: { namespace: vi.fn() }
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

describe("Runtime-backed Session Manager tools", () => {
  it("shares the browser and Runtime session tool schemas", () => {
    expect(sessionListToolDefinition()).toMatchObject({
      name: "sessionList",
      inputSchema: {
        properties: {
          view_type: { enum: ["index", "tree"] }
        }
      }
    });
    expect(sessionGetToolDefinition()).toMatchObject({
      name: "sessionGet",
      inputSchema: {
        required: ["id"]
      }
    });
    expect(sessionCreateToolDefinition()).toMatchObject({
      name: "sessionCreate",
      inputSchema: {
        properties: {
          content: { type: "string" }
        }
      }
    });
    expect(sessionUpdateToolDefinition()).toMatchObject({
      name: "sessionUpdate",
      inputSchema: {
        properties: {
          update_type: { enum: ["content", "title"] }
        }
      }
    });
    expect(sessionDeleteToolDefinition()).toMatchObject({
      name: "sessionDelete",
      inputSchema: {
        properties: {
          confirm: { type: "boolean" }
        }
      }
    });
  });

  it("lists sessions from Runtime workbench-state snapshots", () => {
    const snapshot = {
      snapshot: {
        tree: {
          id: "root",
          type: "folder",
          title: "Sessions",
          children: [{
            id: "folder-a",
            type: "folder",
            title: "Project",
            children: [{ id: "s1", type: "session", title: "Alpha" }]
          }]
        },
        index: [{
          id: "s1",
          title: "Alpha",
          updatedAt: 2000,
          createdAt: 1000,
          size: 10,
          hash: "h1"
        }, {
          id: "s2",
          title: "Beta",
          updatedAt: 3000,
          createdAt: 1500,
          size: 20,
          hash: "h2"
        }]
      }
    };

    expect(listSessionsFromSnapshot(snapshot, { limit: 1 })).toEqual({
      ok: true,
      sessions: [expect.objectContaining({ id: "s2", title: "Beta" })]
    });
    expect(listSessionsFromSnapshot(snapshot, {
      view_type: "tree",
      folder_id: "folder-a",
      current_id: "s1"
    })).toEqual({
      ok: true,
      tree: expect.objectContaining({
        id: "folder-a",
        hasCurrent: true
      })
    });
  });

  it("exposes read-only sessionList and sessionGet tools from Runtime", async () => {
    const service = {
      readSnapshot: vi.fn(() => ({
        snapshot: {
          index: [{
            id: "s1",
            title: "Alpha",
            updatedAt: 2000,
            createdAt: 1000,
            size: 10,
            hash: "h1"
          }],
          tree: {
            id: "root",
            type: "folder",
            title: "Sessions",
            children: [{ id: "s1", type: "session", title: "Alpha" }]
          }
        }
      })),
      readSession: vi.fn((id) => id === "s1"
        ? {
            id: "s1",
            text: "user hello\nassistant hi",
            meta: { id: "s1", title: "Alpha" },
            session_revision: 3,
            content_hash: "hash"
          }
        : null)
    };
    const tools = activateWithService(service);

    expect(tools.sessionList.policy).toEqual({ minimumPreset: "read-only" });
    expect(tools.sessionGet.policy).toEqual({ minimumPreset: "read-only" });

    const list = JSON.parse((await tools.sessionList.invoke({})).content);
    expect(list).toEqual([expect.objectContaining({ id: "s1", title: "Alpha" })]);

    const detail = JSON.parse((await tools.sessionGet.invoke({
      id: "s1",
      include_doc: true,
      include_meta: true
    })).content);
    expect(detail).toEqual({
      id: "s1",
      doc: "user hello\nassistant hi",
      meta: { id: "s1", title: "Alpha" },
      session_revision: 3,
      content_hash: "hash"
    });

    const missing = await tools.sessionGet.invoke({ id: "missing" });
    expect(missing).toMatchObject({
      ok: false,
      error: "Session not found"
    });
  });

  it("exposes workspace-write session mutation tools from Runtime", async () => {
    const sessions = new Map();
    const service = {
      readSnapshot: vi.fn(() => ({
        snapshot: {
          index: Array.from(sessions.values()).map((session) => ({
            id: session.id,
            title: session.meta.title,
            updatedAt: session.meta.updatedAt,
            createdAt: session.meta.createdAt,
            size: session.text.length,
            hash: "hash"
          })),
          tree: {
            id: "root",
            type: "folder",
            title: "Sessions",
            children: Array.from(sessions.values()).map((session) => ({
              id: session.id,
              type: "session",
              title: session.meta.title
            }))
          }
        }
      })),
      readSession: vi.fn((id) => sessions.get(String(id)) || null),
      createSession: vi.fn((input) => {
        const id = String(input.id || "runtime-created");
        const record = {
          id,
          text: String(input.text || ""),
          meta: {
            id,
            title: String(input.title || "Runtime Created"),
            createdAt: 1000,
            updatedAt: 1000
          },
          session_revision: 1,
          content_hash: "hash"
        };
        sessions.set(id, record);
        return {
          ok: true,
          id,
          revision: "runtime:1",
          session_revision: 1
        };
      }),
      updateSession: vi.fn((id, patch) => {
        const current = sessions.get(String(id));
        const next = {
          ...current,
          text: patch.text == null ? current.text : String(patch.text),
          meta: {
            ...current.meta,
            ...(patch.title != null ? { title: String(patch.title) } : {}),
            updatedAt: 2000
          },
          session_revision: current.session_revision + 1
        };
        sessions.set(String(id), next);
        return {
          ok: true,
          id: String(id),
          revision: "runtime:2",
          session_revision: next.session_revision
        };
      }),
      deleteSession: vi.fn((id) => {
        sessions.delete(String(id));
        return {
          ok: true,
          revision: "runtime:3",
          session_revision: 3
        };
      })
    };
    const tools = activateWithService(service);

    expect(tools.sessionCreate.policy).toEqual({ minimumPreset: "workspace-write" });
    expect(tools.sessionUpdate.policy).toEqual({ minimumPreset: "workspace-write" });
    expect(tools.sessionDelete.policy).toEqual({ minimumPreset: "workspace-write" });

    const created = JSON.parse((await tools.sessionCreate.invoke({
      id: "s1",
      title: "Created",
      content: "hello",
      parent_id: "root",
      operation_id: "create-s1"
    })).content);
    expect(created).toMatchObject({
      ok: true,
      id: "s1",
      session: {
        id: "s1",
        doc: "hello",
        meta: { title: "Created" }
      }
    });
    expect(service.createSession).toHaveBeenCalledWith(expect.objectContaining({
      id: "s1",
      title: "Created",
      text: "hello",
      parent_id: "root",
      operation_id: "create-s1"
    }));

    const updated = JSON.parse((await tools.sessionUpdate.invoke({
      id: "s1",
      update_type: "content",
      mode: "append",
      content: "again",
      expected_session_revision: 1
    })).content);
    expect(updated).toMatchObject({
      ok: true,
      id: "s1",
      session: {
        id: "s1",
        doc: "hello\nagain"
      }
    });
    expect(service.updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      text: "hello\nagain",
      expected_session_revision: 1
    }));

    await expect(tools.sessionDelete.invoke({
      id: "s1",
      confirm: false
    })).resolves.toMatchObject({
      ok: false,
      error: "confirm=true is required"
    });

    const deleted = JSON.parse((await tools.sessionDelete.invoke({
      id: "s1",
      confirm: true,
      operation_id: "delete-s1"
    })).content);
    expect(deleted).toMatchObject({
      ok: true,
      id: "s1"
    });
    expect(service.deleteSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      operation_id: "delete-s1"
    }));
  });
});
