import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import JSZip from "jszip";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
const IDENTITY_SOURCE_ROOT = join(
  REPOSITORY_ROOT,
  "extensions",
  "dev.identity"
);
const FIXED_ZIP_DATE = new Date("2026-01-01T00:00:00.000Z");

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) {
    throw new Error(`${name} requires a value`);
  }
  return resolve(args[index + 1]);
}

function transformedManifest(source) {
  const manifest = JSON.parse(JSON.stringify(source));
  manifest.zion.main = "./dist/main.js";
  manifest.zion.entries = {
    ...manifest.zion.entries,
    ui: "./dist/main.js",
    runtime: "./dist/runtime.js"
  };
  return manifest;
}

async function buildBundles(outputRoot) {
  await mkdir(join(outputRoot, "dist"), { recursive: true });
  await Promise.all([
    esbuild.build({
      entryPoints: [join(IDENTITY_SOURCE_ROOT, "main.js")],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outfile: join(outputRoot, "dist", "main.js"),
      logLevel: "warning"
    }),
    esbuild.build({
      entryPoints: [join(IDENTITY_SOURCE_ROOT, "runtime.js")],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      outfile: join(outputRoot, "dist", "runtime.js"),
      logLevel: "warning"
    })
  ]);
}

async function addDirectoryToZip(zip, directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const absolutePath = join(directory, entry.name);
    const archivePath = prefix
      ? `${prefix}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, absolutePath, archivePath);
      continue;
    }
    if (!entry.isFile()) continue;
    zip.file(archivePath, await readFile(absolutePath), {
      date: FIXED_ZIP_DATE,
      createFolders: false
    });
  }
}

async function replaceDirectory(source, target) {
  await mkdir(dirname(target), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const staged = `${target}.tmp-${suffix}`;
  const backup = `${target}.backup-${suffix}`;
  await cp(source, staged, { recursive: true });
  let backedUp = false;
  try {
    if (await stat(target).then(() => true, () => false)) {
      await rename(target, backup);
      backedUp = true;
    }
    await rename(staged, target);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    if (
      backedUp
      && !(await stat(target).then(() => true, () => false))
    ) {
      await rename(backup, target);
    }
    throw error;
  }
}

export async function packageIdentityPlugin({
  installDirectory = join(homedir(), ".zion-next", "plugins", "dev.identity"),
  archiveDirectory = join(
    homedir(),
    ".zion-local-tools",
    "plugins",
    "dev.identity"
  ),
  install = true,
  archive = true
} = {}) {
  const manifestSource = JSON.parse(
    await readFile(join(IDENTITY_SOURCE_ROOT, "manifest.json"), "utf8")
  );
  const manifest = transformedManifest(manifestSource);
  const version = String(manifest.zion.version || manifest.version || "").trim();
  if (!version) throw new Error("Identity plugin manifest has no version");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "zion-identity-plugin-"));
  const packageRoot = join(temporaryRoot, "dev.identity");
  try {
    await mkdir(packageRoot, { recursive: true });
    await buildBundles(packageRoot);
    await Promise.all([
      cp(
        join(IDENTITY_SOURCE_ROOT, "styles.css"),
        join(packageRoot, "styles.css")
      ),
      cp(
        join(IDENTITY_SOURCE_ROOT, "skills"),
        join(packageRoot, "skills"),
        { recursive: true }
      ),
      writeFile(
        join(packageRoot, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`
      ),
      writeFile(
        join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: manifest.name,
          version,
          private: true,
          type: "module",
          zion: manifest.zion
        }, null, 2)}\n`
      )
    ]);

    let installedAt = null;
    if (install) {
      installedAt = resolve(installDirectory);
      await replaceDirectory(packageRoot, installedAt);
    }

    let archivePath = null;
    let archiveSha256 = null;
    if (archive) {
      await mkdir(archiveDirectory, { recursive: true });
      archivePath = join(
        resolve(archiveDirectory),
        `dev.identity-${version}.zip`
      );
      const zip = new JSZip();
      await addDirectoryToZip(zip, packageRoot);
      const bytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
        platform: "UNIX"
      });
      const stagedArchive = `${archivePath}.tmp-${process.pid}`;
      await writeFile(stagedArchive, bytes, { mode: 0o644 });
      await rename(stagedArchive, archivePath);
      archiveSha256 = createHash("sha256").update(bytes).digest("hex");
    }

    return {
      id: String(manifest.zion.id),
      version,
      source: relative(REPOSITORY_ROOT, IDENTITY_SOURCE_ROOT),
      installDirectory: installedAt,
      archivePath,
      archiveSha256
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const result = await packageIdentityPlugin({
    installDirectory: readOption(
      args,
      "--install-dir",
      join(homedir(), ".zion-next", "plugins", "dev.identity")
    ),
    archiveDirectory: readOption(
      args,
      "--archive-dir",
      join(homedir(), ".zion-local-tools", "plugins", "dev.identity")
    ),
    install: !args.includes("--no-install"),
    archive: !args.includes("--no-archive")
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
