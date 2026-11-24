import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sandboxConfig, configSummary, ManagedSandboxProvider, SandboxJournal, SandboxPocController
} from "../src/index.mjs";

const scope = { accountId: "account:a", workspaceId: "workspace:a", attemptId: "attempt:a", epoch: 1 };
const config = () => sandboxConfig({ E2B_API_KEY: "test-only-key", ZION_SANDBOX_TEMPLATE: "template:poc" });

function fixture(options = {}) {
  const boxes = new Map();
  const calls = { creates: 0, connects: 0, execs: 0, kills: 0 };
  const sdk = {
    async create(template, args) {
      calls.creates++;
      const id = `box-${calls.creates}`;
      const info = { sandboxId: id, state: "running", metadata: args.metadata, files: new Map() };
      boxes.set(id, info);
      if (options.createTransportFailure) throw new Error("request failed with test-only-key");
      return { sandboxId: id };
    },
    async getInfo(id) {
      const info = boxes.get(id);
      if (!info) throw Object.assign(new Error("not found"), { name: "SandboxNotFoundError" });
      return info;
    },
    list(args) {
      let hasNext = true;
      return {
        get hasNext() { return hasNext; },
        async nextItems() {
          hasNext = false;
          return [...boxes.values()].filter((item) =>
            Object.entries(args.query.metadata).every(([key, value]) => item.metadata[key] === value));
        }
      };
    },
    async connect(id) {
      calls.connects++;
      const box = boxes.get(id);
      box.state = "running";
      return {
        commands: {
          async run(command, args) {
            calls.execs++;
            if (options.execTransportFailure) throw new Error("ACK lost");
            if (options.nonzero) throw Object.assign(new Error("command failed"), {
              name: "CommandExitError", exitCode: 7, stdout: "", stderr: "intentional failure"
            });
            if (options.largeOutput) {
              args.onStdout("x".repeat(1024 * 1024 + 1));
              throw new Error("stream aborted");
            }
            if (options.execGate) await options.execGate;
            return { exitCode: 0, stdout: "done", stderr: "" };
          }
        },
        files: {
          async write(path, content) { box.files.set(path, content); },
          async read(path) { return box.files.get(path); },
          async getInfo(path) { return { size: Buffer.byteLength(box.files.get(path) || "") }; }
        },
        async pause() { box.state = "paused"; }
      };
    },
    async kill(id) { calls.kills++; boxes.delete(id); return true; }
  };
  return { sdk, boxes, calls, provider: new ManagedSandboxProvider(config(), { sdk }) };
}

