#!/usr/bin/env node
import { execFileSync, execFile } from "node:child_process";
import { mkdir, readFile, rename, open, unlink, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PostgresAccountStore } from "../apps/runtime/src/accounts/postgres-account-store.mjs";
import { AccountAccessControl } from "../apps/runtime/src/accounts/account-access-control.mjs";
import { PostgresAccessStore } from "../apps/runtime/src/postgres-access-store.mjs";
import { memoryConnectionDirectory } from "../apps/runtime/src/accounts/memory-account-connection.mjs";
import { contentHash } from "../packages/local-tools-client/src/plugin-data-files.mjs";
import { sandboxConfig } from "../packages/sandbox/src/config.mjs";
import { ManagedSandboxProvider, fingerprint } from "../packages/sandbox/src/provider.mjs";
import { SandboxToolBroker } from "../apps/runtime/src/sandbox/sandbox-tool-broker.mjs";
import { PostgresSandboxStore } from "../apps/runtime/src/sandbox/postgres-sandbox-store.mjs";
import { CancellationController } from "../packages/runtime/dist/index.js";
import { manageAgentfsAuth } from "./agentfs-login.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = "/memory/dev.identity";
const runtimeUrl = "https://runtime.zioon.tech";
const apiUrl = `${runtimeUrl}/memory`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function request(url, token, body) {
  const response = await fetch(url, {
    redirect: "error", method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000)
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(`Memory request failed: HTTP ${response.status}`), {
    statusCode: response.status, code: value.code || value.error
  });
  return value;
}

// Create-only import is resumable. Existing bytes must match; an account's
// existing memories are never replaced as a side effect of connecting.
export async function importMemoryFiles(files, remoteRequest) {
  for (const file of files) {
    const path = `${root}/${file.path}`;
    let existing;
    try { existing = await remoteRequest(`read?path=${encodeURIComponent(path)}`); }
    catch (error) { if (error.statusCode !== 404) throw error; }
    if (existing && existing.content !== file.content) {
      throw new Error(`Online file differs; retained both copies without overwrite: ${file.path}`);
    }
  }
  for (const file of files) {
    const path = `${root}/${file.path}`;
    const result = await remoteRequest("write", { path, content: file.content, create_only: true });
    if (result.content_hash !== contentHash(file.content)) throw new Error(`Concurrent memory change: ${file.path}`);
    const loaded = await remoteRequest(`read?path=${encodeURIComponent(path)}`);
    if (loaded.content !== file.content) throw new Error(`Memory verification failed: ${file.path}`);
  }
}

async function exportMemory(localUrl, token) {
  const files = [];
  async function walk(path = ".", depth = 0) {
    if (depth > 32 || files.length > 1000) throw new Error("Memory export exceeds its safety limit");
    const listing = await request(`${localUrl}/v1/plugins/dev.identity/files/entries?path=${encodeURIComponent(path)}`, token);
    for (const entry of listing.entries) {
      if (!entry.path.startsWith(`${root}/`)) throw new Error("Unexpected memory export path");
      const relative = entry.path.slice(root.length + 1);
      if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error("Invalid memory export path");
      }
      if (entry.type === "directory") await walk(relative, depth + 1);
      else if (entry.type === "file") {
        const loaded = await request(`${localUrl}/v1/plugins/dev.identity/files/read?path=${encodeURIComponent(relative)}`, token);
        files.push({ path: relative, content: loaded.content, contentHash: loaded.content_hash });
      }
    }
  }
  await walk();
  return files;
}

async function retireLocalPilot() {
  const pidFile = join(homedir(), ".zion-next/memory-pilot/memory-service.pid");
  const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const command = await execute("ps", ["-p", String(pid), "-o", "command="])
    .then((value) => value.stdout.trim()).catch(() => "");
  const cwd = await execute("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .then((value) => value.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1)).catch(() => "");
  if (!command.endsWith("bun apps/memory-service/src/main.ts") || cwd !== repository.replace(/\/$/, "")) return false;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    const alive = await fetch("http://127.0.0.1:18991/health", { signal: AbortSignal.timeout(1000) })
      .then((response) => response.ok).catch(() => false);
    if (!alive) { await unlink(pidFile); return true; }
    await delay(100);
  }
  return false;
}

