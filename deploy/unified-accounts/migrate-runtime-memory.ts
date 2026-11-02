import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildBiographyDigest } from "../../extensions/dev.identity/identity-core.js";

// Run offline with the stopped Memory service's exact storage environment.
const [legacyRoot, output] = process.argv.slice(2);
if (!legacyRoot || !output) throw new Error("Usage: bun migrate-runtime-memory.ts LEGACY_SNAPSHOT REPORT");
for (const service of ["zion-runtime", "zion-memory"]) {
  let active = false;
  try { active = execFileSync("systemctl", ["is-active", service], { encoding: "utf8" }).trim() === "active"; } catch {}
  assert(!active, `${service} must be stopped for a consistent migration`);
}
const { core } = await import("/opt/zion-memory/apps/memory-service/src/upstream.ts");
const db = core.createDatabase(resolve(process.env.AGENT_FS_HOME, "agent-fs.db"));
const storage = core.createStorageAdapter(core.getConfig().s3);
const subject = "fQNCVWX7KJtZ1NLEy5nIZYMnSEhGQfKy";
const link = db.$client.query("SELECT * FROM zioon_memory_account_links WHERE subject=?").get(subject);
assert.equal(link?.memory_user_id, "6dc1fa13-a895-4811-929f-5d741d573666");
const ctx = { db, s3: storage, userId: link.memory_user_id, ...core.resolveContext(db, { userId: link.memory_user_id }),
  embeddingProvider: null };
assert.equal(ctx.driveId, "0291e4cd-8459-4d63-90d3-3063a11baf18");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const root = "/memory/dev.identity";
const previousVersions = db.$client.query("SELECT * FROM file_versions WHERE drive_id=?").all(ctx.driveId);
const report = { subject, userId: ctx.userId, driveId: ctx.driveId, legacyFiles: 0, files: [],
  jsonl: {}, recoveredEncoding: [], priorVersions: previousVersions.length };
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error("Unexpected legacy symlink");
  }
  return files.sort();
}
async function current(path) {
  const row = core.getHeadVersionRow(ctx, path);
  if (!row) return null;
  return decode((await storage.getObject(core.getS3Key(ctx.orgId, ctx.driveId, path))).body);
}
function records(text) {
  return String(text || "").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}
