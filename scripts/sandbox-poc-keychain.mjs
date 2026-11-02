#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const region = process.env.ZION_SANDBOX_REGION || "cn-shanghai";
const teamId = process.env.ZION_SANDBOX_TEAM_ID;
if (!teamId || !/^[a-zA-Z0-9-]{1,100}$/.test(teamId)) {
  throw new Error("Set ZION_SANDBOX_TEAM_ID to the PoC Team ID");
}

let saved;
try {
  saved = JSON.parse(execFileSync("security", [
    "find-generic-password",
    "-s", "dev.zion.sandbox-poc",
    "-a", `aliyun:${region}:${teamId}`,
    "-w"
  ], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  }).trim());
} catch {
  throw new Error("PoC Sandbox API Key is unavailable in macOS Keychain");
}
if (
  typeof saved.apiKey !== "string"
  || !saved.apiKey
  || saved.teamID !== teamId
  || saved.region !== region
) {
  throw new Error("PoC Sandbox Keychain entry does not match Team and region");
}

process.env.E2B_API_KEY = saved.apiKey;
process.env.ZION_SANDBOX_PROVIDER ||= "aliyun";
process.env.ZION_SANDBOX_REGION = region;
await import("./sandbox-poc.mjs");
