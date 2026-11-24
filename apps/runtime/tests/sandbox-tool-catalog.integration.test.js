import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createAccountOidcFixture } from "./helpers/account-oidc-fixture.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

it("serves native search and actual sandbox capabilities before any Device registers", async () => {
  const database = await createPostgresTestDatabase("sandbox_catalog");
  const idp = await createAccountOidcFixture();
  const directory = await mkdtemp(join(tmpdir(), "zion-sandbox-catalog-"));
  let child;
  try {
    const bindingsFile = join(directory, "bindings.json");
    await writeFile(bindingsFile, JSON.stringify([{
      accountId: (await database.pool.query("SELECT id FROM account_users LIMIT 1")).rows[0].id,
      workspaceId: "workspace:test",
      storageMetadata: {
        "fc.sandbox.storage.agenticfs": JSON.stringify({ mountPoints: [{ mountDir: "/workspace", serverAddr: "test.invalid" }] }),
        "fc.sandbox.auth.role": "test-role"
      },
      storageNetwork: { vpcId: "test-only" }
    }]));
    child = spawn(process.execPath, [resolve("src/main.mjs"), "--port", "0", "--runtime-plugins", "none"], {
      cwd: resolve("."),
      env: {
        PATH: process.env.PATH, ...database.childEnvironment,
        ZION_ENV: "development", ZION_ARTIFACT_STORE: "local",
        ZION_ARTIFACT_DIRECTORY: join(directory, "artifacts"),
        ZION_SPACE_ID: database.defaultSpaceId, ZION_RUNTIME_DATA_DIR: directory,
        ZION_RUNTIME_HOST: "127.0.0.1", ZION_RUNTIME_PUBLIC_URL: "http://127.0.0.1:8766",
        ZION_RUNTIME_AUTH_MODE: "accounts", ZION_RUNTIME_TOOL_MODE: "sandbox", ZION_RUNTIME_ENGINE: "echo",
        ZION_OIDC_ISSUER: idp.issuer, ZION_OIDC_CLIENT_ID: "zion-account-test",
        ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP: "1", ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION: "1",
        E2B_API_KEY: "test-unused-sandbox-key", ZION_SANDBOX_TEMPLATE: "test-unused-template",
        ZION_SANDBOX_BINDINGS_FILE: bindingsFile, ZION_RUNTIME_EXTERNAL_PLUGINS: "none",
        ZION_RUNTIME_SCHEDULER_WORKER: "0", ZION_RUNTIME_PROJECT_AUTOMATION_WORKER: "0",
        ZION_RUNTIME_MIGRATE_LOCAL_TOOLS_STATE: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let url;
    for (let attempt = 0; attempt < 100; attempt++) {
      url = output.match(/Zion Runtime listening at (http:\/\/\S+)/)?.[1];
      if (url) break;
      if (child.exitCode !== null) throw new Error(output);
      await delay(100);
    }
    expect(url, output).toBeTruthy();
    const userId = (await database.pool.query("SELECT created_by FROM account_spaces WHERE id=$1",
      [database.defaultSpaceId])).rows[0].created_by;
    const session = await database.accounts.createSession(userId, { activeSpaceId: database.defaultSpaceId });
    const response = await fetch(`${url}/v1/capabilities/tools`, {
      headers: { authorization: `Bearer ${session.token}` }
    });
    expect(response.status).toBe(200);
    const { tools } = await response.json();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "Bash", "read", "write", "edit", "glob", "grep", "tree", "webSearch", "webFetch", "todoWrite"
    ]));
    for (const name of ["sendMail", "mcpListTools", "mcpCall"]) {
      const delegated = tools.find((tool) => tool.name === name);
      if (delegated) expect(delegated.availability.requiresDevice).toBe(true);
    }
    expect(tools.find((tool) => tool.name === "webSearch")).toMatchObject({
      hostKinds: ["runtime"], execution: { effect: "read", idempotency: "safe" }
    });
    const bash = tools.find((tool) => tool.name === "Bash");
    expect(bash.inputSchema.properties.timeout).toMatchObject({ default: 120000, maximum: 600000 });
    expect(bash.execution.timeoutMs).toBeGreaterThan(bash.inputSchema.properties.timeout.maximum);
  } finally {
    if (child && child.exitCode === null) {
      const exit = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exit;
      clearTimeout(timer);
    }
    await idp.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
