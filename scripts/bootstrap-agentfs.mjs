#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const commit = "aecd4c83606f45325daece46b01f0c38ad2cc0ed";
const destination = resolve(process.env.AGENT_FS_UPSTREAM_DIR || join(homedir(), ".zion-next/vendor/agent-fs"));
const bun = process.env.ZION_BUN_BINARY || "bun";
if (execFileSync(bun, ["--version"], { encoding: "utf8" }).trim() !== "1.4.1") {
  throw new Error("Install Bun 1.4.1 or set ZION_BUN_BINARY to its executable");
}
if (!existsSync(destination)) {
  await mkdir(resolve(destination, ".."), { recursive: true });
  execFileSync("git", ["clone", "https://github.com/desplega-ai/agent-fs.git", destination], { stdio: "inherit" });
  execFileSync("git", ["-C", destination, "checkout", "--detach", commit], { stdio: "inherit" });
}
const head = execFileSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const changes = execFileSync("git", ["-C", destination, "status", "--porcelain"], { encoding: "utf8" }).trim();
if (head !== commit || changes) throw new Error("Existing upstream checkout must be clean and match the pinned commit");
execFileSync(bun, ["install", "--frozen-lockfile"], { cwd: destination, stdio: "inherit" });
execFileSync(bun, ["install", "--frozen-lockfile"], {
  cwd: new URL("../apps/memory-service", import.meta.url), stdio: "inherit"
});
console.log(`agent-fs 0.18.5 ready at ${destination}`);
