import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { OssStorageAdapter } from "../src/oss-storage.ts";

// Probe only this random prefix, never existing memory objects or bucket settings.
const storage = new OssStorageAdapter();
const prefix = `zion-memory-probe/${randomUUID()}/`;
const key = `${prefix}记忆.md`, copied = `${prefix}copy.md`;
try {
  assert(await storage.checkVersioningEnabled(), "Enable Bucket versioning before testing memory history");
  const first = await storage.putObject(key, "# OSS memory\n", undefined, "text/markdown");
  assert(first.versionId, "OSS did not return an object version ID");
  assert.equal(new TextDecoder().decode((await storage.getObject(key)).body), "# OSS memory\n");
  await storage.putObject(key, "# Updated\n");
  assert.equal(new TextDecoder().decode((await storage.getObject(key, first.versionId)).body), "# OSS memory\n");
  assert.equal((await storage.headObject(key)).size, Buffer.byteLength("# Updated\n"));
  assert((await storage.listObjects(prefix)).objects.some((v) => v.key === key));
  assert((await storage.listObjectVersions(key)).length >= 2);
  await storage.copyObject(key, copied);
  assert.equal(new TextDecoder().decode((await storage.getObject(copied)).body), "# Updated\n");
  console.log(JSON.stringify({ ok: true, verified: [
    "UTF-8 object keys", "write", "read", "historical version read",
    "head", "list", "version listing", "copy"
  ], probePrefix: prefix }));
} finally {
  // Remove each exact version created under the owned prefix, including delete markers.
  const versions = await storage.client.getBucketVersions({ prefix, maxKeys: 1000 });
  for (const object of [...(versions.objects || []), ...(versions.deleteMarker || [])]) {
    await storage.client.delete(object.name, { versionId: object.versionId });
  }
}
