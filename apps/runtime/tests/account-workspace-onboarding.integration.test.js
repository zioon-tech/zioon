import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { AccountWorkspaceProvisioner } from "../src/sandbox/account-workspace-provisioner.mjs";
import { AccountRuntimeGateway } from "../src/accounts/account-runtime-gateway.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { PostgresSandboxStore } from "../src/sandbox/postgres-sandbox-store.mjs";
import { SandboxToolBroker } from "../src/sandbox/sandbox-tool-broker.mjs";
import { RuntimeToolBroker } from "../src/runtime-tool-broker.mjs";
import { FileInteractionProfileStore } from "../src/interaction-profile-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createWorkbenchStateHttpHandler } from "../src/workbench-state-http-handler.mjs";
import { createSharedAccountProvider } from "../src/accounts/shared-account-provider.mjs";
import { createAccountClient } from "../../../packages/zioon-account/src/client.mjs";
import { createLocalDevOidc } from "../src/accounts/local-dev-oidc.mjs";

const disposers = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
const policy = {
  preset: "trusted-automation", allowedTools: ["Bash", "read", "write"],
  fileRoots: ["/"], allowedCommandPrefixes: [], allowedTerminalSessionIds: [],
  allowedRecipients: [], maxToolCalls: 4, maxMailPerRun: 0
};
function binding(accountId, workspaceId, key) {
  return { accountId, workspaceId,
    storageNetwork: { allowOut: ["10.88.1.0/24"] },
    storageMetadata: {
      "fc.sandbox.storage.agenticfs": JSON.stringify({ mountPoints: [
        { mountDir: "/workspace", serverAddr: `nas-${key}:/` }
      ] }),
      "fc.sandbox.auth.role": `role:${key}`
    }
  };
}
async function database() {
  const db = await createPostgresTestDatabase("onboarding");
  disposers.push(() => db.close());
  return db;
}
async function user(db, label) {
  const account = await db.accounts.resolveIdentity({ issuer: "https://onboarding.test", subject: label });
  const space = await db.accounts.personalSpace(account.id);
  const session = await db.accounts.createSession(account.id);
  return { account, space, session };
}
function cloud() {
  return { provision: vi.fn(async ({ accountId, workspaceId, key, save }) => {
    await save({ volumeId: `volume:${key}` });
    return binding(accountId, workspaceId, key);
  }) };
}

