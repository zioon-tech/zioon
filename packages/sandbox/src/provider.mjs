import { createHash } from "node:crypto";
import { sandboxScope, scopeMetadata, requireReadyConfig } from "./config.mjs";
import { canonicalSandboxPath } from "./paths.mjs";
import { SANDBOX_PROFILE_HOOK, sandboxEnvironmentCommand } from "./environment.mjs";
import { cancelExecutionCommand, executionCommand } from "./execution.mjs";

export class SandboxOperationError extends Error {
  constructor(code, operation, sandboxId = null) {
    super(`Sandbox ${operation} failed (${code}); inspect the recorded operation before retrying`);
    this.code = code;
    this.operation = operation;
    this.sandboxId = sandboxId;
  }
}

export function fingerprint(value) {
  const canonical = (item) => Array.isArray(item)
    ? item.map(canonical)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]))
      : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Operator-only adapter. Scope metadata is checked before any connect/resume. */
export class ManagedSandboxProvider {
  #config;
  #sdk;
  #persistentHome;
  #prepared = new Map();
  constructor(config, { sdk, persistentHome = false } = {}) {
    requireReadyConfig(config);
    this.#config = config;
    this.#sdk = sdk;
    this.#persistentHome = persistentHome;
  }
  async sdk() {
    if (!this.#sdk) this.#sdk = (await import("e2b")).Sandbox;
    return this.#sdk;
  }
  options() {
    return {
      apiKey: this.#config.apiKey, apiUrl: this.#config.apiUrl, domain: this.#config.domain,
      requestTimeoutMs: this.#config.requestTimeoutMs, debug: false
    };
  }
  publicIdentity() {
    return { provider: this.#config.provider, region: this.#config.region, template: this.#config.template };
  }
  get supportsPause() { return this.#config.supportsPause; }
  async preflight() {
    try {
      const SDK = await this.sdk();
      const paginator = SDK.list({ ...this.options(), limit: 1, query: { metadata: { "zion.poc": "1" } } });
      await paginator.nextItems();
      return { authenticated: true };
    } catch {
      throw new SandboxOperationError("sandbox_auth_or_list_failed", "preflight");
    }
  }
  async create(scopeInput, requestKey, {
    storageMetadata = {}, storageNetwork = null, autoPause = false,
    timeoutMs = this.#config.timeoutMs
  } = {}) {
    const scope = sandboxScope(scopeInput);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) throw new Error("Invalid sandbox lifetime");
    if (autoPause && !this.supportsPause) throw new Error("Automatic pause requires verified pause support");
    if (typeof requestKey !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(requestKey)) throw new Error("Invalid sandbox request key");
    const allowed = new Set(["fc.sandbox.storage.agenticfs", "fc.sandbox.network.vpc", "fc.sandbox.auth.role"]);
    if (Object.keys(storageMetadata).some((key) => !allowed.has(key))) throw new Error("Unsupported storage metadata");
    if (storageNetwork && (!Array.isArray(storageNetwork.allowOut) || !storageNetwork.allowOut.length
      || storageNetwork.allowOut.some((item) => !/^(?:10\.\d+\.\d+\.\d+\/(?:2[4-9]|3[0-2])|100\.100\.2\.(?:136|138)\/32)$/.test(item)))) {
      throw new Error("PoC storage egress must use narrow private CIDRs and approved DNS addresses");
    }
    if (storageMetadata["fc.sandbox.storage.agenticfs"] && !storageNetwork) {
      throw new Error("AgenticFS requires an explicit storage egress allowlist");
    }
    const metadata = { ...storageMetadata, ...scopeMetadata(scope), "zion.requestKey": requestKey, "zion.poc": "1" };
    try {
      const SDK = await this.sdk();
      const sandbox = await SDK.create(this.#config.template, {
        ...this.options(), timeoutMs,
        secure: true,
        ...(autoPause ? { lifecycle: { onTimeout: "pause", autoResume: false } } : {}),
        allowInternetAccess: this.#config.allowInternetAccess === true,
        ...(this.#config.allowInternetAccess ? { network: { allowOut: ["0.0.0.0/0"], denyOut: [] } }
          : storageNetwork ? { network: { allowOut: [...storageNetwork.allowOut] } } : {}),
        metadata
      });
      return {
        ...this.publicIdentity(), sandboxId: sandbox.sandboxId, scope, requestKey,
        createdAt: Date.now(), expiresAt: Date.now() + timeoutMs
      };
    } catch {
      // Creation can succeed before a transport failure. Never create again automatically.
      throw new SandboxOperationError("sandbox_create_outcome_unknown", "create");
    }
  }
  assertIdentity(handle, scopeInput) {
    const scope = sandboxScope(scopeInput);
    const identity = this.publicIdentity();
    if (!handle?.sandboxId || Object.entries(identity).some(([key, value]) => handle[key] !== value)
      || fingerprint(handle.scope) !== fingerprint(scope)) {
      throw new SandboxOperationError("sandbox_scope_mismatch", "authorize");
    }
    return scope;
  }
  async inspect(handle, scopeInput) {
    const scope = this.assertIdentity(handle, scopeInput);
    const SDK = await this.sdk();
    let info;
    try { info = await SDK.getInfo(handle.sandboxId, this.options()); }
    catch (error) {
      if (error?.statusCode === 404 || error?.code === 404 || error?.name === "SandboxNotFoundError") {
        this.#prepared.delete(handle.sandboxId);
        return { state: "destroyed", sandboxId: handle.sandboxId };
      }
      throw new SandboxOperationError("sandbox_inspection_failed", "inspect", handle.sandboxId);
    }
    const expected = { ...scopeMetadata(scope), "zion.requestKey": handle.requestKey, "zion.poc": "1" };
    if (Object.entries(expected).some(([key, value]) => info.metadata?.[key] !== value)) {
      throw new SandboxOperationError("sandbox_scope_mismatch", "authorize", handle.sandboxId);
    }
    return { state: info.state, sandboxId: handle.sandboxId };
  }
  async connection(handle, scope, { resume = false } = {}) {
    const info = await this.inspect(handle, scope);
    if (info.state === "destroyed") throw new SandboxOperationError("sandbox_destroyed", "connect", handle.sandboxId);
    if (info.state !== "running" && !resume) throw new SandboxOperationError("sandbox_not_running", "connect", handle.sandboxId);
    try {
      const SDK = await this.sdk();
      return await SDK.connect(handle.sandboxId, {
        ...this.options(),
        ...(resume ? { requestTimeoutMs: 60_000 } : {}),
        timeoutMs: this.supportsPause ? 600_000 : this.#config.timeoutMs
      });
    } catch { throw new SandboxOperationError("sandbox_connect_outcome_unknown", "connect", handle.sandboxId); }
  }
  async prepareEnvironment(handle, scope) {
    this.assertIdentity(handle, scope);
    if (!this.#persistentHome) return;
    const key = fingerprint({ sandboxId: handle.sandboxId, scope });
    if (this.#prepared.get(handle.sandboxId) === key) return;
    const sandbox = await this.connection(handle, scope);
    try {
      const profile = await sandbox.files.read("/etc/profile", { user: "root" });
      const split = SANDBOX_PROFILE_HOOK.indexOf("export HOME=");
      const internal = SANDBOX_PROFILE_HOOK.slice(0, split);
      const environment = SANDBOX_PROFILE_HOOK.slice(split);
      // The Aliyun template eagerly sources both rc files in /etc/profile.
      // Bash itself reads the login profile next; remove that redundant hook
      // so user initialization runs once, after the shared HOME/PATH defaults.
      let managedProfile = profile.replaceAll(
        "if [ -f ~/.bashrc ]; then source ~/.bashrc; fi; if [ -f ~/.profile ]; then source ~/.profile; fi",
        "# Zion: Bash reads the user login profile after /etc/profile."
      );
      if (!managedProfile.startsWith(internal)) managedProfile = internal + managedProfile + "\n" + environment;
      if (managedProfile !== profile) {
        await sandbox.files.write("/etc/profile", managedProfile, { user: "root" });
      }
      const command = sandboxEnvironmentCommand();
      const result = await sandbox.commands.run(command, {
        user: "root", timeoutMs: 60_000, requestTimeoutMs: 70_000,
        envs: { ZION_INTERNAL_COMMAND: Buffer.from(command).toString("base64") }
      });
      if (result.exitCode !== 0 || JSON.parse(result.stdout).version !== 1) throw new Error("HOME initialization failed");
      this.#prepared.set(handle.sandboxId, key);
    } catch {
      throw new SandboxOperationError("sandbox_environment_init_failed", "prepare_environment", handle.sandboxId);
    }
  }
  async exec(handle, scope, {
    command,
    timeoutMs = 30_000,
    onStdout,
    onStderr,
    internal = false,
    maxOutputBytes = 1024 * 1024,
    execution = null,
    onStarted = async () => {},
    signal = null
  } = {}) {
    if (typeof command !== "string" || !command || Buffer.byteLength(command) > 32_768) throw new Error("Invalid command");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("Invalid command timeout");
    if (!Number.isSafeInteger(maxOutputBytes)
      || maxOutputBytes < 1024
      || maxOutputBytes > 5 * 1024 * 1024) {
      throw new Error("Invalid sandbox output limit");
    }
    let sandbox;
    try { sandbox = await this.connection(handle, scope); }
    catch (error) {
      // Connecting/resuming cannot have dispatched this command.
      throw Object.assign(error, { outcomeKnown: true, toolDispatchState: "not_sent" });
    }
    const controller = new AbortController();
    const subscription = signal?.onCancel(() => controller.abort());
    let process;
    let timer;
    let bytes = 0;
    const output = (callback) => (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) { controller.abort(); return; }
      return callback?.(chunk);
    };
    const normalize = (result) => ({
      exitCode: result.exitCode,
      stdout: String(result.stdout || "").slice(0, maxOutputBytes),
      stderr: String(result.stderr || "").slice(0, maxOutputBytes)
    });
    try {
      signal?.throwIfCancelled();
      const launched = execution ? executionCommand(command, execution, { internal }) : command;
      const pending = sandbox.commands.run(launched, {
        user: "root", timeoutMs: execution ? 0 : timeoutMs, requestTimeoutMs: timeoutMs + 10_000,
        onStdout: output(onStdout), onStderr: output(onStderr), signal: controller.signal,
        ...(execution ? { background: true } : {}),
        envs: {
          ...(execution ? { ZION_EXECUTION_ID: execution.id } : {}),
          ...((internal || execution) && this.#persistentHome
            ? { ZION_INTERNAL_COMMAND: Buffer.from(launched).toString("base64") } : {})
        }
      });
      let result;
      if (execution) {
        // A background handle exposes a PID without waiting for command exit.
        // The broker has already journalled the UUID before starting this call.
        timer = setTimeout(() => controller.abort(), timeoutMs);
        const interrupted = new Promise((_, reject) => {
          const abort = () => reject(new Error("Execution interrupted"));
          if (controller.signal.aborted) abort();
          else controller.signal.addEventListener("abort", abort, { once: true });
        });
        result = await Promise.race([pending.then(async (started) => {
          process = started;
          if (controller.signal.aborted) {
            await started.disconnect?.();
            throw new Error("Execution interrupted");
          }
          await onStarted({ ...execution, pid: started.pid });
          return started.wait();
        }), interrupted]);
      } else result = await pending;
      if (controller.signal.aborted) throw new Error("Output limit exceeded");
      return normalize(result);
    } catch (error) {
      if (!controller.signal.aborted && error?.name === "CommandExitError" && Number.isInteger(error.exitCode)) return normalize(error);
      throw new SandboxOperationError("execution_outcome_unknown", "exec", handle.sandboxId);
    } finally {
      clearTimeout(timer);
      subscription?.dispose();
      await process?.disconnect?.();
    }
  }
  async stopExecution(handle, scope, execution) {
    const info = await this.inspect(handle, scope);
    if (info.state === "destroyed") return true;
    // Idle pause preserves processes. Wake the scoped instance to install the
    // durable cancel marker and terminate them before admitting new work.
    if (info.state === "paused") await this.resume(handle, scope);
    if (execution?.kind === "pty") {
      const python = `
import os,pathlib,signal,time,json
pid=${JSON.stringify(execution.pid)}
start=${JSON.stringify(execution.start)}
def members():
    rows=[]
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            stat=(path/'stat').read_text().rsplit(')',1)[1].split()
            if stat[0]!='Z': rows.append((int(path.name),int(stat[3]),stat[19]))
        except (FileNotFoundError,ProcessLookupError): pass
    return rows
rows=members()
if any(p==pid and s!=start for p,sid,s in rows): raise RuntimeError('terminal_pid_reused')
for attempt in range(100):
    targets=[p for p,sid,s in members() if sid==pid]
    if not targets: print(json.dumps({'stopped':True})); break
    for p in targets:
        try: os.kill(p,signal.SIGKILL)
        except ProcessLookupError: pass
    time.sleep(0.05)
else: raise RuntimeError('terminal_termination_unconfirmed')
`;
      const command = `/usr/bin/python3 -c "$(printf '%s' '${Buffer.from(python).toString("base64")}' | /usr/bin/base64 -d)"`;
      const output = await this.exec(handle, scope, { command, internal: true, timeoutMs: 10_000 });
      if (output.exitCode !== 0 || JSON.parse(output.stdout).stopped !== true) {
        throw new SandboxOperationError("execution_termination_unconfirmed", "pty_cancel", handle.sandboxId);
      }
      return true;
    }
    const command = cancelExecutionCommand(execution);
    const output = await this.exec(handle, scope, { command, internal: true, timeoutMs: 10_000 });
    if (output.exitCode !== 0 || JSON.parse(output.stdout).stopped !== true) {
      throw new SandboxOperationError("execution_termination_unconfirmed", "cancel", handle.sandboxId);
    }
    return true;
  }
  async ptyExecution(handle, scope, pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid PTY pid");
    const python = `import pathlib,json; s=pathlib.Path('/proc/${pid}/stat').read_text().rsplit(')',1)[1].split(); assert int(s[3])==${pid},'terminal_session_not_isolated'; print(json.dumps({'kind':'pty','pid':${pid},'start':s[19]}))`;
    const command = `/usr/bin/python3 -c "$(printf '%s' '${Buffer.from(python).toString("base64")}' | /usr/bin/base64 -d)"`;
    const result = await this.exec(handle, scope, { command, internal: true });
    if (result.exitCode !== 0) throw new SandboxOperationError("terminal_identity_unconfirmed", "pty_identity", handle.sandboxId);
    return JSON.parse(result.stdout);
  }
  async write(handle, scope, path, content) {
    canonicalSandboxPath(path);
    if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) throw new Error("Invalid PoC file content");
    const sandbox = await this.connection(handle, scope);
    try { await sandbox.files.write(path, content, { user: "root" }); }
    catch { throw new SandboxOperationError("execution_outcome_unknown", "write", handle.sandboxId); }
  }
  async writeTemporary(handle, scope, path, content) {
    if (!/^\/tmp\/zion-workspace-[a-f0-9-]+\.json$/.test(String(path || ""))
      || typeof content !== "string"
      || Buffer.byteLength(content) > 5 * 1024 * 1024) {
      throw new Error("Invalid temporary sandbox payload");
    }
    const sandbox = await this.connection(handle, scope);
    try { await sandbox.files.write(path, content, { user: "root" }); }
    catch { throw new SandboxOperationError("execution_outcome_unknown", "write_temporary", handle.sandboxId); }
  }
  async read(handle, scope, path) {
    canonicalSandboxPath(path);
    const sandbox = await this.connection(handle, scope);
    try {
      const stat = await sandbox.files.getInfo(path, { user: "root" });
      if (stat.size > 4 * 1024 * 1024) throw new Error("File exceeds limit");
      const content = await sandbox.files.read(path, { user: "root" });
      if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error("File exceeds limit");
      return content;
    } catch { throw new SandboxOperationError("sandbox_file_read_failed", "read", handle.sandboxId); }
  }
  async pause(handle, scope) {
    if (!this.#config.supportsPause) throw new Error("Pause must be verified for the selected template first");
    const sandbox = await this.connection(handle, scope);
    try { await sandbox.pause({ requestTimeoutMs: 60_000 }); }
    catch { throw new SandboxOperationError("sandbox_pause_outcome_unknown", "pause", handle.sandboxId); }
  }
  async resume(handle, scope) {
    if (!this.#config.supportsPause) throw new Error("Pause must be verified for the selected template first");
    await this.connection(handle, scope, { resume: true });
  }
  async touch(handle, scope, timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) throw new Error("Invalid sandbox lifetime");
    const info = await this.inspect(handle, scope);
    if (info.state !== "running") throw new SandboxOperationError("sandbox_not_running", "touch", handle.sandboxId);
    try {
      const SDK = await this.sdk();
      await SDK.setTimeout(handle.sandboxId, timeoutMs, this.options());
    } catch { throw new SandboxOperationError("sandbox_lifetime_update_failed", "touch", handle.sandboxId); }
  }
  async openPty(handle, scope, { pid = null, cols = 80, rows = 24, cwd = "/workspace", onData }) {
    const sandbox = await this.connection(handle, scope);
    try {
      return pid == null
        ? await sandbox.pty.create({ cols, rows, cwd, user: "root", onData, timeoutMs: 0, requestTimeoutMs: 20000 })
        : await sandbox.pty.connect(pid, { onData, timeoutMs: 0, requestTimeoutMs: 20000 });
    } catch { throw new SandboxOperationError("execution_outcome_unknown", "pty_open", handle.sandboxId); }
  }
  async ptyInput(handle, scope, pid, data) {
    const sandbox = await this.connection(handle, scope);
    await sandbox.pty.sendInput(pid, Buffer.from(data));
  }
  async ptyResize(handle, scope, pid, size) {
    const sandbox = await this.connection(handle, scope);
    await sandbox.pty.resize(pid, size);
  }
  async ptyKill(handle, scope, pid) {
    const sandbox = await this.connection(handle, scope);
    await sandbox.pty.kill(pid);
  }
  async destroy(handle, scope) {
    const info = await this.inspect(handle, scope);
    if (info.state === "destroyed") return;
    try {
      const SDK = await this.sdk();
      // Static kill does not connect to or wake an idle sandbox.
      await SDK.kill(handle.sandboxId, { ...this.options(), requestTimeoutMs: 60_000 });
      this.#prepared.delete(handle.sandboxId);
    } catch { throw new SandboxOperationError("sandbox_destroy_outcome_unknown", "destroy", handle.sandboxId); }
  }
  async findCreated(scopeInput, requestKey) {
    const scope = sandboxScope(scopeInput);
    const SDK = await this.sdk();
    const metadata = { ...scopeMetadata(scope), "zion.requestKey": requestKey, "zion.poc": "1" };
    try {
      const pages = SDK.list({ ...this.options(), limit: 100, query: { metadata } });
      const results = [];
      let pageCount = 0;
      while (pages.hasNext && pageCount++ < 10) {
        for (const info of await pages.nextItems()) {
          if (Object.entries(metadata).every(([key, value]) => info.metadata?.[key] === value)) {
            results.push({ ...this.publicIdentity(), sandboxId: info.sandboxId, scope, requestKey });
          }
        }
      }
      if (pages.hasNext) throw new Error("Pagination limit reached");
      return results;
    } catch { throw new SandboxOperationError("sandbox_reconcile_failed", "reconcile"); }
  }

  async listManaged() {
    const SDK = await this.sdk();
    try {
      const pages = SDK.list({
        ...this.options(),
        limit: 100,
        query: { metadata: { "zion.poc": "1" } }
      });
      const results = [];
      let pageCount = 0;
      while (pages.hasNext && pageCount++ < 10) {
        for (const info of await pages.nextItems()) {
          if (info.metadata?.["zion.poc"] !== "1") continue;
          results.push({
            sandboxId: info.sandboxId,
            state: info.state,
            requestKey: info.metadata?.["zion.requestKey"] || null,
            attemptId: info.metadata?.["zion.attemptId"] || null,
            workspaceId: info.metadata?.["zion.workspaceId"] || null,
            epoch: Number(info.metadata?.["zion.epoch"] || 0) || null
          });
        }
      }
      if (pages.hasNext) throw new Error("Pagination limit reached");
      return results;
    } catch {
      throw new SandboxOperationError("sandbox_audit_failed", "audit");
    }
  }
}
