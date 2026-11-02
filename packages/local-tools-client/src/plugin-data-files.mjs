import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_BYTES = 4 * 1024 * 1024;
export const contentHash = (value) => createHash("sha256").update(value).digest("hex");
const stableJson = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item);

function failure(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

async function rejectSymlinks(path, boundary = dirname(path)) {
  for (let current = path; dirname(current) !== current; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw failure("Plugin data symlinks are not supported", 403);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current === boundary) break;
  }
}

export async function withDataFileLock(path, operation, { timeoutMs = 10000, signal } = {}) {
  const lock = `${path}.zion-lock`;
  await rejectSymlinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfCancelled?.();
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw failure("Plugin data file is locked; retry or inspect the lock owner");
      await delay(25);
    }
  }
  try {
    signal?.throwIfCancelled?.();
    await rejectSymlinks(path);
    return await operation();
  } finally {
    await rmdir(lock);
  }
}

async function readText(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw failure("Plugin data path is not a regular file", 400);
    if (info.size > MAX_BYTES) throw failure("Plugin data file exceeds 4 MiB", 413);
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path, content) {
  if (Buffer.byteLength(content) > MAX_BYTES) throw failure("Plugin data file exceeds 4 MiB", 413);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function mergeJsonlRecords(current, records, field = "id") {
  if (!Array.isArray(records) || !records.length) throw failure("records are required", 400);
  const existing = new Map();
  for (const line of (current || "").split(/\r?\n/).filter((value) => value.trim())) {
    let record;
    try { record = JSON.parse(line); } catch { throw failure("Invalid JSONL history; repair before appending"); }
    if (!record || record[field] == null) throw failure("JSONL history has a missing record id");
    const key = String(record[field]);
    if (existing.has(key) && stableJson(existing.get(key)) !== stableJson(record)) {
      throw failure(`Conflicting JSONL id: ${key}`);
    }
    existing.set(key, record);
  }
  const appended = [];
  const skipped = [];
  const additions = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record) || record[field] == null) {
      throw failure("Each JSONL record requires an id", 400);
    }
    const key = String(record[field]);
    if (!key.trim()) throw failure("Empty JSONL id", 400);
    if (existing.has(key)) {
      if (stableJson(existing.get(key)) !== stableJson(record)) throw failure(`Conflicting JSONL id: ${key}`);
      skipped.push(key);
    } else {
      existing.set(key, record);
      additions.push(JSON.stringify(record));
      appended.push(key);
    }
  }
  const prefix = current ? current.replace(/\n?$/, "\n") : "";
  return { appended, skipped, content: `${prefix}${additions.length ? `${additions.join("\n")}\n` : ""}` };
}

// This adapter preserves the existing file tools and HTTP routes. It only owns
// physical plugin-data files; caller authorization must run before invoking it.
export function createPluginDataFileHost({ root }) {
  const base = resolve(root.startsWith("~/") ? `${homedir()}/${root.slice(2)}` : root);
  return Object.freeze({
    async handle(operation, args = {}, { signal } = {}) {
      signal?.throwIfCancelled?.();
      if (!["read", "read-jsonl", "entries", "write", "edit", "append-jsonl"].includes(operation)
        || !isAbsolute(String(args.path || ""))) return null;
      const path = resolve(args.path);
      const child = relative(base, path);
      if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return null;
      if (args.session_id) throw failure("Plugin data file tools must omit session_id", 400);
      if (child.split(sep).some((part) => part.endsWith(".zion-lock"))) {
        throw failure("Lock paths are reserved", 403);
      }
      await rejectSymlinks(path, base);
      if (operation === "entries") {
        const entries = await readdir(path, { withFileTypes: true });
        return {
          plugin_data_version: 1,
          entries: entries.filter((entry) => !entry.isSymbolicLink() && !entry.name.endsWith(".zion-lock"))
            .map((entry) => ({
              name: entry.name, path: `${path}/${entry.name}`,
              type: entry.isDirectory() ? "directory" : "file"
            }))
        };
      }
      if (operation === "read" || operation === "read-jsonl") {
        const content = await readText(path);
        if (content === null) throw failure("ENOENT: no such file", 404);
        if (operation === "read-jsonl" || args.offset || args.limit) {
          const lines = content.split("\n");
          if (lines.at(-1) === "") lines.pop();
          const limit = Math.max(1, Math.min(1000, Number(args.limit) || 80));
          const start = args.tail
            ? Math.max(0, lines.length - Math.min(limit, Number(args.tail)))
            : Math.max(0, (Number(args.offset) || 1) - 1);
          const end = Math.min(lines.length, start + limit);
          return {
            ok: true, plugin_data_version: 1, path, content: lines.slice(start, end).join("\n"),
            content_hash: contentHash(content), start_line: start + 1, end_line: end,
            previous_offset: Math.max(1, start - limit + 1), has_previous: start > 0,
            has_more: end < lines.length
          };
        }
        return { ok: true, plugin_data_version: 1, path, content, content_hash: contentHash(content) };
      }
      return withDataFileLock(path, async () => {
        const current = await readText(path);
        if (args.create_only && current !== null) return { ok: true, plugin_data_version: 1, path, created: false };
        if (args.expected_hash !== undefined
          && args.expected_hash !== (current === null ? null : contentHash(current))) {
          throw failure("File changed since last read; read again before writing");
        }
        let content;
        let extra = {};
        if (operation === "append-jsonl") {
          extra = mergeJsonlRecords(
            current,
            args.records,
            args.dedupe_field || "id"
          );
          content = extra.content;
          delete extra.content;
        } else if (operation === "edit") {
          if (current === null) throw failure("ENOENT: no such file", 404);
          const before = String(args.old_string || "");
          const count = before ? current.split(before).length - 1 : 0;
          if (!count || (count > 1 && !args.replace_all)) throw failure("Edit requires an unambiguous matching string");
          content = args.replace_all
            ? current.replaceAll(before, () => String(args.new_string || ""))
            : current.replace(before, () => String(args.new_string || ""));
        } else {
          content = String(args.content ?? "");
        }
        signal?.throwIfCancelled?.();
        if (content !== current) await atomicWrite(path, content);
        return { ok: true, plugin_data_version: 1, path, content_hash: contentHash(content), ...extra };
      }, { signal });
    }
  });
}
