import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.identity/runtime.js";
import {
  IDENTITY_RUNTIME_KV_KEY,
  PROJECT_AUTOMATION_RUNTIME_KV_KEY,
  buildIdentityContextFromSnapshot,
  controlRuntimeProjectAutomation,
  createIdentitySnapshot,
  loadProjectAutomationFromRuntime,
  projectAutomationSyncDirection,
  syncProjectAutomationToRuntime,
  syncIdentitySnapshotToRuntime
} from "../extensions/dev.identity/identity-runtime-state.js";
import {
  IDENTITY_PROFILE_FILE_PATHS,
  IDENTITY_MANAGE_READONLY_ACTIONS,
  IDENTITY_MANAGE_RUNTIME_ACTIONS,
  PROJECT_AUTOMATION_READONLY_ACTIONS,
  PROJECT_AUTOMATION_RUNTIME_ACTIONS,
  identityManageToolDefinition,
  projectAutomationManageToolDefinition
} from "../extensions/dev.identity/identity-runtime-shared.js";

function createState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn((key) => values.get(key)),
    set: vi.fn((key, value) => {
      values.set(key, value);
      return value;
    }),
    values
  };
}

function appendToDisk(disk) {
  return vi.fn(async ({ records, relativePath }) => {
    const key = relativePath === "biography/distillations.jsonl" ? "biographyDistillations" : "biographyEvents";
    const existing = String(disk.get(key) || "").split("\n").filter(Boolean).map(JSON.parse);
    const ids = new Set(existing.map((event) => event.id));
    const added = records.filter((record) => !ids.has(record.id));
    disk.set(key, [...existing, ...added].map(JSON.stringify).join("\n") + "\n");
    return { appended: added.map((event) => event.id), skipped: records.filter((event) => ids.has(event.id)).map((event) => event.id) };
  });
}

