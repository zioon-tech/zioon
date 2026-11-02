#!/usr/bin/env node
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { validatePluginId } from "../packages/plugin-sdk/src/data-location.mjs";
import { contentHash, withDataFileLock } from "../packages/local-tools-client/src/plugin-data-files.mjs";

function absolute(path) {
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

async function inventory(root, path = root, files = new Map()) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Migration refuses symlinks: ${path}`);
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) {
      if (name === ".DS_Store" || name === "__MACOSX" || name.startsWith("._")) continue;
      if (name.endsWith(".zion-lock")) throw new Error("Source contains a file lock; stop writers before migration");
      await inventory(root, join(path, name), files);
    }
  } else if (info.isFile()) {
    const bytes = await readFile(path);
    files.set(relative(root, path), { hash: contentHash(bytes), bytes: bytes.length });
  } else {
    throw new Error(`Migration only supports regular files: ${path}`);
  }
  return files;
}

const signature = (files) => JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)));

export async function migratePluginData({
  pluginId, source, dataRoot = join(homedir(), ".zion-next/data/plugins"), apply = false
}) {
  const id = validatePluginId(pluginId);
  if (!source) throw new Error("An explicit --source is required");
  const from = absolute(source);
  const destination = join(absolute(dataRoot), id);
  if (from === destination || from.startsWith(`${destination}${sep}`) || destination.startsWith(`${from}${sep}`)) {
    throw new Error("Source and destination must be separate directories");
  }
  if (!(await lstat(from)).isDirectory()) throw new Error("Migration source must be a directory");
  const files = await inventory(from);
  let existing = null;
  try { existing = await inventory(destination); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && signature(existing) !== signature(files)) {
    throw new Error("Destination differs from source; migration will not merge or overwrite data");
  }
  const report = {
    pluginId: id, source: from, destination, files: files.size,
    bytes: [...files.values()].reduce((sum, file) => sum + file.bytes, 0),
    status: existing ? "already-migrated" : apply ? "migrated" : "dry-run"
  };
  if (existing || !apply) return report;
  await withDataFileLock(destination, async () => {
    try {
      await lstat(destination);
      throw new Error("Destination appeared during migration; inspect before retrying");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const staging = await mkdtemp(join(dirname(destination), `.${id}-import-`));
    try {
      for (const name of files.keys()) {
        await mkdir(dirname(join(staging, name)), { recursive: true, mode: 0o700 });
        await copyFile(join(from, name), join(staging, name));
      }
      if (signature(await inventory(from)) !== signature(files)
        || signature(await inventory(staging)) !== signature(files)) {
        throw new Error("Source changed during migration; nothing was published");
      }
      await rename(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  migratePluginData({
    pluginId: value("--plugin-id"),
    source: value("--source"),
    dataRoot: value("--data-root"),
    apply: args.includes("--apply")
  }).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
