import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.skills/runtime.js";
import {
  applySkillsSnapshotToState,
  buildAvailableSkillsContextXml,
  captureSkillsSnapshotEdits,
  disposeSkillsRuntimeState,
  isApplyingSkillsSnapshot,
  loadSkillsSnapshotFromRuntime,
  normalizeSkillsSnapshot,
  persistSkillsSnapshot,
  reconcileSkillsSourceSnapshots,
  selectNewestSkillsSnapshot,
  skillsSnapshotFromState,
  startSkillsSnapshotRefresh,
  syncSkillsSnapshotToRuntime
} from "../extensions/dev.skills/skills-runtime-state.js";

const states = [];

afterEach(() => {
  for (const state of states.splice(0)) disposeSkillsRuntimeState(state);
  vi.useRealTimers();
});

function createState(initial = {}) {
  const values = new Map(Object.entries(initial));
  const state = {
    get: vi.fn((key) => values.get(key)),
    set: vi.fn((key, value) => {
      values.set(key, value);
      return value;
    }),
    values
  };
  states.push(state);
  return state;
}

function snapshotResponse(snapshot) {
  return new Response(JSON.stringify({ ok: true, snapshot }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function createRuntimeState() {
  return createState({
    "runtime.mode": "runtime",
    "runtime.baseUrl": "http://runtime.test"
  });
}

function sourceSnapshot(syncedAt = 10, version = "v1") {
  const source = {
    nodeId: "node:mac",
    syncedAt,
    paths: ["/skills"],
    catalog: ["writer", "reviewer"].map((id) => ({
      id,
      sourceNodeId: "node:mac",
      sourcePath: `/skills/${id}`,
      contentHash: `${id}-${version}`,
      body: `${id} ${version}`
    }))
  };
  return {
    savedAt: syncedAt,
    paths: source.paths,
    enabled: ["writer", "reviewer"],
    catalog: source.catalog,
    sources: [source]
  };
}

function editSnapshot(state, changes) {
  applySkillsSnapshotToState(state, {
    ...skillsSnapshotFromState(state),
    ...changes
  });
  captureSkillsSnapshotEdits({ state, storage: null });
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

  it("preserves offline paths but removes successfully deleted or unconfigured skills", () => {
    const previousSources = [{
      nodeId: "node:mac",
      nodeLabel: "This Mac",
      syncedAt: 10,
      paths: ["/skills"],
      catalog: [{
        id: "writer",
        sourcePath: "/skills/writer",
        source: "user"
      }, {
        id: "plugin/helper",
        sourcePath: "/skills/.plugins/helper",
        source: "plugin"
      }]
    }];

    expect(reconcileSkillsSourceSnapshots({
      previousSources,
      configuredSources: [{
        path: "/skills",
        nodeId: "node:mac"
      }],
      now: 20
    })[0]).toMatchObject({
      syncedAt: 10,
      catalog: [{ id: "writer" }, { id: "plugin/helper" }]
    });

    expect(reconcileSkillsSourceSnapshots({
      previousSources,
      configuredSources: [],
      pluginCatalogReady: false,
      now: 20
    })[0]).toMatchObject({
      syncedAt: 20,
      catalog: [{ id: "plugin/helper" }]
    });

    expect(reconcileSkillsSourceSnapshots({
      previousSources,
      scannedSources: [{
        nodeId: "node:mac",
        syncedAt: 20,
        paths: ["/skills"],
        catalog: []
      }],
      configuredSources: [{
        path: "/skills",
        nodeId: "node:mac"
      }],
      successfulPaths: ["node:mac\0/skills"],
      pluginCatalogReady: true,
      now: 20
    })[0]).toMatchObject({
      syncedAt: 20,
      catalog: []
    });
  });

  it("keeps Runtime catalog and enabled Skills authoritative while preserving local UI settings", () => {
    expect(selectNewestSkillsSnapshot(
      { savedAt: 20, enabled: ["local"], catalog: [{ id: "local" }] },
      { savedAt: 10, enabled: ["runtime"], catalog: [{ id: "runtime" }] }
    )).toMatchObject({
      source: "runtime",
      snapshot: {
        enabled: ["runtime"],
        catalog: [{ id: "runtime" }]
      }
    });
    expect(selectNewestSkillsSnapshot(
      {
        savedAt: 20,
        enabled: [],
        catalog: [{ id: "local" }],
        paths: ["/local-only"]
      },
      {
        savedAt: 10,
        enabled: ["runtime"],
        catalog: [{ id: "runtime" }],
        sources: [{
          nodeId: "node:mac",
          catalog: [{ id: "runtime" }]
        }]
      }
    )).toMatchObject({
      source: "runtime",
      snapshot: {
        enabled: ["runtime"],
        paths: ["/local-only"],
        catalog: [{ id: "runtime" }]
      }
    });
    expect(selectNewestSkillsSnapshot(
      { savedAt: 20, enabled: ["local"], catalog: [{ id: "local" }] },
      { savedAt: 30, enabled: ["runtime"], catalog: [{ id: "runtime" }] }
    )).toMatchObject({
      source: "runtime",
      snapshot: { enabled: ["runtime"] }
    });
    expect(selectNewestSkillsSnapshot(
      {
        savedAt: 20,
        enabled: ["writer"],
        catalog: [{
          id: "writer",
          body: "unsynced",
          contentHash: "writer-v2"
        }]
      },
      {
        savedAt: 10,
        enabled: ["writer"],
        catalog: [{
          id: "writer",
          body: "synced",
          contentHash: "writer-v1"
        }],
        sources: [{
          nodeId: "node:mac",
          syncedAt: 10,
          catalog: [{
            id: "writer",
            body: "synced",
            contentHash: "writer-v1"
          }]
        }]
      }
    )).toMatchObject({
      source: "runtime",
      snapshot: {
        catalog: [{
          id: "writer",
          body: "synced",
          contentHash: "writer-v1"
        }]
      }
    });
  });

  it("does not infer transient content from newer browser timestamps or cached bodies", () => {
    const runtime = sourceSnapshot();
    const local = {
      ...runtime,
      savedAt: 200,
      catalog: runtime.catalog.map((skill) => ({
        ...skill,
        body: "stale browser body",
        contentHash: "stale-cache"
      }))
    };

    const selected = selectNewestSkillsSnapshot(local, runtime).snapshot;

    expect(selected.catalog.map(({ id, body, contentHash }) => ({
      id, body, contentHash
    }))).toEqual(runtime.catalog.map(({ id, body, contentHash }) => ({
      id, body, contentHash
    })));
    expect(selected.catalog.every((skill) => !skill.transient)).toBe(true);

    local.catalog[0].transient = true;
    expect(selectNewestSkillsSnapshot(local, runtime).snapshot.catalog[0])
      .toMatchObject({
        id: "writer",
        body: "stale browser body",
        contentHash: "stale-cache",
        transient: true
      });
  });

  it("builds the same available skills XML for Workbench and Runtime", () => {
    const xml = buildAvailableSkillsContextXml({
      enabled: ["writer"],
      catalog: [{
        id: "writer",
        name: "Writer",
        description: "Draft text",
        file: "/skills/writer/SKILL.md",
        sourceNodeId: "node:mac"
      }, {
        id: "disabled",
        name: "Disabled"
      }]
    });

    expect(xml).toContain("<available_skills>");
    expect(xml).toContain("<name>Writer</name>");
    expect(xml).toContain(
      '<location node_id="node:mac">/skills/writer/SKILL.md</location>'
    );
    expect(xml).not.toContain("Disabled");
  });

  it("syncs a source-aware Workbench snapshot into the Runtime Skills API", async () => {
    const state = createState({
      "runtime.mode": "auto",
      "runtime.connection": {
        backend: "runtime",
        baseUrl: "http://runtime.test"
      },
      "skills.paths": ["/skills"],
      "skills.pathSources": [{
        path: "/skills",
        nodeId: "node:mac",
        nodeLabel: "This Mac"
      }],
      "skills.enabled": ["writer"],
      "skills.catalog": [{
        id: "writer",
        name: "Writer",
        file: "/skills/writer/SKILL.md",
        sourceNodeId: "node:mac",
        contentHash: "writer-v1",
        body: "# Writer"
      }],
      "skills.sources": [{
        nodeId: "node:mac",
        nodeLabel: "This Mac",
        syncedAt: 20,
        paths: ["/skills"],
        catalog: [{
          id: "writer",
          name: "Writer",
          file: "/skills/writer/SKILL.md",
          sourceNodeId: "node:mac",
          contentHash: "writer-v1",
          body: "# Writer"
        }]
      }]
    });
    const scannedSources = state.get("skills.sources");
    captureSkillsSnapshotEdits({ state, scannedSources });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (init.method === "GET") {
        expect(String(url)).toBe("http://127.0.0.1:8766/v1/skills/snapshot");
        return snapshotResponse({ enabled: [], catalog: [], sources: [] });
      }
      expect(String(url)).toBe("http://127.0.0.1:8766/v1/skills/sync");
      expect(init.method).toBe("POST");
      const payload = JSON.parse(init.body);
      expect(Object.keys(payload.snapshot)).toEqual(["sources"]);
      expect(payload).toMatchObject({
        snapshot: {
          sources: [{
            nodeId: "node:mac",
            catalog: [{
              id: "writer",
              contentHash: "writer-v1",
              body: "# Writer"
            }]
          }]
        }
      });
      return snapshotResponse({
        ...payload.snapshot,
        enabled: ["writer"],
        catalog: payload.snapshot.sources[0].catalog
      });
    });

    await expect(syncSkillsSnapshotToRuntime({ state, fetchImpl }))
      .resolves.toMatchObject({ synced: false, reason: "runtime-unacknowledged" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await loadSkillsSnapshotFromRuntime({ state, fetchImpl });
    await expect(syncSkillsSnapshotToRuntime({ state, fetchImpl }))
      .resolves.toMatchObject({ synced: true });
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "POST"]);
    expect(state.values.get("runtime.skillsSync")).toMatchObject({
      status: "synced",
      enabled: 1,
      total: 1,
      hashes: { writer: "writer-v1" }
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
    const first = {
      savedAt: 100,
      lastScan: 100,
      pluginLastSync: 100,
      paths: ["/skills"],
      enabled: ["writer"],
      catalog: [{ id: "writer", name: "Writer", sourceNodeId: "node:mac" }],
      sources: [{
        nodeId: "node:mac",
        syncedAt: 100,
        paths: ["/skills"],
        catalog: [{
          id: "writer",
          name: "Writer",
          sourceNodeId: "node:mac",
          syncedAt: 100
        }]
      }]
    };
    const second = {
      ...first,
      savedAt: 200,
      lastScan: 200,
      pluginLastSync: 200
    };
    const fetchImpl = vi.fn(async () => snapshotResponse(first));

    await loadSkillsSnapshotFromRuntime({ state, fetchImpl });
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
    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
    expect(state.values.get("runtime.skillsSync")).toMatchObject({
      status: "synced",
      enabled: 1,
      total: 1
    });
  });

  it("patches Runtime enabled Skills when the source snapshot is unchanged", async () => {
    const state = createState({
      "runtime.mode": "auto",
      "runtime.connection": {
        backend: "runtime",
        baseUrl: "http://runtime.test"
      }
    });
    const source = {
      nodeId: "node:mac",
      syncedAt: 100,
      paths: ["/skills"],
      catalog: [{
        id: "writer",
        name: "Writer",
        sourceNodeId: "node:mac",
        contentHash: "writer-v1"
      }]
    };
    const first = {
      savedAt: 100,
      paths: ["/skills"],
      enabled: ["writer"],
      catalog: source.catalog,
      sources: [source]
    };
    const fetchImpl = vi.fn(async (url, init = {}) => {
      expect(String(url)).toBe("http://127.0.0.1:8766/v1/skills/snapshot");
      if (init.method === "GET") return snapshotResponse(first);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({
        updates: [{ id: "writer", enabled: false }]
      });
      return new Response(JSON.stringify({
        ok: true,
        snapshot: {
          ...first,
          enabled: []
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    await loadSkillsSnapshotFromRuntime({ state, fetchImpl });
    await expect(syncSkillsSnapshotToRuntime({
      snapshot: first,
      state,
      fetchImpl
    })).resolves.toMatchObject({ synced: true });
    await expect(syncSkillsSnapshotToRuntime({
      snapshot: {
        ...first,
        savedAt: 200,
        enabled: []
      },
      state,
      fetchImpl
    })).resolves.toMatchObject({ synced: true, patched: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "PATCH"]);
    expect(state.values.get("runtime.skillsSync")).toMatchObject({
      status: "synced",
      enabled: 0,
      total: 1
    });
  });

  it("does not write an empty snapshot without Runtime acknowledgement", async () => {
    const state = createState({
      "runtime.mode": "auto",
      "runtime.connection": {
        backend: "runtime",
        baseUrl: "http://runtime.test"
      }
    });
    const fetchImpl = vi.fn();

    await expect(syncSkillsSnapshotToRuntime({
      snapshot: {
        savedAt: 100,
        enabled: [],
        catalog: [],
        sources: []
      },
      state,
      fetchImpl
    })).resolves.toMatchObject({
      synced: false,
      reason: "runtime-unacknowledged"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.values.get("runtime.skillsSync")).toMatchObject({
      status: "pending",
      reason: "runtime-unacknowledged"
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
    const snapshot = {
      savedAt: 100,
      enabled: ["writer"],
      catalog: [{
        id: "writer",
        name: "Writer",
        sourceNodeId: "node:mac"
      }]
    };
    snapshot.sources = [{
      nodeId: "node:mac",
      syncedAt: 100,
      catalog: snapshot.catalog
    }];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(snapshotResponse({ enabled: [], catalog: [], sources: [] }))
      .mockResolvedValueOnce(snapshotResponse(snapshot));

    await loadSkillsSnapshotFromRuntime({ state, storage, fetchImpl });
    await expect(persistSkillsSnapshot({
      snapshot,
      state,
      storage,
      fetchImpl
    })).resolves.toMatchObject({
      localSaved: false,
      runtimeSynced: true
    });
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "POST"]);
    expect(state.values.get("runtime.skillsSync")).toMatchObject({
      status: "synced-runtime-only",
      enabled: 1,
      total: 1
    });
  });

  it("does not acknowledge local apply and accepts an empty Runtime without replaying cached selection", async () => {
    const state = createRuntimeState();
    applySkillsSnapshotToState(state, {
      ...sourceSnapshot(),
      config: { maxActiveSkills: 7 },
      tokenBudget: 12345,
      usageHistory: { writer: [1] },
      paths: ["/client/preference"]
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(snapshotResponse({
      enabled: [], catalog: [], sources: []
    }));

    await expect(syncSkillsSnapshotToRuntime({ state, storage: null, fetchImpl }))
      .resolves.toMatchObject({ synced: false, reason: "runtime-unacknowledged" });
    expect(fetchImpl).not.toHaveBeenCalled();

    await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    expect(skillsSnapshotFromState(state)).toMatchObject({
      enabled: [],
      catalog: [],
      sources: [],
      config: { maxActiveSkills: 7 },
      tokenBudget: 12345,
      usageHistory: { writer: [1] },
      paths: ["/client/preference"]
    });
    await expect(syncSkillsSnapshotToRuntime({ state, storage: null, fetchImpl }))
      .resolves.toMatchObject({ synced: true, skipped: true });
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET"]);
  });

  it.each([
    { name: "failed HTTP response", status: 503, body: { error: "offline" } },
    { name: "rejected snapshot", status: 200, body: { ok: false, snapshot: {} } },
    { name: "missing canonical snapshot", status: 200, body: { ok: true, revision: "2" } }
  ])("does not acknowledge a $name", async ({ status, body }) => {
    const state = createRuntimeState();
    applySkillsSnapshotToState(state, sourceSnapshot());
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    }));

    await expect(loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl }))
      .rejects.toThrow();
    expect(state.get("skills.enabled")).toEqual(["writer", "reviewer"]);
    expect(state.get("skills.catalog")).toHaveLength(2);
    await expect(syncSkillsSnapshotToRuntime({ state, storage: null, fetchImpl }))
      .resolves.toMatchObject({ synced: false, reason: "runtime-unacknowledged" });
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET"]);
  });

  it("publishes simultaneous source and enabled edits as independent operations", async () => {
    const state = createRuntimeState();
    const updated = sourceSnapshot(20, "v2");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(snapshotResponse(sourceSnapshot()))
      .mockResolvedValueOnce(snapshotResponse(updated))
      .mockResolvedValueOnce(snapshotResponse({ ...updated, enabled: ["reviewer"] }));
    await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });

    editSnapshot(state, { ...updated, enabled: ["reviewer"] });
    await expect(persistSkillsSnapshot({ state, storage: null, fetchImpl }))
      .resolves.toMatchObject({
        runtimeSynced: true,
        snapshot: { enabled: ["reviewer"] }
      });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ["http://runtime.test/v1/skills/snapshot", "GET"],
      ["http://runtime.test/v1/skills/sync", "POST"],
      ["http://runtime.test/v1/skills/snapshot", "PATCH"]
    ]);
    const sourcePayload = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(Object.keys(sourcePayload)).toEqual(["snapshot"]);
    expect(Object.keys(sourcePayload.snapshot)).toEqual(["sources"]);
    expect(sourcePayload.snapshot.sources).toMatchObject(updated.sources);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({
      updates: [{ id: "writer", enabled: false }]
    });
    expect(state.get("skills.catalog").map((skill) => skill.contentHash).sort())
      .toEqual(["reviewer-v2", "writer-v2"]);
  });

  it("keeps a newly scanned skill disabled when its source POST acknowledgement arrives late", async () => {
    const state = createRuntimeState();
    const baseline = sourceSnapshot();
    baseline.enabled = ["writer"];
    baseline.catalog = baseline.catalog.filter((skill) => skill.id === "writer");
    baseline.sources[0].catalog = baseline.catalog;
    const scannedCatalog = [
      ...baseline.catalog,
      {
        id: "new-skill",
        sourceNodeId: "node:mac",
        sourcePath: "/skills/new-skill",
        contentHash: "new-skill-v1",
        body: "new skill"
      }
    ];
    const scanned = {
      ...baseline,
      enabled: ["writer", "new-skill"],
      catalog: scannedCatalog,
      sources: [{
        ...baseline.sources[0], syncedAt: 20, catalog: scannedCatalog
      }]
    };
    let canonical = baseline;
    let releasePost;
    let enterPost;
    const heldPost = new Promise((resolve) => { releasePost = resolve; });
    const postStarted = new Promise((resolve) => { enterPost = resolve; });
    const fetchImpl = vi.fn(async (url, init) => {
      if (init.method === "POST") {
        expect(String(url)).toBe("http://runtime.test/v1/skills/sync");
        const body = JSON.parse(init.body);
        expect(Object.keys(body.snapshot)).toEqual(["sources"]);
        expect(body.snapshot.sources).toMatchObject(scanned.sources);
        canonical = scanned;
        enterPost();
        await heldPost;
        return snapshotResponse(scanned);
      }
      expect(String(url)).toBe("http://runtime.test/v1/skills/snapshot");
      if (init.method === "PATCH") {
        expect(JSON.parse(init.body)).toEqual({
          updates: [{ id: "new-skill", enabled: false }]
        });
        canonical = { ...canonical, enabled: ["writer"] };
      } else {
        expect(init.method).toBe("GET");
      }
      return snapshotResponse(canonical);
    });
    await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    applySkillsSnapshotToState(state, scanned);
    captureSkillsSnapshotEdits({ state, storage: null, scannedSources: scanned.sources });
    const flush = syncSkillsSnapshotToRuntime({ state, storage: null, fetchImpl });
    try {
      await postStarted;
      editSnapshot(state, { enabled: ["writer"] });
      expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "POST"]);

      releasePost();
      await expect(flush).resolves.toMatchObject({ synced: true });
      expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "POST", "PATCH"]);
      expect(state.get("skills.enabled")).toEqual(["writer"]);
      await expect(loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl }))
        .resolves.toMatchObject({
          enabled: ["writer"],
          catalog: expect.arrayContaining([expect.objectContaining({ id: "new-skill" })])
        });
      expect(state.get("skills.enabled")).toEqual(["writer"]);
      expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "POST", "PATCH", "GET"]);
    } finally {
      releasePost();
      await flush;
    }
  });

  it.each(["POST", "PATCH"])(
    "retains only unacknowledged intent after a failed %s while keeping transient content",
    async (failedMethod) => {
      const state = createRuntimeState();
      const baseline = sourceSnapshot();
      const updated = sourceSnapshot(20, "v2");
      const selected = { ...updated, enabled: ["reviewer"] };
      const failure = new Error(`${failedMethod} unavailable`);
      const fetchImpl = vi.fn().mockResolvedValueOnce(snapshotResponse(baseline));
      if (failedMethod === "POST") {
        fetchImpl.mockRejectedValueOnce(failure)
          .mockResolvedValueOnce(snapshotResponse({ ...baseline, enabled: ["reviewer"] }));
      } else {
        fetchImpl.mockResolvedValueOnce(snapshotResponse(updated))
          .mockRejectedValueOnce(failure);
      }
      fetchImpl.mockResolvedValueOnce(snapshotResponse(selected));
      await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
      editSnapshot(state, {
        ...selected,
        catalog: updated.catalog.map((skill) => skill.id === "writer"
          ? { ...skill, body: "local draft", contentHash: "draft", transient: true }
          : skill)
      });

      await expect(persistSkillsSnapshot({ state, storage: null, fetchImpl }))
        .rejects.toThrow(failure);
      expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "POST", "PATCH"]);
      expect(state.get("runtime.skillsSync")).toMatchObject({
        status: "error",
        pending: ["writer"],
        pendingEnabled: failedMethod === "PATCH" ? ["writer"] : [],
        pendingSources: failedMethod === "POST" ? ["node:mac"] : []
      });
      expect(state.get("skills.enabled")).toEqual(["reviewer"]);

      await expect(persistSkillsSnapshot({ state, storage: null, fetchImpl }))
        .resolves.toMatchObject({ runtimeSynced: false });
      expect(fetchImpl.mock.calls.map(([, init]) => init.method))
        .toEqual(["GET", "POST", "PATCH", failedMethod]);
      expect(state.get("runtime.skillsSync")).toMatchObject({
        status: "pending", pending: ["writer"], pendingEnabled: [], pendingSources: []
      });
      expect(state.get("skills.catalog").find((skill) => skill.id === "writer"))
        .toMatchObject({ body: "local draft", contentHash: "draft", transient: true });
      expect(state.get("skills.catalog").find((skill) => skill.id === "reviewer").transient)
        .toBeFalsy();

      const published = sourceSnapshot(30, "v2");
      published.enabled = ["reviewer"];
      published.catalog[0] = {
        ...published.catalog[0], body: "local draft", contentHash: "draft"
      };
      published.sources[0].catalog = published.catalog;
      fetchImpl.mockResolvedValueOnce(snapshotResponse(published));
      editSnapshot(state, published);
      await expect(persistSkillsSnapshot({ state, storage: null, fetchImpl }))
        .resolves.toMatchObject({ runtimeSynced: true });
      expect(state.get("runtime.skillsSync")).toMatchObject({
        status: "synced", pending: [], pendingEnabled: [], pendingSources: []
      });
      expect(state.get("skills.catalog").find((skill) => skill.id === "writer"))
        .toMatchObject({ body: "local draft", contentHash: "draft" });
      expect(state.get("skills.catalog").every((skill) => !skill.transient)).toBe(true);
      expect(fetchImpl.mock.calls.map(([, init]) => init.method))
        .toEqual(["GET", "POST", "PATCH", failedMethod, "POST"]);
      for (const [, init] of fetchImpl.mock.calls.filter(([, init]) => init.method === "PATCH")) {
        expect(JSON.parse(init.body)).toEqual({
          updates: [{ id: "writer", enabled: false }]
        });
      }
    }
  );

  it("does not let a transient source block an unrelated enabled delta", async () => {
    const state = createRuntimeState();
    const baseline = sourceSnapshot();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(snapshotResponse(baseline))
      .mockResolvedValueOnce(snapshotResponse({ ...baseline, enabled: ["writer"] }));
    await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    const edited = sourceSnapshot(20, "draft");
    edited.catalog[0].transient = true;
    editSnapshot(state, { ...edited, enabled: ["writer"] });

    await expect(persistSkillsSnapshot({ state, storage: null, fetchImpl }))
      .resolves.toMatchObject({ runtimeSynced: false });

    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "PATCH"]);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      updates: [{ id: "reviewer", enabled: false }]
    });
    expect(state.get("skills.enabled")).toEqual(["writer"]);
    expect(state.get("runtime.skillsSync")).toMatchObject({
      pendingEnabled: [], pendingSources: ["node:mac"], pending: ["writer"]
    });
  });

  it("applies canonical reads without local writeback and preserves only actual local edits", async () => {
    const state = createRuntimeState();
    const localWriteback = vi.fn();
    state.set.mockImplementation((key, value) => {
      state.values.set(key, value);
      if (key.startsWith("skills.") && !isApplyingSkillsSnapshot(state)) {
        captureSkillsSnapshotEdits({ state, storage: null });
        localWriteback();
      }
      return value;
    });
    const remote = sourceSnapshot(20, "v2");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(snapshotResponse(sourceSnapshot()))
      .mockResolvedValueOnce(snapshotResponse(remote))
      .mockResolvedValueOnce(snapshotResponse(remote));

    await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    expect(localWriteback).not.toHaveBeenCalled();
    expect(isApplyingSkillsSnapshot(state)).toBe(false);
    expect(state.get("skills.catalog").every((skill) => !skill.transient)).toBe(true);
    expect(state.get("skills.catalog").find((skill) => skill.id === "writer"))
      .toMatchObject({ body: "writer v2", contentHash: "writer-v2" });
    await expect(syncSkillsSnapshotToRuntime({ state, storage: null, fetchImpl }))
      .resolves.toMatchObject({ synced: true, skipped: true });

    state.set("skills.catalog", state.get("skills.catalog").map((skill) =>
      skill.id === "writer"
        ? { ...skill, body: "actual local edit", contentHash: "local" }
        : skill
    ));
    expect(localWriteback).toHaveBeenCalledOnce();
    await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    expect(localWriteback).toHaveBeenCalledOnce();
    expect(state.get("skills.catalog").find((skill) => skill.id === "writer"))
      .toMatchObject({ body: "actual local edit", contentHash: "local", transient: true });
    expect(state.get("skills.catalog").find((skill) => skill.id === "reviewer").transient)
      .toBeFalsy();
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "GET", "GET"]);
  });

  it("coalesces reads and keeps a captured enabled edit through an older GET", async () => {
    const state = createRuntimeState();
    const baseline = sourceSnapshot();
    let releaseRead;
    const heldRead = new Promise((resolve) => { releaseRead = resolve; });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(snapshotResponse(baseline))
      .mockReturnValueOnce(heldRead)
      .mockResolvedValueOnce(snapshotResponse({ ...baseline, enabled: ["reviewer"] }));
    await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    const firstRead = loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    const secondRead = loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    expect(firstRead).toBe(secondRead);
    await Promise.resolve();
    editSnapshot(state, { enabled: ["reviewer"] });
    const write = syncSkillsSnapshotToRuntime({ state, storage: null, fetchImpl });
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "GET"]);

    releaseRead(snapshotResponse(baseline));
    await Promise.all([firstRead, secondRead, write]);

    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({
      updates: [{ id: "writer", enabled: false }]
    });
    expect(state.get("skills.enabled")).toEqual(["reviewer"]);
  });

  it("aborts disposed reads and ignores late replies without retaining acknowledgement", async () => {
    const state = createRuntimeState();
    let releaseRead;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(snapshotResponse(sourceSnapshot()))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
    await loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    const read = loadSkillsSnapshotFromRuntime({ state, storage: null, fetchImpl });
    await Promise.resolve();
    const signal = fetchImpl.mock.calls[1][1].signal;
    const snapshot = skillsSnapshotFromState(state);

    disposeSkillsRuntimeState(state);
    expect(signal.aborted).toBe(true);
    releaseRead(snapshotResponse({ enabled: [], catalog: [], sources: [] }));
    await expect(read).resolves.toBeNull();
    expect(state.get("skills.enabled")).toEqual(snapshot.enabled);
    expect(state.get("skills.catalog")).toEqual(snapshot.catalog);
    await expect(syncSkillsSnapshotToRuntime({ state, storage: null, fetchImpl }))
      .resolves.toMatchObject({ synced: false, reason: "runtime-unacknowledged" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { active: true, interval: 3000 },
    { active: false, interval: 5000 }
  ])("refreshes foreground at $interval ms, pauses hidden, and disposes in-flight scheduling", async ({ active, interval }) => {
    vi.useFakeTimers();
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), { hidden: false });
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    let releaseRefresh;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const refresher = startSkillsSnapshotRefresh({
      window, document, refresh, isActive: () => active
    });
    try {
      await vi.advanceTimersByTimeAsync(interval - 1);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledOnce();

      document.hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(refresh).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);

      refresh.mockImplementationOnce(() => new Promise((resolve) => { releaseRefresh = resolve; }));
      document.hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      const pending = refresher.refresh();
      await Promise.resolve();
      expect(refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(interval * 2);
      expect(refresh).toHaveBeenCalledTimes(2);

      refresher.dispose();
      releaseRefresh();
      await pending;
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await refresher.refresh();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(removeWindowListener.mock.calls.map(([event]) => event)).toEqual(["focus", "online"]);
      expect(removeDocumentListener.mock.calls.map(([event]) => event)).toEqual(["visibilitychange"]);
    } finally {
      refresher.dispose();
      releaseRefresh?.();
    }
  });

  it("backs off failed foreground refreshes and resets after a successful read", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const refresher = startSkillsSnapshotRefresh({
      window: new EventTarget(),
      document: Object.assign(new EventTarget(), { hidden: false }),
      refresh
    });
    try {
      let calls = 0;
      for (const interval of [5000, 10_000, 20_000, 30_000, 5000]) {
        await vi.advanceTimersByTimeAsync(interval - 1);
        expect(refresh).toHaveBeenCalledTimes(calls);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(++calls);
      }
    } finally {
      refresher.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
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
        sourceNodeId: "node:mac",
        sourceFile: "/skills/writer/SKILL.md",
        runtimeCached: true,
        runtimeNodeId: "node:cloud",
        runtimeFile: "/runtime/skills/writer/SKILL.md",
        body: "# Writer\n\nDraft clearly."
      }, {
        id: "reviewer",
        name: "Reviewer",
        description: "Review text",
        file: "/skills/reviewer/SKILL.md"
      }]
    });
    activateRuntimePlugin({
      apiVersion: 2,
      plugin: { id: "dev.skills", version: "test" },
      config: {
        availableNodes: () => [{
          nodeId: "node:mac",
          status: "offline"
        }]
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
        content: expect.stringContaining(
          '<source node_id="node:mac" status="offline">'
        )
      }),
      { role: "user", content: "hello" }
    ]);
    expect((await providers[0].contribute([
      { role: "user", content: "hello" }
    ]))[0].content).toContain(
      "do not assume that source-local files, commands, credentials"
    );
    const sessionMessages = await providers[0].contribute(
      [{ role: "user", content: "hello" }],
      {
        request: {
          metadata: {
            skills: {
              enabled: ["reviewer"]
            }
          }
        }
      }
    );
    expect(sessionMessages[0].content).toContain("<name>Reviewer</name>");
    expect(sessionMessages[0].content).not.toContain("<name>Writer</name>");
    const transientMessages = await providers[0].contribute(
      [{ role: "user", content: "hello" }],
      {
        request: {
          metadata: {
            skills: {
              enabled: ["writer"],
              transientCatalog: [{
                id: "writer",
                name: "Writer",
                body: "# Writer\n\nUnsynced local instructions.",
                sourceNodeId: "node:mac"
              }]
            }
          }
        }
      }
    );
    expect(transientMessages[0].content).toContain(
      "<instructions># Writer\n\nUnsynced local instructions.</instructions>"
    );
    expect(transientMessages[0].content).not.toContain("Draft clearly.");
    await expect(providers[0].contribute(
      [{ role: "user", content: "hello" }],
      {
        request: {
          metadata: {
            skills: {
              enabled: []
            }
          }
        }
      }
    )).resolves.toEqual([{ role: "user", content: "hello" }]);
    await expect(tools[0].invoke({ enabled_only: true })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("\"id\": \"writer\"")
    });
    const detail = await tools[0].invoke({
      name: "writer",
      include_body: true
    });
    expect(detail.ok).toBe(true);
    expect(detail.content).toContain("# Writer");
    expect(detail.content).toContain("source Node is offline");
  });
});
