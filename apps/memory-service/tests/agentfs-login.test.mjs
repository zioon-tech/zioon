import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, stat, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { manageAgentfsAuth } from "../../../scripts/agentfs-login.mjs";
import { installAgentfsLogin } from "../../../scripts/install-agentfs-login.mjs";

const execute = promisify(execFile);
const newToken = "zion_account_v1.test-new";
const oldToken = "zion_account_v1.test-old";
const me = { userId: "test-user", email: "test@example.invalid", defaultOrgId: "org", defaultDriveId: "drive" };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agentfs-auth-test-"));
  const requests = [];
  let polls = 0;
  let origin;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = { path: req.url, token: req.headers.authorization, body: body ? JSON.parse(body) : undefined };
    requests.push(request);
    const defaults = {
      "/v1/account/device/start": () => ({
        flowToken: "private-flow", userCode: "ABCD-EFGH", interval: 5,
        verificationUri: `${origin}/confirm`,
        verificationUriComplete: `${origin}/confirm?code=ABCD-EFGH`, expiresAt: Date.now() + 30_000
      }),
      "/v1/account/device/poll": () => ++polls === 1 ? { pending: true }
        : { token: newToken, expiresAt: Date.now() + 60_000 },
      "/memory/auth/me": () => me,
      "/v1/account/logout": () => ({ ok: true })
    };
    try {
      const value = await (overrides[req.url] || defaults[req.url] || (() => ({ status: 404 })))(request);
      res.writeHead(value.status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(value.body || value));
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"test_server_failed"}');
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "config.json");
  const original = {
    custom: { preserved: true }, apiUrl: `${origin}/memory`,
    apiKey: oldToken, auth: { apiKey: oldToken, other: "keep" },
    defaultOrg: "previous-org", defaultDrive: "previous-drive",
    zionAccount: { runtimeUrl: origin, apiUrl: `${origin}/memory`, expiresAt: Date.now() + 60_000 }
  };
  await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const before = await readFile(path, "utf8");
  const outputs = [];
  const env = { AGENT_FS_HOME: directory, AGENT_FS_API_URL: `${origin}/memory`, ZION_ACCOUNT_RUNTIME_URL: origin };
  const run = (args, options = {}) => manageAgentfsAuth({
    args, env, emit: (line) => outputs.push(line), sleep: () => Promise.resolve(), ...options
  });
  return { directory, path, requests, env, run, before, outputs, origin, original };
}

test("device login polls, verifies Memory, saves 0600 and revokes only replaced session", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(["login", "--json"]), 0);
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(saved.apiKey, newToken);
  assert.equal(saved.auth.apiKey, newToken);
  assert.deepEqual(saved.custom, f.original.custom);
  assert.equal(saved.auth.other, "keep");
  assert.equal(saved.defaultOrg, me.defaultOrgId);
  assert.equal(saved.defaultDrive, me.defaultDriveId);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/poll")).length, 2);
  assert.equal(f.requests.find((r) => r.path.endsWith("/logout")).token, `Bearer ${oldToken}`);
  const events = f.outputs.map(JSON.parse);
  assert.match(events[0].verificationUri, /confirm\?code=ABCD-EFGH/);
  assert.equal(events[1].authenticated, true);
  assert.ok(!f.outputs.join("").includes(newToken));
  assert.ok(!f.outputs.join("").includes("private-flow"));
  assert.equal(await f.run(["auth", "whoami"]), 0);
});

test("declined login leaves previous configuration untouched", async (t) => {
  const f = await fixture(t, {
    "/v1/account/device/poll": () => ({ status: 401, body: { error: "device_login_failed" } })
  });
  await assert.rejects(f.run(["auth", "login"]), /未获确认|拒绝/);
  assert.equal(await readFile(f.path, "utf8"), f.before);
  assert.ok(!f.requests.some((r) => r.path.endsWith("/logout")));
});

test("expired flow stops without redeeming or modifying previous credentials", async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  await assert.rejects(f.run(["login"], {
    now: () => clock, sleep: async () => { clock += 60_000; }
  }), /过期/);
  assert.ok(!f.requests.some((r) => r.path.endsWith("/poll")));
  assert.equal(await readFile(f.path, "utf8"), f.before);
});

test("cancellation before redemption preserves prior credentials", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(f.run(["login"], {
    signal: controller.signal, emit: () => controller.abort()
  }), { name: "AbortError" });
  assert.ok(!f.requests.some((r) => r.path.endsWith("/poll")));
  assert.equal(await readFile(f.path, "utf8"), f.before);
});

