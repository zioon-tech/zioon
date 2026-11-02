#!/usr/bin/env node
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  sandboxConfig, configSummary, ManagedSandboxProvider, SandboxJournal, SandboxPocController
} from "../packages/sandbox/src/index.mjs";

const args = process.argv.slice(2);
const command = args[0] || "preflight";
const allowed = new Set(["preflight", "run", "audit", "cleanup"]);
if (!allowed.has(command)) throw new Error("Usage: sandbox-poc.mjs preflight [--live] | run [--pause] [--persistence] [--report path] | audit | cleanup");
const flags = new Set(["--live", "--pause", "--persistence"]);
for (let index = 1; index < args.length; index++) {
  if (["--journal", "--report"].includes(args[index])) {
    if (!args[++index] || args[index].startsWith("--")) throw new Error("Missing path argument");
  } else if (!flags.has(args[index])) throw new Error("Unknown PoC option");
}
function arg(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}
const config = sandboxConfig();
const journal = new SandboxJournal(resolve(arg("--journal", join(homedir(), ".zion-next", "sandbox-poc", "operations.json"))));
const summary = configSummary(config);
const checks = [];
const report = { kind: "zion-sandbox-poc", startedAt: new Date().toISOString(), config: summary, checks };
const hash = (content) => createHash("sha256").update(content).digest("hex");
async function check(name, action) {
  const start = Date.now();
  try {
    const value = await action();
    checks.push({ name, status: "passed", durationMs: Date.now() - start });
    return value;
  } catch (error) {
    checks.push({ name, status: "failed", durationMs: Date.now() - start, code: error.code || "check_failed" });
    throw error;
  }
}
async function main() {
  if (command === "preflight") {
    console.log(JSON.stringify({ ...summary, liveRequested: args.includes("--live"), liveChecked: false, journal: journal.path }, null, 2));
    if (summary.missing.length) { process.exitCode = 2; return; }
    if (args.includes("--live")) {
      const provider = new ManagedSandboxProvider(config);
      console.log(JSON.stringify({ ...await provider.preflight(), liveChecked: true }));
    }
    return;
  }
  const provider = new ManagedSandboxProvider(config);
  const controller = new SandboxPocController(provider, journal);
  if (command === "audit") {
    const audit = await controller.audit();
    console.log(JSON.stringify(audit, null, 2));
    if (audit.orphanedCloud.length || audit.missingCloud.length) process.exitCode = 1;
    return;
  }
  if (command === "cleanup") {
    const cleanup = await controller.cleanup();
    console.log(JSON.stringify(cleanup, null, 2));
    if (cleanup.some((item) => item.status !== "destroyed")) process.exitCode = 1;
    return;
  }
  if (args.includes("--pause") && !config.supportsPause) throw new Error("Confirm template pause support and set ZION_SANDBOX_PAUSE_VERIFIED=1 before this optional probe");
  const storageMetadata = JSON.parse(process.env.ZION_SANDBOX_STORAGE_METADATA || "{}");
  const storageNetwork = JSON.parse(process.env.ZION_SANDBOX_STORAGE_NETWORK || "null");
  if (args.includes("--persistence") && !storageMetadata["fc.sandbox.storage.agenticfs"]) {
    throw new Error("Persistence probe requires an isolated AgenticFS mount at /workspace");
  }
  const nonce = randomUUID();
  const scope = {
    accountId: process.env.ZION_SANDBOX_POC_ACCOUNT_ID || "account:poc",
    workspaceId: `workspace:${nonce}`, attemptId: `attempt:${nonce}`, epoch: 1
  };
  const file = `/workspace/zion-poc-${nonce}.txt`;
  const content = `zion-poc:${nonce}\n`;
  let handle;
  try {
    await check("nonbillable-authentication", () => provider.preflight());
    handle = await check("create", () => controller.create(scope, `create:${nonce}`, { storageMetadata, storageNetwork }));
    report.sandboxId = handle.sandboxId;
    const bootstrap = await check("command", async () => {
      const result = await controller.exec(handle, scope, `bootstrap:${nonce}`, {
        command: "mkdir -p /workspace && printf 'zion-sandbox-ready\\n'", timeoutMs: 30_000
      });
      if (result.exitCode !== 0 || result.stdout.trim() !== "zion-sandbox-ready") throw new Error("Unexpected bootstrap result");
      return result;
    });
    await check("root-workspace-and-egress-policy", async () => {
      const result = await controller.exec(handle, scope, `boundary:${nonce}`, {
        command: [
          "test \"$(id -u)\" = 0",
          "test -w /workspace",
          "if timeout 5 curl -fsS --max-time 3 https://example.com >/dev/null 2>&1; then exit 23; fi",
          "printf 'boundary-ok\\n'"
        ].join(" && "),
        timeoutMs: 30_000
      });
      if (result.exitCode !== 0 || result.stdout.trim() !== "boundary-ok") {
        throw new Error("Sandbox root/workspace/egress boundary check failed");
      }
    });
    await check("write", () => provider.write(handle, scope, file, content));
    await check("read-hash", async () => {
      if (hash(await provider.read(handle, scope, file)) !== hash(content)) throw new Error("File hash mismatch");
    });
    await check("receipt-replay", async () => {
      const replay = await controller.exec(handle, scope, `bootstrap:${nonce}`, {
        command: "mkdir -p /workspace && printf 'zion-sandbox-ready\\n'", timeoutMs: 30_000
      });
      if (hash(replay.stdout) !== hash(bootstrap.stdout)) throw new Error("Receipt mismatch");
    });
    if (args.includes("--pause")) {
      await check("pause", () => provider.pause(handle, scope));
      await check("inspect-without-resume", async () => {
        if ((await provider.inspect(handle, scope)).state !== "paused") throw new Error("Pause was not observed");
      });
      await check("resume", () => provider.resume(handle, scope));
      await check("resume-file", async () => {
        if (hash(await provider.read(handle, scope, file)) !== hash(content)) throw new Error("Resume file mismatch");
      });
    }
    if (args.includes("--persistence")) {
      await check("hard-destroy-first", () => provider.destroy(handle, scope));
      const secondScope = { ...scope, attemptId: `attempt:rebuild:${nonce}`, epoch: 2 };
      handle = await check("rebuild", () => controller.create(secondScope, `rebuild:${nonce}`, { storageMetadata, storageNetwork }));
      await check("persistent-file-after-rebuild", async () => {
        if (hash(await provider.read(handle, secondScope, file)) !== hash(content)) throw new Error("Persistent file mismatch");
      });
      await check("remove-own-test-file", async () => {
        const removal = await controller.exec(handle, secondScope, `remove:${nonce}`, {
          command: `rm -- '${file}'`, timeoutMs: 30_000
        });
        if (removal.exitCode !== 0) throw new Error("Test file cleanup failed");
      });
    }
    report.status = "passed";
  } finally {
    const cleanup = await check("cleanup", () => controller.cleanup());
    report.cleanup = cleanup;
    if (cleanup.some((item) => item.status !== "destroyed")) {
      report.status = "unresolved";
      throw new Error("Sandbox cleanup unresolved; inspect journal before running another probe");
    }
  }
}
try { await main(); }
catch (error) {
  if (report.status !== "unresolved") report.status = "failed";
  report.errorCode = error.code || "poc_failed";
  // Never print provider response bodies or credentials.
  console.error(JSON.stringify({ status: report.status, code: report.errorCode, message: error.code ? error.message : "PoC failed; inspect configuration and report" }));
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const destination = arg("--report", "");
  if (destination) {
    const path = resolve(destination);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  if (command === "run") console.log(JSON.stringify(report, null, 2));
}