async function installSandboxConnection({ directory, config, accounts, pool, cliConfig, files }) {
  const credential = JSON.parse(execFileSync("security", [
    "find-generic-password", "-s", "dev.zion.sandbox-poc",
    "-a", `aliyun:${config.region}:${config.teamId}`, "-w"
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const provider = new ManagedSandboxProvider(sandboxConfig({
    ZION_SANDBOX_REGION: config.region, ZION_SANDBOX_TEMPLATE: config.template,
    E2B_API_KEY: credential.apiKey, ZION_SANDBOX_PAUSE_VERIFIED: "1",
    ZION_SANDBOX_ALLOW_INTERNET_ACCESS: "1"
  }), { persistentHome: true });
  const store = await new PostgresSandboxStore(pool, { spaceId: config.spaceId }).initialize();
  const accessControl = new AccountAccessControl({
    store: new PostgresAccessStore(pool, { spaceId: config.spaceId }),
    accounts, oidc: { secureCookies: false }, publicBaseUrl: "http://127.0.0.1:18891",
    servedSpaceId: config.spaceId
  });
  const broker = new SandboxToolBroker({
    provider, store, bindings: JSON.parse(await readFile(join(directory, "bindings.json"), "utf8")),
    authorizeInvocation: (invocation) => accessControl.authorizeInvocation(invocation)
  });
  const policy = {
    preset: "trusted-automation", allowedTools: ["Bash"], fileRoots: ["/"],
    allowedCommandPrefixes: [], allowedTerminalSessionIds: [], allowedRecipients: [],
    maxToolCalls: 1, maxMailPerRun: 0
  };
  const principal = await accounts.issueGrant(config.userId, policy, {
    spaceId: config.spaceId, ttlMs: 300_000, scopes: ["run.execute", "resource.execute"]
  });
  const invocationId = `identity-online-connect:${randomUUID()}`;
  const payload = JSON.stringify({ config: cliConfig, files });
  const args = { command: "install verified online Memory account and compare CLI files", timeout: 60000 };
  const requestBinding = { connectionHash: hash(payload), installerVersion: 2 };
  try {
    const binding = broker.bindingForAccount(config.userId);
    const requestHash = fingerprint({ runId: "identity-online-connect", accountId: config.userId,
      workspaceId: binding.workspaceId, name: "Bash", args, requestBinding });
    const completed = await pool.query(`SELECT invocation_id FROM runtime_sandbox_operations
      WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3 AND request_hash=$4
        AND result->>'ok'='true' LIMIT 1`, [config.spaceId, config.userId, binding.workspaceId, requestHash]);
    if (completed.rows.length) {
      await accessControl.authorizeInvocation({ principal, policy,
        toolCall: { name: "Bash", arguments: args } });
      console.log(`沿用已成功的 CLI 校验回执：${completed.rows[0].invocation_id}`);
      return completed.rows[0].invocation_id;
    }
    const result = await broker.invoke({
      invocationId, runId: "identity-online-connect", attemptId: "install",
      principal, policy, toolCall: { id: "install", name: "Bash", arguments: args }
    }, new CancellationController().signal, async ({ handle, scope }) => {
      const payloadPath = `/tmp/zion-workspace-${randomUUID()}.json`;
      await provider.writeTemporary(handle, scope, payloadPath, payload);
      // Credentials travel in a private temporary file, not in command text or
      // a Run transcript. Durable Sandbox receipts record only its digest.
      const command = `python3 - '${payloadPath}' <<'PY'
import hashlib,json,os,pathlib,subprocess,sys,tempfile
p=pathlib.Path(sys.argv[1])
p.chmod(0o600)
data=json.loads(p.read_text())
p.unlink()
home=pathlib.Path('/root/.agent-fs')
home.mkdir(mode=0o700,exist_ok=True)
target=home/'config.json'
if target.exists():
    old=json.loads(target.read_text())
    oldkey=old.get('apiKey') or old.get('auth',{}).get('apiKey')
    newkey=data['config']['apiKey']
    if oldkey and oldkey.startswith('zion_account_v1.') and oldkey!=newkey:
        same=(old.get('apiUrl')==data['config']['apiUrl']
              and old.get('defaultOrg')==data['config']['defaultOrg']
              and old.get('defaultDrive')==data['config']['defaultDrive'])
        if not same:
            raise SystemExit('Sandbox already has a different account login; reconnect it explicitly')
fd,tmp=tempfile.mkstemp(dir=home,prefix='.online-account-')
with os.fdopen(fd,'w') as f:
    json.dump(data['config'],f);f.flush();os.fsync(f.fileno())
os.replace(tmp,target)
assert (target.stat().st_mode&0o777)==0o600
env=dict(os.environ)
env.pop('AGENT_FS_API_KEY',None)
env['AGENT_FS_API_URL']='${apiUrl}'
env['PATH']='/root/.local/bin:/root/.bun/bin:'+env.get('PATH','')
status=subprocess.run(['agent-fs','auth','status','--json'],env=env,capture_output=True,text=True,timeout=20)
assert status.returncode==0,'CLI authentication failed'
for file in data['files']:
    result=subprocess.run(['agent-fs','cat','${root}/'+file['path']],env=env,capture_output=True,text=True,timeout=30)
    assert result.returncode==0,'CLI read failed: '+file['path']
    assert result.stdout.rstrip('\\n')==file['content'].rstrip('\\n'),'CLI file differs: '+file['path']
print(json.dumps({'authenticated':True,'verifiedFiles':len(data['files']),'configMode':'0600'}))
PY`;
      try { return await provider.exec(handle, scope, { command, timeoutMs: 60000 }); }
      finally { await provider.exec(handle, scope, { command: `rm -f -- '${payloadPath}'`, timeoutMs: 5000 }).catch(() => {}); }
    }, requestBinding);
    if (!result.ok) throw new Error(`Sandbox connection failed: ${result.failureCode || "tool_error"}`);
    console.log(`沙箱 CLI 已连接并校验 ${files.length} 个文件；receipt: ${invocationId}`);
    return invocationId;
  } finally {
    await accounts.revokeGrant(config.userId, principal.grantId, config.spaceId);
    // This task broker never starts maintenance. The running Runtime owns
    // lifecycle management for the same durable workspace and pauses on stop.
    broker.closing = true;
    clearInterval(broker.timer);
  }
}

export async function connectLocalIdentityMemory({ prepareOnly = false, resume = false } = {}) {
  const directory = process.env.ZION_SANDBOX_LOCAL_DIR || join(homedir(), ".zion-next/sandbox-demo");
  const config = JSON.parse(await readFile(join(directory, "account.json"), "utf8"));
  const database = new URL(config.url);
  if (!["postgres:", "postgresql:"].includes(database.protocol)
    || !["127.0.0.1", "localhost"].includes(database.hostname)
    || !/^[a-z][a-z0-9_]*$/.test(config.schema)) throw new Error("A dedicated local account database is required");
  const localUrl = `http://127.0.0.1:${Number(process.env.ZION_SANDBOX_LOCAL_PORT || 18891)}`;
  const pool = new pg.Pool({ connectionString: config.url, options: `-c search_path=${config.schema}`, max: 3 });
  const accounts = await new PostgresAccountStore({ pool }).initialize();
  const session = await accounts.createSession(config.userId, { activeSpaceId: config.spaceId });
  const connections = join(directory, "runtime/memory-connections");
  const connection = memoryConnectionDirectory(connections, config);
  await mkdir(connection, { recursive: true, mode: 0o700 });
  const lock = join(connection, "connecting.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { await accounts.revokeSession(config.userId, session.sessionId); await pool.end(); throw new Error("Another Memory connection is running"); }
  try {
    const initialLocation = await request(`${localUrl}/v1/plugins/dev.identity/locations`, session.token);
    const alreadyOnline = initialLocation.data?.apiUrl === apiUrl;
    // Renewal must remain possible even when the previous remote session has
    // expired. Locations do not access the remote credential.
    let files = alreadyOnline && !prepareOnly ? [] : await exportMemory(localUrl, session.token);
    const backup = join(directory, "memory-backups", `${Date.now()}-${randomUUID()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await atomicJson(join(backup, "export.json"), { localUserId: config.userId, localSpaceId: config.spaceId, files });
    let events = files.find((file) => file.path === "biography/events.jsonl")?.content.trim().split("\n").filter(Boolean).length || 0;
    console.log(alreadyOnline && !prepareOnly ? "正在续期现有线上记忆连接…"
      : `已备份 ${files.length} 个记忆文件、${events} 条事件：${backup}`);
    if (prepareOnly) return { backup, files: files.length, events };
    if (!resume) await manageAgentfsAuth({
      args: ["login", "--api-url", apiUrl, "--runtime-url", runtimeUrl],
      env: { ...process.env, AGENT_FS_HOME: connection, AGENT_FS_API_KEY: undefined, AGENT_FS_API_URL: apiUrl }
    });
    const cliConfig = JSON.parse(await readFile(join(connection, "config.json"), "utf8"));
    if (cliConfig.apiUrl !== apiUrl || cliConfig.zionAccount?.runtimeUrl !== runtimeUrl
      || !cliConfig.apiKey?.startsWith("zion_account_v1.") || cliConfig.zionAccount.expiresAt <= Date.now()) {
      throw new Error("Online Memory login is missing or expired");
    }
    const me = await request(`${runtimeUrl}/v1/account/me`, cliConfig.apiKey);
    if (!me.authenticated || !me.user?.id || !me.space?.id || me.membership?.status !== "active"
      || !me.scopes?.includes("runtime.write")) throw new Error("An active online account with Memory write permission is required");
    const previous = await readFile(join(connection, "binding.json"), "utf8").then(JSON.parse).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (previous && (previous.remoteUserId !== me.user.id || previous.remoteSpaceId !== me.space.id)) {
      throw new Error("This local account is linked to a different online identity; no migration was performed");
    }
    files = await exportMemory(localUrl, session.token);
    events = files.find((file) => file.path === "biography/events.jsonl")?.content.trim().split("\n").filter(Boolean).length || 0;
    await atomicJson(join(backup, "latest-export.json"), { localUserId: config.userId, localSpaceId: config.spaceId, files });
    const remoteRequest = (operation, body) => request(`${apiUrl}/zion/files/${operation}`, cliConfig.apiKey, body);
    await importMemoryFiles(files, remoteRequest);
    const receipt = await installSandboxConnection({ directory, config, accounts, pool, cliConfig, files });
    await atomicJson(join(connection, "binding.json"), {
      localUserId: config.userId, localSpaceId: config.spaceId,
      remoteUserId: me.user.id, remoteSpaceId: me.space.id,
      orgId: cliConfig.defaultOrg, driveId: cliConfig.defaultDrive, apiUrl, runtimeUrl
    });
    // Recheck the source before switching, so a concurrent edit is not lost.
    const fresh = await exportMemory(localUrl, session.token);
    if (JSON.stringify(fresh.map((file) => [file.path, file.contentHash]).sort())
      !== JSON.stringify(files.map((file) => [file.path, file.contentHash]).sort())) {
      throw new Error("Local memory changed during connection; rerun after saving current edits");
    }
    const settingsPath = join(directory, "runtime-settings.json");
    const settings = await readFile(settingsPath, "utf8").then(JSON.parse).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return {};
    });
    await atomicJson(join(backup, "previous-settings.json"), settings);
    await atomicJson(settingsPath, { ...settings, memoryServiceUrl: apiUrl, memoryPublicUrl: apiUrl,
      memoryAccountConnectionsDir: connections, mcpEnabled: "0", memoryMcpEnabled: "0" });
    const launcher = join(repository, "scripts/local-sandbox.mjs");
    await execute(process.execPath, [launcher, "stop"], { cwd: repository });
    for (let i = 0; i < 450; i++) {
      const alive = await fetch(`${localUrl}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
      if (!alive) break;
      if (i === 449) throw new Error("Local Runtime did not stop; configuration saved but restart is pending");
      await delay(200);
    }
    await execute(process.execPath, [launcher, "up", "--background"], { cwd: repository, timeout: 45000 });
    const locations = await request(`${localUrl}/v1/plugins/dev.identity/locations`, session.token);
    if (locations.data.apiUrl !== apiUrl || locations.data.accessMode !== "cli") throw new Error("Identity did not switch to online Memory");
    const panelFiles = await exportMemory(localUrl, session.token);
    for (const file of files) {
      if (panelFiles.find((item) => item.path === file.path)?.content !== file.content) throw new Error(`Panel file differs: ${file.path}`);
    }
    const capabilities = await request(`${localUrl}/v1/capabilities/tools`, session.token);
    if (capabilities.tools.some((tool) => /^mcp/.test(tool.name))) throw new Error("MCP unexpectedly enabled");
    await request(`${apiUrl}/ready`, cliConfig.apiKey);
    const localPilotRetired = initialLocation.data?.apiUrl === "http://127.0.0.1:18991"
      ? await retireLocalPilot() : false;
    await atomicJson(join(backup, "result.json"), { connected: true, apiUrl, files: files.length,
      events, receipt, localPilotRetired });
    console.log(`Identity 面板与沙箱 CLI 已共用线上记忆：${apiUrl}；${events} 条事件校验通过，MCP 关闭。`);
    return { connected: true, backup, receipt };
  } finally {
    try { await accounts.revokeSession(config.userId, session.sessionId); }
    finally { await rmdir(lock); await pool.end(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--prepare", "--resume"].includes(arg))) {
    console.error("Usage: npm run memory:connect -- [--prepare | --resume]");
    process.exitCode = 1;
  } else {
    try { await connectLocalIdentityMemory({ prepareOnly: args.includes("--prepare"), resume: args.includes("--resume") }); }
    catch (error) { console.error(`Identity 线上连接未完成：${error.message}`); process.exitCode = 1; }
  }
}
