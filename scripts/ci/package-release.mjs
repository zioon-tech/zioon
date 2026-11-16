import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const component = process.argv[2];
const stage = resolve(".release-stage", component);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const copy = (from, to = from) => cpSync(from, resolve(stage, to), {
  recursive: true, verbatimSymlinks: true,
});
if (component === "runtime") {
  execFileSync("bash", ["-e", "-o", "pipefail", "-c", 'git archive HEAD | tar -x -C "$1"', "_", stage]);
  copy("node_modules");
  copy("apps/runtime/node_modules");
  for (const entry of readdirSync("packages")) {
    if (existsSync(`packages/${entry}/dist`)) copy(`packages/${entry}/dist`);
  }
  // These browser libraries are bundled into Workbench. Keeping them as root
  // production dependencies otherwise adds >120 MiB to every Runtime archive.
  // Change only the staged manifest; product development/builds keep their
  // original dependency tree. npm computes and prunes transitive dependencies.
  const manifestPath = resolve(stage, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const frontendOnly = ["monaco-editor", "mermaid", "lucide-react"];
  for (const name of frontendOnly) {
    if (!manifest.dependencies[name]) throw new Error(`Missing classified browser dependency: ${name}`);
    manifest.devDependencies[name] = manifest.dependencies[name];
    delete manifest.dependencies[name];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("npm", ["prune", "--omit=dev", "--ignore-scripts"], { cwd: stage, stdio: "inherit" });
  for (const name of frontendOnly) {
    if (existsSync(resolve(stage, "node_modules", name))) {
      throw new Error(`Runtime archive still contains browser dependency: ${name}`);
    }
  }
  // Sandbox has its own lockfile and is not part of the root dependency tree.
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--prefix", "packages/sandbox"],
    { cwd: stage, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/ci/verify-runtime-release.mjs"],
    { cwd: stage, stdio: "inherit" });
} else if (component === "workbench") {
  copy("dist", ".");
} else if (component === "portals") {
  copy("apps/client-portal/server");
  copy("apps/marketplace/server/app.mjs");
  copy("dist/mobile", "mobile");
  copy("dist/admin", "admin");
} else if (component === "marketplace") {
  copy("apps/marketplace/dist", "dist");
  copy("apps/marketplace/server", "apps/marketplace/server");
} else if (component === "public-site") {
  copy("apps/public-site/dist", ".");
} else throw new Error(`Unsupported component: ${component}`);
execFileSync("python3", [resolve(process.env.RELEASE_TOOLS_DIR || ".release-tools", "scripts/pack.py"),
  "--stage", stage, "--output", resolve(".release-out", component),
  "--product", "zioon", "--component", component], { stdio: "inherit" });