describe("Runtime-backed Identity state", () => {
  it("builds identity_context from snapshot files", () => {
    const snapshot = createIdentitySnapshot({
      sourceRoot: "/Users/test/.zion-next/data/plugins/dev.identity",
      files: {
        identity: "# Identity\nZion <agent>",
        user: "# User\nPrefers Runtime & CLI parity",
        biography: "# 自传摘要\n- Runtime migration",
        projects: "# 项目索引\n| Zion Next | active | high | Finish Runtime host | 2026-09-03 |"
      },
      savedAt: 1000
    });

    const context = buildIdentityContextFromSnapshot(snapshot);
    expect(context).toContain("<identity_context>");
    expect(context).toContain("<agent_identity");
    expect(context).toContain("Zion &lt;agent&gt;");
    expect(context).toContain("Runtime &amp; CLI parity");
    expect(context).toContain("<projects_index");
  });

  it("syncs the rendered identity snapshot into Runtime workbench-state KV", async () => {
    const state = createState({
      "runtime.mode": "auto",
      "runtime.baseUrl": "http://runtime.test",
      "runtime.connection": {
        backend: "runtime",
        baseUrl: "http://runtime.test"
      }
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      expect(String(url)).toBe(
        `http://runtime.test/v1/workbench-state/kv/${encodeURIComponent(IDENTITY_RUNTIME_KV_KEY)}`
      );
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toMatchObject({
        value: {
          sourceRoot: "/Users/test/.zion-next/data/plugins/dev.identity",
          content: "<identity_context>cached</identity_context>"
        }
      });
      return new globalThis.Response(JSON.stringify({ ok: true, revision: "runtime:3" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    await expect(syncIdentitySnapshotToRuntime({
      state,
      fetchImpl,
      snapshot: createIdentitySnapshot({
        sourceRoot: "/Users/test/.zion-next/data/plugins/dev.identity",
        content: "<identity_context>cached</identity_context>",
        savedAt: 2000
      })
    })).resolves.toMatchObject({ synced: true });
    expect(state.values.get("runtime.identitySync")).toMatchObject({
      status: "synced",
      sourceRoot: "/Users/test/.zion-next/data/plugins/dev.identity"
    });
  });

  it("loads and syncs project automation through the Runtime plugin KV", async () => {
    const state = createState({
      "runtime.mode": "runtime",
      "runtime.baseUrl": "http://runtime.test"
    });
    const runtimeDocument = {
      version: 1,
      projects: {
        "zion-next": {
          enabled: true,
          mode: "execute",
          updatedAt: 2000
        }
      },
      requests: []
    };
    const fetchImpl = vi.fn(async (url, init = {}) => {
      expect(String(url)).toBe(
        `http://runtime.test/v1/workbench-state/kv/${encodeURIComponent(PROJECT_AUTOMATION_RUNTIME_KV_KEY)}`
      );
      if (init.method === "PUT") {
        expect(JSON.parse(init.body).value.projects["zion-next"]).toMatchObject({
          enabled: true,
          mode: "execute",
          updatedAt: 2000
        });
        return new globalThis.Response(JSON.stringify({ ok: true, revision: "runtime:4" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new globalThis.Response(JSON.stringify({ value: runtimeDocument }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const loaded = await loadProjectAutomationFromRuntime({ state, fetchImpl });
    expect(loaded.projects["zion-next"]).toMatchObject({
      enabled: true,
      mode: "execute",
      updatedAt: 2000
    });
    await expect(syncProjectAutomationToRuntime({
      document: loaded,
      state,
      fetchImpl
    })).resolves.toMatchObject({
      synced: true,
      document: expect.objectContaining({ version: 1 })
    });
    expect(state.values.get("runtime.projectAutomationSync")).toMatchObject({
      status: "synced",
      revision: 2000
    });
  });

  it("chooses the newer project automation projection without duplicate setup", () => {
    const local = {
      projects: {
        "zion-next": { enabled: false, updatedAt: 1000 }
      }
    };
    const runtime = {
      projects: {
        "zion-next": { enabled: true, updatedAt: 2000 }
      }
    };

    expect(projectAutomationSyncDirection(local, runtime)).toBe("restore");
    expect(projectAutomationSyncDirection(runtime, local)).toBe("upload");
    expect(projectAutomationSyncDirection(local, null)).toBe("upload");
    expect(projectAutomationSyncDirection({}, null)).toBe("none");
  });

  it("routes project run controls to the Runtime Host", async () => {
    const state = createState({
      "runtime.mode": "runtime",
      "runtime.baseUrl": "http://runtime.test"
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      expect(String(url)).toBe(
        "http://runtime.test/v1/project-automation/projects/zion-next/run"
      );
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        interaction_profile_id: "interactive.default"
      });
      return new globalThis.Response(JSON.stringify({
        status: "running",
        projectKey: "zion-next",
        runId: "runtime-run-1"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    await expect(controlRuntimeProjectAutomation({
      action: "run",
      projectKey: "zion-next",
      interactionProfileId: "interactive.default",
      state,
      fetchImpl
    })).resolves.toEqual({
      handled: true,
      result: {
        status: "running",
        projectKey: "zion-next",
        runId: "runtime-run-1"
      }
    });
  });

  it("exposes Runtime identity context and Runtime KV identityManage writes", async () => {
    const providers = [];
    const tools = [];
    const stateBucket = new Map();
    const projectAutomationService = {
      readDocument: () => stateBucket.get("projectAutomation.v1") || {},
      writeDocument: (value) => stateBucket.set("projectAutomation.v1", value),
      runNow: vi.fn(async (projectKey) => ({
        status: "running",
        projectKey,
        runId: "project-run-1"
      })),
      stopProject: vi.fn(async (projectKey) => ({
        status: "stopped",
        projectKey,
        abortedRun: true
      }))
    };
    stateBucket.set("snapshot", createIdentitySnapshot({
      sourceRoot: "/Users/test/.zion-next/data/plugins/dev.identity",
      content: "<identity_context><user_profile>Chinese first</user_profile></identity_context>",
      savedAt: 3000
    }));

    activateRuntimePlugin({
      apiVersion: 2,
      plugin: { id: "dev.identity", version: "test" },
      config: { projectAutomationService },
      state: {
        namespace: () => ({
          get: (key) => stateBucket.get(key),
          set: (key, value) => stateBucket.set(key, value),
          delete: (key) => stateBucket.delete(key),
          entries: () => Array.from(stateBucket.entries())
        })
      },
      context: {
        registerProvider(provider) {
          providers.push(provider);
          return { dispose() {} };
        }
      },
      tools: {
        registerTool(tool) {
          tools.push(tool);
          return { dispose() {} };
        }
      }
    });

    await expect(providers[0].contribute([
      { role: "system", content: "base" },
      { role: "user", content: "hello" }
    ])).resolves.toEqual([
      { role: "system", content: "base" },
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Chinese first")
      }),
      { role: "user", content: "hello" }
    ]);

    await expect(providers[0].contribute([
      { role: "system", content: "<identity_context>already</identity_context>" },
      { role: "user", content: "hello" }
    ])).resolves.toEqual([
      { role: "system", content: "<identity_context>already</identity_context>" },
      { role: "user", content: "hello" }
    ]);

    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(toolByName.get("identityManage")?.inputSchema.properties.action.enum)
      .toEqual(IDENTITY_MANAGE_RUNTIME_ACTIONS);
    expect(identityManageToolDefinition().inputSchema.properties.action.enum)
      .toEqual(IDENTITY_MANAGE_READONLY_ACTIONS);
    expect(toolByName.get("projectAutomationManage")?.inputSchema.properties.action.enum)
      .toEqual(PROJECT_AUTOMATION_RUNTIME_ACTIONS);
    expect(projectAutomationManageToolDefinition().inputSchema.properties.action.enum)
      .toEqual(PROJECT_AUTOMATION_READONLY_ACTIONS);

    const result = await toolByName.get("identityContext").invoke({ include_content: true });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      sourceRoot: "/Users/test/.zion-next/data/plugins/dev.identity",
      hasContext: true,
      content: expect.stringContaining("Chinese first")
    });

    await expect(toolByName.get("identityManage").invoke({
      action: "patch_files",
      files: {
        user: "# User\nRuntime-managed preference"
      }
    }, {
      policy: { preset: "read-only" }
    })).resolves.toMatchObject({
      ok: false,
      error: "identityManage action patch_files requires workspace-write capability"
    });

    const patched = JSON.parse((await toolByName.get("identityManage").invoke({
      action: "patch_files",
      files: {
        user: "# User\nRuntime-managed preference"
      }
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(patched.updated).toMatchObject({
      hasContext: true,
      content: expect.stringContaining("Runtime-managed preference")
    });
    expect(stateBucket.get("snapshot").files.user).toContain("Runtime-managed preference");

    await expect(toolByName.get("projectAutomationManage").invoke({
      action: "request_update",
      project_key: "zion-next",
      enabled: true
    }, {
      policy: { preset: "read-only" }
    })).resolves.toMatchObject({
      ok: false,
      error: "projectAutomationManage action request_update requires workspace-write capability"
    });

    const automationRequest = JSON.parse((await toolByName.get("projectAutomationManage").invoke({
      action: "request_update",
      project_key: "zion-next",
      enabled: true,
      mode: "execute"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(automationRequest).toMatchObject({
      status: "pending_user_approval",
      projectKey: "zion-next",
      automation: {
        projectKey: "zion-next",
        pending: [expect.objectContaining({
          projectKey: "zion-next",
          status: "pending"
        })]
      }
    });
    expect(stateBucket.get("projectAutomation.v1").projects["zion-next"]).toBeUndefined();

    await expect(toolByName.get("projectAutomationManage").invoke({
      action: "approve_request",
      request_id: automationRequest.requestId
    }, {
      policy: { preset: "workspace-write" }
    })).resolves.toMatchObject({
      ok: false,
      error: "Unsupported Runtime projectAutomationManage action: approve_request"
    });

    const started = JSON.parse((await toolByName.get("projectAutomationManage").invoke({
      action: "run_now",
      project_key: "zion-next"
    }, {
      runId: "parent-run",
      attemptId: "parent-attempt",
      policy: { preset: "workspace-write" }
    })).content);
    expect(started).toMatchObject({
      status: "running",
      projectKey: "zion-next",
      runId: "project-run-1"
    });
    expect(projectAutomationService.runNow).toHaveBeenCalledWith(
      "zion-next",
      expect.objectContaining({
        parentRunId: "parent-run",
        parentAttemptId: "parent-attempt"
      })
    );

    const stopped = JSON.parse((await toolByName.get("projectAutomationManage").invoke({
      action: "stop",
      project_key: "zion-next"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(stopped).toMatchObject({
      status: "stopped",
      projectKey: "zion-next",
      abortedRun: true
    });

    const updated = JSON.parse((await toolByName.get("identityManage").invoke({
      action: "update_snapshot",
      content: "<identity_context><user_profile>Direct Runtime snapshot</user_profile></identity_context>",
      sourceRoot: "runtime://identity"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(updated.updated).toMatchObject({
      sourceRoot: "runtime://identity",
      content: expect.stringContaining("Direct Runtime snapshot")
    });

    const cleared = JSON.parse((await toolByName.get("identityManage").invoke({
      action: "clear"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(cleared).toMatchObject({
      cleared: true,
      updated: {
        hasContext: false
      }
    });
  });

  it("hydrates an empty Runtime identity snapshot from the Device memory root", async () => {
    const providers = [];
    const stateBucket = new Map();
    const fileService = {
      readTextFiles: vi.fn(async ({ fileRoot, files }) => ({
        fileRoot,
        files: Object.fromEntries(Object.keys(files).map((key) => [
          key,
          key === "identity" ? "# Identity\nRuntime hydrated identity" : ""
        ]))
      }))
    };

    activateRuntimePlugin({
      apiVersion: 2,
      plugin: { id: "dev.identity", version: "test" },
      config: {
        fileService,
        biography: {
          memoryRoot: "/Users/test/.zion-next/data/plugins/dev.identity"
        }
      },
      state: {
        namespace: () => ({
          get: (key) => stateBucket.get(key),
          set: (key, value) => stateBucket.set(key, value),
          delete: (key) => stateBucket.delete(key),
          entries: () => Array.from(stateBucket.entries())
        })
      },
      context: {
        registerProvider(provider) {
          providers.push(provider);
          return { dispose() {} };
        }
      },
      tools: {
        registerTool() {
          return { dispose() {} };
        }
      }
    });

    await expect(providers[0].contribute([
      { role: "user", content: "hello" }
    ], {
      runId: "run-1",
      attemptId: "attempt-1",
      request: {
        sessionId: "chat-session-1",
        projectId: "project-1",
        policy: { preset: "read-only", fileRoots: [] }
      }
    })).resolves.toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Runtime hydrated identity")
      }),
      { role: "user", content: "hello" }
    ]);
    expect(fileService.readTextFiles).toHaveBeenCalledWith({
      fileRoot: "/Users/test/.zion-next/data/plugins/dev.identity",
      files: IDENTITY_PROFILE_FILE_PATHS,
      runContext: expect.objectContaining({
        runId: "run-1",
        attemptId: "attempt-1",
        sessionId: "chat-session-1",
        projectId: "project-1",
        policy: expect.objectContaining({
          fileRoots: ["/Users/test/.zion-next/data/plugins/dev.identity"]
        })
      })
    });
    expect(stateBucket.get("snapshot").content).toContain(
      "Runtime hydrated identity"
    );
  });

  it("loads and writes Identity profile files through the injected Runtime file service", async () => {
    const disk = new Map([
      ["identity", "# Identity\nRuntime file identity"],
      ["user", "# User\nRuntime file user"],
      ["biography", "# Biography\nRuntime file biography"],
      ["projects", "# Projects\nRuntime file projects"],
      ["projectsInbox", ""],
      ["projectsAttention", ""]
    ]);
    const fileService = {
      readTextFiles: vi.fn(async ({ fileRoot, files }) => ({
        fileRoot,
        files: Object.fromEntries(
          Object.keys(files).map((key) => [key, disk.get(key) || ""])
        )
      })),
      writeTextFiles: vi.fn(async ({ fileRoot, files }) => {
        for (const [key, spec] of Object.entries(files)) {
          disk.set(key, spec.content);
        }
        return {
          fileRoot,
          written: Object.entries(files).map(([key, spec]) => ({
            key,
            path: `${fileRoot}/${spec.relativePath}`
          }))
        };
      })
    };
    const stateBucket = new Map();
    const tools = [];
    activateRuntimePlugin({
      apiVersion: 2,
      plugin: { id: "dev.identity", version: "test" },
      config: { fileService },
      state: {
        namespace: () => ({
          get: (key) => stateBucket.get(key),
          set: (key, value) => stateBucket.set(key, value),
          delete: (key) => stateBucket.delete(key),
          entries: () => Array.from(stateBucket.entries())
        })
      },
      context: {
        registerProvider() {
          return { dispose() {} };
        }
      },
      tools: {
        registerTool(tool) {
          tools.push(tool);
          return { dispose() {} };
        }
      }
    });
    const identityManage = new Map(tools.map((tool) => [tool.name, tool])).get("identityManage");

    await expect(identityManage.invoke({
      action: "load_files",
      file_root: "/Users/test/.zion-next/data/plugins/dev.identity"
    }, {
      policy: { preset: "read-only" }
    })).resolves.toMatchObject({
      ok: false,
      error: "identityManage action load_files requires workspace-write capability"
    });

    const loaded = JSON.parse((await identityManage.invoke({
      action: "load_files",
      file_root: "/Users/test/.zion-next/data/plugins/dev.identity",
      session_id: "terminal-1"
    }, {
      runId: "run-1",
      attemptId: "attempt-1",
      policy: { preset: "workspace-write", fileRoots: ["/Users/test"] }
    })).content);
    expect(loaded.loaded).toMatchObject({
      sourceRoot: "/Users/test/.zion-next/data/plugins/dev.identity",
      hasContext: true,
      content: expect.stringContaining("Runtime file user")
    });
    expect(fileService.readTextFiles).toHaveBeenCalledWith(expect.objectContaining({
      fileRoot: "/Users/test/.zion-next/data/plugins/dev.identity",
      sessionId: "terminal-1",
      runContext: expect.objectContaining({ runId: "run-1" })
    }));

    const written = JSON.parse((await identityManage.invoke({
      action: "write_files",
      file_root: "/Users/test/.zion-next/data/plugins/dev.identity",
      files: {
        user: "# User\nUpdated from Runtime",
        ignored: "not written"
      }
    }, {
      policy: { preset: "workspace-write", fileRoots: ["/Users/test"] }
    })).content);
    expect(fileService.writeTextFiles).toHaveBeenCalledWith(expect.objectContaining({
      files: {
        user: {
          relativePath: "user.md",
          content: "# User\nUpdated from Runtime"
        }
      }
    }));
    expect(written).toMatchObject({
      written: [{
        key: "user",
        path: "/Users/test/.zion-next/data/plugins/dev.identity/user.md"
      }],
      updated: {
        hasContext: true,
        content: expect.stringContaining("Updated from Runtime")
      }
    });
  });

  it("appends biography events through Runtime file service and refreshes the snapshot", async () => {
    const disk = new Map([
      ["biographyEvents", ""],
      ["identity", "# Identity\nRuntime identity"],
      ["user", "# User\nRuntime user"],
      ["biography", ""],
      ["projects", ""],
      ["projectsInbox", ""],
      ["projectsAttention", ""]
    ]);
    const fileService = {
      appendJsonl: appendToDisk(disk),
      readTextFiles: vi.fn(async ({ fileRoot, files }) => ({
        fileRoot,
        files: Object.fromEntries(
          Object.keys(files).map((key) => [key, disk.get(key) || ""])
        )
      })),
      writeTextFiles: vi.fn(async ({ fileRoot, files }) => {
        for (const [key, spec] of Object.entries(files)) {
          disk.set(key, spec.content);
        }
        return {
          fileRoot,
          written: Object.entries(files).map(([key, spec]) => ({
            key,
            path: `${fileRoot}/${spec.relativePath}`
          }))
        };
      })
    };
    const stateBucket = new Map();
    const tools = [];
    activateRuntimePlugin({
      apiVersion: 2,
      plugin: { id: "dev.identity", version: "test" },
      config: { fileService },
      state: {
        namespace: () => ({
          get: (key) => stateBucket.get(key),
          set: (key, value) => stateBucket.set(key, value),
          delete: (key) => stateBucket.delete(key),
          entries: () => Array.from(stateBucket.entries())
        })
      },
      context: {
        registerProvider() {
          return { dispose() {} };
        }
      },
      tools: {
        registerTool(tool) {
          tools.push(tool);
          return { dispose() {} };
        }
      }
    });
    const identityManage = new Map(tools.map((tool) => [tool.name, tool])).get("identityManage");

    await expect(identityManage.invoke({
      action: "append_biography_events",
      file_root: "/Users/test/.zion-next/data/plugins/dev.identity",
      source_session_id: "session-1",
      source_run_id: "run-1",
      source_at: "2026-09-03T10:00:00.000Z",
      events: [{
        kind: "outcome",
        summary: "Runtime 持久化自传事件",
        project: "zion-next",
        topics: ["runtime"]
      }]
    }, {
      policy: { preset: "read-only" }
    })).resolves.toMatchObject({
      ok: false,
      error: "identityManage action append_biography_events requires workspace-write capability"
    });

    const result = JSON.parse((await identityManage.invoke({
      action: "append_biography_events",
      file_root: "/Users/test/.zion-next/data/plugins/dev.identity",
      source_session_id: "session-1",
      source_run_id: "run-1",
      source_at: "2026-09-03T10:00:00.000Z",
      events: [{
        kind: "outcome",
        summary: "Runtime 持久化自传事件",
        project: "zion-next",
        topics: ["runtime"]
      }]
    }, {
      policy: { preset: "workspace-write", fileRoots: ["/Users/test"] }
    })).content);

    expect(result).toMatchObject({
      appended: ["session-1:run-1:0"],
      skipped: [],
      totalEvents: 1,
      updated: {
        hasContext: true,
        content: expect.stringContaining("Runtime 持久化自传事件")
      }
    });
    expect(fileService.appendJsonl).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: "biography/events.jsonl",
      records: [expect.objectContaining({ id: "session-1:run-1:0" })]
    }));
    expect(fileService.writeTextFiles).toHaveBeenCalledWith(expect.objectContaining({
      files: expect.objectContaining({
        biography: expect.objectContaining({
          relativePath: "biography/digest.md",
          content: expect.stringContaining("[[memory:session-1:run-1:0]]")
        })
      })
    }));
    expect(stateBucket.get("snapshot").files.biography).toContain("Runtime 持久化自传事件");

    fileService.writeTextFiles.mockClear();
    const duplicate = JSON.parse((await identityManage.invoke({
      action: "append_biography_events",
      file_root: "/Users/test/.zion-next/data/plugins/dev.identity",
      source_session_id: "session-1",
      source_run_id: "run-1",
      events: [{
        kind: "outcome",
        summary: "Runtime 持久化自传事件",
        project: "zion-next",
        topics: ["runtime"]
      }]
    }, {
      policy: { preset: "workspace-write", fileRoots: ["/Users/test"] }
    })).content);
    expect(duplicate).toMatchObject({
      appended: [],
      skipped: ["session-1:run-1:0"],
      totalEvents: 1
    });
    expect(fileService.writeTextFiles).toHaveBeenCalledWith(expect.objectContaining({
      files: { biography: expect.objectContaining({ content: expect.stringContaining("Runtime") }) }
    }));
  });

  it.each(["success", "summary-failure", "append-failure"])("distills once and recovers partial publication (%s)", async failureStage => {
    const disk = new Map([
      ["biographyEvents", ""],
      ["identity", "# Identity\nRuntime identity"],
      ["user", "# User\nRuntime user"],
      ["biography", ""],
      ["projects", ""],
      ["projectsInbox", ""],
      ["projectsAttention", ""]
    ]);
    let failed = false;
    const append = appendToDisk(disk);
    const fileService = {
      appendJsonl: vi.fn(async input => {
        if (failureStage === "append-failure" && !failed && input.relativePath.endsWith("/events.jsonl")) {
          failed = true;
          throw new Error("temporary publication failure");
        }
        return append(input);
      }),
      readTextFiles: vi.fn(async ({ fileRoot, files }) => ({
        fileRoot,
        files: Object.fromEntries(
          Object.keys(files).map((key) => [key, disk.get(key) || ""])
        )
      })),
      writeTextFiles: vi.fn(async ({ fileRoot, files }) => {
        if (failureStage === "summary-failure" && !failed && files.biography) {
          failed = true;
          throw new Error("temporary publication failure");
        }
        for (const [key, spec] of Object.entries(files)) {
          disk.set(key, spec.content);
        }
        return {
          fileRoot,
          written: Object.entries(files).map(([key, spec]) => ({
            key,
            path: `${fileRoot}/${spec.relativePath}`
          }))
        };
      })
    };
    const modelService = {
      generateText: vi.fn(async ({ messages, requestContext }) => {
        expect(messages[0].content).toContain("经历事件蒸馏器");
        expect(messages[1].content).toContain("<assistant_result>");
        expect(messages[1].content).toContain("完成 Runtime post processor");
        expect(requestContext).toEqual({
          source: "identity-biography",
          pluginId: "dev.identity",
          operation: "biography-distillation",
          parentRunId: "run-1",
          sessionId: "session-1"
        });
        return JSON.stringify({
          events: [{
            kind: "outcome",
            summary: "完成 Runtime post processor",
            project: "zion-next",
            topics: ["runtime"],
            confirmed: false
          }]
        });
      })
    };
    const stateBucket = new Map();
    const processors = [];
    const pluginContext = {
      apiVersion: 2,
      plugin: { id: "dev.identity", version: "test" },
      config: {
        fileService,
        modelService,
        biography: {
          enabled: true,
          memoryRoot: "/Users/test/.zion-next/data/plugins/dev.identity"
        }
      },
      state: {
        namespace: () => ({
          get: (key) => stateBucket.get(key),
          set: (key, value) => stateBucket.set(key, value),
          delete: (key) => stateBucket.delete(key),
          entries: () => Array.from(stateBucket.entries())
        })
      },
      context: {
        registerProvider() {
          return { dispose() {} };
        }
      },
      tools: {
        registerTool() {
          return { dispose() {} };
        }
      },
      runs: {
        registerPostProcessor(processor) {
          processors.push(processor);
          return { dispose() {} };
        }
      }
    };
    activateRuntimePlugin(pluginContext);

    expect(processors).toHaveLength(1);
    const run = {
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      status: "completed",
      idempotencyKey: "run-1:attempt-1:dev.identity.biography",
      model: { profileId: "workbench.user.dynamic.kimi-k2.5" },
      policy: { preset: "trusted-automation" },
      metadata: { sessionTitle: "Runtime Post Processor" },
      messages: [
        { role: "user", content: "继续推进 Runtime" },
        { role: "assistant", content: "完成 Runtime post processor" }
      ]
    };
    if (failureStage !== "success") {
      await expect(processors[0].process(run)).rejects.toThrow("temporary publication failure");
      activateRuntimePlugin(pluginContext);
      await processors[1].process(run);
    } else {
      await processors[0].process(run);
    }
    await processors.at(-1).process(run);

    expect(modelService.generateText).toHaveBeenCalledOnce();
    expect(String(disk.get("biographyEvents")).split("\n").filter(Boolean)).toHaveLength(1);
    expect(String(disk.get("biographyDistillations")).split("\n").filter(Boolean)).toHaveLength(1);
    expect(fileService.readTextFiles).toHaveBeenCalledWith(
      expect.not.objectContaining({
        sessionId: "session-1"
      })
    );
    expect(fileService.writeTextFiles).toHaveBeenCalledWith(expect.objectContaining({
      fileRoot: "/Users/test/.zion-next/data/plugins/dev.identity",
      sessionId: undefined,
      files: expect.objectContaining({
        biography: expect.objectContaining({
          content: expect.stringContaining("完成 Runtime post processor")
        })
      })
    }));
    expect(fileService.appendJsonl).toHaveBeenCalledWith(expect.objectContaining({
      records: [expect.objectContaining({ id: "session-1:run-1:0" })]
    }));
    expect(stateBucket.get("snapshot").files.biography).toContain("完成 Runtime post processor");
    await expect(processors.at(-1).process({
      ...run, runId: "missing-input", messages: [{ role: "assistant", content: "completed" }]
    })).rejects.toThrow("input context is unavailable");
  });
});