function mergeRecords(path, legacy, existing) {
  const values = new Map();
  const before = records(existing), old = records(legacy);
  for (const value of [...old, ...before]) {
    assert(typeof value.id === "string" && value.id, `Missing stable id: ${path}`);
    if (values.has(value.id)) assert.deepEqual(value, values.get(value.id), `Conflicting id: ${path}/${value.id}`);
    else values.set(value.id, value);
  }
  report.jsonl[path] = { legacy: old.length, existing: before.length, combined: values.size,
    idsSha256: hash([...values.keys()].sort().join("\n")) };
  return [...values.values()].map((value) => JSON.stringify(value)).join("\n") + "\n";
}
function mergeText(legacy, existing) {
  if (!existing || legacy.includes(existing.trim())) return legacy;
  if (existing.includes(legacy.trim())) return existing;
  return `${legacy.trimEnd()}\n\n## Memory 服务迁移前的补充\n\n${existing.trim()}\n`;
}
async function save(path, content, message, malformedPrevious = false) {
  const before = malformedPrevious ? null : await current(path);
  const written = await core.dispatchOp(ctx, "write", {
    path, content, expectedVersion: core.getHeadVersionRow(ctx, path)?.version || 0, message
  });
  assert.equal(await current(path), content);
  assert.equal(written.contentHash, hash(Buffer.from(content)));
  report.files.push({ path, bytes: Buffer.byteLength(content), contentHash: written.contentHash,
    version: written.version, changed: before !== content });
}
try {
  const inputs = await walk(legacyRoot);
  report.legacyFiles = inputs.length;
  assert(inputs.length >= 42, "Legacy inventory is smaller than the verified snapshot; inspect before importing");
  let events;
  for (const input of inputs) {
    const name = relative(legacyRoot, input).replaceAll("\\", "/");
    const path = `${root}/${name}`;
    if (name === "biography/digest.md") continue;
    const bytes = await readFile(input);
    let legacy;
    try { legacy = decode(bytes); }
    catch {
      // The original line starts with b4 a2, the final two bytes of 索 (e7 b4 a2).
      // Preserve the exact original as a version before a one-byte repair.
      assert.equal(name, "projects/q-first-paper-research/project.md");
      assert.equal(bytes[14340], 0xb4);
      assert.equal(bytes[14341], 0xa2);
      let raw = db.$client.query("SELECT version,s3_version_id FROM file_versions WHERE drive_id=? AND path=? AND content_hash=? ORDER BY version LIMIT 1")
        .get(ctx.driveId, path, hash(bytes));
      if (!core.getHeadVersionRow(ctx, path)) {
        await core.writeRaw(ctx, { path, bytes, expectedVersion: 0,
          message: "Original legacy bytes, including pre-existing malformed UTF-8" });
        raw = db.$client.query("SELECT version,s3_version_id FROM file_versions WHERE drive_id=? AND path=? AND content_hash=?")
          .get(ctx.driveId, path, hash(bytes));
      }
      assert(raw, "Existing file has no preserved original bytes; inspect before importing");
      const original = await storage.getObject(core.getS3Key(ctx.orgId, ctx.driveId, path), raw.s3_version_id);
      assert.equal(hash(original.body), hash(bytes));
      legacy = decode(Buffer.concat([bytes.subarray(0, 14340), Buffer.from([0xe7]), bytes.subarray(14340)]));
      report.recoveredEncoding.push({ path, originalHash: hash(bytes), originalVersion: raw.version,
        repair: "insert missing UTF-8 prefix e7 at offset 14340 (索)" });
      let existing = null;
      try { existing = await current(path); } catch (error) { if (!(error instanceof TypeError)) throw error; }
      await save(path, mergeText(legacy, existing), "Repair one missing UTF-8 prefix; original bytes retained in history", existing === null);
      continue;
    }
    const existing = await current(path);
    let merged = legacy;
    if (name.endsWith(".jsonl")) merged = mergeRecords(path, legacy, existing);
    else merged = mergeText(legacy, existing);
    await save(path, merged, "Import legacy Zion Identity while preserving existing Memory content and versions");
    if (name === "biography/events.jsonl") events = records(merged);
  }
  assert(events);
  await save(`${root}/biography/digest.md`, buildBiographyDigest(events),
    "Rebuild biography projection from both preserved event streams");
  for (const old of previousVersions) {
    const version = db.$client.query("SELECT * FROM file_versions WHERE id=?").get(old.id);
    assert.deepEqual(version, old, "A pre-existing Memory version changed");
  }
  for (const recovery of report.recoveredEncoding) {
    const version = db.$client.query("SELECT s3_version_id FROM file_versions WHERE drive_id=? AND path=? AND version=?")
      .get(ctx.driveId, recovery.path, recovery.originalVersion);
    const bytes = await storage.getObject(core.getS3Key(ctx.orgId, ctx.driveId, recovery.path), version.s3_version_id);
    assert.equal(hash(bytes.body), recovery.originalHash);
  }
  report.currentFiles = db.$client.query("SELECT count(*) AS n FROM files WHERE drive_id=? AND is_deleted=0").get(ctx.driveId).n;
  report.totalVersions = db.$client.query("SELECT count(*) AS n FROM file_versions WHERE drive_id=?").get(ctx.driveId).n;
  db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ migrated: true, files: report.currentFiles, versions: report.totalVersions,
    jsonl: report.jsonl, originalBytesPreserved: report.recoveredEncoding.length }));
} finally {
  db.$client.close();
}
