/* global AbortSignal, fetch */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import {
  createDeviceCredentialStore,
  deviceCredentialKey
} from "../apps/device-connector/src/device-credential-store.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const runtimeDnsPreload = pathToFileURL(
  join(repository, "scripts/force-runtime-dns.mjs")
).href;
const runtimeUrl = process.env.ZION_ONLINE_RUNTIME_URL || "https://47-101-150-8.nip.io:8443";
const localToolsUrl = process.env.ZION_LOCAL_TOOLS_URL || "http://127.0.0.1:8765";
const pluginServiceUrl = process.env.ZION_PLUGIN_SERVICE_URL || "http://127.0.0.1:8767";
const nodeId = process.env.ZION_NODE_ID || "node:macbook-permissive-online";
const workspaceRoot = resolve(process.env.ZION_NODE_WORKSPACE_ROOT || homedir());
const projectId = process.env.ZION_NODE_PROJECT_ID || "macbook-permissive-online";
const resourceId = process.env.ZION_NODE_RESOURCE_ID || `workspace:${projectId}`;
const policyPath = process.env.ZION_DEVICE_ACCESS_POLICY
  || join(homedir(), ".zion-next/device-access-runtime-zioon-permissive.json");
const CONNECTOR_RESTART_FAST_FAILURE_LIMIT = 3;

const help = `Usage:
  npm run tools:online -- [pairing-code]

First run:
  1. Open https://runtime.zioon.tech/account
  2. Create a Tool computer / Resource pairing code
  3. Run: npm run tools:online -- <pairing-code>

After the first successful pairing:
  npm run tools:online

The command stays in the foreground and restarts the online connector after
network drops or laptop sleep. Press Ctrl-C to stop it.
`;

function localToolsCandidates() {
  return [
    process.env.ZION_LOCAL_TOOLS_DIR,
    join(repository, "../zion-local-tools"),
    join(repository, "../../../zion-local-tools"),
    join(homedir(), "Downloads/zion-local-tools")
  ].filter(Boolean);
}

function resolveLocalToolsRoot() {
  for (const candidate of localToolsCandidates()) {
    const root = resolve(candidate);
    if (existsSync(join(root, "run.py"))) return root;
  }
  throw new Error(
    "Could not find zion-local-tools. Set ZION_LOCAL_TOOLS_DIR to the checkout path."
  );
}

function pythonFor(root) {
  const local = join(root, ".venv/bin/python");
  return existsSync(local) ? local : "python3";
}

function prefixStream(name, stream, output) {
  let pending = "";
  stream?.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) output.write(`[${name}] ${line}\n`);
  });
  stream?.on("end", () => {
    if (pending) output.write(`[${name}] ${pending}\n`);
  });
}

function spawnChild(name, command, args, {
  cwd = repository,
  env = {},
  children
} = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.once("exit", (code, signal) => {
    if (code || signal) process.stderr.write(`[${name}] exited: ${signal || code}\n`);
  });
  child.once("error", (error) => {
    process.stderr.write(`[${name}] failed: ${error.message}\n`);
  });
  prefixStream(name, child.stdout, process.stdout);
  prefixStream(name, child.stderr, process.stderr);
  children.push({ name, child });
  return child;
}

function withRuntimeDnsPreload(env = {}) {
  const current = String(env.NODE_OPTIONS || process.env.NODE_OPTIONS || "").trim();
  const preload = `--import=${runtimeDnsPreload}`;
  return {
    ...env,
    NODE_OPTIONS: current.includes(preload)
      ? current
      : [current, preload].filter(Boolean).join(" ")
  };
}

async function isServing(url) {
  return await fetch(url, { signal: AbortSignal.timeout(700) })
    .then((response) => response.ok || response.status === 401)
    .catch(() => false);
}

async function waitHttp(url, {
  name,
  child,
  attempts = 100,
  ok = (response) => response.ok
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child?.exitCode !== null) throw new Error(`${name} exited before becoming ready`);
    const ready = await fetch(url, { signal: AbortSignal.timeout(1000) })
      .then(ok)
      .catch(() => false);
    if (ready) return;
    await delay(150);
  }
  throw new Error(`${name} did not become ready: ${url}`);
}

async function stopChildren(children) {
  for (const { child } of [...children].reverse()) {
    if (!child || child.exitCode !== null) continue;
    child.kill("SIGTERM");
  }
  await Promise.all(children.map(({ child }) => (
    child.exitCode !== null
      ? Promise.resolve()
      : Promise.race([
          new Promise((resolvePromise) => child.once("exit", resolvePromise)),
          delay(5000).then(() => child.kill("SIGKILL"))
        ])
  )));
}

function writePermissiveDevicePolicy() {
  mkdirSync(dirname(policyPath), { recursive: true, mode: 0o700 });
  writeFileSync(policyPath, `${JSON.stringify({
    version: 1,
    scope: "selected-roots",
    permissions: { read: true, write: true, execute: true },
    selectedRoots: ["/"],
    sensitiveExceptions: ["/"],
    requests: [],
    updatedAt: Date.now()
  }, null, 2)}\n`, { mode: 0o600 });
}

async function hasConnectorCredential(pairingCode) {
  if (String(process.env.ZION_DEVICE_TOKEN || "").trim()) return true;
  if (String(pairingCode || process.env.ZION_DEVICE_PAIRING_CODE || "").trim()) return true;
  try {
    const stored = await createDeviceCredentialStore()
      .get(deviceCredentialKey(runtimeUrl, nodeId));
    return !!stored?.credential && Number(stored.expiresAt || 0) > Date.now();
  } catch {
    return false;
  }
}

