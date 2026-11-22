import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PostgresAccountStore } from "../apps/runtime/src/accounts/postgres-account-store.mjs";
import { initializePostgresRuntimeSchema } from "../apps/runtime/src/postgres-runtime-schema.mjs";
import { createLocalDevOidc, seedLocalIdentityUser } from "../apps/runtime/src/accounts/local-dev-oidc.mjs";
import { startPreviewModel } from "./spaces-preview/fixtures.mjs";
import { seedSharingPreview } from "./spaces-preview/sharing-seed.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const stateDirectory = resolve(process.env.ZIOON_SPACES_PREVIEW_DIR || join(repository, ".runtime-data/spaces-preview"));
const statusPath = join(stateDirectory, "status.json");
const configPath = join(stateDirectory, "config.local.json");
const databaseUrl = "postgresql://zion@127.0.0.1:55671/zioon_spaces_preview?sslmode=disable";
const runtimeUrl = "http://127.0.0.1:55672";
const issuer = "http://127.0.0.1:55673";
const memoryUrl = "http://127.0.0.1:55674";
const vendor = join(repository, ".vendor/spaces-preview");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const load = async path => JSON.parse(await readFile(path, "utf8"));
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

async function waitHealthy(url, child) {
  for (let i = 0; i < 150; i++) {
    if (child && child.exitCode !== null) throw new Error(`Service exited while starting ${url}; read preview logs`);
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`Service did not become ready: ${url}`);
}
async function call(token, spaceId, path, method = "GET", body) {
  const response = await fetch(runtimeUrl + path, {
    method, headers: { authorization: `Bearer ${token}`, "x-zioon-space-id": spaceId,
      "content-type": "application/json", "x-zion-workbench-protocol": "5" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000)
  });
  const value = await response.json();
  if (!response.ok || value.ok === false) throw Object.assign(new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`), { statusCode: response.status });
  return value;
}

async function supervise() {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  // The preview has its own DB, sessions, files and Memory.
  // No existing account/devices or production credentials are inspected.
  const admin = new pg.Pool({ connectionString: databaseUrl.replace("/zioon_spaces_preview?", "/postgres?"), max: 1 });
  try {
    await admin.query("SELECT 1");
  } catch (error) {
    if (error.code !== "ECONNREFUSED") throw error;
    const sockets = "/private/tmp/zioon-spaces-preview-postgres";
    await mkdir(sockets, { recursive: true, mode: 0o700 });
    execFileSync("/opt/homebrew/opt/postgresql@16/bin/pg_ctl", ["-D", join(stateDirectory, "postgres"),
      "-l", join(stateDirectory, "postgres.log"), "-o", `-h 127.0.0.1 -p 55671 -k ${sockets} -c max_connections=160`,
      "-w", "start"], { stdio: "ignore" });
  }
  if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='zioon_spaces_preview'")).rowCount) {
    await admin.query("CREATE DATABASE zioon_spaces_preview");
  }
  await admin.end();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const accounts = await new PostgresAccountStore({ pool }).initialize();
  await initializePostgresRuntimeSchema(pool);
  let config = existsSync(configPath) ? await load(configPath) : null;
  if (!config) {
    const samples = [];
    for (const [email, name] of [["owner@spaces.test", "分享提供者"], ["partner@spaces.test", "接收者"],
      ["guest@spaces.test", "只读访客"]]) {
      const password = randomBytes(15).toString("base64url");
      const local = await seedLocalIdentityUser({ pool, email, name, password });
      const user = await accounts.resolveIdentity({ issuer, subject: local.subject, name, email, emailVerified: true });
      const personal = await accounts.personalSpace(user.id);
      const session = await accounts.createSession(user.id, { ttlMs: 30 * 24 * 60 * 60 * 1000 });
      samples.push({ email, name, password, userId: user.id, personalSpaceId: personal.id, token: session.token });
    }
    config = { databaseUrl, runtimeUrl, issuer, memoryUrl,
      memoryWorktree: resolve(repository, "../zioon-spaces-memory-20261121"),
      bun: join(vendor, "bun-1.4.1/bun-darwin-aarch64/bun"),
      upstream: join(vendor, "agent-fs"), accounts: samples, seeded: false };
    await save(configPath, config);
    await writeFile(join(stateDirectory, "memory-secret"), randomBytes(48).toString("base64url"), { mode: 0o600 });
  }
  const owner = config.accounts[0], partner = config.accounts[1], guest = config.accounts[2];
  const runtimeDirectory = join(stateDirectory, "runtime");
  for (const [index, name] of ["分享提供者", "接收者", "只读访客"].entries()) {
    config.accounts[index].name = name;
    await pool.query("UPDATE account_users SET name=$2 WHERE id=$1", [config.accounts[index].userId, name]);
    await pool.query("UPDATE local_identity_users SET name=$2 WHERE email=$1", [config.accounts[index].email, name]);
  }
  await mkdir(runtimeDirectory, { recursive: true });
  const modelProfile = { id: "spaces-local-fixture", label: "本地测试模型",
    providerId: "spaces-fixture", providerType: "openai", endpoint: "http://127.0.0.1:55675/v1/chat/completions",
    model: "spaces-local-fixture", credentialRequired: false, temperature: 0,
    capabilities: { supportsImage: false, supportsThinking: false } };
  if (!existsSync(join(runtimeDirectory, "model-profiles.json"))) {
    await save(join(runtimeDirectory, "model-profiles.json"), { version: 1, profiles: [modelProfile] });
  }
  // Persisted fixture credentials are refreshed only when expired/revoked.
  for (const sample of config.accounts) {
    try { await accounts.authenticate(sample.token); }
    catch { sample.token = (await accounts.createSession(sample.userId, { ttlMs: 30 * 24 * 60 * 60 * 1000 })).token; }
  }
  await save(configPath, config);
  const services = [], children = [];
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await save(statusPath, { pid: process.pid, status: "stopping", runtimeUrl });
    for (const service of services.reverse()) await service.close().catch(() => {});
    for (const child of children.reverse()) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(5000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
    await accounts.close();
    await pool.end();
    await save(statusPath, { status: "stopped", runtimeUrl, stoppedAt: Date.now() });
  };
  process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
  const child = async (name, executable, args, env) => {
    const log = await open(join(stateDirectory, `${name}.log`), "a", 0o600);
    const running = spawn(executable, args, { cwd: repository,
      env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", log.fd, log.fd] });
    await log.close();
    children.push(running);
    running.once("exit", code => {
      if (!closing) {
        console.error(`${name} exited (${code}); stopping joined preview`);
        void stop().then(() => process.exit(1));
      }
    });
    return running;
  };
  try {
    await save(statusPath, { pid: process.pid, status: "starting", runtimeUrl });
    services.push(await createLocalDevOidc({ pool, port: 55673, runtimeOrigin: runtimeUrl, clientId: "spaces-preview" }));
    services.push(await startPreviewModel({ port: 55675, receiptPath: join(stateDirectory, "model-receipts.jsonl") }));
    const memory = await child("memory", config.bun, [join(config.memoryWorktree, "apps/memory-service/src/main.ts")], {
      AGENT_FS_HOME: join(stateDirectory, "memory"), AGENT_FS_STORAGE_PROVIDER: "local",
      AGENT_FS_LOCAL_ROOT: join(stateDirectory, "memory/objects"), AGENT_FS_UPSTREAM_DIR: config.upstream,
      ZION_ACCOUNT_RUNTIME_URL: runtimeUrl, ZION_MEMORY_HOST: "127.0.0.1", ZION_MEMORY_PORT: "55674",
      ZION_MEMORY_BRIDGE_SECRET_FILE: join(stateDirectory, "memory-secret"), ZION_MEMORY_ALLOWED_ORIGINS: runtimeUrl
    });
    await waitHealthy(memoryUrl + "/health", memory);
    const runtime = await child("runtime", process.execPath, [join(repository, "apps/runtime/src/main.mjs")], {
      ZION_DATABASE_URL: databaseUrl, ZION_DATABASE_SSL: "disable", ZION_DATABASE_POOL_SIZE: "5",
      ZION_RUNTIME_DATA_DIR: runtimeDirectory, ZION_ARTIFACT_STORE: "local", ZION_ENV: "development",
      ZION_ARTIFACT_DIRECTORY: join(runtimeDirectory, "artifacts"),
      ZION_RUNTIME_HOST: "127.0.0.1", ZION_RUNTIME_PORT: "55672", ZION_RUNTIME_PUBLIC_URL: runtimeUrl,
      ZION_RUNTIME_AUTH_MODE: "accounts", ZION_SPACE_ID: owner.personalSpaceId,
      ZION_OIDC_ISSUER: issuer, ZION_OIDC_CLIENT_ID: "spaces-preview", ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP: "1",
      ZION_RUNTIME_ENGINE: "openai", ZION_RUNTIME_MODEL_PROFILE: modelProfile.id,
      ZION_RUNTIME_DEFAULT_INTERACTION_MODEL_PROFILE: modelProfile.id,
      ZION_RUNTIME_TOOL_MODE: "node", ZION_PLUGIN_DATA_HOST: "runtime",
      ZION_RUNTIME_PLUGINS: "dev.identity,dev.skills,dev.session-manager,dev.observability,dev.langchain-chat,dev.plugins,dev.tools,dev.scheduler",
      ZION_RUNTIME_EXTERNAL_PLUGINS: "none", ZION_RUNTIME_SCHEDULER_WORKER: "0",
      ZION_RUNTIME_EXTERNAL_PLUGIN_ROOT: join(stateDirectory, "external-plugins"),
      ZION_RUNTIME_PROJECT_AUTOMATION_WORKER: "0", ZION_RUNTIME_WORKBENCH_DIST: join(repository, "dist"),
      ZION_MEMORY_SERVICE_URL: memoryUrl, ZION_MEMORY_PUBLIC_URL: memoryUrl,
      ZION_MEMORY_BRIDGE_SECRET_FILE: join(stateDirectory, "memory-secret"),
      ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION: "1"
    });
    await waitHealthy(runtimeUrl + "/health", runtime);
    await seedSharingPreview({ config, call, save: () => save(configPath, config) });
    await waitHealthy(memoryUrl + "/ready", memory);
    await save(statusPath, { pid: process.pid, status: "ready", runtimeUrl, memoryUrl, issuer,
      sharingSeedVersion: config.sharingSeedVersion, startedAt: Date.now(), children: children.map(c => c.pid) });
    console.log(`Sharing preview ready: ${runtimeUrl}/`);
    console.log(`Local sample login details: ${configPath}`);
  } catch (error) {
    console.error(error);
    await stop();
    process.exit(1);
  }
}

const command = process.argv[2] || "status";
if (command === "serve") await supervise().catch(async error => {
  console.error(error);
  await save(statusPath, { status: "failed", runtimeUrl, failedAt: Date.now() });
  process.exitCode = 1;
});
else if (command === "start") {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const status = existsSync(statusPath) ? await load(statusPath) : {};
  if (status.pid && alive(status.pid)) console.log(JSON.stringify(status, null, 2));
  else {
    const log = await open(join(stateDirectory, "supervisor.log"), "a", 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
      cwd: repository, detached: true, env: { ...process.env, ZIOON_SPACES_PREVIEW_DIR: stateDirectory },
      stdio: ["ignore", log.fd, log.fd]
    });
    child.unref();
    await log.close();
    await save(statusPath, { pid: child.pid, status: "starting", runtimeUrl });
    for (let i = 0; i < 300; i++) {
      const current = await load(statusPath);
      if (current.status === "ready") { console.log(JSON.stringify(current, null, 2)); break; }
      if (!alive(child.pid) || current.status === "stopped") {
        throw new Error(`Preview startup failed; read ${join(stateDirectory, "supervisor.log")}`);
      }
      if (i === 299) throw new Error("Preview is still starting; inspect status and service logs.");
      await sleep(100);
    }
  }
} else if (command === "stop") {
  const status = existsSync(statusPath) ? await load(statusPath) : {};
  if (status.pid && alive(status.pid)) {
    process.kill(status.pid, "SIGTERM");
    for (let i = 0; i < 150 && alive(status.pid); i++) await sleep(100);
    if (alive(status.pid)) throw new Error("Preview has not stopped; inspect supervisor log.");
    console.log("Preview stopped; data is retained.");
  }
  else console.log("Preview is stopped.");
} else if (command === "status") {
  const status = existsSync(statusPath) ? await load(statusPath) : { status: "not_started" };
  if (status.pid && !alive(status.pid)) status.status = "stopped";
  console.log(JSON.stringify(status, null, 2));
} else if (command === "accounts") {
  const config = await load(configPath);
  console.log(JSON.stringify(config.accounts.map(({ email, name, password, userId, personalSpaceId }) =>
    ({ email, name, password, userId, personalSpaceId })), null, 2));
} else throw new Error("Use start, stop, status or accounts.");
