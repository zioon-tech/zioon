import { spawn, execFile, execFileSync } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { createLocalDevOidc } from "../apps/runtime/src/accounts/local-dev-oidc.mjs";
import { PostgresAccountStore } from "../apps/runtime/src/accounts/postgres-account-store.mjs";
import { FileInteractionProfileStore } from "../apps/runtime/src/interaction-profile-store.mjs";
import { packageIdentityPlugin } from "./package-identity-plugin.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(process.env.ZION_SANDBOX_LOCAL_DIR || join(homedir(), ".zion-next/sandbox-demo"));
const runtimePort = Number(process.env.ZION_SANDBOX_LOCAL_PORT || 18891);
const identityPort = Number(process.env.ZION_SANDBOX_LOCAL_IDENTITY_PORT || 18091);
const origin = `http://127.0.0.1:${runtimePort}`;
const pidFile = join(directory, "supervisor.pid");
const action = process.argv[2] || "up";
const config = JSON.parse(await readFile(join(directory, "account.json"), "utf8"));
const runtimeSettings = await readFile(join(directory, "runtime-settings.json"), "utf8")
  .then(JSON.parse).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return {};
  });
const database = new URL(config.url);
if (!["postgres:", "postgresql:"].includes(database.protocol)
  || !["127.0.0.1", "localhost"].includes(database.hostname)
  || !/^[a-z][a-z0-9_]*$/.test(config.schema)) {
  throw new Error("Local sandbox requires a loopback database and a dedicated schema");
}
const poolOptions = { connectionString: config.url, options: `-c search_path=${config.schema}` };
const executeFile = promisify(execFile);

async function postgresReady() {
  const probe = new pg.Pool({ ...poolOptions, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch (error) {
    if (!["ECONNREFUSED", "ETIMEDOUT", "57P03"].includes(error.code)) throw error;
    return false;
  } finally {
    await probe.end();
  }
}

async function ensureLocalPostgres() {
  if (await postgresReady()) return;
  // Reuse the installed local development database, never initialize or reset it.
  const roots = [
    process.env.ZION_SANDBOX_LOCAL_POSTGRES_ROOT,
    config.postgresRoot,
    join(repository, ".account-data/postgres"),
    join(dirname(resolve(repository)), "core-observability/.account-data/postgres")
  ].filter(Boolean);
  const root = roots.find((candidate) =>
    existsSync(join(candidate, "toolchain/bin/pg_ctl"))
    && existsSync(join(candidate, "data/PG_VERSION")));
  if (!root || (database.port || "5432") !== "55432") {
    throw new Error("Local PostgreSQL is not ready; set ZION_SANDBOX_LOCAL_POSTGRES_ROOT to the existing development database directory");
  }
  const pgCtl = join(root, "toolchain/bin/pg_ctl");
  const running = await executeFile(pgCtl, ["-D", join(root, "data"), "status"])
    .then(() => true, (error) => {
      if (error.code !== 3) throw error;
      return false;
    });
  if (!running) {
    console.log("正在启动现有本地 PostgreSQL…");
    await executeFile(pgCtl, [
      "-D", join(root, "data"), "-l", join(root, "postgres.log"),
      "-o", "-p 55432 -h 127.0.0.1 -k ''", "-W", "start"
    ], { timeout: 5000 });
  } else {
    console.log("本地 PostgreSQL 正在恢复，等待连接就绪…");
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120000) {
    if (await postgresReady()) return;
    await delay(1000);
  }
  throw new Error(`PostgreSQL recovery is still in progress; inspect ${join(root, "postgres.log")}`);
}

async function ready() {
  return await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })
    .then((response) => response.ok).catch(() => false);
}