test("Memory refusal revokes new session and preserves prior credentials", async (t) => {
  const f = await fixture(t, {
    "/memory/auth/me": () => ({ status: 403, body: { error: "memory_denied" } })
  });
  await assert.rejects(f.run(["login"]), /403/);
  assert.equal(await readFile(f.path, "utf8"), f.before);
  assert.equal(f.requests.find((r) => r.path.endsWith("/logout")).token, `Bearer ${newToken}`);
});

test("failed save revokes newly issued session; previous file survives", async (t) => {
  const f = await fixture(t);
  await mkdir(`${f.path}.lock`);
  await assert.rejects(f.run(["login"]), /保存配置/);
  assert.equal(await readFile(f.path, "utf8"), f.before);
  assert.equal(f.requests.find((r) => r.path.endsWith("/logout")).token, `Bearer ${newToken}`);
});

test("logout revokes session and preserves unrelated config; 401 is already revoked", async (t) => {
  const f = await fixture(t, {
    "/v1/account/logout": () => ({ status: 401, body: { error: "invalid_session" } })
  });
  assert.equal(await f.run(["logout"]), 0);
  const config = JSON.parse(await readFile(f.path, "utf8"));
  assert.deepEqual(config.custom, f.original.custom);
  assert.deepEqual(config.auth, { other: "keep" });
  assert.equal(config.apiKey, undefined);
  assert.equal(config.defaultDrive, undefined);
  assert.equal(config.zionAccount, undefined);
  assert.equal(await f.run(["auth", "status"]), 1);
});

test("logout service failure retains credentials for retry", async (t) => {
  const f = await fixture(t, {
    "/v1/account/logout": () => ({ status: 503, body: { error: "offline" } })
  });
  await assert.rejects(f.run(["logout"]), /503/);
  assert.equal(await readFile(f.path, "utf8"), f.before);
});

test("status distinguishes expired/rejected authentication from service failure", async (t) => {
  const f = await fixture(t, {
    "/memory/auth/me": () => ({ status: 401, body: { error: "invalid_session" } })
  });
  assert.equal(await f.run(["auth", "status", "--json"]), 1);
  assert.equal(JSON.parse(f.outputs.pop()).authenticated, false);
  f.requests.length = 0;
  assert.equal(await f.run(["status"], { now: () => Date.now() + 120_000 }), 1);
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.run(["whoami"], { fetchImpl: async () => { throw new Error(newToken); } }), /无法连接/);
  assert.ok(!f.outputs.join("").includes("register"));
  assert.equal(await readFile(f.path, "utf8"), f.before);
});

test("masked credentials and unsafe endpoint fail before a login starts", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(["login"], { env: { ...f.env, AGENT_FS_API_KEY: oldToken } }), /unset AGENT_FS_API_KEY/);
  await assert.rejects(f.run(["login", "--api-url", "http://example.invalid/memory"]), /HTTPS/);
  assert.equal(f.requests.length, 0);
});

test("installed command emits URL, supports cancellation and preserves upstream argv", async (t) => {
  const f = await fixture(t, {
    "/v1/account/device/poll": () => ({ token: newToken, expiresAt: Date.now() + 60_000 })
  });
  const upstream = join(f.directory, "upstream.mjs");
  await writeFile(upstream, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const prefix = join(f.directory, "installation with spaces");
  const installed = await installAgentfsLogin({ prefix, bun: process.execPath, upstreamCli: upstream });
  const runtimeEnv = { ...process.env, ...f.env };
  delete runtimeEnv.AGENT_FS_API_KEY;
  const fileCommand = await execute(installed.executable, ["cat", "/memory/example path.md"], { env: runtimeEnv });
  assert.deepEqual(JSON.parse(fileCommand.stdout), ["cat", "/memory/example path.md"]);
  const help = await execute(installed.executable, ["auth", "--help"], { env: runtimeEnv });
  assert.match(help.stdout, /agent-fs login/);
  const status = await execute(installed.executable, ["--json", "auth", "whoami"], { env: runtimeEnv });
  assert.equal(JSON.parse(status.stdout).authenticated, true);

  const child = spawn(installed.executable, ["login"], { env: runtimeEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("/confirm?code=")) child.kill("SIGINT");
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code] = await new Promise((resolve) => child.once("exit", (...result) => resolve(result)));
  clearTimeout(timer);
  assert.equal(code, 130);
  assert.match(stdout, /浏览器打开/);
  assert.match(stderr, /已取消/);
  assert.ok(!stdout.includes("private-flow"));
  assert.equal(await readFile(f.path, "utf8"), f.before);

  const success = await execute(installed.executable, ["auth", "login", "--json"], { env: runtimeEnv, timeout: 15_000 });
  const events = success.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(events[0].type, "auth.deviceCode");
  assert.equal(events[1].type, "auth.completed");
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).apiKey, newToken);
  assert.ok(!success.stdout.includes(newToken));
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});
