import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSkillsCatalogHttpHandler
} from "../src/skills-catalog-http-handler.mjs";
import {
  SKILLS_RUNTIME_KV_KEY,
  SKILLS_RUNTIME_SOURCES_KV_KEY
} from "../../../extensions/dev.skills/skills-runtime-shared.js";

const servers = [];

function memoryStore() {
  const values = new Map();
  return {
    values,
    readKV(key) {
      return values.has(key) ? { key, value: values.get(key) } : null;
    },
    writeKV(key, value) {
      values.set(key, value);
      return { ok: true, key };
    }
  };
}

async function start(handler) {
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
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("Runtime Skills catalog HTTP handler", () => {
  it("merges per-Node snapshots and keeps one newest skill per id", async () => {
    const store = memoryStore();
    const baseUrl = await start(createSkillsCatalogHttpHandler({
      store,
      availableNodes: () => [
        { nodeId: "node:mac", status: "offline" },
        { nodeId: "node:cloud", status: "online" }
      ]
    }));

    for (const snapshot of [{
      savedAt: 10,
      enabled: ["lark-doc"],
      sources: [{
        nodeId: "node:cloud",
        nodeLabel: "Cloud",
        syncedAt: 10,
        paths: ["/home/zion/.zion-next/skills"],
        catalog: [{
          id: "lark-doc",
          name: "Lark Doc",
          body: "old cloud instructions",
          contentHash: "old"
        }]
      }]
    }, {
      savedAt: 20,
      enabled: ["lark-doc"],
      sources: [{
        nodeId: "node:mac",
        nodeLabel: "This Mac",
        syncedAt: 20,
        paths: ["/Users/me/.zion-next/skills"],
        catalog: [{
          id: "lark-doc",
          name: "Lark Doc",
          body: "new local instructions",
          contentHash: "new",
          runtimeCached: true,
          runtimeNodeId: "node:cloud",
          runtimeFile: "/srv/zion-plugin-data/plugins/dev.skills/cache/lark-doc/new/SKILL.md"
        }]
      }]
    }]) {
      const response = await fetch(`${baseUrl}/v1/skills/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshot })
      });
      expect(response.status).toBe(200);
    }

    const response = await fetch(`${baseUrl}/v1/skills/snapshot`);
    const body = await response.json();
    expect(body.snapshot.catalog).toHaveLength(1);
    expect(body.snapshot.catalog[0]).toMatchObject({
      id: "lark-doc",
      body: "new local instructions",
      sourceNodeId: "node:mac",
      sourceStatus: "offline",
      runtimeCached: true
    });
    expect(body.snapshot.catalog[0].sourceVariants).toHaveLength(2);
    expect(body.snapshot.sources).toHaveLength(2);
    expect(store.values.has(SKILLS_RUNTIME_KV_KEY)).toBe(true);
    expect(store.values.has(SKILLS_RUNTIME_SOURCES_KV_KEY)).toBe(true);
  });

  it("updates global enabled Skills without replacing source snapshots", async () => {
    const store = memoryStore();
    const baseUrl = await start(createSkillsCatalogHttpHandler({ store }));
    await fetch(`${baseUrl}/v1/skills/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot: {
          enabled: ["writer"],
          sources: [{
            nodeId: "node:mac",
            catalog: [{
              id: "writer",
              body: "Write clearly.",
              contentHash: "writer-v1"
            }]
          }]
        }
      })
    });

    const response = await fetch(`${baseUrl}/v1/skills/snapshot`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: [] })
    });
    const body = await response.json();

    expect(body.snapshot.enabled).toEqual([]);
    expect(body.snapshot.catalog[0]).toMatchObject({
      id: "writer",
      body: "Write clearly."
    });
    expect(body.snapshot.sources).toHaveLength(1);
  });

  it("treats empty sync payloads as a no-op and preserves source snapshots", async () => {
    const store = memoryStore();
    const baseUrl = await start(createSkillsCatalogHttpHandler({ store }));
    await fetch(`${baseUrl}/v1/skills/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot: {
          enabled: ["writer"],
          sources: [{
            nodeId: "node:mac",
            syncedAt: 20,
            catalog: [{
              id: "writer",
              body: "Write clearly.",
              contentHash: "writer-v1"
            }]
          }]
        }
      })
    });

    const response = await fetch(`${baseUrl}/v1/skills/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot: {
          savedAt: 30,
          enabled: [],
          catalog: [],
          sources: []
        }
      })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.snapshot.sources).toHaveLength(1);
    expect(body.snapshot.catalog[0]).toMatchObject({
      id: "writer",
      body: "Write clearly."
    });
    expect(body.snapshot.enabled).toEqual(["writer"]);
  });

  it("does not let source sync overwrite existing enabled Skills", async () => {
    const store = memoryStore();
    const baseUrl = await start(createSkillsCatalogHttpHandler({ store }));
    await fetch(`${baseUrl}/v1/skills/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot: {
          savedAt: 20,
          enabled: ["writer"],
          sources: [{
            nodeId: "node:mac",
            syncedAt: 20,
            catalog: [{
              id: "writer",
              body: "Write clearly.",
              contentHash: "writer-v1"
            }]
          }]
        }
      })
    });

    const response = await fetch(`${baseUrl}/v1/skills/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot: {
          savedAt: 30,
          enabled: [],
          sources: [{
            nodeId: "node:mac",
            syncedAt: 30,
            catalog: [{
              id: "writer",
              body: "Write clearly.",
              contentHash: "writer-v1"
            }]
          }]
        }
      })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.snapshot.enabled).toEqual(["writer"]);
  });

  it("reports the synthetic single-host Runtime source as online", async () => {
    const store = memoryStore();
    const baseUrl = await start(createSkillsCatalogHttpHandler({
      store,
      localSourceAvailable: true
    }));
    await fetch(`${baseUrl}/v1/skills/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot: {
          enabled: ["writer"],
          sources: [{
            nodeId: "runtime:local",
            catalog: [{
              id: "writer",
              body: "Write clearly.",
              contentHash: "writer-v1"
            }]
          }]
        }
      })
    });

    const response = await fetch(`${baseUrl}/v1/skills/snapshot`);
    const body = await response.json();
    expect(body.snapshot.sources[0]).toMatchObject({
      nodeId: "runtime:local",
      status: "online"
    });
    expect(body.snapshot.catalog[0]).toMatchObject({
      id: "writer",
      sourceStatus: "online"
    });
  });

  it("does not let a stale client overwrite a newer source snapshot", async () => {
    const store = memoryStore();
    const baseUrl = await start(createSkillsCatalogHttpHandler({ store }));
    for (const input of [{
      savedAt: 20,
      enabled: ["writer"],
      source: {
        nodeId: "node:mac",
        syncedAt: 20,
        catalog: [{
          id: "writer",
          body: "new instructions",
          contentHash: "writer-v2"
        }]
      }
    }, {
      savedAt: 10,
      enabled: [],
      source: {
        nodeId: "node:mac",
        syncedAt: 10,
        catalog: [{
          id: "writer",
          body: "stale instructions",
          contentHash: "writer-v1"
        }]
      }
    }]) {
      const response = await fetch(`${baseUrl}/v1/skills/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          snapshot: {
            savedAt: input.savedAt,
            enabled: input.enabled,
            sources: [input.source]
          }
        })
      });
      expect(response.status).toBe(200);
    }

    const response = await fetch(`${baseUrl}/v1/skills/snapshot`);
    const body = await response.json();
    expect(body.snapshot.catalog[0]).toMatchObject({
      id: "writer",
      body: "new instructions",
      contentHash: "writer-v2",
      syncedAt: 20
    });
    expect(body.snapshot.enabled).toEqual(["writer"]);
    expect(body.snapshot.savedAt).toBe(20);
  });
});
