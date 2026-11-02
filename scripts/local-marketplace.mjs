import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLocalAccounts } from "./local-accounts.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(repository, ".marketplace-local");
const postgresData = join(directory, "postgres");
const port = "55439";
const databaseUrl = `postgresql://zion@127.0.0.1:${port}/zion_marketplace?sslmode=disable`;
const candidates = [
  process.env.ZION_MARKETPLACE_POSTGRES_BIN,
  join(repository, "../core-observability/.account-data/postgres/toolchain/bin"),
  "/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/opt/postgresql@16/bin"
].filter(Boolean);
const configured = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
if (configured.status === 0) candidates.push(configured.stdout.trim());
const bin = candidates.find((path) => existsSync(join(path, "pg_ctl")));
if (!bin) throw new Error("未找到 PostgreSQL。设置 ZION_MARKETPLACE_POSTGRES_BIN 指向包含 pg_ctl/initdb 的目录。");
const command = (name, args, output = true) => {
  const result = spawnSync(join(bin, name), args, { encoding: "utf8", stdio: output ? "inherit" : "pipe" });
  if (result.status !== 0) throw new Error(`${name} 失败${result.stderr ? `：${result.stderr.trim()}` : ""}`);
  return result.stdout?.trim() || "";
};
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (!existsSync(join(postgresData, "PG_VERSION"))) {
  command("initdb", ["-D", postgresData, "-U", "zion", "--auth=trust", "--encoding=UTF8", "--locale=C"]);
}
const ready = spawnSync(join(bin, "pg_isready"), ["-h", "127.0.0.1", "-p", port], { stdio: "ignore" });
if (ready.status !== 0) {
  command("pg_ctl", ["-D", postgresData, "-l", join(directory, "postgres.log"),
    "-o", `-p ${port} -h 127.0.0.1 -k ''`, "-w", "start"]);
}
const postgresArgs = ["-h", "127.0.0.1", "-p", port, "-U", "zion", "-d", "postgres", "-At"];
const actualData = command("psql", [...postgresArgs, "-c", "SHOW data_directory"], false);
if (resolve(actualData) !== postgresData) throw new Error(`端口 ${port} 已被其他数据库占用，未使用或修改该数据库。`);
if (!command("psql", [...postgresArgs, "-c", "SELECT 1 FROM pg_database WHERE datname='zion_marketplace'"], false)) {
  command("createdb", ["-h", "127.0.0.1", "-p", port, "-U", "zion", "zion_marketplace"]);
}
for (const artifact of ["dist/index.html", "dist/mobile/index.html", "packages/runtime/dist/index.js"]) {
  if (!existsSync(join(repository, artifact))) throw new Error("请先运行 npm run runtime:build && npm run build:all");
}
Object.assign(process.env, {
  ZION_LOCAL_ACCOUNT_DIR: join(directory, "accounts"),
  ZION_DATABASE_URL: databaseUrl, ZION_RUNTIME_ENGINE: "echo", ZION_DATABASE_POOL_SIZE: "3",
  ZION_RUNTIME_PLUGINS: [
    "dev.skills", "dev.session-manager", "dev.tools", "dev.plugins", "dev.langchain-chat",
    ...(existsSync(join(repository, "extensions/dev.agent-device-cloud/manifest.json")) ? ["dev.agent-device-cloud"] : [])
  ].join(","),
  ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION: process.env.ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION === "1" ? "1" : "0"
});
console.log("扩展市场：http://127.0.0.1:18866/?marketplace=1");
await runLocalAccounts(["up", process.argv[2] || "marketplace@example.test"]);
