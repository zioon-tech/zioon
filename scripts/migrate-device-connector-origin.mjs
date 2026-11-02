#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  statSync
} from "node:fs";
import { hostname } from "node:os";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL, URL } from "node:url";

const DEFAULT_LABEL = "dev.zion.device-connector";
const USAGE = `Usage:
  npm run device:migrate-origin -- --runtime-url <https-origin> [options]

Before running:
  1. Sign in as Owner at the new Workbench URL.
  2. Revoke the existing Resource device with the same node ID.
  3. Create a new "Tool computer" pairing code.

Options:
  --runtime-url <url>  New Runtime HTTPS origin (required)
  --plist <path>       LaunchAgent plist path
  --label <label>      LaunchAgent and Keychain service (default:
                       dev.zion.device-connector)
  --repair             Rebuild plist arguments and reuse an existing credential
  --dry-run            Show the planned change without stopping the Connector
  --help               Show this help

The pairing code is read from ZION_DEVICE_PAIRING_CODE or from a hidden prompt.
Do not put it directly in shell history.
`;

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--repair", "--dry-run", "--help"].includes(key)) {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    values.set(key, value);
    index += 1;
  }
  return {
    value(name, fallback = "") {
      return values.get(name) ?? fallback;
    },
    has(name) {
      return flags.has(name);
    }
  };
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function plistValue(path, key) {
  return run("/usr/bin/plutil", [
    "-extract", key, "raw", "-o", "-", path
  ]).stdout.trim();
}

function plistJson(path, key, fallback) {
  const result = run("/usr/bin/plutil", [
    "-extract", key, "json", "-o", "-", path
  ], { allowFailure: true });
  if (result.status !== 0) return fallback;
  return JSON.parse(result.stdout);
}

export function normalizeRuntimeOrigin(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") {
    throw new Error("Remote Runtime URL must use HTTPS");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Runtime URL must be an origin without path or credentials");
  }
  return url.origin;
}

export function replaceRuntimeUrlArgument(programArguments, runtimeOrigin) {
  const values = [...programArguments];
  const index = values.indexOf("--runtime-url");
  if (index < 0) {
    values.push("--runtime-url", runtimeOrigin);
    return values;
  }
  if (!values[index + 1] || values[index + 1].startsWith("--")) {
    values.splice(index + 1, 0, runtimeOrigin);
  } else {
    values[index + 1] = runtimeOrigin;
  }
  while (
    values[index + 2]
    && !values[index + 2].startsWith("--")
    && /^https?:\/\//i.test(values[index + 2])
  ) {
    values.splice(index + 2, 1);
  }
  return values;
}

function nodeIdFromArguments(programArguments) {
  const index = programArguments.indexOf("--node-id");
  if (index >= 0 && programArguments[index + 1]) {
    return programArguments[index + 1];
  }
  const normalized = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `node:${normalized || "local"}`;
}

async function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Set ZION_DEVICE_PAIRING_CODE when stdin is not an interactive terminal"
    );
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Pairing canceled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolvePromise(value.trim());
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

function stopLaunchAgent(plistPath) {
  const domain = `gui/${process.getuid()}`;
  run("launchctl", ["bootout", domain, plistPath], { allowFailure: true });
  return domain;
}

function startLaunchAgent(domain, label, plistPath) {
  run("launchctl", ["bootstrap", domain, plistPath]);
  run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
}

function installProgramArguments(plistPath, programArguments) {
  run("/usr/bin/plutil", [
    "-replace",
    "ProgramArguments",
    "-json",
    JSON.stringify(programArguments),
    plistPath
  ]);
  run("/usr/bin/plutil", ["-lint", plistPath]);
}

async function verifyLaunchAgent(domain, label, runtimeOrigin) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  const launchState = run("launchctl", [
    "print", `${domain}/${label}`
  ]).stdout;
  if (!launchState.includes(runtimeOrigin)) {
    throw new Error("LaunchAgent is not using the new Runtime URL");
  }
}

function waitForConnector(child, runtimeOrigin, timeoutMs = 45_000) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(
        `Connector did not connect within ${timeoutMs / 1_000}s\n${stderr}`
      ));
    }, timeoutMs);
    const settle = (handler, value) => {
      clearTimeout(timer);
      child.removeAllListeners("exit");
      handler(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
      if (stdout.includes(`connected to ${runtimeOrigin}`)) {
        settle(resolvePromise, { stdout, stderr });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.once("exit", (code, signal) => {
      settle(reject, new Error(
        `Connector exited before registration (${signal || code})\n${stderr}`
      ));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))
  ]);
  if (child.exitCode == null && !child.signalCode) child.kill("SIGKILL");
}

function keychainExists(label, account) {
  return run("/usr/bin/security", [
    "find-generic-password", "-s", label, "-a", account
  ], { allowFailure: true }).status === 0;
}