async function control(actionName) {
  const pool = new pg.Pool(poolOptions);
  const accounts = new PostgresAccountStore({ pool });
  let session;
  try {
    await accounts.initialize();
    session = await accounts.createSession(config.userId, { activeSpaceId: config.spaceId });
    const endpoint = actionName === "status" ? "" : `/${actionName}`;
    const response = await fetch(`${origin}/v1/sandbox/workspace${endpoint}`, {
      method: actionName === "status" ? "GET" : "POST",
      headers: { authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(90000)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    console.log(JSON.stringify(value, null, 2));
  } finally {
    if (session) await accounts.revokeSession(config.userId, session.sessionId);
    await pool.end();
  }
}

async function run() {
  for (const path of ["dist/index.html", "packages/runtime/dist/index.js", "packages/sandbox/node_modules/e2b"]) {
    if (!existsSync(join(repository, path))) throw new Error(`Missing ${path}; install dependencies and build the worktree`);
  }
  if (await ready()) throw new Error(`Local sandbox is already running at ${origin}`);
  await ensureLocalPostgres();
  const identityPackage = await packageIdentityPlugin({
    publishServiceUrl: "http://127.0.0.1:8767"
  });
  console.log(`Identity ${identityPackage.version} 已安装，Plugin Host 下载包校验通过。`);
  const profilesPath = join(directory, "runtime/interaction-profiles.json");
  if (existsSync(profilesPath)) {
    const profiles = new FileInteractionProfileStore(profilesPath);
    const profile = profiles.get("interactive.default");
    if (profile?.policy.fileRoots?.length === 1 && profile.policy.fileRoots[0] === "/workspace") {
      profiles.patch(profile.id, { policy: { fileRoots: ["/"] } });
    }
    if ((process.env.ZION_RUNTIME_MCP_ENABLED || runtimeSettings.mcpEnabled || "0") === "0") {
      for (const item of profiles.list()) {
        const allowedTools = item.policy.allowedTools.filter((name) =>
          !/^mcp(?:__|ListTools$|Call$)/.test(name));
        if (allowedTools.length !== item.policy.allowedTools.length) {
          profiles.patch(item.id, { policy: { allowedTools } });
        }
      }
    }
  }
  const credential = JSON.parse(execFileSync("security", [
    "find-generic-password", "-s", "dev.zion.sandbox-poc",
    "-a", `aliyun:${config.region}:${config.teamId}`, "-w"
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  if (!credential.apiKey || credential.region !== config.region || credential.teamID !== config.teamId) {
    throw new Error("Sandbox Keychain entry does not match the local configuration");
  }
  const pool = new pg.Pool(poolOptions);
  const sharedIssuer = process.env.ZIOON_ACCOUNT_ISSUER || runtimeSettings.accountIssuer || "";
  const identity = sharedIssuer ? {
    issuer: sharedIssuer, clientId: runtimeSettings.accountClientId || "zion-runtime-local", close: async () => {}
  } : await createLocalDevOidc({ pool, port: identityPort, runtimeOrigin: origin });
  const child = spawn(process.execPath, ["apps/runtime/src/main.mjs"], {
    cwd: repository, stdio: "inherit",
    env: {
      ...process.env, PGOPTIONS: `-c search_path=${config.schema}`,
      ZION_DATABASE_URL: config.url, ZION_SPACE_ID: config.spaceId,
      ZION_RUNTIME_DATA_DIR: join(directory, "runtime"),
      ZION_ENV: "development", ZION_ARTIFACT_STORE: "local",
      ZION_ARTIFACT_DIRECTORY: join(directory, "artifacts"),
      ZION_RUNTIME_HOST: "127.0.0.1", ZION_RUNTIME_PORT: String(runtimePort),
      ZION_RUNTIME_PUBLIC_URL: origin, ZION_RUNTIME_AUTH_MODE: "accounts",
      ZION_OIDC_ISSUER: identity.issuer, ZION_OIDC_CLIENT_ID: identity.clientId,
      ZIOON_ACCOUNT_ISSUER: sharedIssuer,
      ZIOON_ADC_ORIGIN: process.env.ZIOON_ADC_ORIGIN || runtimeSettings.adcOrigin || "",
      ZIOON_ACCOUNT_SESSION_KEY_FILE: process.env.ZIOON_ACCOUNT_SESSION_KEY_FILE
        || join(directory, "shared-account-session.key"),
      ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP: "1", ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION: "1",
      ZION_RUNTIME_TOOL_MODE: "sandbox", ZION_SANDBOX_BINDINGS_FILE: join(directory, "bindings.json"),
      ZION_PLUGIN_DATA_HOST: "managed", ZION_PLUGIN_DATA_SCOPE: "account",
      ZION_PLUGIN_DATA_ROOT: "/workspace/.zion/plugin-data",
      ZION_SANDBOX_REGION: config.region, ZION_SANDBOX_TEMPLATE: config.template,
      ZION_SANDBOX_PAUSE_VERIFIED: "1", E2B_API_KEY: credential.apiKey,
      ZION_SANDBOX_ALLOW_INTERNET_ACCESS: process.env.ZION_SANDBOX_ALLOW_INTERNET_ACCESS
        || runtimeSettings.sandboxAllowInternetAccess || "1",
      ZION_RUNTIME_MCP_ENABLED: process.env.ZION_RUNTIME_MCP_ENABLED
        || runtimeSettings.mcpEnabled || "0",
      ZION_MEMORY_MCP_ENABLED: process.env.ZION_MEMORY_MCP_ENABLED
        || runtimeSettings.memoryMcpEnabled || "0",
      ZION_MEMORY_SERVICE_URL: process.env.ZION_MEMORY_SERVICE_URL
        || runtimeSettings.memoryServiceUrl || "http://127.0.0.1:18991",
      ZION_MEMORY_PUBLIC_URL: process.env.ZION_MEMORY_PUBLIC_URL
        || runtimeSettings.memoryPublicUrl || "http://127.0.0.1:18991",
      ZION_MEMORY_ACCOUNT_CONNECTIONS_DIR: process.env.ZION_MEMORY_ACCOUNT_CONNECTIONS_DIR
        || runtimeSettings.memoryAccountConnectionsDir || "",
      ZION_MEMORY_BRIDGE_SECRET_FILE: process.env.ZION_MEMORY_BRIDGE_SECRET_FILE
        || join(homedir(), ".zion-next/memory-pilot/bridge.key"),
      ZION_RUNTIME_ENGINE: "openai", ZION_RUNTIME_MODEL_PROFILE: config.profile,
      ZION_RUNTIME_DEFAULT_INTERACTION_MODEL_PROFILE: config.profile,
      ZION_RUNTIME_WORKBENCH_DIST: join(repository, "dist"),
      ZION_RUNTIME_PLUGINS: "dev.terminal-manager,dev.identity,dev.session-manager,dev.langchain-chat,dev.tools,dev.plugins,dev.skills",
      ZION_RUNTIME_EXTERNAL_PLUGINS: "dev.identity", ZION_RUNTIME_STORAGE_MAINTENANCE: "0",
      ZION_RUNTIME_MIGRATE_LOCAL_TOOLS_STATE: "0", ZION_RUNTIME_SCHEDULER_WORKER: "0",
      OTEL_SDK_DISABLED: "true"
    }
  });
  await writeFile(pidFile, String(process.pid), { mode: 0o600 });
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null) {
      const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
      await exited;
      clearTimeout(timer);
    }
    await identity.close();
    await pool.end();
    await unlink(pidFile).catch(() => {});
  }
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  child.once("exit", () => { void stop(); });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error("Runtime exited before readiness");
    if (await ready()) {
      console.log(`本地沙箱已启动：${origin}/；账号 ${config.email}`);
      return;
    }
    await delay(200);
  }
  await stop();
  throw new Error("Local sandbox startup timed out");
}

if (["status", "pause", "release"].includes(action)) {
  await control(action);
} else if (action === "stop") {
  const pid = Number(await readFile(pidFile, "utf8"));
  const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  if (!command.includes(fileURLToPath(import.meta.url))) throw new Error("PID does not belong to the local sandbox launcher");
  process.kill(pid, "SIGTERM");
  console.log("本地沙箱正在停止，健康实例会暂停，文件保留。");
} else if (action === "up" && process.argv.includes("--background")) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await ready()) throw new Error(`Local sandbox is already running at ${origin}`);
  await ensureLocalPostgres();
  const log = join(directory, "runtime.log");
  const fd = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "up"], {
    detached: true, cwd: repository, stdio: ["ignore", fd, fd]
  });
  child.unref();
  closeSync(fd);
  for (let i = 0; i < 150; i++) {
    if (await ready()) {
      console.log(`本地沙箱已启动：${origin}/；日志：${log}`);
      break;
    }
    if (i === 149) throw new Error(`Startup failed; inspect ${log}`);
    await delay(200);
  }
} else if (action === "up") {
  await run();
} else {
  throw new Error("Usage: npm run sandbox:local -- up [--background] | status | pause | release | stop");
}
