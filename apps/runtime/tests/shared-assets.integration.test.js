import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { AssetService } from "../src/asset-service.mjs";
import { PostgresAssetStore } from "../src/postgres-asset-store.mjs";
import { LocalFilesystemBlobStore } from "../src/local-filesystem-blob-store.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
const sha256 = createHash("sha256").update(png).digest("hex");
const key = `sha256/${sha256.slice(0, 2)}/${sha256}`;
async function fixture() {
  const db = await createPostgresTestDatabase("asset_gc");
  cleanups.push(() => db.close());
  const root = await mkdtemp(join(tmpdir(), "space-asset-gc-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const blobs = await new LocalFilesystemBlobStore({ root }).initialize();
  const metadata = new PostgresAssetStore(db.pool, { spaceId: db.defaultSpaceId });
  const service = new AssetService({ blobs, metadata });
  return { db, blobs, metadata, service };
}
describe("native asset cleanup with database upload coordination", () => {
  it("collects failed-transfer blobs after their metadata is discarded, preserving other referenced uploads", async () => {
    const h = await fixture();
    const first = await h.service.createImage({ stream: [png] });
    const second = await h.service.createImage({ stream: [png] });
    await h.db.pool.query("DELETE FROM runtime_assets WHERE id=$1", [first.id]);
    await utimes(h.blobs.pathForKey(key), new Date(0), new Date(0));
    expect(await h.service.collectGarbage()).toEqual({ checked: 1, deleted: 0 });
    expect(await h.service.requireReady(second.id)).toMatchObject({ sha256 });
    await h.db.pool.query("DELETE FROM runtime_assets WHERE id=$1", [second.id]);
    expect(await h.service.collectGarbage()).toEqual({ checked: 1, deleted: 1 });
    await expect(stat(h.blobs.pathForKey(key))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("never deletes a live blob while a new upload of the same bytes commits", async () => {
    const h = await fixture();
    const staged = await h.blobs.stage([png], { maxBytes: 1024 });
    await staged.commit();
    const [collected, created] = await Promise.all([
      h.service.collectGarbage({ minimumAgeMs: 0 }), h.service.createImage({ stream: [png] })
    ]);
    expect(collected.checked).toBe(1);
    expect(await h.service.requireReady(created.id)).toMatchObject({ sha256 });
    const read = await h.service.openRead(created.id), chunks = [];
    for await (const chunk of read.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(png);
  });
});
