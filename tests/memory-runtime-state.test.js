import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.memory/runtime.js";
import {
  MEMORY_ACTIVE_STORAGE_KEY,
  MEMORY_ITEMS_STORAGE_KEY,
  MEMORY_RUNTIME_KV_KEY,
  MEMORY_SETTINGS_STORAGE_KEY,
  applyMemorySnapshotToStorage,
  buildMemoryContextFromSnapshot,
  memorySnapshotFromStorage,
  shouldApplyRuntimeMemorySnapshot,
  syncMemorySnapshotToRuntime
} from "../extensions/dev.memory/memory-runtime-state.js";

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

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => {
      values.set(key, String(value));
    }),
    values
  };
}

function memoryItem(patch = {}) {
  return {
    id: "mem_working",
    providerId: "local-markdown-files",
    title: "Project Rules",
    content: "Runtime owns durable context.",
    type: "semantic",
    layer: "working",
    path: "working/project-rules.md",
    scope: "project",
    tags: ["runtime"],
    enabled: true,
    pinned: false,
    confidence: 0.9,
    createdAt: 1000,
    updatedAt: 2000,
    ...patch
  };
}

describe("Runtime-backed Memory state", () => {
  it("builds working memory XML from a normalized snapshot", () => {
    const result = buildMemoryContextFromSnapshot({
      settings: {
        memoryRootPath: "~/zion-next/memory",
        includePinnedLongTerm: true
      },
      items: [
        memoryItem({
          title: "Escaped <Rule>",
          content: "Prefer Runtime & CLI parity."
        }),
        memoryItem({
          id: "mem_disabled",
          title: "Disabled",
          content: "hidden",
          enabled: false,
          updatedAt: 3000
        }),
        memoryItem({
          id: "mem_pinned",
          title: "Pinned Long Term",
          content: "Keep plugin Runtime entries headless.",
          layer: "long-term",
          path: "long-term/semantic/plugins.md",
          pinned: true,
          updatedAt: 4000
        })
      ]
    }, "plugins");

    expect(result.text).toContain("<working_memory>");
    expect(result.text).toContain("<title>Escaped &lt;Rule&gt;</title>");
    expect(result.text).toContain("Prefer Runtime &amp; CLI parity.");
    expect(result.text).toContain("Pinned Long Term");
    expect(result.text).not.toContain("Disabled");
    expect(result.items.map((item) => item.id)).toEqual(["mem_pinned", "mem_working"]);
  });

  it("syncs the Workbench memory snapshot into Runtime workbench-state KV", async () => {
    const storage = createStorage({
      [MEMORY_ITEMS_STORAGE_KEY]: JSON.stringify([memoryItem()]),
      [MEMORY_SETTINGS_STORAGE_KEY]: JSON.stringify({ maxContextChars: 2400 }),
      [MEMORY_ACTIVE_STORAGE_KEY]: "mem_working"
    });
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
        `http://runtime.test/v1/workbench-state/kv/${encodeURIComponent(MEMORY_RUNTIME_KV_KEY)}`
      );
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toMatchObject({
        value: {
          activeId: "mem_working",
          settings: {
            maxContextChars: 2400
          },
          items: [{
            id: "mem_working",
            title: "Project Rules"
          }]
        }
      });
      return new Response(JSON.stringify({ ok: true, revision: "runtime:2" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const snapshot = memorySnapshotFromStorage({ storage });
    await expect(syncMemorySnapshotToRuntime({ snapshot, state, storage, fetchImpl }))
      .resolves.toMatchObject({ synced: true });
    expect(state.values.get("runtime.memorySync")).toMatchObject({
      status: "synced",
      count: 1
    });
  });

  it("applies Runtime snapshots to browser storage without accepting stale snapshots", () => {
    const storage = createStorage();
    const state = createState();
    const applied = applyMemorySnapshotToStorage({
      activeId: "mem_working",
      savedAt: 3000,
      items: [memoryItem()]
    }, { storage, state });

    expect(applied.items).toHaveLength(1);
    expect(JSON.parse(storage.values.get(MEMORY_ITEMS_STORAGE_KEY))).toHaveLength(1);
    expect(storage.values.get(MEMORY_ACTIVE_STORAGE_KEY)).toBe("mem_working");
    expect(state.values.get("memory.activeId")).toBe("mem_working");

    expect(shouldApplyRuntimeMemorySnapshot({
      savedAt: 2000,
      items: [memoryItem({ updatedAt: 2000 })]
    }, {
      savedAt: 3000,
      items: [memoryItem({ id: "remote", updatedAt: 3000 })]
    })).toBe(true);
    expect(shouldApplyRuntimeMemorySnapshot({
      savedAt: 4000,
      items: [memoryItem({ updatedAt: 4000 })]
    }, {
      savedAt: 3000,
      items: [memoryItem({ id: "remote", updatedAt: 3000 })]
    })).toBe(false);
    expect(shouldApplyRuntimeMemorySnapshot({
      savedAt: 1000,
      items: [memoryItem()]
    }, {
      savedAt: 5000,
      lastChangedAt: 5000,
      items: []
    })).toBe(true);
    expect(shouldApplyRuntimeMemorySnapshot({
      savedAt: 5000,
      items: [memoryItem({ updatedAt: 5000 })]
    }, {
      savedAt: 3000,
      lastChangedAt: 3000,
      items: []
    })).toBe(false);
  });

  it("exposes Runtime memory context and read-only memory tools", async () => {
    const providers = [];
    const tools = [];
    const stateBucket = new Map();
    stateBucket.set("snapshot", {
      settings: {
        autoInjectLayer: "working",
        includePinnedLongTerm: false
      },
      items: [
        memoryItem(),
        memoryItem({
          id: "mem_long",
          title: "Plugin Architecture",
          content: "Runtime plugin entries keep capabilities available after Workbench closes.",
          layer: "long-term",
          path: "long-term/semantic/plugins.md",
          tags: ["plugins"],
          updatedAt: 3000
        }),
        memoryItem({
          id: "mem_disabled",
          title: "Disabled",
          content: "hidden",
          enabled: false,
          updatedAt: 4000
        })
      ]
    });

    activateRuntimePlugin({
      apiVersion: 2,
      plugin: { id: "dev.memory", version: "test" },
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
      { role: "system", content: "system" },
      { role: "user", content: "hello" }
    ])).resolves.toEqual([
      { role: "system", content: "system" },
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("<working_memory>")
      }),
      { role: "user", content: "hello" }
    ]);

    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(toolByName.get("memoryManage")?.policy).toEqual({ minimumPreset: "read-only" });
    expect(toolByName.get("memoryManage")?.inputSchema.properties.action.enum)
      .toEqual([
        "list",
        "tree",
        "read",
        "search",
        "build_context",
        "providers",
        "create",
        "update",
        "delete",
        "select",
        "settings"
      ]);
    expect(toolByName.get("memoryManage")?.inputSchema.properties.action.enum)
      .toContain("delete");

    const result = await toolByName.get("memoryList").invoke({
      query: "Workbench closes",
      enabled_only: true
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      returned: 1,
      items: [{
        id: "mem_long",
        title: "Plugin Architecture"
      }]
    });

    const listed = JSON.parse((await toolByName.get("memoryManage").invoke({
      action: "list",
      layer: "working"
    })).content);
    expect(listed).toEqual([
      expect.objectContaining({ id: "mem_working", title: "Project Rules" })
    ]);

    const read = JSON.parse((await toolByName.get("memoryManage").invoke({
      action: "read",
      id: "mem_long"
    })).content);
    expect(read).toMatchObject({
      id: "mem_long",
      content: expect.stringContaining("Runtime plugin entries")
    });

    const context = JSON.parse((await toolByName.get("memoryManage").invoke({
      action: "build_context",
      query: "runtime",
      max_items: 1
    })).content);
    expect(context.text).toContain("<working_memory>");
    expect(context.items).toHaveLength(1);

    const providerList = JSON.parse((await toolByName.get("memoryManage").invoke({
      action: "providers"
    })).content);
    expect(providerList).toEqual([
      expect.objectContaining({
        id: "local-markdown-files",
        runtimeBacked: true,
        readOnlyInRuntime: false
      })
    ]);

    await expect(toolByName.get("memoryManage").invoke({
      action: "delete",
      id: "mem_working"
    }, {
      policy: { preset: "read-only" }
    })).resolves.toMatchObject({
      ok: false,
      error: "memoryManage action delete requires workspace-write capability"
    });

    const created = JSON.parse((await toolByName.get("memoryManage").invoke({
      action: "create",
      id: "mem_runtime",
      title: "Runtime Note",
      content: "Written by Runtime memoryManage",
      layer: "working",
      tags: ["runtime"]
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(created.created).toMatchObject({
      id: "mem_runtime",
      title: "Runtime Note",
      source: "runtime"
    });
    expect(stateBucket.get("snapshot").activeId).toBe("mem_runtime");

    const updated = JSON.parse((await toolByName.get("memoryManage").invoke({
      action: "update",
      id: "mem_runtime",
      pinned: true,
      content: "Updated from Runtime"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(updated.updated).toMatchObject({
      id: "mem_runtime",
      pinned: true,
      content: "Updated from Runtime"
    });

    const settings = JSON.parse((await toolByName.get("memoryManage").invoke({
      action: "settings",
      maxContextChars: 3200,
      includePinnedLongTerm: true
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(settings.settings).toMatchObject({
      maxContextChars: 3200,
      includePinnedLongTerm: true
    });

    const selected = JSON.parse((await toolByName.get("memoryManage").invoke({
      action: "select",
      id: "mem_working"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(selected.selected).toBe("mem_working");
    expect(stateBucket.get("snapshot").activeId).toBe("mem_working");

    const deleted = JSON.parse((await toolByName.get("memoryManage").invoke({
      action: "delete",
      id: "mem_runtime"
    }, {
      policy: { preset: "workspace-write" }
    })).content);
    expect(deleted.deleted).toBe("mem_runtime");
    expect(stateBucket.get("snapshot").items.some((item) => item.id === "mem_runtime"))
      .toBe(false);
  });
});
