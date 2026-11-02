import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentExecutor, CancellationController } from "../../../packages/runtime/src/index";
import { sandboxConfig } from "../../../packages/sandbox/src/config.mjs";
import { ManagedSandboxProvider, fingerprint } from "../../../packages/sandbox/src/provider.mjs";
import { SandboxToolBroker } from "../src/sandbox/sandbox-tool-broker.mjs";
import { PostgresSandboxStore } from "../src/sandbox/postgres-sandbox-store.mjs";
import { ManagedNodeToolRouter } from "../src/sandbox/managed-node-router.mjs";
import { SandboxTerminalService } from "../src/sandbox/sandbox-terminal-service.mjs";
import { workspaceFileCommand } from "../src/sandbox/workspace-file-command.mjs";
import { RuntimeToolBroker } from "../src/runtime-tool-broker.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { FileInteractionProfileStore } from "../src/interaction-profile-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createLocalDevOidc } from "../src/accounts/local-dev-oidc.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { parseTerminalReference } from "../../../packages/node-protocol/src/resource-references.mjs";

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const policy = {
  preset: "trusted-automation",
  allowedTools: [
    "Bash", "read", "write", "edit", "glob", "grep", "tree",
    "sandboxBash", "sandboxRead", "sandboxWrite"
  ],
  maxToolCalls: 10, fileRoots: ["/"], allowedCommandPrefixes: [],
  allowedTerminalSessionIds: [], allowedRecipients: [], maxMailPerRun: 0
};
function storage(accountId, label) {
  return {
    accountId, workspaceId: `workspace:${label}`,
    storageMetadata: {
      "fc.sandbox.storage.agenticfs": JSON.stringify({ mountPoints: [{ serverAddr: `nas-${label}:/`, mountDir: "/workspace" }] }),
      "fc.sandbox.auth.role": `role:${label}`
    }, storageNetwork: { allowOut: ["10.88.1.0/24"] }
  };
}
async function harness(provider) {
  const db = await createPostgresTestDatabase("sandbox");
  cleanup.push(() => db.close());
  const users = [];
  for (const label of ["a", "b"]) {
    const user = await db.accounts.resolveIdentity({ issuer: "https://sandbox.test", subject: label });
    const space = await db.accounts.personalSpace(user.id);
    users.push({ user, space });
  }
  // Two accounts in the same Space still receive distinct mounts.
  await db.pool.query(`INSERT INTO account_memberships
    (space_id,user_id,role,status,revision,created_at,updated_at)
    VALUES ($1,$2,'member','active',1,$3,$3)`,
  [users[0].space.id, users[1].user.id, Date.now()]);
  const spaceId = users[0].space.id;
  const access = new AccountAccessControl({
    accounts: db.accounts, store: new PostgresAccessStore(db.pool, { spaceId }),
    oidc: { secureCookies: true }, publicBaseUrl: "https://sandbox.test", servedSpaceId: spaceId
  });
  const principals = await Promise.all(users.map(({ user }) => db.accounts.issueGrant(user.id, policy, { spaceId })));
  const bindings = users.map(({ user }, i) => storage(user.id, i === 0 ? "a" : "b"));
  const store = await new PostgresSandboxStore(db.pool, { spaceId }).initialize();
  const brokers = [];
  cleanup.push(async () => {
    for (const broker of brokers) clearInterval(broker.timer);
    for (const row of await store.workspaces()) {
      await store.withWorkspace(row.account_id, row.workspace_id, async (tx) => {
        const instance = tx.state.instance;
        if (instance) await provider.destroy(instance.handle, instance.scope);
      });
    }
  });
  const make = (cloud = provider, options = {}) => {
    const broker = new SandboxToolBroker({
      provider: cloud, store, bindings, authorizeInvocation: (input) => access.authorizeInvocation(input),
      ...options
    });
    brokers.push(broker);
    return broker;
  };
  const invocation = (name = "sandboxBash", args = { command: "echo ok" }, account = 0) => ({
    invocationId: `invocation:${randomUUID()}`, runId: "run:test", attemptId: "attempt:test",
    principal: principals[account], policy, toolCall: { id: "call", name, arguments: args }
  });
  return { db, store, make, invocation, users, principals, bindings, access, spaceId };
}
function fakeCloud() {
  const handles = new Map();
  const ptys = new Map();
  let nextPid = 100;
  return {
    handles,
    ptys,
    supportsPause: true,
    create: vi.fn(async (scope, requestKey) => {
      const handle = { sandboxId: randomUUID(), scope, requestKey };
      handles.set(handle.sandboxId, handle);
      return handle;
    }),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
    destroy: vi.fn(async (handle) => { handles.delete(handle.sandboxId); }),
    inspect: vi.fn(async (handle) => ({ state: handles.get(handle.sandboxId)?.state || (handles.has(handle.sandboxId) ? "running" : "destroyed") })),
    pause: vi.fn(async (handle) => { handles.get(handle.sandboxId).state = "paused"; }),
    resume: vi.fn(async (handle) => { handles.get(handle.sandboxId).state = "running"; }),
    touch: vi.fn(async () => {}),
    prepareEnvironment: vi.fn(async () => {}),
    writeTemporary: vi.fn(async () => {}),
    stopExecution: vi.fn(async (_handle, _scope, execution) => {
      if (execution?.kind === "pty") ptys.delete(Number(execution.pid));
      return true;
    }),
    ptyExecution: vi.fn(async (_handle, _scope, pid) => ({ kind: "pty", pid, start: `start:${pid}` })),
    openPty: vi.fn(async (_handle, _scope, { pid = null, cwd = "/workspace", onData } = {}) => {
      const id = pid == null ? ++nextPid : Number(pid);
      if (!ptys.has(id)) {
        if (pid != null) throw new Error("Unknown PTY");
        ptys.set(id, { cwd, listeners: new Set() });
      }
      const terminal = ptys.get(id);
      terminal.listeners.add(onData);
      return {
        pid: id,
        wait: () => new Promise(() => {}),
        async disconnect() { terminal.listeners.delete(onData); }
      };
    }),
    ptyInput: vi.fn(async (_handle, _scope, pid, data) => {
      const terminal = ptys.get(Number(pid));
      if (!terminal) throw new Error("Unknown PTY");
      const input = String(data);
      if (input === "stty -echo\n") return;
      const start = input.match(/printf '\\n(__ZION_START_[a-f0-9]+__)\\n'/)?.[1];
      const end = input.match(/printf '\\n(__ZION_END_[a-f0-9]+__):%s:'/ )?.[1];
      const encoded = input.match(/printf '%s' '([^']+)' \| base64 -d/)?.[1];
      if (start && end && encoded) {
        const command = Buffer.from(encoded, "base64").toString("utf8");
        let output = "";
        let exitCode = 0;
        const cd = command.match(/^cd -- '([^']+)'$/);
        if (cd) terminal.cwd = cd[1];
        else if (command === "pwd") output = `${terminal.cwd}\n`;
        else if (command.startsWith("echo ")) output = `${command.slice(5)}\n`;
        else exitCode = 127;
        const frame = `\r\n${start}\r\n${output}\r\n${end}:${exitCode}:${Buffer.from(`${terminal.cwd}\n`).toString("base64")}\r\n`;
        for (const listener of terminal.listeners) listener(Buffer.from(frame));
        return;
      }
      for (const listener of terminal.listeners) listener(Buffer.from(input));
    }),
    ptyResize: vi.fn(async () => {}),
    ptyKill: vi.fn(async (_handle, _scope, pid) => { ptys.delete(Number(pid)); }),
    findCreated: vi.fn(async (scope, key) => [...handles.values()].filter((h) => fingerprint(h.scope) === fingerprint(scope) && h.requestKey === key))
  };
}