async function ensureLocalTools(children) {
  if (await isServing(`${localToolsUrl}/health`)) {
    process.stdout.write(`[local-tools] reusing ${localToolsUrl}\n`);
    return;
  }
  const root = resolveLocalToolsRoot();
  const child = spawnChild("local-tools", pythonFor(root), ["run.py"], {
    cwd: root,
    children,
    env: {
      ZION_LOCAL_HOST: "127.0.0.1",
      ZION_LOCAL_PORT: "8765",
      ZION_BASH_SANDBOX: "1",
      ZION_ALLOW_DANGEROUS: "1",
      ZION_ENABLE_LEGACY_CONTROL_PLANE: "0",
      ZION_ENABLE_PLUGIN_HOSTING: "0",
      ZION_REDIS_ENABLED: process.env.ZION_REDIS_ENABLED || "0"
    }
  });
  await waitHttp(`${localToolsUrl}/health`, { name: "local-tools", child });
}

async function ensurePluginHost(children) {
  if (await isServing(`${pluginServiceUrl}/health`)) {
    process.stdout.write(`[plugin-host] reusing ${pluginServiceUrl}\n`);
    return;
  }
  const root = resolveLocalToolsRoot();
  const child = spawnChild("plugin-host", pythonFor(root), ["run_plugin_host.py"], {
    cwd: root,
    children,
    env: {
      ZION_PLUGIN_HOST: "127.0.0.1",
      ZION_PLUGIN_PORT: "8767",
      ZION_PLUGIN_RELOAD: process.env.ZION_PLUGIN_RELOAD || "1",
      ZION_REDIS_ENABLED: process.env.ZION_REDIS_ENABLED || "0"
    }
  });
  await waitHttp(`${pluginServiceUrl}/health`, { name: "plugin-host", child });
}

function spawnOnlineConnector({
  pairingCode,
  children,
  usePairingCode
}) {
  return spawnChild("online-connector", process.execPath, [
    join(repository, "apps/device-connector/src/main.mjs"),
    "--runtime-url", runtimeUrl,
    "--local-tools-url", localToolsUrl,
    "--plugin-service-url", pluginServiceUrl,
    "--node-id", nodeId,
    "--workspace-root", workspaceRoot,
    "--project-id", projectId,
    "--resource-id", resourceId,
    "--additional-roots", "/",
    "--access-scope", "selected-roots",
    "--access-policy", policyPath
  ], {
    cwd: repository,
    children,
    env: withRuntimeDnsPreload({
      ZION_ALLOW_DANGEROUS: "1",
      ...(usePairingCode && pairingCode ? { ZION_DEVICE_PAIRING_CODE: pairingCode } : {})
    })
  });
}

async function runConnectorForever({
  pairingCode,
  children,
  isStopping
}) {
  let fastFailures = 0;
  for (;;) {
    const hasStoredCredential = await hasConnectorCredential("");
    const usePairingCode = !hasStoredCredential && !!pairingCode;
    const startedAt = Date.now();
    const connector = spawnOnlineConnector({
      pairingCode,
      children,
      usePairingCode
    });
    await new Promise((resolvePromise) => connector.once("exit", resolvePromise));
    if (isStopping()) return;

    const runtimeMs = Date.now() - startedAt;
    const hasUsableCredential = await hasConnectorCredential("");
    if (!hasUsableCredential && !pairingCode) {
      throw new Error(
        "Online connector exited and no stored credential is available. "
        + "Run: npm run tools:online -- <pairing-code>"
      );
    }
    if (!hasUsableCredential && runtimeMs < 15_000) {
      fastFailures += 1;
      if (fastFailures >= CONNECTOR_RESTART_FAST_FAILURE_LIMIT) {
        throw new Error(
          "Online connector exited before saving a credential. "
          + "The pairing code may be invalid/expired, or the network cannot reach Runtime."
        );
      }
    } else {
      fastFailures = 0;
    }

    const restartDelayMs = runtimeMs < 30_000
      ? Math.min(30_000, 2_000 * (2 ** fastFailures))
      : 3_000;
    process.stderr.write(
      `[online-connector] restarting in ${Math.round(restartDelayMs / 1000)}s; `
      + "keep this Terminal open or press Ctrl-C to stop\n"
    );
    await delay(restartDelayMs);
  }
}

export async function runOnlineToolsPermissive(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(help);
    return;
  }
  const pairingCode = argv.find((arg) => !arg.startsWith("-")) || "";
  const children = [];
  let stopping = false;
  writePermissiveDevicePolicy();

  const stop = async () => {
    stopping = true;
    await stopChildren(children);
  };
  process.once("SIGINT", () => {
    void stop().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void stop().finally(() => process.exit(143));
  });

  await ensureLocalTools(children);
  await ensurePluginHost(children);
  if (!await hasConnectorCredential(pairingCode)) {
    throw new Error(
      "First run needs a runtime.zioon.tech Tool computer pairing code. "
      + "Run: npm run tools:online -- <pairing-code>"
    );
  }

  process.stdout.write("\nOnline tools connector is starting with permissive access.\n");
  process.stdout.write(`Runtime: ${runtimeUrl}\n`);
  process.stdout.write(`Node: ${nodeId} (${hostname()})\n`);
  process.stdout.write(`Device policy: ${policyPath}\n`);
  process.stdout.write("Keep this Terminal open. The connector will reconnect after network drops or laptop wake. Press Ctrl-C to stop.\n\n");

  await runConnectorForever({
    pairingCode,
    children,
    isStopping: () => stopping
  });
  await stop();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOnlineToolsPermissive().catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
    process.kill(process.pid, "SIGTERM");
  });
}
