import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapAccountOwner } from "../../apps/runtime/src/accounts/account-cli.mjs";
import { accountPublicUrl } from "../../apps/runtime/src/accounts/oidc-provider.mjs";

const [configFile, action = "start"] = process.argv.slice(2);
if (!configFile || !["start", "bootstrap"].includes(action)) {
  throw new Error("Usage: node deploy/accounts/start-space.mjs <space.json> [start|bootstrap]");
}
const repository = fileURLToPath(new URL("../../", import.meta.url));
const file = resolve(configFile);
const config = JSON.parse(readFileSync(file, "utf8"));
for (const key of ["spaceId", "dataDirectory", "publicUrl", "issuer", "clientId"]) {
  if (!config[key] || typeof config[key] !== "string") throw new Error(`Missing config: ${key}`);
}
accountPublicUrl(config.publicUrl, config.allowLoopbackHttp === true);
const directory = resolve(dirname(file), config.dataDirectory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const databaseUrl = String(
  process.env.ZION_DATABASE_URL || config.databaseUrl || ""
).trim();
if (!databaseUrl) throw new Error("Set ZION_DATABASE_URL or config.databaseUrl");
if (action === "bootstrap") {
  if (!config.ownerSubject) throw new Error("Set ownerSubject to the verified OIDC sub before bootstrapping");
  await bootstrapAccountOwner({ argv: [
    "bootstrap", "--space", config.spaceId, "--name", config.spaceName || config.spaceId,
    "--issuer", config.issuer, "--subject", config.ownerSubject
  ], environment: { ...process.env, ZION_DATABASE_URL: databaseUrl } });
} else {
  // Avoid inheriting another Space's storage, secrets, device endpoints or
  // plugins. Only explicit integration env names cross this launcher boundary.
  const integration = {};
  for (const name of [
    "ZION_OIDC_CLIENT_SECRET", "ZION_RUNTIME_ENGINE", "ZION_RUNTIME_MODEL_URL",
    "ZION_RUNTIME_MODEL_ID", "ZION_RUNTIME_API_KEY", "ZION_RUNTIME_API_KEY_REQUIRED",
    "ZION_OBSERVABILITY_RETENTION_DAYS", "ZION_OBSERVABILITY_MAX_BYTES",
    "ZION_OBSERVABILITY_DEBOUNCE_MS", "ZION_OBSERVABILITY_QUERY_TIMEOUT_MS",
    "ZION_OBSERVABILITY_QUERY_MAX_ROWS", "ZION_OBSERVABILITY_QUERY_MAX_BYTES"
  ]) if (process.env[name]) integration[name] = process.env[name];
  const child = spawn(process.execPath, [join(repository, "apps/runtime/src/main.mjs")], {
    cwd: repository, stdio: "inherit",
    env: {
      PATH: process.env.PATH, ...integration,
      ZION_RUNTIME_AUTH_MODE: "accounts", ZION_RUNTIME_HOST: config.host || "127.0.0.1",
      ZION_RUNTIME_PORT: String(config.port || 8766),
      ZION_RUNTIME_DATA_DIR: directory,
      ZION_DATABASE_URL: databaseUrl,
      ZION_SPACE_ID: config.spaceId,
      ZION_RUNTIME_PUBLIC_URL: config.publicUrl, ZION_OIDC_ISSUER: config.issuer,
      ZION_OIDC_CLIENT_ID: config.clientId,
      ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP: config.allowLoopbackHttp === true ? "1" : "0",
      ZION_RUNTIME_WORKBENCH_DIST: join(repository, "dist"),
      ZION_RUNTIME_TOOL_MODE: "node",
      ZION_RUNTIME_PLUGINS: "dev.skills,dev.memory,dev.identity,dev.context-compression,dev.scheduler,dev.session-manager,dev.langchain-chat,dev.agents,dev.observability",
      ZION_RUNTIME_EXTERNAL_PLUGINS: "none", ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION: "0",
      ZION_RUNTIME_MIGRATE_LOCAL_TOOLS_STATE: "0"
    }
  });
  process.once("SIGINT", () => child.kill("SIGINT"));
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  child.once("error", error => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; });
}
