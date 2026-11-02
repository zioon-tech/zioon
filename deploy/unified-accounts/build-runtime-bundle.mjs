import { cp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { packageIdentityPlugin } from "../../scripts/package-identity-plugin.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error("Build into an empty release directory");
async function copy(source, target = `source/${source}`) {
  await mkdir(dirname(join(output, target)), { recursive: true });
  await cp(join(repository, source), join(output, target), {
    recursive: true, dereference: true,
    filter: (path) => !path.split("/").some((part) => ["node_modules", ".git", "__pycache__", ".DS_Store"].includes(part))
  });
}
for (const path of ["apps/runtime/src", "apps/runtime/package.json", "apps/runtime/package-lock.json",
  "apps/device-connector/src", "apps/device-connector/package.json", "extensions", "scripts",
  "src/chat",
  "packages/runtime/dist", "packages/runtime/package.json", "deploy/accounts/start-space.mjs",
  "deploy/unified-accounts/migrate-runtime-memory.ts"]) await copy(path);
for (const directory of await readdir(join(repository, "packages"), { withFileTypes: true })) {
  if (!directory.isDirectory() || directory.name === "runtime") continue;
  for (const name of ["src", "package.json"]) {
    const path = `packages/${directory.name}/${name}`;
    try { await copy(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
await copy("dist", "workbench");
await copy("packages/zioon-account/src/provider.mjs", "zioon-provider.mjs");
await copy("deploy/unified-accounts/clients.json", "clients.json");
await copy("deploy/unified-accounts/release-runtime.mjs", "release-runtime.mjs");
await copy("deploy/unified-accounts/plugin-host-catalog.mjs", "plugin-host-catalog.mjs");
const identityPackage = await packageIdentityPlugin({ install: false, archiveDirectory: output });
const files = {};
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) {
      const bytes = await readFile(full);
      files[relative(output, full)] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    } else throw new Error("Unexpected symlink");
  }
}
await walk(output);
await writeFile(join(output, "manifest.json"), JSON.stringify({
  format: 1, product: "Zion", identityVersion: identityPackage.version, issuer: "https://auth.zioon.tech", files
}, null, 2) + "\n");
console.log(JSON.stringify({ output, files: Object.keys(files).length,
  bytes: Object.values(files).reduce((sum, value) => sum + value.bytes, 0) }));