describe("sandbox Runtime durable integration", () => {
  it("refuses the legacy managed plugin-data path for Identity", async () => {
    const h = await harness(fakeCloud());
    const directory = await mkdtemp(join(tmpdir(), "zion-sandbox-main-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const oidc = await createLocalDevOidc({ pool: h.db.pool, port: 18892, runtimeOrigin: "http://127.0.0.1:18893" });
    cleanup.push(() => oidc.close());
    const bindingsPath = join(directory, "bindings.json");
    await writeFile(bindingsPath, JSON.stringify(h.bindings));
    const child = spawn(process.execPath, ["src/main.mjs"], {
      cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, ...h.db.childEnvironment,
        ZION_SPACE_ID: h.spaceId, ZION_RUNTIME_DATA_DIR: directory,
        ZION_RUNTIME_PORT: "18893", ZION_RUNTIME_ENGINE: "echo",
        ZION_RUNTIME_TOOL_MODE: "sandbox", ZION_RUNTIME_AUTH_MODE: "accounts",
        ZION_RUNTIME_PUBLIC_URL: "http://127.0.0.1:18893",
        ZION_OIDC_ISSUER: oidc.issuer, ZION_OIDC_CLIENT_ID: oidc.clientId,
        ZION_ACCOUNT_ALLOW_LOOPBACK_HTTP: "1", ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION: "1",
        ZION_SANDBOX_BINDINGS_FILE: bindingsPath, E2B_API_KEY: "startup-fixture-not-a-secret",
        ZION_SANDBOX_TEMPLATE: "startup-fixture",
        ZION_PLUGIN_DATA_HOST: "managed",
        ZION_PLUGIN_DATA_SCOPE: "account",
        ZION_RUNTIME_PLUGINS: "dev.identity",
        ZION_RUNTIME_EXTERNAL_PLUGINS: "none",
        ZION_RUNTIME_STORAGE_MAINTENANCE: "0", OTEL_SDK_DISABLED: "true"
      }
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    cleanup.push(async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    });
    await vi.waitFor(() => {
      expect(child.exitCode).not.toBeNull();
    }, { timeout: 45000, interval: 200 });
    expect(output).toContain(
      "dev.identity requires ZION_MEMORY_SERVICE_URL; "
      + "legacy plugin-data storage is no longer supported"
    );
    expect(output).not.toContain("Zion Runtime listening");
  }, 60000);

  it("reauthorizes cached operations and rejects device targets, unbound accounts and paths before create", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    const broker = h.make();
    const call = h.invocation();
    expect((await broker.invoke(call, new CancellationController().signal)).ok).toBe(true);
    expect((await broker.invoke(call, new CancellationController().signal)).ok).toBe(true);
    expect(cloud.exec).toHaveBeenCalledTimes(1);
    await expect(broker.invoke({ ...h.invocation(), target: { nodeId: "device" } }, new CancellationController().signal)).rejects.toThrow("device_target");
    await expect(broker.invoke(h.invocation("sandboxRead", { path: "/workspace/../secret" }), new CancellationController().signal)).rejects.toThrow("invalid_path");
    h.bindings.splice(1);
    await expect(broker.invoke(h.invocation("sandboxBash", { command: "echo b" }, 1), new CancellationController().signal)).rejects.toThrow("unbound");
    await h.db.accounts.revokeGrant(h.users[0].user.id, h.principals[0].grantId, h.spaceId);
    await expect(broker.invoke(call, new CancellationController().signal)).rejects.toThrow();
    expect(cloud.create).toHaveBeenCalledTimes(1);
  });

  it("allows VM paths while enforcing a narrower account grant before dispatch", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    const broker = h.make();
    for (const path of ["/root/.gitconfig", "/etc/passwd", "/tmp/probe.txt"]) {
      expect((await broker.invoke(h.invocation("read", { path }), new CancellationController().signal)).ok).toBe(true);
    }
    const narrowPolicy = { ...policy, fileRoots: ["/workspace"] };
    const principal = await h.db.accounts.issueGrant(h.users[0].user.id, narrowPolicy, { spaceId: h.spaceId });
    await expect(broker.invoke({
      ...h.invocation("read", { path: "/root/.gitconfig" }),
      principal, policy: narrowPolicy
    }, new CancellationController().signal)).rejects.toThrow("outside_grant");
    expect(cloud.exec).toHaveBeenCalledTimes(3);
  });

  it("stops when persistent HOME initialization fails or is cancelled without dispatching the command", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    cloud.prepareEnvironment.mockRejectedValueOnce(new Error("mount unavailable"));
    const broker = h.make();
    expect((await broker.invoke(h.invocation(), new CancellationController().signal)).failureCode).toBe("execution_outcome_unknown");
    expect(cloud.exec).not.toHaveBeenCalled();
    expect(cloud.handles.size).toBe(0);
    let started;
    const gate = new Promise((resolve) => { started = resolve; });
    cloud.prepareEnvironment.mockImplementationOnce(() => { started(); return new Promise(() => {}); });
    const controller = new CancellationController();
    const pending = broker.invoke(h.invocation("Bash", { command: "echo different" }), controller.signal);
    await gate;
    controller.cancel("cancel-init");
    expect((await pending).failureCode).toBe("execution_outcome_unknown");
    expect(cloud.exec).not.toHaveBeenCalled();
    expect(cloud.handles.size).toBe(0);
  });

  it("checks resolved symlink paths against file grants while permitting HOME with full VM access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zion-file-grants-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const { mkdir, symlink } = await import("node:fs/promises");
    await mkdir(join(directory, "workspace"));
    await mkdir(join(directory, "home"));
    await writeFile(join(directory, "home/config"), "persistent-setting");
    await symlink(join(directory, "home"), join(directory, "workspace/home"));
    const args = { path: join(directory, "workspace/home/config") };
    const run = (fileRoots) => execFileSync("/bin/bash", ["-c", workspaceFileCommand("read", args, { fileRoots })], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(run(["/"])).content).toBe("persistent-setting");
    expect(() => run([join(directory, "workspace")])).toThrow();
  });

  it("rechecks account authority after slow HOME initialization before the user command", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    cloud.prepareEnvironment.mockImplementationOnce(async () => {
      await h.db.accounts.revokeGrant(h.users[0].user.id, h.principals[0].grantId, h.spaceId);
    });
    expect((await h.make().invoke(h.invocation(), new CancellationController().signal)).ok).toBe(false);
    expect(cloud.exec).not.toHaveBeenCalled();
    expect(cloud.handles.size).toBe(1);
  });

  it("allows independent invocation claims concurrently while preserving account isolation", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    let unblock;
    cloud.exec.mockImplementationOnce(() => new Promise((resolve) => { unblock = () => resolve({ exitCode: 0, stdout: "first" }); }));
    const first = h.make().invoke(h.invocation(), new CancellationController().signal);
    await vi.waitFor(() => expect(unblock).toBeTypeOf("function"));
    const second = await h.make().invoke(h.invocation(), new CancellationController().signal);
    expect(second.ok).toBe(true);
    expect((await h.make().invoke(h.invocation("sandboxBash", { command: "b" }, 1), new CancellationController().signal)).ok).toBe(true);
    unblock();
    expect((await first).ok).toBe(true);
    expect(cloud.create).toHaveBeenCalledTimes(2);
    expect(cloud.exec).toHaveBeenCalledTimes(3);
  });

  it("does not hold the execution lock during a slow workspace status inspection", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    const broker = h.make();
    await broker.invoke(h.invocation(), new CancellationController().signal);
    let inspectStarted;
    let finishInspection;
    const started = new Promise((resolve) => { inspectStarted = resolve; });
    const gate = new Promise((resolve) => { finishInspection = resolve; });
    cloud.inspect.mockImplementationOnce(async () => {
      inspectStarted();
      await gate;
      return { state: "running" };
    });
    const status = broker.workspaceStatus(h.users[0].user.id);
    await started;
    try {
      expect((await h.make().invoke(h.invocation("read", { path: "/workspace/hello.txt" }), new CancellationController().signal)).ok).toBe(true);
    } finally {
      finishInspection();
      await status;
    }
  });

  it("skips recent idle maintenance before attempting to acquire an execution lock", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    const broker = h.make();
    await broker.invoke(h.invocation(), new CancellationController().signal);
    const workspaceLock = vi.spyOn(h.store, "withWorkspace");
    await broker.sweep();
    expect(workspaceLock).not.toHaveBeenCalled();
  });

  it("returns an executing status without inspecting the cloud or blocking on the active command", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    let started;
    let finishCommand;
    const gate = new Promise((resolve) => { started = resolve; });
    cloud.exec.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => { finishCommand = () => resolve({ exitCode: 0, stdout: "done" }); });
    });
    const broker = h.make();
    const executing = broker.invoke(h.invocation(), new CancellationController().signal);
    await gate;
    cloud.inspect.mockClear();
    try {
      expect(await broker.workspaceStatus(h.users[0].user.id)).toMatchObject({ state: "executing", workspaceId: h.bindings[0].workspaceId });
      expect(cloud.inspect).not.toHaveBeenCalled();
    } finally {
      finishCommand();
      await executing;
    }
  });

  it("terminates on cancellation and preserves an unknown result across restart and changed invocation ids", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    let fail;
    cloud.exec.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    cloud.stopExecution.mockImplementation(async () => { fail?.(new Error("terminated")); return true; });
    const controller = new CancellationController();
    const call = h.invocation();
    const executing = h.make().invoke(call, controller.signal);
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    controller.cancel("user-pause");
    expect((await executing).failureCode).toBe("execution_outcome_unknown");
    const restarted = h.make();
    expect((await restarted.invoke(call, new CancellationController().signal)).failureCode).toBe("execution_outcome_unknown");
    expect((await restarted.invoke({ ...call, invocationId: "another" }, new CancellationController().signal)).failureCode).toBe("execution_outcome_unknown");
    expect(cloud.exec).toHaveBeenCalledTimes(1);
    expect(cloud.stopExecution).toHaveBeenCalledTimes(1);
    expect(cloud.handles.size).toBe(1);
  });

  it("blocks further writers when kill cannot be confirmed, then reconciles before the next operation", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    cloud.exec.mockRejectedValueOnce(new Error("ACK lost"));
    cloud.stopExecution.mockRejectedValue(new Error("stop unavailable"));
    const call = h.invocation();
    expect((await h.make().invoke(call, new CancellationController().signal)).failureCode).toBe("execution_outcome_unknown");
    await expect(h.make().invoke(h.invocation("sandboxRead", { path: "/workspace/file" }), new CancellationController().signal)).rejects.toThrow("termination remains unconfirmed");
    expect(cloud.exec).toHaveBeenCalledTimes(1);
    expect(cloud.create).toHaveBeenCalledTimes(1);
    cloud.stopExecution.mockResolvedValue(true);
    expect((await h.make().invoke(h.invocation("sandboxRead", { path: "/workspace/file" }), new CancellationController().signal)).ok).toBe(true);
    expect(cloud.handles.size).toBe(1);
  });

  it("recovers a crash after create using metadata and does not reexecute the old operation", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    const call = h.invocation();
    const scope = { accountId: h.bindings[0].accountId, workspaceId: h.bindings[0].workspaceId, attemptId: call.attemptId, epoch: 1 };
    const hash = fingerprint({ runId: call.runId, accountId: scope.accountId, workspaceId: scope.workspaceId, name: "Bash", args: call.toolCall.arguments });
    await h.store.withWorkspace(scope.accountId, scope.workspaceId, async (tx) => {
      await tx.begin({ invocationId: call.invocationId, toolName: call.toolCall.name, scope, requestKey: "crash", reconcileAfter: Date.now() + 10000 }, hash);
      await cloud.create(scope, "crash");
      // Process died before storing the cloud handle.
    });
    expect((await h.make().invoke(call, new CancellationController().signal)).failureCode).toBe("execution_outcome_unknown");
    expect(cloud.findCreated).toHaveBeenCalledTimes(1);
    expect(cloud.exec).not.toHaveBeenCalled();
    expect(cloud.handles.size).toBe(0);
  });

  it("does not reinterpret an empty listing as proof that a timed-out create failed", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    cloud.create.mockRejectedValue(new Error("timeout"));
    expect((await h.make().invoke(h.invocation(), new CancellationController().signal)).failureCode).toBe("execution_outcome_unknown");
    await expect(h.make().invoke(h.invocation(), new CancellationController().signal)).rejects.toThrow("creation outcome remains unknown");
    expect(cloud.create).toHaveBeenCalledTimes(1);
  });

  it("rejects persistent mount rebinding after an account has used a workspace", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    await h.make().invoke(h.invocation(), new CancellationController().signal);
    h.bindings[0].storageMetadata["fc.sandbox.auth.role"] = "different-role";
    await expect(h.make().invoke(h.invocation(), new CancellationController().signal)).rejects.toThrow("explicit migration required");
    expect(cloud.create).toHaveBeenCalledTimes(1);
  });

  it("reuses the same instance across calls, sessions, and broker restart", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    const call = h.invocation();
    await h.make().invoke({ ...call, sessionId: "session:a" }, new CancellationController().signal);
    const first = await h.make().workspaceStatus(h.users[0].user.id);
    await h.make().invoke({ ...h.invocation(), attemptId: "new:attempt", sessionId: "session:b" }, new CancellationController().signal);
    const second = await h.make().workspaceStatus(h.users[0].user.id);
    expect(first.sandboxId).toBe(second.sandboxId);
    expect(second.epoch).toBe(1);
    expect(cloud.create).toHaveBeenCalledTimes(1);
    expect(cloud.destroy).not.toHaveBeenCalled();
  });

  it("pauses when idle, resumes the same instance and releases it after prolonged inactivity", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    let now = 100000;
    const broker = h.make(cloud, { now: () => now, idlePauseMs: 30000, idleDestroyMs: 90000 });
    await broker.invoke(h.invocation(), new CancellationController().signal);
    const first = await broker.workspaceStatus(h.users[0].user.id);
    now += 30001;
    await broker.sweep();
    expect((await broker.workspaceStatus(h.users[0].user.id)).state).toBe("paused");
    await broker.invoke(h.invocation(), new CancellationController().signal);
    expect(cloud.resume).toHaveBeenCalledTimes(1);
    expect((await broker.workspaceStatus(h.users[0].user.id)).sandboxId).toBe(first.sandboxId);
    now += 90001;
    await broker.sweep();
    expect((await broker.workspaceStatus(h.users[0].user.id)).state).toBe("not_created");
    await broker.invoke(h.invocation(), new CancellationController().signal);
    expect(cloud.create).toHaveBeenCalledTimes(2);
  });
  it("holds activity for plugin work and rotates the Host resource epoch when resuming the same VM", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    let now = 100000;
    const broker = h.make(cloud, { now: () => now, idlePauseMs: 30000, idleDestroyMs: 90000 });
    const signal = new CancellationController().signal;
    const lease = broker.acquireActivityLease(h.bindings[0].accountId, h.bindings[0].workspaceId);
    const first = await broker.prepareExtensionHost(h.invocation(), signal);
    const sandboxId = (await broker.workspaceStatus(h.users[0].user.id)).sandboxId;
    now += 30001;
    await broker.sweep();
    expect(cloud.pause).not.toHaveBeenCalled();
    await expect(broker.controlWorkspace(h.users[0].user.id, "pause")).rejects.toMatchObject({ failureCode: "sandbox_workspace_busy" });
    lease.dispose();
    await broker.sweep();
    expect(cloud.pause).toHaveBeenCalledTimes(1);
    const second = await broker.prepareExtensionHost(h.invocation(), signal);
    expect(second).not.toBe(first);
    expect((await broker.workspaceStatus(h.users[0].user.id)).sandboxId).toBe(sandboxId);
    expect(cloud.exec).not.toHaveBeenCalled();
  });

  it("idle sweep cannot pause an active command and shutdown cancels before releasing ownership", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    let started;
    const gate = new Promise((resolve) => { started = resolve; });
    cloud.exec.mockImplementationOnce(() => { started(); return new Promise(() => {}); });
    const broker = h.make();
    const operation = broker.invoke(h.invocation(), new CancellationController().signal);
    await gate;
    await broker.sweep({ pauseAll: true });
    expect(cloud.pause).not.toHaveBeenCalled();
    await broker.close();
    expect((await operation).failureCode).toBe("execution_outcome_unknown");
    expect(cloud.stopExecution).toHaveBeenCalledTimes(1);
    expect(cloud.handles.size).toBe(1);
  });

  it("recreates an expired instance and reconciles uncertain processes before reusing a healthy instance", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    const broker = h.make();
    await broker.invoke(h.invocation(), new CancellationController().signal);
    cloud.handles.clear();
    await broker.invoke(h.invocation(), new CancellationController().signal);
    expect(cloud.create).toHaveBeenCalledTimes(2);
    cloud.exec.mockRejectedValueOnce(new Error("unknown"));
    expect((await broker.invoke(h.invocation("sandboxBash", { command: "uncertain" }), new CancellationController().signal)).failureCode).toBe("execution_outcome_unknown");
    expect(cloud.stopExecution).toHaveBeenCalledTimes(1);
    expect(cloud.handles.size).toBe(1);
    await broker.invoke(h.invocation("sandboxRead", { path: "/workspace/file" }), new CancellationController().signal);
    expect(cloud.create).toHaveBeenCalledTimes(2);
  });

  it("fences a lost PostgreSQL lock connection before a replacement broker starts another writer", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    let backendId;
    const original = h.store.withExecution.bind(h.store);
    h.store.withExecution = (account, workspace, invocationId, task, hash, signal) => original(account, workspace, invocationId, async (tx) => {
      backendId = (await tx.assertOwned()).rows[0].pid;
      return task(tx);
    }, hash, signal);
    let started;
    const gate = new Promise((resolve) => { started = resolve; });
    cloud.exec.mockImplementationOnce(() => { started(); return new Promise(() => {}); });
    const first = h.make().invoke(h.invocation(), new CancellationController().signal);
    const observed = first.then(() => null, (error) => error);
    await gate;
    expect(backendId).toBeTypeOf("number");
    await h.db.pool.query("SELECT pg_terminate_backend($1)", [backendId]);
    const replacement = await h.make().invoke(h.invocation("sandboxRead", { path: "/workspace/file" }), new CancellationController().signal);
    expect(replacement.ok).toBe(true);
    expect(cloud.stopExecution).toHaveBeenCalled();
    expect(cloud.destroy).not.toHaveBeenCalled();
    expect(cloud.create).toHaveBeenCalledTimes(1);
    expect(await observed).toBeInstanceOf(Error);
  }, 15000);

  it("exposes the reusable sandbox as a managed Node with persistent PTY routing and stale-reference fences", async () => {
    const cloud = fakeCloud();
    const h = await harness(cloud);
    const broker = h.make();
    const canonicalPolicy = {
      ...policy,
      allowedTools: ["Bash", "read", "write", "edit", "glob", "grep", "tree"]
    };
    const canonicalPrincipal = await h.db.accounts.issueGrant(
      h.users[0].user.id,
      canonicalPolicy,
      { spaceId: h.spaceId }
    );
    const authorizeActor = async (runContext) => (
      await h.db.accounts.validateGrant(
        runContext.principal,
        runContext.policy
      )
    ).principal;
    const withLifecycleGrant = async (runContext, operation) => {
      const actor = await authorizeActor(runContext);
      const lifecyclePolicy = {
        ...policy,
        allowedTools: ["Bash"]
      };
      const principal = await h.db.accounts.issueGrant(
        actor.userId,
        lifecyclePolicy,
        {
          spaceId: actor.spaceId,
          ttlMs: 60_000,
          scopes: ["run.execute", "resource.execute"]
        }
      );
      try {
        return await operation({ principal, policy: lifecyclePolicy });
      } finally {
        await h.db.accounts.revokeGrant(
          actor.userId,
          principal.grantId,
          actor.spaceId
        );
      }
    };
    const terminal = new SandboxTerminalService({
      sandbox: broker,
      provider: cloud,
      store: h.store,
      authorizeActor,
      withLifecycleGrant
    });
    cleanup.push(() => terminal.close());
    const device = {
      supportedToolNames: ["Bash"],
      getToolDefinitions: () => [],
      listTools: vi.fn(async () => []),
      invoke: vi.fn(async () => ({ ok: true, content: "device" }))
    };
    const router = new ManagedNodeToolRouter({
      sandbox: broker,
      device
    });
    router.setTerminalService(terminal);
    const runContext = {
      principal: h.principals[0],
      policy,
      signal: new CancellationController().signal
    };

    const initial = await terminal.listInventory({ runContext });
    expect(initial.nodes).toEqual([
      expect.objectContaining({ status: "ready", managed: true })
    ]);
    expect(initial.sessions).toEqual([]);
    expect(initial.machines[0]).toMatchObject({ status: "ready", managed: true, workspaceState: "not_created" });
    const session = await terminal.createSession({
      payload: { type: "local", initial_cwd: "/root" },
      runContext
    });
    const firstReference = parseTerminalReference(session.id);
    expect(firstReference?.nodeId).toBe(initial.nodes[0].nodeId);
    expect(firstReference?.instanceId).toMatch(/^sandbox:/);
    expect(session.cwd).toBe("/root");
    expect((await terminal.setSessionCwd({ sessionId: session.id, cwd: "/tmp", runContext })).cwd).toBe("/tmp");
    expect((await terminal.getSession({ sessionId: session.id, runContext })).cwd).toBe("/tmp");
    await expect(terminal.createSession({ payload: { cwd: "/tmp/../root" }, runContext })).rejects.toMatchObject({ statusCode: 400 });

    const commandId = `managed-command:${randomUUID()}`;
    const command = await router.invoke({
      invocationId: commandId,
      runId: "managed-run",
      attemptId: "managed-attempt",
      principal: canonicalPrincipal,
      policy: canonicalPolicy,
      toolCall: {
        id: commandId,
        name: "Bash",
        arguments: {
          command: "echo managed",
          session_id: session.id
        }
      }
    }, new CancellationController().signal);
    expect(command.ok).toBe(true);
    expect(command.content).toContain("managed");
    const largeWriteId = `managed-write:${randomUUID()}`;
    const largeWrite = await router.invoke({
      invocationId: largeWriteId,
      runId: "managed-run",
      attemptId: "managed-attempt",
      principal: canonicalPrincipal,
      policy: canonicalPolicy,
      toolCall: {
        id: largeWriteId,
        name: "write",
        arguments: {
          path: "/workspace/large.txt",
          content: "x".repeat(100_000)
        }
      }
    }, new CancellationController().signal);
    expect(largeWrite.ok).toBe(true);
    expect(cloud.writeTemporary).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(cloud.exec.mock.calls.at(-1)[2].command))
      .toBeLessThan(32_000);

    const opened = await terminal.handleRequest({
      path: `/sessions/${encodeURIComponent(session.id)}/pty/relay/open`,
      method: "POST",
      body: Buffer.from(JSON.stringify({ cols: 100, rows: 30 })),
      runContext
    });
    const channelId = opened.body.channelId;
    expect(channelId).toBeTruthy();
    await terminal.handleRequest({
      path: `/sessions/${encodeURIComponent(session.id)}/pty/relay/${channelId}/input`,
      method: "POST",
      body: Buffer.from(JSON.stringify({ type: "input", data: "hello" })),
      runContext
    });
    const events = await terminal.handleRequest({
      path: `/sessions/${encodeURIComponent(session.id)}/pty/relay/${channelId}/events?waitMs=1`,
      method: "GET",
      runContext
    });
    expect(Buffer.from(events.body.events[0].dataBase64, "base64").toString()).toBe("hello");

    await broker.sweep({ pauseAll: true });
    expect(cloud.pause).not.toHaveBeenCalled();
    await terminal.handleRequest({
      path: `/sessions/${encodeURIComponent(session.id)}/pty/relay/${channelId}`,
      method: "DELETE",
      runContext
    });
    await broker.sweep({ pauseAll: true });
    expect(cloud.pause).toHaveBeenCalledTimes(1);

    const deviceId = `device-command:${randomUUID()}`;
    await router.invoke({
      invocationId: deviceId,
      runId: "managed-run",
      attemptId: "managed-attempt",
      principal: canonicalPrincipal,
      policy: canonicalPolicy,
      toolCall: {
        id: deviceId,
        name: "Bash",
        arguments: { command: "echo device", node_id: "node:device" }
      }
    }, new CancellationController().signal);
    expect(device.invoke).toHaveBeenCalledTimes(1);

    await broker.controlWorkspace(h.users[0].user.id, "release");
    await expect(terminal.getSession({
      sessionId: session.id,
      runContext
    })).rejects.toMatchObject({ code: "stale_terminal_reference" });
    const replacement = await terminal.createSession({
      payload: { type: "local" },
      runContext
    });
    expect(parseTerminalReference(replacement.id).instanceId)
      .not.toBe(firstReference.instanceId);
  }, 15000);
});