async function controllerTest(action, options) {
  const directory = await mkdtemp(join(tmpdir(), "zion-sandbox-test-"));
  try {
    const f = fixture(options);
    const journal = new SandboxJournal(join(directory, "operations.json"));
    const controller = new SandboxPocController(f.provider, journal);
    await action({ ...f, journal, controller });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("configuration pins region/domain and never prints credentials", () => {
  const summary = configSummary(config());
  assert.equal(summary.apiUrl, "https://api.cn-shanghai.sandbox.aliyuncs.com");
  assert.equal(JSON.stringify(summary).includes("test-only-key"), false);
  assert.deepEqual(configSummary(sandboxConfig({})).missing, ["E2B_API_KEY", "ZION_SANDBOX_TEMPLATE"]);
  assert.throws(() => sandboxConfig({ E2B_API_URL: "https://attacker.example" }), /does not match/);
  assert.throws(() => sandboxConfig({ E2B_DEBUG: "true" }), /debug/);
  assert.throws(() => sandboxConfig({ ZION_SANDBOX_TIMEOUT_MS: "0" }), /timeout/);
});

test("metadata and epoch are validated before connecting or resuming", async () => {
  const f = fixture();
  const handle = await f.provider.create(scope, "create:a");
  await assert.rejects(f.provider.exec(handle, { ...scope, epoch: 2 }, { command: "true" }), { code: "sandbox_scope_mismatch" });
  f.boxes.get(handle.sandboxId).metadata["zion.accountId"] = "account:b";
  await assert.rejects(f.provider.exec(handle, scope, { command: "true" }), { code: "sandbox_scope_mismatch" });
  assert.equal(f.calls.connects, 0);
});

test("managed command transport accepts ten-minute deadlines and rejects larger requests", async () => {
  const f = fixture();
  const handle = await f.provider.create(scope, "create:long-command");
  assert.equal((await f.provider.exec(handle, scope, { command: "true", timeoutMs: 600_000 })).exitCode, 0);
  assert.equal(f.calls.execs, 1);
  await assert.rejects(f.provider.exec(handle, scope, { command: "true", timeoutMs: 600_001 }), /command timeout/);
  assert.equal(f.calls.execs, 1);
});

test("file transport rejects traversal and enforces scope", async () => {
  const f = fixture();
  const handle = await f.provider.create(scope, "create:a");
  for (const path of ["/workspace/../secret", "/workspace//file", "/workspace/./file", "relative/file", "/workspace/a\0b"]) {
    await assert.rejects(f.provider.write(handle, scope, path, "data"), /canonical absolute path/);
  }
  await f.provider.write(handle, scope, "/workspace/result.txt", "data");
  assert.equal(await f.provider.read(handle, scope, "/workspace/result.txt"), "data");
  await f.provider.write(handle, scope, "/root/.gitconfig", "config");
  assert.equal(await f.provider.read(handle, scope, "/root/.gitconfig"), "config");
});

test("inspect and static destruction do not wake paused instances", async () => {
  const f = fixture();
  const handle = await f.provider.create(scope, "create:a");
  f.boxes.get(handle.sandboxId).state = "paused";
  assert.equal((await f.provider.inspect(handle, scope)).state, "paused");
  await assert.rejects(f.provider.exec(handle, scope, { command: "true" }), { code: "sandbox_not_running" });
  await f.provider.destroy(handle, scope);
  await f.provider.destroy(handle, scope);
  assert.equal(f.calls.connects, 0);
  assert.equal(f.calls.kills, 1);
});

test("nonzero process exit is known while transport failure is unknown", async () => {
  const known = fixture({ nonzero: true });
  const h = await known.provider.create(scope, "create:a");
  assert.equal((await known.provider.exec(h, scope, { command: "false" })).exitCode, 7);
  const unknown = fixture({ execTransportFailure: true });
  const u = await unknown.provider.create(scope, "create:u");
  await assert.rejects(unknown.provider.exec(u, scope, { command: "publish" }), { code: "execution_outcome_unknown" });
  assert.equal(unknown.calls.execs, 1);
});

test("output overflow aborts reception and preserves unknown outcome", async () => {
  const f = fixture({ largeOutput: true });
  const handle = await f.provider.create(scope, "create:a");
  await assert.rejects(f.provider.exec(handle, scope, { command: "verbose" }), { code: "execution_outcome_unknown" });
});

test("durable receipts survive controller replacement and parameter conflicts fail", async () => {
  await controllerTest(async ({ controller, journal, provider, calls }) => {
    const handle = await controller.create(scope, "create:a");
    const request = { command: "effect" };
    assert.equal((await controller.exec(handle, scope, "invocation:a", request)).exitCode, 0);
    const restarted = new SandboxPocController(provider, new SandboxJournal(journal.path));
    assert.equal((await restarted.exec(handle, scope, "invocation:a", request)).stdout, "done");
    assert.equal(calls.execs, 1);
    await assert.rejects(restarted.exec(handle, scope, "invocation:a", { command: "other" }), /different arguments/);
    assert.equal((await readFile(journal.path, "utf8")).includes("test-only-key"), false);
  });
});

test("unknown execution cannot be silently replayed after restart", async () => {
  await controllerTest(async ({ controller, journal, provider, calls }) => {
    const handle = await controller.create(scope, "create:a");
    await assert.rejects(controller.exec(handle, scope, "invocation:a", { command: "effect" }), { code: "execution_outcome_unknown" });
    const restarted = new SandboxPocController(provider, new SandboxJournal(journal.path));
    await assert.rejects(restarted.exec(handle, scope, "invocation:a", { command: "effect" }), { code: "execution_outcome_unknown" });
    assert.equal(calls.execs, 1);
  }, { execTransportFailure: true });
});

test("lost create ACK blocks recreation and metadata reconciliation finds the orphan", async () => {
  await controllerTest(async ({ controller, journal, provider, calls }) => {
    await assert.rejects(controller.create(scope, "create:a"), { code: "sandbox_create_outcome_unknown" });
    await assert.rejects(controller.create(scope, "create:a"), { code: "sandbox_create_requires_reconcile" });
    assert.equal(calls.creates, 1);
    const restarted = new SandboxPocController(provider, new SandboxJournal(journal.path));
    const matches = await restarted.reconcile("create:a");
    assert.equal(matches.length, 1);
    assert.equal((await restarted.create(scope, "create:a")).sandboxId, matches[0].sandboxId);
    assert.deepEqual((await restarted.cleanup()).map((item) => item.status), ["destroyed"]);
    assert.equal(calls.kills, 1);
    assert.equal((await readFile(journal.path, "utf8")).includes("test-only-key"), false);
  }, { createTransportFailure: true });
});

test("single-operator journal refuses a concurrent execution owner", async () => {
  let finish;
  let started;
  const gate = new Promise((resolve) => { finish = resolve; });
  await controllerTest(async ({ controller, journal }) => {
    const handle = await controller.create(scope, "create:a");
    const original = controller.provider.exec.bind(controller.provider);
    const dispatched = new Promise((resolve) => { started = resolve; });
    controller.provider.exec = async (...args) => { started(); return await original(...args); };
    const first = controller.exec(handle, scope, "invocation:a", { command: "effect" });
    await dispatched;
    await assert.rejects(journal.exclusive(async () => {}), /locked/);
    finish();
    await first;
  }, { execGate: gate });
});

test("audit reports cloud orphans and missing recorded instances without connecting", async () => {
  await controllerTest(async ({ controller, sdk, calls }) => {
    const handle = await controller.create(scope, "create:a");
    await sdk.create("template:poc", {
      metadata: {
        "zion.poc": "1",
        "zion.requestKey": "create:orphan",
        "zion.accountId": scope.accountId,
        "zion.workspaceId": "workspace:orphan",
        "zion.attemptId": "attempt:orphan",
        "zion.epoch": "1"
      }
    });
    const first = await controller.audit();
    assert.equal(first.orphanedCloud.length, 1);
    assert.equal(first.missingCloud.length, 0);
    await sdk.kill(handle.sandboxId);
    const second = await controller.audit();
    assert.equal(second.orphanedCloud.length, 1);
    assert.equal(second.missingCloud.length, 1);
    assert.equal(calls.connects, 0);
  });
});
