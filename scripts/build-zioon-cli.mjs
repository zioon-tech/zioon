#!/usr/bin/env node
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages/zioon-cli");
const downloads = join(root, "apps/public-site/downloads");
const skillSource = process.env.ZIOON_SKILL_SOURCE
  ? resolve(process.env.ZIOON_SKILL_SOURCE)
  : await stat(join(pkg, "skills/zioon")).then(() => true, () => false)
    ? join(pkg, "skills/zioon") : join(root, ".trae/skills/zioon");
// Read the complete source before replacing generated output. A packaged
// checkout can use its included skill without a repository-local .trae tree.
const skillFiles = new Map();
async function collectSkill(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) await collectSkill(join(directory, entry.name), path);
    else if (entry.isFile()) skillFiles.set(path, await readFile(join(directory, entry.name)));
    else throw new Error("CLI skill must contain regular files");
  }
}
await collectSkill(skillSource);
if (!skillFiles.has("SKILL.md")) throw new Error("CLI skill has no SKILL.md");
await rm(join(pkg, "dist"), { recursive: true, force: true });
await mkdir(join(pkg, "dist"), { recursive: true });
for (const name of ["cli", "sdk"]) {
  await build({
    entryPoints: [join(pkg, `src/${name}.mjs`)], outfile: join(pkg, `dist/${name}.mjs`),
    bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    logLevel: "warning"
  });
}
await chmod(join(pkg, "bin/zioon.mjs"), 0o755);
await rm(join(pkg, "skills"), { recursive: true, force: true });
for (const [path, content] of skillFiles) {
  const target = join(pkg, "skills/zioon", path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}
await mkdir(downloads, { recursive: true });
const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", downloads], { cwd: pkg, encoding: "utf8" }))[0];
const version = JSON.parse(await readFile(join(pkg, "package.json"), "utf8")).version;
const file = `zioon-cli-${version}.tgz`;
if (packed.filename !== file) {
  await cp(join(downloads, packed.filename), join(downloads, file));
  await rm(join(downloads, packed.filename));
}
execFileSync("tar", ["-czf", join(downloads, `zioon-skill-${version}.tar.gz`), "-C", join(pkg, "skills"), "zioon"]);
await cp(join(pkg, "skills/zioon/SKILL.md"), join(downloads, "SKILL.md"));
const files = [file, `zioon-skill-${version}.tar.gz`, "SKILL.md", "install.sh", "install.ps1"];
const hashes = {};
for (const name of files) hashes[name] = createHash("sha256").update(await readFile(join(downloads, name))).digest("hex");
await writeFile(join(downloads, "SHA256SUMS"), Object.entries(hashes).map(([name, hash]) => `${hash}  ${name}\n`).join(""));
await writeFile(join(downloads, "release.json"), JSON.stringify({ version, requires: "Node.js >=22.5", package: "@zioon/cli", files: hashes }, null, 2) + "\n");
console.log(JSON.stringify({ package: file, version, size: packed.size, unpackedSize: packed.unpackedSize, dependencies: 0, hashes }, null, 2));