export async function runMigrationCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.has("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("This migration helper currently supports macOS only");
  }

  const runtimeOrigin = normalizeRuntimeOrigin(args.value("--runtime-url"));
  const label = args.value("--label", DEFAULT_LABEL);
  const plistPath = args.value(
    "--plist",
    `${process.env.HOME}/Library/LaunchAgents/${label}.plist`
  );
  if (!existsSync(plistPath)) {
    throw new Error(`LaunchAgent plist not found: ${plistPath}`);
  }

  const originalArguments = plistJson(plistPath, "ProgramArguments", []);
  if (!Array.isArray(originalArguments) || originalArguments.length < 2) {
    throw new Error("LaunchAgent ProgramArguments is missing or invalid");
  }
  const migratedArguments = replaceRuntimeUrlArgument(
    originalArguments,
    runtimeOrigin
  );
  const oldRuntimeIndex = originalArguments.indexOf("--runtime-url");
  const oldRuntimeOrigin = oldRuntimeIndex >= 0
    ? normalizeRuntimeOrigin(originalArguments[oldRuntimeIndex + 1])
    : "";
  const nodeId = nodeIdFromArguments(migratedArguments);
  const workingDirectory = plistValue(plistPath, "WorkingDirectory");
  const launchEnvironment = plistJson(plistPath, "EnvironmentVariables", {});
  const argumentsChanged = JSON.stringify(originalArguments)
    !== JSON.stringify(migratedArguments);

  process.stdout.write(`LaunchAgent: ${plistPath}
Node: ${nodeId}
Old Runtime: ${oldRuntimeOrigin || "not configured"}
New Runtime: ${runtimeOrigin}
ProgramArguments change required: ${argumentsChanged ? "yes" : "no"}
`);
  if (args.has("--dry-run")) {
    process.stdout.write("Dry run only; no files or credentials changed.\n");
    return;
  }

  let pairingCode = "";
  if (args.has("--repair")) {
    const account = `${runtimeOrigin}|${nodeId}`;
    if (!keychainExists(label, account)) {
      throw new Error(`No existing Keychain credential for ${account}`);
    }
  } else {
    pairingCode = String(
      process.env.ZION_DEVICE_PAIRING_CODE
      || await readHidden("Tool computer pairing code: ")
    ).trim();
    if (!pairingCode) throw new Error("Pairing code is required");
  }

  const domain = `gui/${process.getuid()}`;
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const backupPath = `${plistPath}.before-origin-${timestamp}`;
  const originalStat = statSync(plistPath);
  copyFileSync(plistPath, backupPath);
  chmodSync(backupPath, originalStat.mode);

  if (args.has("--repair")) {
    stopLaunchAgent(plistPath);
    let installed = false;
    try {
      installProgramArguments(plistPath, migratedArguments);
      startLaunchAgent(domain, label, plistPath);
      await verifyLaunchAgent(domain, label, runtimeOrigin);
      installed = true;
      process.stdout.write(
        `Connector LaunchAgent repaired.\nBackup: ${backupPath}\n`
        + `Runtime: ${runtimeOrigin}\nNode: ${nodeId}\n`
      );
    } finally {
      if (!installed) {
        copyFileSync(backupPath, plistPath);
        chmodSync(plistPath, originalStat.mode);
        run("launchctl", ["bootout", domain, plistPath], { allowFailure: true });
        startLaunchAgent(domain, label, plistPath);
        process.stderr.write(`Repair failed; restored ${backupPath}\n`);
      }
    }
    return;
  }

  stopLaunchAgent(plistPath);
  let child = null;
  let installed = false;
  try {
    child = spawn(migratedArguments[0], migratedArguments.slice(1), {
      cwd: workingDirectory,
      env: {
        ...process.env,
        ...launchEnvironment,
        ZION_DEVICE_PAIRING_CODE: pairingCode
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForConnector(child, runtimeOrigin);
    await stopChild(child);
    child = null;

    installProgramArguments(plistPath, migratedArguments);
    startLaunchAgent(domain, label, plistPath);
    await verifyLaunchAgent(domain, label, runtimeOrigin);
    const newAccount = `${runtimeOrigin}|${nodeId}`;
    if (!keychainExists(label, newAccount)) {
      throw new Error("New Device credential was not saved to Keychain");
    }
    if (oldRuntimeOrigin && oldRuntimeOrigin !== runtimeOrigin) {
      run("/usr/bin/security", [
        "delete-generic-password",
        "-s", label,
        "-a", `${oldRuntimeOrigin}|${nodeId}`
      ], { allowFailure: true });
    }
    installed = true;
    process.stdout.write(
      `Connector migration completed.\nBackup: ${backupPath}\n`
      + `Runtime: ${runtimeOrigin}\nNode: ${nodeId}\n`
    );
  } finally {
    if (child) await stopChild(child);
    if (!installed) {
      copyFileSync(backupPath, plistPath);
      chmodSync(plistPath, originalStat.mode);
      run("launchctl", ["bootout", domain, plistPath], { allowFailure: true });
      startLaunchAgent(domain, label, plistPath);
      process.stderr.write(`Migration failed; restored ${backupPath}\n`);
    }
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runMigrationCli().catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
