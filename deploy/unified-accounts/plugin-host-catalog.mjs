import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function baseUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(!url.username && !url.password && !url.search && !url.hash);
  return url.href.replace(/\/+$/, "");
}
async function catalog(base, fetchImpl) {
  const response = await fetchImpl(`${base}/plugins/dev.identity`, {
    redirect: "error", signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 404) return null;
  assert(response.ok, `Plugin Host catalog HTTP ${response.status}`);
  const { data } = await response.json();
  assert.equal(data.id, "dev.identity");
  assert(/^[a-f0-9]{64}$/.test(data.file_hash));
  return data;
}
async function download(base, expected, fetchImpl) {
  const response = await fetchImpl(`${base}/plugins/dev.identity/download`, {
    redirect: "error", signal: AbortSignal.timeout(20_000)
  });
  assert(response.ok, `Plugin Host download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), expected, "Plugin Host download differs from its catalog");
  return bytes;
}
export async function snapshotIdentityCatalog({
  directory, serviceBaseUrl, fetchImpl = globalThis.fetch
}) {
  const base = baseUrl(serviceBaseUrl);
  const entry = await catalog(base, fetchImpl);
  if (entry) {
    const bytes = await download(base, entry.file_hash, fetchImpl);
    await writeFile(join(directory, "browser-identity.zip"), bytes, { mode: 0o600 });
  }
  await writeFile(join(directory, "browser-identity-catalog.json"),
    JSON.stringify({ entry }, null, 2), { mode: 0o600 });
}
export async function restoreIdentityCatalog({
  directory, serviceBaseUrl, publishedHash, fetchImpl = globalThis.fetch
}) {
  const base = baseUrl(serviceBaseUrl);
  const { entry } = JSON.parse(await readFile(join(directory, "browser-identity-catalog.json"), "utf8"));
  const current = await catalog(base, fetchImpl);
  if (!entry && !current) return;
  if (entry && current?.file_hash === entry.file_hash) {
    await download(base, entry.file_hash, fetchImpl);
    return;
  }
  assert.equal(current?.file_hash, publishedHash,
    "Plugin catalog changed independently; preserve the newer publication");
  if (!entry) {
    const response = await fetchImpl(`${base}/plugins/dev.identity`, {
      method: "DELETE", redirect: "error", signal: AbortSignal.timeout(20_000)
    });
    assert(response.ok, `Plugin Host removal HTTP ${response.status}`);
    assert.equal(await catalog(base, fetchImpl), null);
    return;
  }
  const bytes = await readFile(join(directory, "browser-identity.zip"));
  assert.equal(hash(bytes), entry.file_hash);
  assert(/^[a-zA-Z0-9._-]+$/.test(entry.metadata.version));
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "application/zip" }), `dev.identity-${entry.metadata.version}.zip`);
  form.set("metadata", JSON.stringify(entry.metadata));
  const response = await fetchImpl(`${base}/plugins/upload`, {
    method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(20_000)
  });
  const result = await response.json();
  assert(response.ok && result.success === true, `Plugin Host restoration HTTP ${response.status}`);
  assert.equal((await catalog(base, fetchImpl)).file_hash, entry.file_hash);
  await download(base, entry.file_hash, fetchImpl);
}
