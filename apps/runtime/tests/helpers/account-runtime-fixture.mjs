import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createPostgresTestDatabase } from "./postgres-test-database.mjs";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
export async function startAccountRuntimeFixture({ directory, spaceId, idp, web = false }) {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  idp.registerRuntime(url);
  const database = await createPostgresTestDatabase("account_runtime");
  const accounts = database.accounts;
  const owner = await accounts.resolveIdentity({
    issuer: idp.issuer,
    subject: "test-owner",
    name: "测试所有者"
  });
  const createdAt = Date.now();
  await database.pool.query(
    `INSERT INTO account_spaces (id, name, kind, created_by, created_at)
     VALUES ($1, $2, 'team', $3, $4)`,
    [spaceId, `测试空间 ${spaceId}`, owner.id, createdAt]
  );
  await database.pool.query(
    `INSERT INTO account_memberships
     (space_id, user_id, role, status, revision, created_at, updated_at)
     VALUES ($1, $2, 'owner', 'active', 1, $3, $3)`,
    [spaceId, owner.id, createdAt]
  );
  const dataDirectory = join(directory, "runtime");
  const child = spawn(process.execPath, [resolve(repository, "apps/runtime/src/main.mjs")], {
    cwd: repository,
    env: {
      ...database.childEnvironment,
      PATH: process.env.PATH,
      ZION_RUNTIME_DATA_DIR: dataDirectory,
      ZION_RUNTIME_HOST: "127.0.0.1", ZION_RUNTIME_PORT: String(port),
      ZION_RUNTIME_PUBLIC_URL: url, ZION_RUNTIME_AUTH_MODE: "accounts",
      ZION_SPACE_ID: spaceId, ZION_OIDC_ISSUER: idp.issuer, ZION_OIDC_CLIENT_ID: "zion-account-test",
      ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP: "1", ZION_RUNTIME_ENGINE: "echo",
      ZION_RUNTIME_TOOL_MODE: "node", ZION_RUNTIME_PLUGINS: "dev.skills,dev.session-manager,dev.observability",
      ZION_RUNTIME_EXTERNAL_PLUGINS: "none",
      ZION_RUNTIME_SCHEDULER_WORKER: "0", ZION_RUNTIME_PROJECT_AUTOMATION_WORKER: "0",
      ...(web ? { ZION_RUNTIME_WORKBENCH_DIST: resolve(repository, "dist") } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-6000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-6000); });
  let exited = false;
  const exit = new Promise(resolve => child.once("exit", () => { exited = true; resolve(); }));
  const close = async () => {
    if (!exited) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exit;
      clearTimeout(kill);
    }
    await database.close();
  };
  try {
    for (let count = 0; count < 100; count++) {
      if (exited) throw new Error(`Runtime fixture exited:\n${output}`);
      const healthy = await fetch(`${url}/health`).then(response => response.ok).catch(() => false);
      if (healthy) {
        return {
          url,
          accounts,
          database,
          dataDirectory,
          close,
          logs: () => output
        };
      }
      await delay(100);
    }
    throw new Error(`Runtime fixture did not start:\n${output}`);
  } catch (error) { await close(); throw error; }
}

export async function browserAccountLogin(url, returnTo = "/account") {
  const begin = await fetch(`${url}/v1/account/login?${new URLSearchParams({ returnTo })}`, { redirect: "manual" });
  const loginCookie = begin.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const authorize = await fetch(begin.headers.get("location"), { redirect: "manual" });
  const callback = await fetch(authorize.headers.get("location"), {
    redirect: "manual", headers: { cookie: loginCookie }
  });
  if (callback.status !== 303) throw new Error(`Login failed: ${callback.status} ${await callback.text()}`);
  return {
    cookie: callback.headers.getSetCookie().find(value => value.startsWith("zion_account_local=")).split(";")[0],
    headers: callback.headers,
    returnTo: callback.headers.get("location")
  };
}
