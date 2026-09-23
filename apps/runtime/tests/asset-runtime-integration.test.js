import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentExecutor,
  MemoryRunStore
} from "../../../packages/runtime/src/index";
import { createAssetHttpHandler } from "../src/asset-http-handler.mjs";
import { AssetInputEngine } from "../src/asset-input-engine.mjs";
import {
  ASSET_URI_PREFIX,
  AssetService
} from "../src/asset-service.mjs";
import { LocalFilesystemBlobStore } from "../src/local-filesystem-blob-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("runtime-round-trip")
]);

class MemoryAssetStore {
  constructor() {
    this.assets = new Map();
  }

  async create(asset) {
    const stored = { ...asset, spaceId: "space:test" };
    this.assets.set(stored.id, stored);
    return stored;
  }

  async get(assetId) {
    return this.assets.get(assetId) || null;
  }
}

function unusedSessions() {
  return {
    async createSession() {},
    async forkSession() {},
    async getSession() { return null; },
    async listSessions() { return []; },
    async getSessionMessages() { return []; },
    async getSessionTranscript() { return []; },
    async appendSessionMessages() {}
  };
}

async function waitForCompletion(store, runId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await store.get(runId);
    if (run?.status === "completed") return run;
    if (run?.status === "failed") throw new Error(run.error || "Run failed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run did not complete");
}

const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Runtime image Asset flow", () => {
  it("keeps the submitted reference while materializing bytes at the model boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "zion-asset-runtime-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const assets = new AssetService({
      blobs: await new LocalFilesystemBlobStore({ root }).initialize(),
      metadata: new MemoryAssetStore(),
      maxImageBytes: 1024,
      createId: () => "asset_round_trip"
    });
    let modelMessages;
    const engine = new AssetInputEngine({
      assets,
      maxInlineBytes: 1024,
      engine: {
        id: "asset-capture",
        async *streamTurn(request) {
          modelMessages = request.messages;
          yield { type: "message.delta", delta: "seen" };
        }
      }
    });
    const runs = new MemoryRunStore();
    const executor = createAgentExecutor({
      engine,
      runs,
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("Unexpected tool invocation"); }
      }
    });
    const runtime = createRuntimeServer({
      executor,
      runs,
      sessions: unusedSessions(),
      serviceHttpHandlers: [createAssetHttpHandler({ assets })],
      validateRunRequest: (request) => assets.validateRunRequest(request)
    });
    cleanups.push(() => runtime.close());
    const address = await runtime.start();

    const upload = await fetch(`${address.url}/v1/assets`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json();
    const uri = uploaded.asset.uri;

    const accepted = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "image_url", image_url: { url: uri } }
          ]
        }],
        maxTurns: 1
      })
    });
    expect(accepted.status).toBe(202);
    const { runId } = await accepted.json();
    await waitForCompletion(runs, runId);

    expect(modelMessages[0].content[1].image_url.url)
      .toMatch(/^data:image\/png;base64,/);
    expect(uri).toBe(`${ASSET_URI_PREFIX}asset_round_trip`);
    expect(JSON.stringify(await runs.getEvents(runId))).not.toContain("base64,");
  });
});
