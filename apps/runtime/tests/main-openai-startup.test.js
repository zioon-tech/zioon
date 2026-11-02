import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const resources = [];

async function startRuntime(directory, environment = {}) {
  const database = await createPostgresTestDatabase("main_startup");
  const child = spawn(process.execPath, [
    resolve("src/main.mjs"),
    "--host", "127.0.0.1",
    "--port", "0",
    "--data-dir", directory,
    "--runtime-plugins", "none"
  ], {
    cwd: resolve("."),
    env: {
      ...process.env,
      ZION_RUNTIME_ENGINE: "openai",
      ZION_RUNTIME_MODEL_PROFILE: "",
      ZION_RUNTIME_MODEL_URL: "",
      ZION_RUNTIME_MODEL_ID: "",
      ZION_RUNTIME_SCHEDULER_WORKER: "0",
      ZION_RUNTIME_PROJECT_AUTOMATION_WORKER: "0",
      ZION_RUNTIME_MIGRATE_LOCAL_TOOLS_STATE: "0",
      ZION_SPACE_ID: database.nextSpaceId(),
      ...database.childEnvironment,
      ...environment
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  resources.push({ child, database, directory });
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for Runtime:\n${output}`));
    }, 10_000);
    const inspect = (chunk) => {
      output += String(chunk || "");
      const match = output.match(/Zion Runtime listening at (http:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolvePromise({ child, url: match[1] });
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(
        `Runtime exited before becoming ready (${signal || code}):\n${output}`
      ));
    });
  });
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    if (resource.child.exitCode == null) {
      resource.child.kill("SIGTERM");
      await new Promise((resolvePromise) => {
        resource.child.once("exit", resolvePromise);
      });
    }
    await resource.database.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("OpenAI Runtime startup", () => {
  it("starts without environment model settings and imports a dynamic profile", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-openai-startup-"));
    const runtime = await startRuntime(directory);

    const health = await fetch(`${runtime.url}/health`);
    expect(health.status).toBe(200);

    const response = await fetch(
      `${runtime.url}/v1/model-profiles/workbench.user.dynamic.test`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: {
            label: "Test model",
            providerId: "user.dynamic",
            sourceModelId: "test",
            providerType: "openai",
            endpoint: "https://example.test/v1/chat/completions",
            model: "test",
            credentialRequired: true
          },
          credential: "test-secret"
        })
      }
    );
    expect(response.status).toBe(200);
    const imported = await response.json();
    expect(imported.profile).toMatchObject({
      id: "workbench.user.dynamic.test",
      credentialConfigured: true
    });
    expect(JSON.stringify(imported)).not.toContain("test-secret");
  });

  it("seeds device tools before a Connector registers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-node-tools-startup-"));
    const runtime = await startRuntime(directory, {
      ZION_RUNTIME_TOOL_MODE: "node",
      ZION_RUNTIME_NODE_TOKEN: "test-node-token"
    });

    const response = await fetch(
      `${runtime.url}/v1/interaction-profiles/interactive.default`
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile.policy.allowedTools).toEqual(expect.arrayContaining([
      "read",
      "glob",
      "grep",
      "tree",
      "webSearch",
      "webFetch"
    ]));
  });
});
