import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createLocalDevOidc,
  localDevSubject
} from "../apps/runtime/src/accounts/local-dev-oidc.mjs";
import {
  PostgresAccountStore
} from "../apps/runtime/src/accounts/postgres-account-store.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const directory = join(repository, ".account-data/local");
const configFile = join(directory, "space.local.json");
const issuer = "http://127.0.0.1:18080";
const runtimeUrl = "http://127.0.0.1:18866";
const clientId = "zion-local";
const interactionProfilesFile = join(directory, "runtime/interaction-profiles.json");
const managedPostgresRoot = join(repository, ".account-data/postgres");
const managedDatabaseUrl = "postgresql://zion@127.0.0.1:55432/zion?sslmode=disable";
const help = `本地轻量账号体验（无需 Docker）

启动：
  npm run accounts:local -- up

可选预填注册邮箱：
  npm run accounts:local -- up <你的注册邮箱>

启动后打开终端打印的注册链接。Ctrl-C 同时停止身份服务和 Zion；
账号、Space 和会话保存在 .account-data/local。
`;

function writeConfig(value) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(`${configFile}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${configFile}.tmp`, configFile);
}

function readConfig() {
  if (!existsSync(configFile)) return null;
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (config.version !== 3 || !config.spaceId
    || config.issuer !== issuer || config.publicUrl !== runtimeUrl
    || config.dataDirectory !== join(directory, "runtime")) {
    throw new Error("本地账号配置不匹配；请勿把体验命令指向现有 Runtime 数据。");
  }
  return config;
}

function normalizeOwnerEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("首次启动需要一个有效邮箱，例如：npm run accounts:local -- up alice@example.test");
  }
  return email;
}

function normalizeDatabaseUrl(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("本地体验需要 PostgreSQL database URL");
  const url = new URL(input);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.password
  ) {
    throw new Error(
      "本地体验仅持久化无密码的 loopback PostgreSQL URL；远程或带密码连接请使用环境变量。"
    );
  }
  return url.toString();
}

function optionalRuntimeEnv(names) {
  return Object.fromEntries(
    names
      .map((name) => [name, process.env[name]])
      .filter(([, value]) => String(value || "").trim())
  );
}

function ensureManagedLocalPostgres(databaseUrl) {
  if (!databaseUrl) return;
  const url = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || (url.port || "5432") !== "55432"
  ) {
    return;
  }
  const bin = join(managedPostgresRoot, "toolchain", "bin");
  const data = join(managedPostgresRoot, "data");
  const ready = spawnSync(join(bin, "pg_isready"), [
    "-h", "127.0.0.1", "-p", "55432", "-d", url.pathname.slice(1)
  ], { stdio: "ignore" });
  if (ready.status === 0) return;
  if (!existsSync(join(bin, "pg_ctl")) || !existsSync(join(data, "PG_VERSION"))) {
    throw new Error(
      "本地 PostgreSQL 尚未安装；请清除 databaseUrl 或先准备 127.0.0.1:55432。"
    );
  }
  const started = spawnSync(join(bin, "pg_ctl"), [
    "-D", data,
    "-l", join(managedPostgresRoot, "postgres.log"),
    "-o", "-p 55432 -h 127.0.0.1 -k ''",
    "-w", "start"
  ], { encoding: "utf8" });
  if (started.status !== 0) {
    throw new Error(
      `本地 PostgreSQL 启动失败：${String(started.stderr || started.stdout || "").trim()}`
    );
  }
}

