import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createAssetHttpHandler } from "../src/asset-http-handler.mjs";
import { AssetInputEngine } from "../src/asset-input-engine.mjs";
import {
  ASSET_URI_PREFIX,
  AssetService,
  assetUri
} from "../src/asset-service.mjs";
import { LocalFilesystemBlobStore } from "../src/local-filesystem-blob-store.mjs";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("runtime-asset")
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

const cleanups = [];

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "zion-assets-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const blobs = await new LocalFilesystemBlobStore({ root }).initialize();
  const metadata = new MemoryAssetStore();
  let sequence = 0;
  const assets = new AssetService({
    blobs,
    metadata,
    maxImageBytes: options.maxImageBytes || 1024,
    now: () => 1000,
    createId: () => `asset_${++sequence}`
  });
  return { root, blobs, metadata, assets };
}

async function listen(handler) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (await handler(request, response, url)) return;
      response.writeHead(404).end();
    } catch (error) {
      const body = JSON.stringify({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
      response.writeHead(error.statusCode || 500, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      });
      response.end(body);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("local image Assets", () => {
  it("publishes validated bytes to filesystem CAS and keeps metadata separate", async () => {
    const { root, assets } = await fixture();
    const asset = await assets.createImage({
      stream: Readable.from([PNG]),
      ownerId: "user:test",
      declaredMediaType: "image/png",
      originalName: "../screen.png",
      declaredBytes: PNG.length
    });

    expect(asset).toMatchObject({
      id: "asset_1",
      ownerId: "user:test",
      state: "ready",
      mediaKind: "image",
      mediaType: "image/png",
      byteLength: PNG.length,
      originalName: "..screen.png"
    });
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(asset.blobKey).toBe(`sha256/${asset.sha256.slice(0, 2)}/${asset.sha256}`);
    expect(await readFile(join(root, "blobs", asset.blobKey))).toEqual(PNG);
    expect(assetUri(asset.id)).toBe(`${ASSET_URI_PREFIX}asset_1`);

    const content = await assets.openRead(asset.id);
    const chunks = [];
    for await (const chunk of content.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(PNG);
  });

  it("rejects oversized and mismatched image uploads before publishing metadata", async () => {
    const tooSmall = await fixture({ maxImageBytes: PNG.length - 1 });
    await expect(tooSmall.assets.createImage({
      stream: Readable.from([PNG]),
      declaredMediaType: "image/png"
    })).rejects.toMatchObject({ code: "ASSET_TOO_LARGE", statusCode: 413 });

    const mismatch = await fixture();
    await expect(mismatch.assets.createImage({
      stream: Readable.from([PNG]),
      declaredMediaType: "image/jpeg"
    })).rejects.toMatchObject({ code: "ASSET_TYPE_MISMATCH", statusCode: 415 });
    expect(mismatch.metadata.assets.size).toBe(0);
  });

  it("rejects browser-private image references before creating a Run", async () => {
    const { assets } = await fixture();
    await expect(assets.validateRunRequest({
      messages: [{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: "app://img/browser-only" }
        }]
      }]
    })).rejects.toMatchObject({
      code: "ASSET_LEGACY_BROWSER_ONLY",
      statusCode: 422
    });
  });

  it("serves metadata, authenticated content shape, and byte ranges over HTTP", async () => {
    const { assets } = await fixture();
    const url = await listen(createAssetHttpHandler({ assets }));
    const created = await fetch(`${url}/v1/assets`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-zion-file-name": encodeURIComponent("screen.png")
      },
      body: PNG
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.asset).toMatchObject({
      id: "asset_1",
      uri: `${ASSET_URI_PREFIX}asset_1`,
      mediaType: "image/png"
    });
    expect(body.asset).not.toHaveProperty("blobKey");

    const metadata = await fetch(`${url}/v1/assets/asset_1`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      asset: { byteLength: PNG.length }
    });

    const content = await fetch(`${url}/v1/assets/asset_1/content`, {
      headers: { range: "bytes=2-7" }
    });
    expect(content.status).toBe(206);
    expect(content.headers.get("content-range")).toBe(`bytes 2-7/${PNG.length}`);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(PNG.subarray(2, 8));
  });

  it("materializes Asset references only for the model request", async () => {
    let observed;
    const delegate = {
      id: "capture",
      async *streamTurn(request) {
        observed = request;
        yield { type: "message.delta", delta: "ok" };
      }
    };
    const assets = {
      async readDataUrl(assetId) {
        expect(assetId).toBe("asset_1");
        return "data:image/png;base64,iVBORw0KGgo=";
      }
    };
    const engine = new AssetInputEngine({
      engine: delegate,
      assets,
      maxInlineBytes: 1024
    });
    const original = [{
      role: "user",
      content: [{
        type: "image_url",
        image_url: { url: `${ASSET_URI_PREFIX}asset_1`, detail: "low" }
      }]
    }];
    const events = [];
    for await (const event of engine.streamTurn({
      messages: original,
      tools: []
    })) events.push(event);

    expect(events).toEqual([{ type: "message.delta", delta: "ok" }]);
    expect(observed.messages[0].content[0].image_url).toEqual({
      url: "data:image/png;base64,iVBORw0KGgo=",
      detail: "low"
    });
    expect(original[0].content[0].image_url.url).toBe(
      `${ASSET_URI_PREFIX}asset_1`
    );
  });
});
