#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "../../ZIOON-RELEASE-20261025");
const payload = join(output, "payload");
await rm(payload, { recursive: true, force: true });
await mkdir(join(payload, "source"), { recursive: true });
const paths = ["apps/runtime/src", "apps/runtime/bin", "apps/runtime/package.json",
  "apps/device-connector/src", "apps/device-connector/package.json", "src",
  "packages/runtime/dist", "packages/runtime/package.json", "packages/plugin-sdk/src",
  "packages/runtime-client/src", "packages/local-tools-client/src", "packages/node-protocol/src",
  "packages/account-ui/src", "packages/sandbox", "packages/zioon-account", "extensions"];
const ignore = (src) => !src.split("/").some((name) => [
  "node_modules", ".DS_Store", ".git", ".env", "credentials.json", ".marketplace-local"
].includes(name));
for (const path of paths) await cp(join(root, path), join(payload, "source", path), { recursive: true, filter: ignore });
const entries = ["apps/runtime/src/main.mjs", "apps/runtime/bin/zion.mjs"];
for (const directory of await readdir(join(root, "extensions"), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const path = `extensions/${directory.name}/manifest.json`;
  const text = await readFile(join(root, path), "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!text) continue;
  const metadata = JSON.parse(text);
  const plugin = metadata.zion || metadata;
  if (plugin.entries?.runtime) entries.push(join("extensions", directory.name, plugin.entries.runtime));
}
const { metafile } = await build({
  absWorkingDir: root, entryPoints: entries, bundle: true, packages: "external",
  platform: "node", format: "esm", target: "node22", outdir: "/tmp/zioon-release-graph",
  write: false, metafile: true, logLevel: "silent"
});
const externalImports = [];
for (const [path, input] of Object.entries(metafile.inputs)) {
  if (path.startsWith("../") || path.startsWith("/") || path.includes("node_modules/")) throw new Error("Release graph escaped the source workspace");
  await cp(join(root, path), join(payload, "source", path), { recursive: true, filter: ignore });
  for (const entry of input.imports) {
    if (entry.external && !entry.path.startsWith("node:")) externalImports.push({ importer: path, package: entry.path });
  }
}
await writeFile(join(payload, "dependencies.json"), JSON.stringify({
  entryPoints: entries, sourceFiles: Object.keys(metafile.inputs), externalImports
}, null, 2) + "\n");
await cp(join(root, "package.json"), join(payload, "source/package.json"));
await cp(join(root, "package-lock.json"), join(payload, "source/package-lock.json"));
await cp(join(root, "dist"), join(payload, "workbench"), { recursive: true, filter: ignore });
await cp(join(root, "apps/public-site/dist"), join(output, "preview-site"), { recursive: true });
execFileSync(process.execPath, [join(root, "apps/public-site/build.mjs")], {
  cwd: root, env: { ...process.env, ZIOON_SITE_RELEASE_STATE: "published" }, stdio: "pipe"
});
await cp(join(root, "apps/public-site/dist"), join(payload, "website"), { recursive: true });
await rm(join(root, "apps/public-site/dist"), { recursive: true, force: true });
await cp(join(output, "preview-site"), join(root, "apps/public-site/dist"), { recursive: true });
await cp(join(root, "deploy/zioon-public.caddy"), join(payload, "website.caddy"));
await cp(join(root, "scripts/zioon-release-preflight.mjs"), join(payload, "release-preflight.mjs"));
const files = {};
const scan = async (directory, prefix = "") => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await scan(join(directory, entry.name), `${name}/`);
    else files[name] = createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex");
  }
};
await scan(payload);
await writeFile(join(payload, "manifest.json"), JSON.stringify({
  release: "zioon-20261025", sourceWorkspace: "release/zioon-cli-site-20261025",
  createdAt: new Date().toISOString(), files
}, null, 2) + "\n");
execFileSync("tar", ["--no-xattrs", "-czf", join(output, "zioon-release-20261025.tgz"), "-C", payload, "."]);
await cp(join(root, "scripts/apply-zioon-release.sh"), join(output, "apply-zioon-release.sh"));
await cp(join(root, "apps/public-site/downloads"), join(output, "downloads"), { recursive: true });
await cp(join(root, ".trae/skills/zioon"), join(output, "zioon"), { recursive: true });
const digest = createHash("sha256").update(await readFile(join(output, "zioon-release-20261025.tgz"))).digest("hex");
const scriptDigest = createHash("sha256").update(await readFile(join(output, "apply-zioon-release.sh"))).digest("hex");
await writeFile(join(output, "SHA256SUMS"), `${digest}  zioon-release-20261025.tgz\n${scriptDigest}  apply-zioon-release.sh\n`);
console.log(JSON.stringify({ output, archive: "zioon-release-20261025.tgz", files: Object.keys(files).length, sha256: digest }, null, 2));