function runtimeEngineEnv() {
  const engine = String(process.env.ZION_RUNTIME_ENGINE || "openai").trim() || "openai";
  const defaultModelProfile = String(
    process.env.ZION_RUNTIME_DEFAULT_INTERACTION_MODEL_PROFILE
    || (engine === "openai" ? "deepseek-v4-flash" : "")
  ).trim();
  const deepseekKey = String(
    process.env.ZION_RUNTIME_DEEPSEEK_API_KEY
    || process.env.DEEPSEEK_API_KEY
    || ""
  ).trim();
  return {
    ZION_RUNTIME_ENGINE: engine,
    ...(defaultModelProfile
      ? { ZION_RUNTIME_DEFAULT_INTERACTION_MODEL_PROFILE: defaultModelProfile }
      : {}),
    ...(deepseekKey ? { ZION_RUNTIME_DEEPSEEK_API_KEY: deepseekKey } : {}),
    ...optionalRuntimeEnv([
      "ZION_RUNTIME_MODEL_PROFILE",
      "ZION_RUNTIME_MODEL_URL",
      "ZION_RUNTIME_MODEL_ID",
      "ZION_RUNTIME_API_KEY",
      "ZION_RUNTIME_API_KEY_REQUIRED"
    ])
  };
}

function migrateEchoInteractionProfilesForEngine(env) {
  const modelProfileId = String(
    env.ZION_RUNTIME_DEFAULT_INTERACTION_MODEL_PROFILE
    || env.ZION_RUNTIME_MODEL_PROFILE
    || ""
  ).trim();
  if (env.ZION_RUNTIME_ENGINE !== "openai" || !modelProfileId || !existsSync(interactionProfilesFile)) {
    return;
  }
  const document = JSON.parse(readFileSync(interactionProfilesFile, "utf8"));
  let changed = false;
  for (const profile of Array.isArray(document.profiles) ? document.profiles : []) {
    if (
      ["interactive.default", "scheduled.default"].includes(profile?.id)
      && (!profile.modelProfileId || profile.modelProfileId === "echo")
    ) {
      profile.modelProfileId = modelProfileId;
      changed = true;
    }
  }
  if (!changed) return;
  writeFileSync(
    `${interactionProfilesFile}.tmp`,
    `${JSON.stringify(document, null, 2)}\n`,
    { mode: 0o600 }
  );
  renameSync(`${interactionProfilesFile}.tmp`, interactionProfilesFile);
}

function runtimeProcess(config) {
  const engineEnv = runtimeEngineEnv();
  const databaseUrl = normalizeDatabaseUrl(
    process.env.ZION_DATABASE_URL || config.databaseUrl
  );
  migrateEchoInteractionProfilesForEngine(engineEnv);
  return spawn(process.execPath, [join(repository, "apps/runtime/src/main.mjs")], {
    cwd: repository,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      ZION_RUNTIME_AUTH_MODE: "accounts",
      ZION_RUNTIME_HOST: "127.0.0.1",
      ZION_RUNTIME_PORT: "18866",
      ZION_RUNTIME_DATA_DIR: config.dataDirectory,
      ZION_DATABASE_URL: databaseUrl,
      ZION_SPACE_ID: config.spaceId,
      ZION_RUNTIME_PUBLIC_URL: runtimeUrl,
      ZION_OIDC_ISSUER: issuer,
      ZION_OIDC_CLIENT_ID: clientId,
      ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP: "1",
      ZION_RUNTIME_WORKBENCH_DIST: join(repository, "dist"),
      ...engineEnv,
      ZION_RUNTIME_TOOL_MODE: "node",
      ZION_RUNTIME_PLUGINS: process.env.ZION_RUNTIME_PLUGINS
        || "dev.session-manager,dev.skills,dev.tools,dev.plugins,"
        + "dev.terminal-manager,dev.identity,dev.memory,dev.agents,"
        + "dev.scheduler,dev.langchain-chat,dev.mail,"
        + "dev.context-compression,dev.observability",
      ZION_RUNTIME_EXTERNAL_PLUGINS:
        process.env.ZION_RUNTIME_EXTERNAL_PLUGINS || "none",
      ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION:
        process.env.ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION || "0",
      ZION_RUNTIME_MIGRATE_LOCAL_TOOLS_STATE: "0",
      ...optionalRuntimeEnv([
        "ZION_DATABASE_POOL_SIZE",
        "ZION_DATABASE_SSL",
        "ZION_PLUGIN_DATA_NODE_ID",
        "ZION_RUNTIME_EXTERNAL_PLUGIN_ROOT",
        "ZION_ALLOW_DANGEROUS"
      ])
    }
  });
}

