import { spawn } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { readFile, mkdir, lstat, realpath, open, rename } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { normalizeHostBinding, normalizeHostDescription } from "../../../packages/plugin-sdk/src/host-contract.mjs";
import { canonicalExtensionConfig, credentialSecrets, readFrame, redactValue, streamRedactor } from "./extension-security.mjs";

const hash = (v) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
const failure = (code) => Object.assign(new Error(code), { code, statusCode: 409 });
const inside = (root, p) => { const part = relative(root, p); return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith("../")); };
async function safeDirectory(path, root) {
  if (!inside(root, path)) throw failure("extension_path_denied");
  if (path !== root) await safeDirectory(dirname(path), root);
  try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(path))) throw failure("extension_path_denied");
}
async function immutable(path, content, root) {
  await safeDirectory(dirname(path), root);
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (e) {
    if (e.code !== "EEXIST" || (await lstat(path)).isSymbolicLink() || await readFile(path, "utf8") !== content) throw failure("extension_file_integrity");
    return;
  }
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

/** Supervises account/permission/version separated child processes. All IPC
 * calls are structured capabilities; there is no network URL in this protocol. */
export class ExtensionHost {
  constructor({ authorize = null, supportDirectory = null, accountIsolated = false,
    idleMs = 300000, leaseMs = 30000, maxWorkers = 16 } = {}) {
    this.authorize = authorize;
    this.accountIsolated = accountIsolated;
    this.supportDirectory = supportDirectory;
    this.idleMs = idleMs;
    this.leaseMs = leaseMs;
    this.maxWorkers = maxWorkers;
    this.workers = new Map();
    this.pending = new Map();
    this.closed = false;
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }
  async sources() {
    const read = (name) => readFile(this.supportDirectory ? join(this.supportDirectory, name)
      : name === "extension-worker.mjs" ? new URL("./extension-worker.mjs", import.meta.url)
        : new URL(`../../../packages/plugin-sdk/src/${name}`, import.meta.url), "utf8");
    const contents = {};
    for (const name of ["extension-worker.mjs", "extension-security.mjs", "manifest.mjs", "host-contract.mjs", "tool-execution.mjs", "model-catalog.mjs"]) {
      contents[name] = (await (name === "extension-security.mjs" && !this.supportDirectory
        ? readFile(new URL("./extension-security.mjs", import.meta.url), "utf8") : read(name)))
        .replaceAll("../../../packages/plugin-sdk/src/", "./");
    }
    return contents;
  }
  async invoke(input, signal, invocation = {}) {
    try {
      if (this.closed || input?.protocolVersion !== 1) throw failure("extension_host_unavailable");
      const binding = normalizeHostBinding(input.binding);
      const principalId = String(invocation.principal?.userId || invocation.principal?.user?.id || "");
      if (principalId !== binding.accountId) throw failure("extension_account_denied");
      binding.config = await canonicalExtensionConfig(binding.config);
      await this.authorize?.({ ...input, binding }, invocation);
      signal?.throwIfCancelled?.();
      let result;
      if (input.action === "ensure") result = await this.ensure(binding, input.artifact);
      else {
        const w = this.workers.get(this.key(binding));
        if (!w || w.hostEpoch !== input.hostEpoch || w.dead) throw failure("extension_host_stale");
        if (!["cancel", "dispose"].includes(input.action)
          && hash(await this.credentials(binding)) !== w.credentialsHash) {
          this.dispose(w);
          throw failure("extension_credentials_changed");
        }
        w.touchedAt = Date.now();
        if (input.action === "dispose") { await this.dispose(w); result = { disposed: true }; }
        else if (input.action === "refresh") result = await this.refresh(w);
        else if (input.action === "invoke") result = await this.start(w, input);
        else if (["poll", "cancel"].includes(input.action)) result = await this.operation(w, input, signal);
        else throw failure("invalid_host_action");
      }
      return { ok: true, content: JSON.stringify(result) };
    } catch (e) {
      const candidate = String(e?.code || "").toLowerCase();
      const code = /^[a-z_]{1,100}$/.test(candidate) ? candidate : "extension_host_error";
      return { ok: false, content: code, failureCode: code, retryable: false };
    }
  }
  receiptKey(binding) { return hash([binding.accountId, binding.listingId, binding.digest, binding.epoch, binding.config]); }
  key(binding) { return hash([this.receiptKey(binding), binding.resourceEpoch || "legacy"]); }
  async ensure(binding, artifact) {
    const key = this.key(binding);
    for (const worker of this.workers.values()) {
      if (worker.binding.accountId === binding.accountId && worker.binding.listingId === binding.listingId
        && worker.key !== key) await this.dispose(worker);
    }
    const credentials = await this.credentials(binding);
    const credentialsHash = hash(credentials);
    const prior = this.workers.get(key);
    if (prior && !prior.dead && prior.credentialsHash === credentialsHash) { prior.touchedAt = Date.now(); return prior.description; }
    if (prior) this.dispose(prior);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.activate(binding, artifact, key, credentials).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  async credentials(binding) {
    const config = binding.config;
    let credentials = {};
    if (config?.credentialsFile) {
      const info = await lstat(config.credentialsFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16000
        || (process.platform !== "win32" && (info.mode & 0o077))) throw failure("extension_credentials_permissions");
      credentials = JSON.parse(await readFile(config.credentialsFile, "utf8"));
      if (credentials.listingId !== binding.listingId
        || (credentials.accountId && credentials.accountId !== binding.accountId)) throw failure("extension_credentials_binding");
    }
    return credentials;
  }
  async activate(binding, artifact, key, credentials) {
    // Reserve a slot across async staging, not only after child creation.
    if (this.workers.size + this.pending.size >= this.maxWorkers) throw failure("extension_host_capacity");
    if (!artifact || artifact.digest !== binding.digest) throw failure("extension_digest_mismatch");
    const { digest, ...unsigned } = artifact;
    if (hash(unsigned) !== digest || Buffer.byteLength(JSON.stringify(artifact)) > 200000) throw failure("extension_digest_mismatch");
    const config = binding.config;
    if (!config || typeof config.workspaceRoot !== "string" || !isAbsolute(config.workspaceRoot)) throw failure("extension_path_denied");
    const workspace = await realpath(config.workspaceRoot);
    const accountRoot = join(workspace, ".zion", "extension-host", "accounts", hash(binding.accountId).slice(0, 24));
    const root = join(accountRoot, "artifacts", artifact.digest);
    const dataRoot = join(workspace, ".zion", "plugin-data", ".account-extensions",
      hash(binding.accountId), hash(binding.listingId));
    const legacyDataRoot = join(accountRoot, "data", hash(binding.listingId).slice(0, 24));
    const receiptRoot = join(accountRoot, "receipts", this.receiptKey(binding));
    await safeDirectory(root, workspace);
    await safeDirectory(dirname(dataRoot), workspace);
    let legacy;
    try { legacy = await lstat(legacyDataRoot); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (legacy) {
      if (!legacy.isDirectory() || legacy.isSymbolicLink() || !inside(workspace, await realpath(legacyDataRoot))) {
        throw failure("extension_path_denied");
      }
      let existing;
      try { existing = await lstat(dataRoot); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (existing) throw failure("extension_data_migration_conflict");
      await rename(legacyDataRoot, dataRoot);
    }
    await safeDirectory(dataRoot, workspace);
    await safeDirectory(receiptRoot, workspace);
    for (const [name, content] of Object.entries(artifact.files || {})) {
      if (!/^[a-zA-Z0-9_.\/-]+$/.test(name) || name.split("/").some((p) => !p || p === "." || p === "..")) throw failure("extension_path_denied");
      await immutable(resolve(root, name), content, workspace);
    }
    const sources = await this.sources();
    const engineRoot = join(accountRoot, "engines", hash(sources));
    for (const [name, source] of Object.entries(sources)) await immutable(join(engineRoot, name), source, workspace);
    let sdkPath;
    if (artifact.kind === "mcp") {
      try { sdkPath = createRequire(this.supportDirectory
        ? join(this.supportDirectory, "package.json") : import.meta.url).resolve("@modelcontextprotocol/sdk/client/index.js"); }
      catch { throw failure("extension_dependencies_required"); }
    }
    let stdioNodeArgs;
    if (artifact.kind === "mcp" && artifact.mcp.transport === "stdio") {
      const spec = artifact.mcp;
      if (spec.command === "node" || spec.command === process.execPath) {
        const entry = spec.args[0];
        if (!entry || entry.startsWith("-") || !Object.hasOwn(artifact.files, entry)
          || !/\.(?:mjs|js|cjs)$/.test(entry)) throw failure("extension_stdio_entry_required");
        stdioNodeArgs = ["--experimental-permission", "--frozen-intrinsics",
          `--allow-fs-read=${root}`, `--allow-fs-read=${dataRoot}`, `--allow-fs-write=${dataRoot}`];
      } else if (!this.accountIsolated) throw failure("extension_stdio_isolation_required");
    }
    // The MCP worker imports trusted SDK code only. User stdio code is a
    // separate confined Node process, or runs in a dedicated account resource.
    const args = artifact.kind === "plugin" ? [
      "--experimental-permission", "--frozen-intrinsics", `--allow-fs-read=${root}`,
      `--allow-fs-read=${engineRoot}`, `--allow-fs-read=${dataRoot}`, `--allow-fs-write=${dataRoot}`
    ] : [];
    const child = spawn(process.execPath, [...args, join(engineRoot, "extension-worker.mjs")], {
      cwd: root, env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: workspace, TMPDIR: "/tmp" },
      stdio: ["pipe", "pipe", "ignore"]
    });
    const w = { key, binding, child, receiptRoot, workspace, credentialsHash: hash(credentials),
      ipcKey: randomBytes(32).toString("hex"), nextFrame: 0, secrets: credentialSecrets(credentials),
      hostEpoch: `host:${randomUUID()}`, operations: new Map(),
      touchedAt: Date.now(), dead: false, buffer: "" };
    this.workers.set(key, w);
    const decoder = new StringDecoder("utf8");
    w.accepting = Promise.resolve();
    child.stdout.on("data", (bytes) => {
      w.buffer += decoder.write(bytes);
      if (Buffer.byteLength(w.buffer) > 200000) { this.dispose(w); return; }
      let newline;
      while ((newline = w.buffer.indexOf("\n")) !== -1) {
        const line = w.buffer.slice(0, newline); w.buffer = w.buffer.slice(newline + 1);
        try {
          const message = readFrame(w.ipcKey, w.nextFrame++, JSON.parse(line));
          w.accepting = w.accepting.then(() => this.accept(w, message)).catch(() => this.dispose(w));
        } catch { this.dispose(w); }
      }
    });
    child.on("error", () => this.dispose(w));
    child.on("exit", () => this.dispose(w));
    child.stdin.on("error", () => this.dispose(w));
    const activationId = `activate:${randomUUID()}`;
    const ready = this.record(w, activationId, { action: "activate" });
    this.send(w, { action: "activate", id: activationId, hostEpoch: w.hostEpoch, artifact, binding,
      root, dataRoot, credentials, sdkPath, stdioNodeArgs, ipcKey: w.ipcKey });
    try {
      await this.wait(ready, 25000);
      if (!ready.done || ready.error) throw failure("extension_activation_failed");
      w.description = normalizeHostDescription(ready.result);
      w.operations.delete(activationId);
      return w.description;
    } catch (e) { this.dispose(w); throw e; }
  }
  record(w, id, request) {
    const op = { id, fingerprint: hash(request), events: [], nextSequence: 0, ack: -1,
      done: false, result: null, error: null, touchedAt: Date.now(), waiters: new Set(), bytes: 0 };
    w.operations.set(id, op);
    return op;
  }
  async refresh(w) {
    if ([...w.operations.values()].some((op) => !op.done)) throw failure("extension_host_busy");
    const id = `refresh:${randomUUID()}`;
    const op = this.record(w, id, { action: "refresh" });
    this.send(w, { action: "refresh", id });
    await this.wait(op, 25000);
    w.operations.delete(id);
    if (!op.done || op.error) throw failure("extension_probe_failed");
    w.description = normalizeHostDescription(op.result);
    return w.description;
  }
  async start(w, input) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(input.invocationId || "")
      || Buffer.byteLength(JSON.stringify(input)) > 750000) throw failure("invalid_host_invocation");
    const descriptor = w.description.handlers.find((h) => h.handle === input.handle);
    if (!descriptor) throw failure("extension_handler_missing");
    const id = input.invocationId;
    const request = { handle: input.handle, method: input.method, input: input.input, context: input.context };
    const existing = w.operations.get(id);
    if (existing) {
      if (existing.fingerprint !== hash(request)) throw failure("extension_invocation_conflict");
      return { invocationId: id, started: true };
    }
    if (w.operations.size >= 256) throw failure("extension_operation_capacity");
    if ([...w.operations.values()].some((op) => !op.done)) throw failure("extension_host_busy");
    const op = this.record(w, id, request);
    op.redactStream = streamRedactor(w.secrets);
    const claimPath = join(w.receiptRoot, `${hash(id)}.claim.json`);
    op.resultPath = join(w.receiptRoot, `${hash(id)}.result.json`);
    try {
      const claim = await open(claimPath, "wx", 0o600);
      try { await claim.writeFile(JSON.stringify({ id, fingerprint: op.fingerprint })); await claim.sync(); } finally { await claim.close(); }
    } catch (e) {
      if (e.code !== "EEXIST") { this.dispose(w); throw e; }
      const prior = JSON.parse(await readFile(claimPath, "utf8"));
      if (prior.id !== id || prior.fingerprint !== op.fingerprint) throw failure("extension_invocation_conflict");
      op.done = true; op.completedAt = Date.now();
      try {
        const result = JSON.parse(await readFile(op.resultPath, "utf8"));
        op.result = result.result; op.error = result.error; op.notifications = result.notifications;
        op.resultUndefined = result.resultUndefined;
      } catch { op.error = "execution_outcome_unknown"; }
      return { invocationId: id, started: true };
    }
    this.send(w, { action: "invoke", id, ...request });
    return { invocationId: id, started: true };
  }
  async accept(w, message) {
    const op = w.operations.get(message.id);
    if (!op || op.done) return;
    if (message.event === "chunk") {
      const bytes = op.redactStream(Buffer.from(message.payload, "base64"));
      if (!bytes.length) { this.send(w, { action: "credit", id: op.id }); return; }
      message = { ...message, payload: bytes.toString("base64") };
    } else message = redactValue(message, w.secrets);
    if (message.event) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (size > 50000 || (op.bytes += size) > 100000) throw failure("extension_stream_budget");
      op.events.push({ sequence: op.nextSequence++, type: message.event, payload: message.payload });
    } else {
      if (op.redactStream) {
        const tail = op.redactStream(null, true);
        if (tail.length) op.events.push({ sequence: op.nextSequence++, type: "chunk", payload: tail.toString("base64") });
      }
      // No completion is exposed until the execution-side receipt is durable.
      if (op.resultPath) await immutable(op.resultPath, JSON.stringify({
        result: message.result ?? null, error: message.error || null, notifications: message.notifications,
        resultUndefined: message.resultUndefined
      }), w.workspace);
      if (op.done || w.dead) return;
      op.done = true;
      op.result = message.result;
      op.error = message.error || null;
      op.notifications = message.notifications;
      op.resultUndefined = message.resultUndefined;
      op.completedAt = Date.now();
    }
    for (const fn of op.waiters) fn();
  }
  async operation(w, input, signal) {
    const op = w.operations.get(input.invocationId);
    if (!op) throw failure("extension_invocation_missing");
    op.touchedAt = Date.now();
    if (input.action === "cancel") {
      this.cancel(w, op);
      // Cancellation is drained before the platform may release resource
      // activity. An uncooperative worker is killed by the watchdog.
      if (!op.done) await this.wait(op, 3000, signal);
      if (!op.done) await this.dispose(w);
      return { cancelled: true, done: op.done };
    }
    const ack = input.ack ?? -1;
    if (!Number.isSafeInteger(ack) || ack < op.ack || ack >= op.nextSequence) throw failure("invalid_host_ack");
    for (const e of op.events.filter((e) => e.sequence <= ack)) {
      op.bytes -= Buffer.byteLength(JSON.stringify({ id: op.id, event: e.type, payload: e.payload }));
      if (e.type === "chunk") this.send(w, { action: "credit", id: op.id });
    }
    op.events = op.events.filter((e) => e.sequence > ack);
    op.ack = ack;
    if (!op.done && !op.events.length) await this.wait(op, Math.min(15000, Math.max(1, input.waitMs || 10000)), signal);
    return { hostEpoch: w.hostEpoch, invocationId: op.id, events: op.events,
      done: op.done, ...(op.done ? { result: op.result, resultUndefined: op.resultUndefined,
        error: op.error, notifications: op.notifications } : {}) };
  }
  wait(op, ms, signal) {
    if (op.done || op.events.length) return Promise.resolve();
    return new Promise((resolve) => {
      let sub, timer;
      const finish = () => { clearTimeout(timer); op.waiters.delete(finish); sub?.dispose?.(); resolve(); };
      timer = setTimeout(finish, ms);
      op.waiters.add(finish);
      sub = signal?.onCancel?.(finish);
    });
  }
  send(w, message) { if (!w.dead) w.child.stdin.write(`${JSON.stringify(message)}\n`); }
  cancel(w, op) {
    if (op.done || op.cancelAt) return;
    op.cancelAt = Date.now();
    this.send(w, { action: "cancel", id: op.id });
  }
  sweep() {
    const now = Date.now();
    for (const w of this.workers.values()) {
      for (const [id, op] of w.operations) {
        if (!op.done && now - op.touchedAt > this.leaseMs) this.cancel(w, op);
        if (op.cancelAt && !op.done && now - op.cancelAt > 2000) this.dispose(w);
        if (op.done && now - op.completedAt > 60000) w.operations.delete(id);
      }
      if (![...w.operations.values()].some((op) => !op.done) && now - w.touchedAt > this.idleMs) this.dispose(w);
    }
  }
  dispose(w) {
    if (w.dead) return w.termination;
    this.send(w, { action: "dispose" });
    w.dead = true;
    for (const op of w.operations.values()) {
      if (!op.done) { op.done = true; op.error = "execution_outcome_unknown"; op.completedAt = Date.now(); }
      for (const fn of op.waiters) fn();
    }
    const kill = setTimeout(() => w.child.kill("SIGKILL"), 2000);
    kill.unref();
    w.termination = new Promise((resolve) => {
      if (!w.child.pid || w.child.exitCode !== null || w.child.signalCode !== null) { clearTimeout(kill); resolve(); }
      else w.child.once("exit", () => { clearTimeout(kill); resolve(); });
    });
    if (this.workers.get(w.key) === w) this.workers.delete(w.key);
    return w.termination;
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    return Promise.allSettled([...this.workers.values()].map((w) => this.dispose(w)));
  }
}
