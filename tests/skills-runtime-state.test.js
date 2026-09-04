import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.skills/runtime.js";
import {
  buildAvailableSkillsContextXml,
  normalizeSkillsSnapshot,
  persistSkillsSnapshot,
  selectNewestSkillsSnapshot,
  SKILLS_RUNTIME_KV_KEY,
  syncSkillsSnapshotToRuntime
} from "../extensions/dev.skills/skills-runtime-state.js";

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

describe("Runtime-backed Skills state", () => {
  it("keeps persisted snapshots metadata-only", () => {
    const snapshot = normalizeSkillsSnapshot({
      cacheContent: {
        writer: "x".repeat(100_000)
      },
      pluginMaterialized: [{
        id: "plugin/writer",
        pluginId: "plugin",
        skillName: "writer",
        path: "/skills/writer",
        file: "/skills/writer/SKILL.md",
        files: [
          "/skills/writer/SKILL.md",
          "/skills/writer/scripts/run.js"
        ],
        embeddedFiles: {
          "SKILL.md": "x".repeat(100_000)
        }
      }]
    });

    expect(snapshot.cacheContent).toEqual({});
    expect(snapshot.pluginMaterialized).toEqual([
      expect.objectContaining({
        id: "plugin/writer",
        file: "/skills/writer/SKILL.md",
        files: [
          "/skills/writer/SKILL.md",
          "/skills/writer/scripts/run.js"
        ]
      })
    ]);
    expect(snapshot.pluginMaterialized[0].embeddedFiles).toBeUndefined();
    expect(JSON.stringify(snapshot).length).toBeLessThan(1000);
  });

  it("prefers the newest Workbench or Runtime snapshot", () => {
    expect(selectNewestSkillsSnapshot(
      { savedAt: 20, enabled: ["local"], catalog: [{ id: "local" }] },
      { savedAt: 10, enabled: ["runtime"], catalog: [{ id: "runtime" }] }
    )).toMatchObject({
      source: "local",
      snapshot: { enabled: ["local"] }
    });
    expect(selectNewestSkillsSnapshot(
      { savedAt: 20, enabled: ["local"], catalog: [{ id: "local" }] },
      { savedAt: 30, enabled: ["runtime"], catalog: [{ id: "runtime" }] }
    )).toMatchObject({
      source: "runtime",
      snapshot: { enabled: ["runtime"] }
    });
  });

  it("builds the same available skills XML for Workbench and Runtime", () => {
    const xml = buildAvailableSkillsContextXml({
      enabled: ["writer"],
      catalog: [{
        id: "writer",
        name: "Writer",
        description: "Draft text",
        file: "/skills/writer/SKILL.md"
      }, {
        id: "disabled",
        name: "Disabled"
      }]
    });

    expect(xml).toContain("<available_skills>");
    expect(xml).toContain("<name>Writer</name>");
    expect(xml).toContain("<location>/skills/writer/SKILL.md</location>");
    expect(xml).not.toContain("Disabled");
  });

  it("syncs the Workbench skills snapshot into Runtime workbench-state KV", async () => {
    const state = createState({
      "runtime.mode": "auto",
      "runtime.connection": {
        backend: "runtime",
        baseUrl: "http://runtime.test"
      },
      "skills.paths": ["/skills"],
      "skills.enabled": ["writer"],
      "skills.catalog": [{
        id: "writer",
        name: "Writer",
        file: "/skills/writer/SKILL.md"
      }]
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      expect(String(url)).toBe(
        `http://127.0.0.1:8766/v1/workbench-state/kv/${encodeURIComponent(SKILLS_RUNTIME_KV_KEY)}`
      );
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toMatchObject({
        value: {
          paths: ["/skills"],
          enabled: ["writer"],
          catalog: [{
            id: "writer",
            file: "/skills/writer/SKILL.md"
          }]
        }
      });
      return new Response(JSON.stringify({ ok: true, revision: "runtime:2" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    await expect(syncSkillsSnapshotToRuntime({ state, fetchImpl }))
      .resolves.toMatchObject({ synced: true });
    expect(state.values.get("runtime.skillsSync")).toMatchObject({
      status: "synced",
      enabled: 1,
      total: 1
    });
  });

  it("skips Runtime skills sync when only volatile timestamps changed", async () => {
    const state = createState({
      "runtime.mode": "auto",
      "runtime.connection": {
        backend: "runtime",
        baseUrl: "http://runtime.test"
      }
    });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, revision: "runtime:2" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const first = {
      savedAt: 100,
      lastScan: 100,
      pluginLastSync: 100,
      paths: ["/skills"],
      enabled: ["writer"],
      catalog: [{ id: "writer", name: "Writer" }]
    };
    const second = {
      ...first,
      savedAt: 200,
      lastScan: 200,
      pluginLastSync: 200
    };

    await expect(syncSkillsSnapshotToRuntime({
      snapshot: first,
      state,
      fetchImpl
    })).resolves.toMatchObject({ synced: true });
    await expect(syncSkillsSnapshotToRuntime({
      snapshot: second,
      state,
      fetchImpl
    })).resolves.toMatchObject({ synced: true, skipped: true });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(state.values.get("runtime.skillsSync")).toMatchObject({
      status: "synced",
      skipped: true,
      enabled: 1,
      total: 1
    });
  });

  it("still syncs Runtime when browser storage is over quota", async () => {
    const state = createState({
      "runtime.mode": "auto",
      "runtime.connection": {
        backend: "runtime",
        baseUrl: "http://runtime.test"
      }
    });
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      })
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, revision: "runtime:3" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(persistSkillsSnapshot({
      snapshot: {
        savedAt: 100,
        enabled: ["writer"],
        catalog: [{ id: "writer", name: "Writer" }]
      },
      state,
      storage,
      fetchImpl
    })).resolves.toMatchObject({
      localSaved: false,
      runtimeSynced: true
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(state.values.get("runtime.skillsSync")).toMatchObject({
      status: "synced-runtime-only",
      enabled: 1,
      total: 1
    });
  });

  it("exposes Runtime skills context and a read-only skillsList tool", async () => {
    const providers = [];
    const tools = [];
    const stateBucket = new Map();
    stateBucket.set("snapshot", {
      enabled: ["writer"],
      catalog: [{
        id: "writer",
        name: "Writer",
        description: "Draft text",
        file: "/skills/writer/SKILL.md"
      }]
    });
    activateRuntimePlugin({
      apiVersion: 2,
      plugin: { id: "dev.skills", version: "test" },
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
        content: expect.stringContaining("<name>Writer</name>")
      }),
      { role: "user", content: "hello" }
    ]);
    await expect(tools[0].invoke({ enabled_only: true })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("\"id\": \"writer\"")
    });
  });
});
