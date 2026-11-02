#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
};

if (args.includes("--help")) {
  console.log("Install the local-development zion command.\n"
    + "Options: --source <repository> --bin-dir <directory> --url <Runtime URL> --profile <name>");
  process.exit(0);
}
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) throw new Error("Zion requires Node.js >=22.5");
const explicitSource = option("--source", "");
const candidates = explicitSource ? [explicitSource] : [
  join(repository, ".worktrees/extension-marketplace"),
  repository,
  join(repository, ".worktrees/sandbox-runtime-integration")
];
const source = candidates.map((path) => resolve(path))
  .find((path) => existsSync(join(path, "apps/runtime/bin/zion.mjs")));
if (!source) throw new Error("Cannot find the Zion Runtime CLI; pass --source <repository>");
const entry = await realpath(join(source, "apps/runtime/bin/zion.mjs"));
execFileSync(process.execPath, [entry, "--help"], { stdio: "pipe" });

const binDirectory = resolve(option("--bin-dir", join(homedir(), ".local/bin")));
await mkdir(binDirectory, { recursive: true });
const gitDirectory = (path) => {
  try { return execFileSync("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const sourceGit = gitDirectory(source);
const launchers = [];
for (const name of ["zion", "zioon"]) {
  const launcher = join(binDirectory, name);
  const existing = await lstat(launcher).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    const target = existing.isSymbolicLink() ? resolve(binDirectory, await readlink(launcher)) : "";
    const sameSource = target === entry;
    const ownedSource = target.endsWith("/apps/runtime/bin/zion.mjs") && sourceGit
      && gitDirectory(resolve(dirname(target), "../../..")) === sourceGit;
    if (!sameSource && !ownedSource) throw new Error(`Existing command at ${launcher} was preserved; choose another --bin-dir`);
  }
  launchers.push(launcher);
}

const endpoint = new URL(option("--url", "https://runtime.zioon.tech"));
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/"
  || !["https:", "http:"].includes(endpoint.protocol)
  || (endpoint.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) {
  throw new Error("Runtime URL must be credential-free HTTPS or loopback HTTP");
}
const configPath = join(homedir(), ".zion-next/cli.json");
let config = { version: 1, profiles: {} };
try { config = JSON.parse(await readFile(configPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw new Error("Existing CLI config is invalid and was preserved"); }
if (config.version !== 1 || !config.profiles || typeof config.profiles !== "object" || Array.isArray(config.profiles)) {
  throw new Error("Existing CLI config has an unsupported format and was preserved");
}
const requestedProfile = option("--profile", "zioon-cloud");
let profileName = requestedProfile;
for (let suffix = 2; config.profiles[profileName]; suffix++) {
  const profile = config.profiles[profileName];
  if (profile.url === endpoint.origin && profile.auth?.type === "account") break;
  profileName = `${requestedProfile}-${suffix}`;
}
config.profiles[profileName] = { ...config.profiles[profileName], url: endpoint.origin, auth: { type: "account" } };
if (!config.defaultProfile) config.defaultProfile = profileName;
await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
const temporary = `${configPath}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
await rename(temporary, configPath);
for (const launcher of launchers) {
  const temporaryLink = `${launcher}.${process.pid}.tmp`;
  await symlink(entry, temporaryLink);
  await rename(temporaryLink, launcher);
}

console.log(`Installed: ${launchers.join(", ")}`);
console.log(`Source: ${source}`);
console.log(`Account profile: ${profileName} (${endpoint.origin})`);
console.log(`Default profile: ${config.defaultProfile}`);
console.log(`Next: zion auth login ${profileName}`);
if (!String(process.env.PATH || "").split(":").includes(binDirectory)) {
  console.log(`Add ${binDirectory} to PATH in your shell before using zion.`);
}