describe("automatic account workspace onboarding", () => {
  it("boots the actual main entry and isolates account defaults and model credentials", async () => {
    const db = await database(), a = await user(db, "main-a"), b = await user(db, "main-b");
    const directory = await mkdtemp(join(tmpdir(), "zion-onboarding-main-"));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    let modelAuthorization;
    const modelServer = createServer(async (request, response) => {
      modelAuthorization = request.headers.authorization;
      for await (const chunk of request) { /* Drain the actual model request. */ }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"fresh-account-model-ok"}}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    disposers.push(() => new Promise((resolve) => modelServer.close(resolve)));
    const runtimeDirectory = join(directory, "runtime");
    await mkdir(runtimeDirectory);
    await writeFile(join(runtimeDirectory, "model-profiles.json"), JSON.stringify({ profiles: [{
      id: "platform-default", providerId: "fixture", providerType: "openai", model: "fixture",
      endpoint: `http://127.0.0.1:${modelServer.address().port}/chat`,
      credentialRef: "model.platform-default", credentialRequired: true
    }] }));
    await writeFile(join(runtimeDirectory, "credentials.json"), JSON.stringify({
      "model.platform-default": { value: "platform-fixture-key" }
    }));
    await writeFile(join(runtimeDirectory, "interaction-profiles.json"), JSON.stringify({ profiles: [{
      id: "interactive.default", modelProfileId: "platform-default", policy: { preset: "read-only" }
    }] }));
    const earlierAccountDirectory = join(runtimeDirectory, "accounts",
      createHash("sha256").update(b.space.id).digest("hex"));
    await mkdir(earlierAccountDirectory, { recursive: true });
    await writeFile(join(earlierAccountDirectory, "interaction-profiles.json"), JSON.stringify({ profiles: [{
      id: "interactive.default", modelProfileId: "deepseek-v4-flash", policy,
      metadata: { defaultToolSetVersion: 23, includeTerminalContext: true }
    }] }));
    const origin = "http://127.0.0.1:18895";
    const oidc = await createLocalDevOidc({ pool: db.pool, port: 18894, runtimeOrigin: origin });
    disposers.push(() => oidc.close());
    const adapter = new URL("../src/sandbox/aliyun-account-storage.mjs", import.meta.url).href;
    const preload = join(directory, "cloud-fixture.mjs");
    await writeFile(preload, `import {AliyunAccountStorage} from ${JSON.stringify(adapter)};
AliyunAccountStorage.prototype.provision = async function({accountId,workspaceId,key}) {
  return {accountId,workspaceId,storageNetwork:{allowOut:["10.88.1.0/24"]},
    storageMetadata:{"fc.sandbox.auth.role":"role:"+key,
      "fc.sandbox.storage.agenticfs":JSON.stringify({mountPoints:[{mountDir:"/workspace",serverAddr:"nas-"+key+":/"}]})}};
};`);
    await writeFile(join(directory, "bindings.json"), "[]");
    await writeFile(join(directory, "storage.json"), JSON.stringify({
      region: "cn-shanghai", zone: "cn-shanghai-f", cloudAccountId: "123",
      fileSystemId: "fs-test", vpcId: "vpc-test", vSwitchId: "vsw-test",
      securityGroupId: "sg-test", instanceRoleName: "ZionRuntimeSandboxProvisioner",
      storageNetwork: { allowOut: ["10.88.1.0/24"] }
    }));
    const child = spawn(process.execPath, ["--import", preload, "src/main.mjs"], {
      cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, ...db.childEnvironment,
        ZION_ENV: "development", ZION_ARTIFACT_STORE: "local",
        ZION_ARTIFACT_DIRECTORY: join(directory, "artifacts"),
        ZION_SPACE_ID: db.defaultSpaceId, ZION_RUNTIME_DATA_DIR: join(directory, "runtime"),
        ZION_RUNTIME_PORT: "18895", ZION_RUNTIME_ENGINE: "openai", ZION_RUNTIME_MODEL_PROFILE: "",
        ZION_RUNTIME_DEFAULT_INTERACTION_MODEL_PROFILE: "",
        ZION_RUNTIME_TOOL_MODE: "sandbox", ZION_RUNTIME_AUTH_MODE: "accounts", ZION_RUNTIME_PUBLIC_URL: origin,
        ZION_OIDC_ISSUER: oidc.issuer, ZION_OIDC_CLIENT_ID: oidc.clientId, ZIOON_ACCOUNT_ISSUER: "",
        ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP: "1", ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION: "1",
        ZION_SANDBOX_BINDINGS_FILE: join(directory, "bindings.json"), E2B_API_KEY: "startup-fixture-not-a-secret",
        ZION_SANDBOX_TEMPLATE: "startup-fixture", ZION_SANDBOX_REGION: "cn-shanghai",
        ZION_SANDBOX_AUTO_PROVISION: "1", ZION_SANDBOX_PROVISIONING_CONFIG: join(directory, "storage.json"),
        ZION_RUNTIME_API_KEY: "", ZION_RUNTIME_DEEPSEEK_API_KEY: "",
        ZION_PLUGIN_DATA_HOST: "managed", ZION_PLUGIN_DATA_SCOPE: "account",
        ZION_RUNTIME_PLUGINS: "none", ZION_RUNTIME_EXTERNAL_PLUGINS: "none",
        ZION_RUNTIME_STORAGE_MAINTENANCE: "0", ZION_RUNTIME_SCHEDULER_WORKER: "0",
        ZION_RUNTIME_PROJECT_AUTOMATION_WORKER: "0", OTEL_SDK_DISABLED: "true"
      }
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    disposers.push(async () => {
      if (child.exitCode !== null) return;
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
      await stopped; clearTimeout(timeout);
    });
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error(output);
      expect(output).toContain("Zion Runtime listening");
    }, { timeout: 30000, interval: 100 });
    const request = async (who, path, body, method = "GET") => {
      const response = await fetch(origin + path, {
        method, headers: { authorization: `Bearer ${who.session.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, body: await response.json() };
    };
    const health = await request(a, "/health");
    expect(health.status, JSON.stringify(health.body)).toBe(200);
    expect(health.body.space.id).toBe(a.space.id);
    expect((await request(b, "/health")).body.space.id).toBe(b.space.id);
    const defaults = await request(a, "/v1/interaction-profiles");
    expect(defaults.body.profiles.find((item) => item.id === "interactive.default").modelProfileId)
      .toBe("platform-default");
    expect((await request(b, "/v1/interaction-profiles")).body.profiles
      .find((item) => item.id === "interactive.default").modelProfileId).toBe("platform-default");
    expect(defaults.body.profiles.find((item) => item.id === "interactive.default").policy)
      .toMatchObject({ preset: "trusted-automation", fileRoots: ["/"], allowedTools: expect.arrayContaining(["Bash", "write", "read"]) });
    const run = await request(a, "/v1/runs", {
      interactionProfileId: "interactive.default", prompt: "Reply with fresh-account-model-ok",
      sessionId: "gateway-completion",
      policy: { allowedTools: [] }
    }, "POST");
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    await vi.waitFor(async () => {
      expect((await request(a, `/v1/runs/${run.body.runId}`)).body.run.status).toBe("completed");
    }, { timeout: 10000, interval: 100 });
    // The actual main entry serves account Runtimes through a shared gateway.
    // Terminal execution alone does not prove that their background work started.
    await vi.waitFor(async () => {
      const task = (await db.pool.query(
        "SELECT status,attempts FROM runtime_run_completion_tasks WHERE space_id=$1 AND run_id=$2",
        [a.space.id, run.body.runId]
      )).rows[0];
      expect(task?.status).toBe("completed");
      expect(task.attempts).toBe(1);
      const events = (await request(a, `/v1/runs/${run.body.runId}/events`)).body.events;
      expect(events.some(event => event.type === "run.finalized")).toBe(true);
    }, { timeout: 10000, interval: 100 });
    expect(modelAuthorization).toBe("Bearer platform-fixture-key");
    const overwrite = await request(a, "/v1/model-profiles/deepseek-v4-flash", {
      profile: { providerType: "openai", model: "custom", endpoint: "https://example.invalid/chat" }
    }, "PUT");
    expect(overwrite.status).toBe(403);
    const own = await request(a, "/v1/model-profiles/default", {
      profile: { providerType: "openai", model: "custom", endpoint: "https://example.invalid/chat" }
    }, "PUT");
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.profile.credentialConfigured).toBe(false);
    expect((await request(b, "/v1/models")).body.profiles.some((item) => item.id === "default")).toBe(false);
    expect(output).not.toContain("platform-fixture-key");
  }, 45000);

  it("onboards a previously unknown identity before completing unified login", async () => {
    const db = await database(), api = cloud();
    const provisioner = await new AccountWorkspaceProvisioner({ pool: db.pool, cloud: api }).initialize();
    const issuer = "https://identity.onboarding.test";
    const grant = {
      identity: { iss: issuer, sub: "previously-unknown", aud: "runtime-test",
        scope: "openid profile email zion.api", email: "fresh@example.invalid", email_verified: true },
      token: "zioon_at_test-fixture", expiresAt: Date.now() + 3600000
    };
    const accountClient = createAccountClient({
      issuer, adcOrigin: "https://adc.onboarding.test", clientId: "runtime-test",
      callbackUrl: "https://runtime.onboarding.test/v1/account/callback"
    });
    const provider = await createSharedAccountProvider({
      issuer, adcOrigin: "https://adc.onboarding.test", clientId: "runtime-test",
      publicBaseUrl: "https://runtime.onboarding.test", key: randomBytes(32), store: db.accounts,
      activeSpaceId: db.defaultSpaceId, onSessionCreated: (account) => provisioner.ensure(account.id),
      client: {
        issuer, begin: accountClient.begin, hostedLoginUrl: accountClient.hostedLoginUrl,
        callback: async () => grant, userinfo: async () => grant.identity
      }
    });
    const begin = await provider.begin("/");
    const authorization = (login) => new URL(login.url).searchParams;
    const session = await provider.callback(authorization(begin), begin.browser);
    const principal = await db.accounts.authenticate(session.token);
    expect(principal.space.id).not.toBe(db.defaultSpaceId);
    expect(principal.space.kind).toBe("personal");
    expect(principal.membership.role).toBe("owner");
    expect(provisioner.bindings).toHaveLength(1);
    expect(provisioner.bindings[0].accountId).toBe(principal.user.id);
    await expect(provider.validateSession(principal)).resolves.toBe(true);
    expect(api.provision).toHaveBeenCalledTimes(1);
    // An invalid grant must not create any account or cloud resource.
    grant.identity.aud = "other-client";
    const invalid = await provider.begin("/");
    await expect(provider.callback(authorization(invalid), invalid.browser))
      .rejects.toMatchObject({ code: "invalid_login_transaction" });
    expect(api.provision).toHaveBeenCalledTimes(1);
  });

  it("provisions an unbound new account once across concurrent logins and reloads", async () => {
    const db = await database(), a = await user(db, "fresh-a"), api = cloud();
    const provisioner = await new AccountWorkspaceProvisioner({ pool: db.pool, cloud: api }).initialize();
    const results = await Promise.all(Array.from({ length: 10 }, () => provisioner.ensure(a.account.id)));
    expect(api.provision).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((value) => value.workspaceId)).size).toBe(1);
    const restarted = await new AccountWorkspaceProvisioner({ pool: db.pool, cloud: api }).initialize();
    expect(await restarted.ensure(a.account.id)).toEqual(results[0]);
    expect(api.provision).toHaveBeenCalledTimes(1);
    const b = await user(db, "fresh-b");
    const other = await restarted.ensure(b.account.id);
    expect(other.workspaceId).not.toBe(results[0].workspaceId);
    expect(other.storageMetadata["fc.sandbox.storage.agenticfs"])
      .not.toBe(results[0].storageMetadata["fc.sandbox.storage.agenticfs"]);
    expect(api.provision).toHaveBeenCalledTimes(2);
  });

  it("serializes independent provisioners and recovers durable steps after failure", async () => {
    const db = await database(), a = await user(db, "recovery");
    let release, now = Date.now();
    const entered = new Promise((resolve) => {
      release = resolve;
    });
    let checkpointed;
    const checkpoint = new Promise((resolve) => { checkpointed = resolve; });
    const api = { provision: vi.fn(async ({ resources, save, ...scope }) => {
      if (!resources.volumeId) {
        await save({ volumeId: "created-once" });
        checkpointed();
        await entered;
        throw Object.assign(new Error("private provider details"), { code: "sandbox_storage_api_failed" });
      }
      expect(resources.volumeId).toBe("created-once");
      return binding(scope.accountId, scope.workspaceId, scope.key);
    }) };
    const p1 = await new AccountWorkspaceProvisioner({ pool: db.pool, cloud: api, now: () => now }).initialize();
    const p2 = await new AccountWorkspaceProvisioner({ pool: db.pool, cloud: api, now: () => now }).initialize();
    const first = p1.ensure(a.account.id);
    const caught = first.catch((error) => error);
    await checkpoint;
    await expect(p2.ensure(a.account.id)).rejects.toMatchObject({ code: "sandbox_provisioning_busy" });
    expect(api.provision).toHaveBeenCalledTimes(1);
    release();
    const error = await caught;
    expect(error.message).not.toContain("private provider");
    expect(error.code).toBe("sandbox_storage_api_failed");
    const row = (await db.pool.query("SELECT * FROM runtime_account_workspaces WHERE account_id=$1", [a.account.id])).rows[0];
    expect(row).toMatchObject({ status: "failed", resources: { volumeId: "created-once" } });
    await expect(p2.ensure(a.account.id)).rejects.toMatchObject({ code: "sandbox_storage_api_failed" });
    now += 31_000;
    expect(await p2.ensure(a.account.id)).toMatchObject({ accountId: a.account.id });
    expect(api.provision).toHaveBeenCalledTimes(2);
  });

  it("preserves imported volumes and refuses disabled users or duplicate mounts", async () => {
    const db = await database(), a = await user(db, "old"), b = await user(db, "new"), api = cloud();
    const imported = binding(a.account.id, "workspace:existing", "old");
    const provisioner = await new AccountWorkspaceProvisioner({ pool: db.pool, cloud: api, bindings: [imported] }).initialize();
    expect(await provisioner.ensure(a.account.id)).toEqual(imported);
    expect(api.provision).not.toHaveBeenCalled();
    await db.pool.query("UPDATE account_users SET status='disabled' WHERE id=$1", [b.account.id]);
    await expect(provisioner.ensure(b.account.id)).rejects.toMatchObject({ code: "account_disabled", statusCode: 403 });
    await db.pool.query("UPDATE account_users SET status='active' WHERE id=$1", [b.account.id]);
    api.provision.mockImplementation(async ({ accountId, workspaceId }) => ({ ...imported, accountId, workspaceId }));
    await expect(provisioner.ensure(b.account.id)).rejects.toMatchObject({ code: "sandbox_provisioning_failed" });
    expect(provisioner.bindings).toEqual([imported]);
  });

  it("routes fresh accounts to isolated sessions, Run caches, receipts and Node credentials", async () => {
    const db = await database(), a = await user(db, "http-a"), b = await user(db, "http-b");
    const api = cloud();
    const provisioner = await new AccountWorkspaceProvisioner({ pool: db.pool, cloud: api }).initialize();
    const sandboxHandles = new Map();
    const provider = {
      supportsPause: true,
      create: vi.fn(async (scope, requestKey) => {
        const handle = { sandboxId: randomUUID(), scope, requestKey };
        sandboxHandles.set(handle.sandboxId, handle);
        return handle;
      }),
      inspect: async (handle) => ({ state: sandboxHandles.has(handle.sandboxId) ? "running" : "destroyed" }),
      destroy: async (handle) => { sandboxHandles.delete(handle.sandboxId); },
      pause: async () => {}, resume: async () => {}, touch: async () => {},
      prepareEnvironment: async () => {},
      exec: async (_handle, scope) => ({ exitCode: 0, stdout: scope.accountId }),
      findCreated: async () => []
    };
    const make = vi.fn(async (spaceId) => {
      const accessStore = new PostgresAccessStore(db.pool, { spaceId });
      const accessControl = new AccountAccessControl({
        accounts: db.accounts, store: accessStore, oidc: { secureCookies: false },
        publicBaseUrl: "http://127.0.0.1", servedSpaceId: spaceId
      });
      const runs = new PostgresRunStore(db.pool, { spaceId });
      const workbench = await new PostgresWorkbenchStateStore(db.pool, { spaceId }).initialize();
      const sandboxStore = await new PostgresSandboxStore(db.pool, { spaceId }).initialize();
      const broker = new SandboxToolBroker({
        provider, store: sandboxStore, bindings: provisioner.bindings,
        allowEmptyBindings: true, authorizeInvocation: (input) => accessControl.authorizeInvocation(input)
      });
      const tools = new RuntimeToolBroker({ localTools: broker, receipts: runs,
        authorizeInvocation: (input) => accessControl.authorizeInvocation(input) });
      const executor = createAgentExecutor({
        runs, tools, authorizeRun: (request) => accessControl.authorizeRunExecution(request),
        engine: { id: "fixture", async *streamTurn(request) {
          if (request.turn === 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            yield { type: "tool.call", call: { id: "same-call", name: "Bash", arguments: { command: "pwd" } } };
          } else yield { type: "message.delta", delta: spaceId };
        } }
      });
      const profiles = new FileInteractionProfileStore();
      profiles.upsert({ id: "interactive.default", modelProfileId: "fixture", policy });
      const runtime = createRuntimeServer({
        executor, runs, accessControl, interactionProfiles: profiles, sessionEventStore: workbench,
        publicHttpHandlers: [accessControl.handleHttp.bind(accessControl)],
        serviceHttpHandlers: [createWorkbenchStateHttpHandler({ store: workbench })]
      });
      return { runtime, accessControl, workbench, runs, accessStore,
        isIdle: () => runtime.isIdle(),
        close: async () => { await runtime.close(); clearInterval(broker.timer); await workbench.close(); }
      };
    });
    const platform = await make(db.defaultSpaceId);
    const gateway = new AccountRuntimeGateway({
      platform, platformSpaceId: db.defaultSpaceId, pool: db.pool, provisioner,
      createRuntime: make, port: 0, idleMs: 0
    });
    disposers.push(() => gateway.close());
    const address = await gateway.start();
    const request = async (who, path, body, method) => {
      const response = await fetch(address.url + path, {
        method: method || (body === undefined ? "GET" : "POST"),
        headers: { authorization: `Bearer ${who.session.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, body: await response.json() };
    };
    const headers = await Promise.all([request(a, "/health"), request(b, "/health")]);
    expect(headers.map((result) => result.status)).toEqual([200, 200]);
    expect(api.provision).toHaveBeenCalledTimes(2);
    const appA = (await gateway.instance(a.space.id)).app, appB = (await gateway.instance(b.space.id)).app;
    await appA.workbench.updateSession("same-session", { text: "only A", meta: {} });
    await appB.workbench.updateSession("same-session", { text: "only B", meta: {} });
    expect((await request(a, "/v1/workbench-state/sessions/same-session")).body.text).toBe("only A");
    expect((await request(b, "/v1/workbench-state/sessions/same-session")).body.text).toBe("only B");
    const submitted = await Promise.all([a, b].map((who) => request(who, "/v1/runs", {
      prompt: "execute", sessionId: "same-session", policy
    })));
    expect(submitted.map((result) => result.status)).toEqual([202, 202]);
    const runIds = submitted.map((result) => result.body.runId);
    for (const [index, who] of [a, b].entries()) {
      let result;
      for (let attempt = 0; attempt < 100; attempt++) {
        result = await request(who, `/v1/runs/${runIds[index]}`);
        if (result.body.run?.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(result.body.run.status).toBe("completed");
      expect(result.body.run.principal.userId).toBe(who.account.id);
      const receipt = (await db.pool.query(`SELECT result_json FROM runtime_tool_invocation_receipts
        WHERE space_id=$1 AND run_id=$2`, [who.space.id, runIds[index]])).rows[0];
      expect(receipt.result_json.ok).toBe(true);
      expect(receipt.result_json.content).toBe(who.account.id);
    }
    expect((await request(b, `/v1/runs/${runIds[0]}`)).status).toBe(404);
    expect((await request(a, `/v1/runs/${runIds[1]}`)).status).toBe(404);
    expect(provider.create).toHaveBeenCalledTimes(2);
    const pairing = await request(a, "/v1/access/pairings", { kind: "resource", label: "A device" });
    expect(pairing.status).toBe(201);
    const paired = await fetch(address.url + "/v1/access/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId: pairing.body.pairingId, secret: pairing.body.secret,
        device: { deviceId: "node:a", label: "A device", platform: "test" } })
    });
    expect(paired.status).toBe(200);
    const connector = await paired.json();
    const entry = await gateway.select({ url: "/v1/nodes", headers: {
      authorization: `Bearer ${connector.credential}`
    } });
    expect(entry.app).toBe(appA);
    expect((await request(a, "/v1/access/devices")).body.devices.map((device) => device.deviceId)).toContain("node:a");
    expect((await request(b, "/v1/access/devices")).body.devices).toEqual([]);
    // Eviction closes in-memory caches, then rehydrates the same account data.
    await gateway.evict();
    expect((await request(a, "/v1/workbench-state/sessions/same-session")).body.text).toBe("only A");
    expect(api.provision).toHaveBeenCalledTimes(2);
  }, 30000);
});
