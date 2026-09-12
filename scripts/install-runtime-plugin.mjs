import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

function parseArgs(args) {
  const value = (name, fallback = "") => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
    return args[index + 1];
  };
  const archivePath = value("--archive");
  const pluginRoot = value("--plugin-root");
  if (!archivePath || !pluginRoot) {
    throw new Error(
      "Usage: install-runtime-plugin.mjs --archive <zip> --plugin-root <directory> [--plugin-id <id>]"
    );
  }
  return {
    archivePath: resolve(archivePath),
    pluginRoot: resolve(pluginRoot),
    expectedPluginId: value("--plugin-id")
  };
}

function safeArchivePath(value) {
  const path = String(value || "").replaceAll("\\", "/");
  const normalized = posix.normalize(path);
  if (
    !path
    || path.startsWith("/")
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error(`Unsafe plugin archive path: ${value}`);
  }
  return normalized.replace(/^\.\//, "");
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function replaceDirectory(source, target) {
  const suffix = `${process.pid}-${Date.now()}`;
  const backup = `${target}.backup-${suffix}`;
  let backedUp = false;
  try {
    if (await exists(target)) {
      await rename(target, backup);
      backedUp = true;
    }
    await rename(source, target);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (backedUp && !(await exists(target))) {
      await rename(backup, target);
    }
    throw error;
  }
}

export async function installRuntimePluginArchive({
  archivePath,
  pluginRoot,
  expectedPluginId = ""
} = {}) {
  const resolvedArchive = resolve(String(archivePath || ""));
  const resolvedRoot = resolve(String(pluginRoot || ""));
  const zip = await JSZip.loadAsync(await readFile(resolvedArchive));
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) {
    throw new Error("Runtime plugin archive must contain manifest.json at its root");
  }
  const manifest = JSON.parse(await manifestEntry.async("string"));
  const pluginId = String(manifest?.zion?.id || "").trim();
  const version = String(
    manifest?.zion?.version || manifest?.version || ""
  ).trim();
  const runtimeEntry = safeArchivePath(manifest?.zion?.entries?.runtime);
  if (!pluginId || !version || !runtimeEntry) {
    throw new Error("Runtime plugin manifest must declare id, version, and entries.runtime");
  }
  if (expectedPluginId && pluginId !== expectedPluginId) {
    throw new Error(
      `Runtime plugin archive contains ${pluginId}, expected ${expectedPluginId}`
    );
  }
  if (!zip.file(runtimeEntry)) {
    throw new Error(`Runtime plugin entry is missing from archive: ${runtimeEntry}`);
  }

  await mkdir(resolvedRoot, { recursive: true });
  const target = join(resolvedRoot, pluginId);
  const staged = join(
    resolvedRoot,
    `.${pluginId}.tmp-${process.pid}-${Date.now()}`
  );
  await mkdir(staged, { recursive: true });
  try {
    for (const entry of Object.values(zip.files)) {
      const relativePath = safeArchivePath(entry.name);
      if (!relativePath || entry.dir) continue;
      const destination = join(staged, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await entry.async("nodebuffer"), {
        mode: 0o644
      });
    }
    await replaceDirectory(staged, target);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }

  return {
    id: pluginId,
    version,
    archive: basename(resolvedArchive),
    installDirectory: target,
    runtimeEntry
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await installRuntimePluginArchive(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
