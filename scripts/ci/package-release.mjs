import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
  execFileSync("npm", ["prune", "--omit=dev", "--ignore-scripts"], { cwd: stage, stdio: "inherit" });
  // Resolve the entrypoint's dependency graph inside the staged release.
  execFileSync(process.execPath, ["--input-type=module", "-e",
    'await import("./apps/runtime/src/server.mjs")'], { cwd: stage, stdio: "inherit" });
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
