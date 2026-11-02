import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createDeviceCredentialStore,
  deviceCredentialKey
} from "../apps/device-connector/src/device-credential-store.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const runtimeUrl = process.env.ZION_RUNTIME_URL || "http://127.0.0.1:18866";
const localToolsUrl = process.env.ZION_LOCAL_TOOLS_URL || "http://127.0.0.1:8765";
const pluginServiceUrl = process.env.ZION_PLUGIN_SERVICE_URL || "http://127.0.0.1:8767";
const nodeId = process.env.ZION_NODE_ID || "node:core-observability-local";
const workspaceRoot = resolve(process.env.ZION_NODE_WORKSPACE_ROOT || repository);
const projectId = process.env.ZION_NODE_PROJECT_ID || "core-observability";
const resourceId = process.env.ZION_NODE_RESOURCE_ID || `workspace:${projectId}`;
const localDataRoot = join(repository, ".account-data/local");
const deviceAccessPolicy = process.env.ZION_DEVICE_ACCESS_POLICY
  || join(localDataRoot, "device-access-permissive.json");

const help = `Usage:
  npm run accounts:local:full -- [owner-email]

Environment:
  ZION_LOCAL_TOOLS_DIR       Path to zion-local-tools checkout
  ZION_LOCAL_OWNER_EMAIL     Owner email for first local account bootstrap
  ZION_DEVICE_PAIRING_CODE   Optional first-time resource pairing code
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
    for (const line of lines) {
      output.write(`[${name}] ${line}\n`);
    }
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
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.once("exit", (code, signal) => {
    if (code || signal) {
      process.stderr.write(`[${name}] exited: ${signal || code}\n`);
    }
  });
  child.once("error", (error) => {
    process.stderr.write(`[${name}] failed: ${error.message}\n`);
  });
  prefixStream(name, child.stdout, process.stdout);
  prefixStream(name, child.stderr, process.stderr);
  children.push({ name, child });
  return child;
}

async function waitHttp(url, {
  name,
  child,
  attempts = 100,
  ok = (response) => response.ok
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child?.exitCode !== null) {
      throw new Error(`${name} exited before becoming ready`);
    }
    const ready = await fetch(url, { signal: AbortSignal.timeout(1000) })
      .then(ok)
      .catch(() => false);
    if (ready) return;
    await delay(150);
  }
  throw new Error(`${name} did not become ready: ${url}`);
}

async function assertNotServing(url, name) {
  const serving = await fetch(url, { signal: AbortSignal.timeout(500) })
    .then(() => true)
    .catch(() => false);
  if (serving) {
    throw new Error(`${name} is already running at ${url}; stop the old process first.`);
  }
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
  mkdirSync(dirname(deviceAccessPolicy), { recursive: true, mode: 0o700 });
  writeFileSync(deviceAccessPolicy, `${JSON.stringify({
    version: 1,
    scope: "selected-roots",
    permissions: { read: true, write: true, execute: true },
    selectedRoots: ["/"],
    sensitiveExceptions: ["/"],
    requests: [],
    updatedAt: Date.now()
  }, null, 2)}\n`, { mode: 0o600 });
}

async function hasConnectorCredential() {
  if (String(process.env.ZION_DEVICE_TOKEN || "").trim()) return true;
  if (String(process.env.ZION_DEVICE_PAIRING_CODE || "").trim()) return true;
  try {
    const stored = await createDeviceCredentialStore()
      .get(deviceCredentialKey(runtimeUrl, nodeId));
    return !!stored?.credential && Number(stored.expiresAt || 0) > Date.now();
  } catch {
    return false;
  }
}

export async function runLocalFullStack(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(help);
    return;
  }
  const ownerEmail = argv.find((arg) => !arg.startsWith("-"))
    || process.env.ZION_LOCAL_OWNER_EMAIL
    || "";
  const children = [];
  const localToolsRoot = resolveLocalToolsRoot();
  const python = pythonFor(localToolsRoot);
  writePermissiveDevicePolicy();
  await assertNotServing(`${localToolsUrl}/health`, "local-tools");
  await assertNotServing(`${pluginServiceUrl}/health`, "plugin-host");
  await assertNotServing(`${runtimeUrl}/health`, "Runtime");

  const stop = async () => {
    await stopChildren(children);
  };
  process.once("SIGINT", () => {
    void stop().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void stop().finally(() => process.exit(143));
  });

  const localTools = spawnChild("local-tools", python, ["run.py"], {
    cwd: localToolsRoot,
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
  await waitHttp(`${localToolsUrl}/health`, { name: "local-tools", child: localTools });

  const pluginHost = spawnChild("plugin-host", python, ["run_plugin_host.py"], {
    cwd: localToolsRoot,
    children,
    env: {
      ZION_PLUGIN_HOST: "127.0.0.1",
      ZION_PLUGIN_PORT: "8767",
      ZION_PLUGIN_RELOAD: process.env.ZION_PLUGIN_RELOAD || "1",
      ZION_REDIS_ENABLED: process.env.ZION_REDIS_ENABLED || "0"
    }
  });
  await waitHttp(`${pluginServiceUrl}/health`, { name: "plugin-host", child: pluginHost });

  const accountArgs = [join(repository, "scripts/local-accounts.mjs"), "up"];
  if (ownerEmail) accountArgs.push(ownerEmail);
  const accounts = spawnChild("accounts", process.execPath, accountArgs, {
    cwd: repository,
    children,
    env: {
      ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION: "1",
      ZION_ALLOW_DANGEROUS: "1",
      ZION_PLUGIN_DATA_HOST: process.env.ZION_PLUGIN_DATA_HOST || "auto",
      ZION_PLUGIN_DATA_NODE_ID: nodeId,
      ZION_PLUGIN_DATA_SCOPE: process.env.ZION_PLUGIN_DATA_SCOPE || "legacy",
      ZION_PLUGIN_DATA_LEGACY_READ_ACCOUNT_ID:
        process.env.ZION_PLUGIN_DATA_LEGACY_READ_ACCOUNT_ID || ""
    }
  });
  await waitHttp(`${runtimeUrl}/health`, {
    name: "accounts-runtime",
    child: accounts,
    ok: (response) => response.ok || response.status === 401
  });

  let connector = null;
  const shouldStartConnector = await hasConnectorCredential();
  const connectorArgs = [
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
    "--access-policy", deviceAccessPolicy
  ];
  if (shouldStartConnector) {
    connector = spawnChild("connector", process.execPath, connectorArgs, {
      cwd: repository,
      children,
      env: {
        ZION_ALLOW_DANGEROUS: "1"
      }
    });
  }

  process.stdout.write("\nLocal full stack is starting with permissive local access.\n");
  process.stdout.write(`Workbench: ${runtimeUrl}/\n`);
  process.stdout.write(`Device policy: ${deviceAccessPolicy}\n`);
  if (!shouldStartConnector) {
    process.stdout.write(
      "If Connector has no stored credential, create a resource pairing in the account UI "
      + "and restart this command with ZION_DEVICE_PAIRING_CODE=<code>.\n"
    );
  }
  process.stdout.write("Press Ctrl-C to stop all child processes.\n\n");

  await new Promise((resolvePromise) => {
    for (const { child } of children) child.once("exit", resolvePromise);
    connector?.once("exit", resolvePromise);
  });
  await stop();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalFullStack().catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
