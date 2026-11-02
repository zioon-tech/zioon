import { core } from "./upstream.ts";
import { contentHash, mergeJsonlRecords } from "../../../packages/local-tools-client/src/plugin-data-files.mjs";

export const MEMORY_ROOT = "/memory/dev.identity";
const conflict = () => { throw Object.assign(new Error("content_hash_conflict"), { statusCode: 409 }); };
export async function pluginFileOperation({ db, storage, binding }, operation, input) {
  const path = String(input.path || "");
  if (!(path === MEMORY_ROOT || path.startsWith(`${MEMORY_ROOT}/`))
    || path.split("/").some((part) => part === ".." || part === ".") || /[\\\x00-\x1f]/.test(path)) {
    throw Object.assign(new Error("invalid_memory_path"), { statusCode: 400 });
  }
  const ctx = { db, s3: storage, ...binding, embeddingProvider: null };
  if (operation === "entries") {
    const result = await core.dispatchOp(ctx, "ls", { path });
    return { ok: true, plugin_data_version: 1, path,
      entries: result.entries.map((entry) => ({ ...entry, path: `${path}/${entry.name}` })) };
  }
  let content = null;
  try {
    const loaded = await storage.getObject(core.getS3Key(ctx.orgId, ctx.driveId, path));
    content = new TextDecoder("utf-8", { fatal: true }).decode(loaded.body);
  } catch (error) {
    if (!["NoSuchKey", "NotFound", "NoSuchObject"].includes(error.name)
      && error.status !== 404 && error.$metadata?.httpStatusCode !== 404) throw error;
  }
  const currentHash = content === null ? null : contentHash(content);
  const version = core.getHeadVersionRow(ctx, path)?.version || 0;
  if (operation === "read") {
    if (content === null) throw Object.assign(new Error("ENOENT: no such file"), { statusCode: 404 });
    return { ok: true, plugin_data_version: 1, path, content, content_hash: currentHash };
  }
  if (!["write", "append-jsonl"].includes(operation)) {
    throw Object.assign(new Error("unsupported_memory_operation"), { statusCode: 400 });
  }
  if (input.create_only && content !== null) return {
    ok: true, plugin_data_version: 1, path, created: false, written: false, content_hash: currentHash
  };
  if (Object.hasOwn(input, "expected_hash") && input.expected_hash !== currentHash) conflict();
  const update = operation === "append-jsonl" ? mergeJsonlRecords(content, input.records) : null;
  const next = update ? update.content : String(input.content ?? "");
  const written = await core.dispatchOp(ctx, "write", { path, content: next, expectedVersion: version });
  return { ok: true, plugin_data_version: 1, path, content_hash: written.contentHash,
    written: true, ...(input.create_only ? { created: true } : {}),
    ...(update ? { appended: update.appended, skipped: update.skipped } : {}) };
}