describe.skipIf(process.env.ZION_SANDBOX_LIVE_TEST !== "1")("live Aliyun HTTP Run integration", () => {
  it("reuses a real VM, resumes it after pause and preserves files after release", async () => {
    const resources = JSON.parse(await readFile(new URL("../../../deploy/sandbox/agenticfs-poc.resources.json", import.meta.url), "utf8"));
    const credential = JSON.parse(execFileSync("security", [
      "find-generic-password", "-s", "dev.zion.sandbox-poc",
      "-a", `aliyun:${resources.region}:${resources.teamId}`, "-w"
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const provider = new ManagedSandboxProvider(sandboxConfig({
      E2B_API_KEY: credential.apiKey, ZION_SANDBOX_TEMPLATE: resources.templateId, ZION_SANDBOX_REGION: resources.region,
      ZION_SANDBOX_PAUSE_VERIFIED: "1"
    }), { persistentHome: true });
    const h = await harness(provider);
    h.bindings.forEach((binding, i) => {
      binding.storageMetadata = {
        "fc.sandbox.auth.role": resources.workspaces[i].roleArn,
        "fc.sandbox.network.vpc": JSON.stringify({
          vpcId: resources.vpcId, securityGroupId: resources.securityGroupId, vSwitchIds: [resources.vSwitchId]
        }),
        "fc.sandbox.storage.agenticfs": JSON.stringify({
          userID: 0, groupID: 0,
          mountPoints: [{ serverAddr: resources.workspaces[i].serverAddr, mountDir: "/workspace" }]
        })
      };
      binding.storageNetwork = { allowOut: ["10.88.1.0/24", "100.100.2.136/32", "100.100.2.138/32"] };
    });
    const runs = new PostgresRunStore(h.db.pool, { spaceId: h.spaceId });
    let nextCall;
    const broker = h.make();
    const tools = new RuntimeToolBroker({
      localTools: broker, receipts: runs,
      authorizeInvocation: (input) => h.access.authorizeInvocation(input)
    });
    const executor = createAgentExecutor({
      runs, tools, authorizeRun: (request) => h.access.authorizeRunExecution(request),
      engine: {
        id: "sandbox-integration-fixture",
        async *streamTurn(request) {
          if (request.turn === 1) yield { type: "tool.call", call: nextCall };
          else yield { type: "message.delta", delta: "verified" };
        }
      }
    });
    const profiles = new FileInteractionProfileStore();
    profiles.upsert({ id: "interactive.default", modelProfileId: "fixture", policy });
    const server = createRuntimeServer({ executor, runs, accessControl: h.access, interactionProfiles: profiles });
    cleanup.push(() => server.close());
    const address = await server.start();
    const sessions = await Promise.all(h.users.map(({ user }) => h.db.accounts.createSession(user.id, { activeSpaceId: h.spaceId })));
    const report = { checks: [], marker: `runtime-${randomUUID()}`, activeSandboxes: null };
    const probeKey = report.marker.replaceAll("-", "");
    const probeVariable = `ZION_PROBE_${probeKey}`;
    const probeCounter = `ZION_PROBE_COUNT_${probeKey}`;
    const probeCli = `zion-probe-${probeKey}`;
    const envBlock = `\n# ${report.marker}\nexport ${probeVariable}=persistent-env\nexport ${probeCounter}=$(("\${${probeCounter}:-0}"+1))\n`;
    const rcBlock = `\n# ${report.marker}\nprintf 'user-startup-output\\n'\n`;
    const encodedEnv = Buffer.from(envBlock).toString("base64");
    const encodedRc = Buffer.from(rcBlock).toString("base64");
    const authorizeActor = async (context) => (
      await h.db.accounts.validateGrant(context.principal, context.policy)
    ).principal;
    const terminal = new SandboxTerminalService({
      sandbox: broker, provider, store: h.store, authorizeActor,
      withLifecycleGrant: async (context, operation) => {
        const actor = await authorizeActor(context);
        const terminalPolicy = { ...policy, allowedTools: ["Bash"] };
        const principal = await h.db.accounts.issueGrant(actor.userId, terminalPolicy, {
          spaceId: actor.spaceId, ttlMs: 300_000, scopes: ["run.execute", "resource.execute"]
        });
        try { return await operation({ principal, policy: terminalPolicy }); }
        finally { await h.db.accounts.revokeGrant(actor.userId, principal.grantId, actor.spaceId); }
      }
    });
    cleanup.push(() => terminal.close());
    const terminalContext = { principal: h.principals[0], policy, signal: new CancellationController().signal };
    const verifyEnvironment = `test "$HOME" = /root && test "$(git config --global zionprobe.${probeKey})" = persistent-git && test "$${probeVariable}" = persistent-env && test "$${probeCounter}" = 1 && ${probeCli}`;
    const cleanupHome = `
import pathlib,base64
for path,block in [(pathlib.Path('/root/.config/zion/env.sh'),base64.b64decode('${encodedEnv}').decode()),(pathlib.Path('/root/.bashrc'),base64.b64decode('${encodedRc}').decode())]:
    if path.exists(): path.write_text(path.read_text().replace(block,''))
pathlib.Path('/root/.local/bin/${probeCli}').unlink(missing_ok=True)
`;
    const cleanupHomeCommand = `/usr/bin/python3 -c "$(printf '%s' '${Buffer.from(cleanupHome).toString("base64")}' | /usr/bin/base64 -d)"; git config --global --unset-all zionprobe.${probeKey} || true`;
    async function httpRun(account, name, args) {
      nextCall = { id: randomUUID(), name, arguments: args };
      const response = await fetch(address.url + "/v1/runs", {
        method: "POST", headers: { authorization: `Bearer ${sessions[account].token}` },
        body: JSON.stringify({ prompt: "sandbox integration", policy })
      });
      expect(response.status).toBe(202);
      const accepted = await response.json();
      await vi.waitFor(async () => expect((await runs.get(accepted.runId))?.status).toBe("completed"), { timeout: 180000, interval: 200 });
      const result = (await h.db.pool.query("SELECT result FROM runtime_sandbox_operations WHERE space_id=$1 AND invocation_id LIKE $2", [h.spaceId, accepted.runId + ":%"])).rows[0]?.result;
      report.checks.push({ account, name, runId: accepted.runId, passed: true, content: result.content });
      expect(result?.ok, JSON.stringify(result)).toBe(true);
      return result;
    }
    try {
      const path = `/workspace/${report.marker}.txt`;
      await httpRun(0, "write", { path, content: "durable-runtime-data" });
      const first = await broker.workspaceStatus(h.users[0].user.id);
      await httpRun(0, "Bash", { command: `printf '#!/bin/sh\\nprintf "persistent-cli\\\\n"\\n' > "$HOME/.local/bin/${probeCli}"; chmod +x "$HOME/.local/bin/${probeCli}"; git config --global zionprobe.${probeKey} persistent-git; printf '%s' '${encodedEnv}' | base64 -d >> "$HOME/.config/zion/env.sh"; printf '%s' '${encodedRc}' | base64 -d >> "$HOME/.bashrc"` });
      expect((await httpRun(0, "Bash", { command: verifyEnvironment })).content).toContain("persistent-cli");
      // Startup chatter must never corrupt JSON from machine file tools.
      expect(JSON.parse((await httpRun(0, "read", { path: "/root/.config/zion/env.sh" })).content).content).toContain(probeVariable);
      const terminalSession = await terminal.createSession({ payload: { cwd: "/root" }, runContext: terminalContext });
      const ptyEnvironment = await terminal.executeHttpCommand({
        sessionId: terminalSession.id, command: `${verifyEnvironment}; cd /tmp; pwd`,
        runContext: terminalContext
      });
      expect(ptyEnvironment.exit_code).toBe(0);
      expect(ptyEnvironment.output).toContain("persistent-cli");
      expect((await terminal.getSession({ sessionId: terminalSession.id, runContext: terminalContext })).cwd).toBe("/tmp");
      await terminal.closeSession({ sessionId: terminalSession.id, runContext: terminalContext });
      report.checks.push({ name: "bash-pty-shared-home-and-environment", passed: true });
      expect(JSON.parse((await httpRun(0, "read", { path })).content).content)
        .toBe("durable-runtime-data");
      expect((await broker.workspaceStatus(h.users[0].user.id)).sandboxId).toBe(first.sandboxId);
      await httpRun(0, "Bash", { command: `echo transient > /tmp/${report.marker}; nohup python3 -m http.server 8099 --bind 127.0.0.1 >/tmp/${report.marker}.server.log 2>&1 </dev/null &` });
      await broker.controlWorkspace(h.users[0].user.id, "pause");
      expect((await broker.workspaceStatus(h.users[0].user.id)).state).toBe("paused");
      await httpRun(0, "Bash", { command: `test "$(cat /tmp/${report.marker})" = transient; curl -fsS http://127.0.0.1:8099/ >/dev/null; echo state-resumed` });
      expect((await broker.workspaceStatus(h.users[0].user.id)).sandboxId).toBe(first.sandboxId);
      report.checks.push({ name: "same-instance-and-process-pause-resume", passed: true, sandboxId: first.sandboxId });
      await httpRun(1, "Bash", { command: `test ! -e ${path} && test ! -e "$HOME/.local/bin/${probeCli}" && test -z "$${probeVariable}" && echo isolated` });
      const cancelled = h.invocation("Bash", { command: `echo started > /workspace/${report.marker}.started; sleep 45; echo late > /workspace/${report.marker}.late` });
      const controller = new CancellationController();
      const operation = tools.invoke(cancelled, controller.signal);
      await vi.waitFor(async () => {
        const active = (await h.db.pool.query(`SELECT active FROM runtime_sandbox_workspaces
          WHERE space_id=$1 AND account_id=$2`, [h.spaceId, h.users[0].user.id])).rows[0]?.active;
        expect(active?.handle).toBeTruthy();
        const content = await provider.read(active.handle, active.scope, `/workspace/${report.marker}.started`);
        expect(content).toContain("started");
      }, { timeout: 30000, interval: 300 });
      controller.cancel("live-user-pause");
      expect((await operation).failureCode).toBe("execution_outcome_unknown");
      // Runtime returns early on cancellation; await durable host termination.
      await vi.waitFor(async () => {
        expect((await h.db.pool.query(`SELECT active FROM runtime_sandbox_workspaces
          WHERE space_id=$1 AND account_id=$2`, [h.spaceId, h.users[0].user.id])).rows[0]?.active).toBeNull();
      }, { timeout: 60000, interval: 300 });
      report.checks.push({ name: "live-cancellation-and-termination", passed: true });
      await httpRun(0, "Bash", { command: `test ! -e /workspace/${report.marker}.late; rm -- /workspace/${report.marker}.started; echo cancellation-verified` });
      expect((await broker.workspaceStatus(h.users[0].user.id)).sandboxId).not.toBe(first.sandboxId);
      await broker.controlWorkspace(h.users[0].user.id, "release");
      expect(JSON.parse((await httpRun(0, "read", { path })).content).content)
        .toBe("durable-runtime-data");
      expect((await httpRun(0, "Bash", { command: verifyEnvironment })).content).toContain("persistent-cli");
      const rebuiltTerminal = await terminal.createSession({ payload: { cwd: "/root" }, runContext: terminalContext });
      expect((await terminal.executeHttpCommand({
        sessionId: rebuiltTerminal.id, command: verifyEnvironment, runContext: terminalContext
      })).output).toContain("persistent-cli");
      await terminal.closeSession({ sessionId: rebuiltTerminal.id, runContext: terminalContext });
      report.checks.push({ name: "home-cli-git-env-survive-release-rebuild", passed: true });
      await httpRun(0, "Bash", { command: cleanupHomeCommand });
      await httpRun(0, "Bash", { command: `findmnt -n -o FSTYPE /workspace; rm -- ${path}; echo cleaned` });
      for (const { user } of h.users) await broker.controlWorkspace(user.id, "release");
      report.activeSandboxes = (await provider.listManaged()).filter((item) => h.bindings.some((binding) => binding.workspaceId === item.workspaceId));
      expect(report.activeSandboxes).toEqual([]);
    } finally {
      const state = await h.store.workspace(h.users[0].user.id, h.bindings[0].workspaceId);
      if (state?.instance) {
        const { handle, scope } = state.instance;
        try {
          if ((await provider.inspect(handle, scope)).state === "paused") await provider.resume(handle, scope);
          await provider.prepareEnvironment(handle, scope);
          await provider.exec(handle, scope, { command: cleanupHomeCommand, internal: true });
        } catch {}
      }
      await writeFile("/tmp/zion-sandbox-runtime-live.json", JSON.stringify(report, null, 2), { mode: 0o600 });
    }
  }, 600000);
});
