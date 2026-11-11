#!/usr/bin/env node
// Isolated staging: never updates the release package, site downloads or manifest.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[2] && resolve(process.argv[2]);
const version = process.argv[3] || "0.2.0-preview.1";
if (!destination || !/^\d+\.\d+\.\d+-preview\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/build-zioon-cli-preview.mjs <output-dir> [0.2.0-preview.1]");
}
const source = join(root, "packages/zioon-cli");
const staging = join(destination, "package");
await mkdir(join(staging, "dist"), { recursive: true });
for (const name of ["cli", "sdk"]) {
  await build({
    entryPoints: [join(source, `src/${name}.mjs`)], outfile: join(staging, `dist/${name}.mjs`),
    bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    logLevel: "warning"
  });
}
for (const name of ["bin", "README.md"]) await cp(join(source, name), join(staging, name), { recursive: true });
await cp(process.env.ZIOON_SKILL_SOURCE ? resolve(process.env.ZIOON_SKILL_SOURCE)
  : join(source, "skills/zioon"), join(staging, "skills/zioon"), { recursive: true });
const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
await writeFile(join(staging, "package.json"), `${JSON.stringify({ ...metadata, version }, null, 2)}\n`);
await chmod(join(staging, "bin/zioon.mjs"), 0o755);
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", destination], { cwd: staging, encoding: "utf8" }));
const hash = createHash("sha256").update(await readFile(join(destination, packed.filename))).digest("hex");
const manifest = { version, package: packed.filename, sha256: hash, size: packed.size, unpackedSize: packed.unpackedSize, dependencies: 0 };
await writeFile(join(destination, "preview.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