async function ensureAccountSpace(config, databaseUrl, registrationEmail) {
  const store = await new PostgresAccountStore({
    connectionString: databaseUrl,
    ssl: process.env.ZION_DATABASE_SSL === "disable" ? false : undefined
  }).initialize();
  try {
    if (config?.spaceId && await store.space(config.spaceId)) {
      return config;
    }
    const email = normalizeOwnerEmail(registrationEmail);
    const user = await store.resolveIdentity({
      issuer,
      subject: localDevSubject(email),
      name: email.split("@")[0],
      email,
      emailVerified: true
    });
    const space = await store.personalSpace(user.id);
    return {
      version: 3,
      spaceId: space.id,
      spaceName: space.name,
      spaceKind: space.kind,
      dataDirectory: join(directory, "runtime"),
      publicUrl: runtimeUrl,
      issuer,
      clientId,
      databaseUrl,
      registrationEmail: email
    };
  } finally {
    await store.close();
  }
}

async function waitForRuntime(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Zion Runtime 启动失败（退出码 ${child.exitCode}）`);
    const ready = await fetch(`${runtimeUrl}/health`, { signal: AbortSignal.timeout(1000) })
      .then((response) => response.ok || response.status === 401)
      .catch(() => false);
    if (ready) return;
    await delay(100);
  }
  throw new Error("Zion Runtime 未在预期时间内启动。");
}

async function stopChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000).then(() => child.kill("SIGKILL"))
  ]);
}

export async function runLocalAccounts(args = process.argv.slice(2)) {
  const [action, inputEmail] = args;
  if (!action || ["--help", "-h", "help"].includes(action)) {
    console.log(help);
    return;
  }
  if (action !== "up" && action !== "start") throw new Error(help);

  let config = readConfig();
  const databaseUrl = normalizeDatabaseUrl(
    process.env.ZION_DATABASE_URL || config?.databaseUrl || managedDatabaseUrl
  );
  const registrationEmail = inputEmail
    ? normalizeOwnerEmail(inputEmail)
    : String(config?.registrationEmail || config?.ownerEmail || "").trim().toLowerCase();
  ensureManagedLocalPostgres(databaseUrl);
  config = await ensureAccountSpace(config, databaseUrl, registrationEmail);
  if (config.databaseUrl !== databaseUrl) config = { ...config, databaseUrl };
  writeConfig(config);

  for (const path of ["dist/index.html", "dist/mobile/index.html", "packages/runtime/dist/index.js"]) {
    if (!existsSync(join(repository, path))) {
      throw new Error("缺少构建产物。先运行 npm run runtime:build && npm run build:all。");
    }
  }

  mkdirSync(join(directory, "runtime"), { recursive: true, mode: 0o700 });
  const identity = await createLocalDevOidc({
    databaseUrl,
    host: "127.0.0.1",
    port: 18080,
    runtimeOrigin: runtimeUrl,
    clientId
  });
  const runtime = runtimeProcess(config);
  let runtimeError = null;
  runtime.once("error", (error) => { runtimeError = error; });
  try {
    await waitForRuntime(runtime);
    if (runtimeError) throw runtimeError;
    const registration = `${identity.registrationUrl}?${new URLSearchParams({
      ...(registrationEmail ? { email: registrationEmail } : {}),
      return_to: `${runtimeUrl}/v1/account/login?returnTo=/account`
    })}`;
    console.log("\n本地账号环境已启动：");
    console.log(`注册账号：${registration}`);
    console.log(`账号管理：${runtimeUrl}/account`);
    console.log(`工作台：${runtimeUrl}/`);
    console.log(`手机界面：${runtimeUrl}/mobile/`);
    console.log("\n注册页面会直接显示本地验证码。按 Ctrl-C 停止，数据会保留。");
    await new Promise((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      runtime.once("exit", stop);
    });
  } finally {
    await stopChild(runtime);
    await identity.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalAccounts().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
