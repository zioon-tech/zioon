import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import { hashExtension } from "../../../../packages/runtime-client/src/extension-package.mjs";
import { EXTENSION_HOST_TOOL, normalizeHostDescription } from "../../../../packages/plugin-sdk/src/host-contract.mjs";
import { CancellationController } from "../../../../packages/runtime/dist/index.js";

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const error = (result) => { throw Object.assign(new Error(result.content || "extension_host_error"),
  { code: result.failureCode || "extension_host_error", failureCode: result.failureCode, retryable: false }); };
/** Pure platform proxy. User modules are transferred as bytes, never imported. */
export class ExtensionHostBridge {
  constructor({ tools, nativeInvoke = null, hasNativeHost = () => false, acquireActivity = () => null,
    resolveResourceEpoch = async () => undefined }) {
    this.tools = tools;
    this.nativeInvoke = nativeInvoke;
    this.hasNativeHost = hasNativeHost;
    this.acquireActivity = acquireActivity;
    this.resolveResourceEpoch = resolveResourceEpoch;
    this.staged = new Map();
    this.dependencies = new Map();
    this.bindings = new Map();
    this.serial = new Map();
    this.source = this.readSources();
  }
  remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > 128) map.delete(map.keys().next().value);
  }
  async readSources() {
    const sources = {};
    for (const name of ["extension-host.mjs", "extension-worker.mjs", "extension-security.mjs", "extension-daemon.mjs", "extension-client.mjs"]) {
      sources[name] = (await readFile(new URL(`../../../device-connector/src/${name}`, import.meta.url), "utf8"))
        .replaceAll("../../../packages/plugin-sdk/src/", "./");
    }
    for (const name of ["manifest.mjs", "host-contract.mjs", "tool-execution.mjs", "model-catalog.mjs"]) {
      sources[name] = await readFile(new URL(`../../../../packages/plugin-sdk/src/${name}`, import.meta.url), "utf8");
    }
    return sources;
  }
  binding(install, artifact, userId) {
    return { accountId: userId, listingId: install.listingId, digest: artifact.digest,
      epoch: install.executionEpoch, config: install.config };
  }
  async step(context, binding, step, name, args, signal = context.signal) {
    const invocationId = `host:${hashExtension([context.invocationId || context.runId, binding, step])}`;
    const result = await this.tools().invoke({
      ...context, signal: undefined, invocationId,
      target: { nodeId: binding.config.nodeId },
      toolCall: { id: invocationId, name, arguments: { ...args, node_id: binding.config.nodeId } }
    }, signal);
    if (!result.ok) error(result);
    return result;
  }
  async transport(input, context, { signal = context.signal, cleanup = false } = {}) {
    const { binding } = input;
    if (!cleanup) await context.authorize?.();
    if (this.nativeInvoke && await this.hasNativeHost(binding.config.nodeId, context.principal)) {
      const id = `host:${randomUUID()}`;
      const result = await this.nativeInvoke({
        ...context, invocationId: id, projectId: undefined, extensionCleanup: cleanup,
        target: { nodeId: binding.config.nodeId },
        policy: { ...context.policy, preset: "trusted-automation",
          allowedTools: [EXTENSION_HOST_TOOL], fileRoots: [binding.config.workspaceRoot,
            ...(binding.config.credentialsFile ? [binding.config.credentialsFile] : [])],
          allowedTerminalSessionIds: [], allowedCommandPrefixes: [] },
        toolCall: { id, name: EXTENSION_HOST_TOOL, arguments: input }
      }, signal);
      if (!result.ok) error(result);
      return JSON.parse(result.content);
    }
    const sources = await this.source;
    const root = posix.join(binding.config.workspaceRoot, ".zion", "extension-host", `bridge-${hashExtension(sources).slice(0, 12)}`);
    const key = hashExtension([binding.config.nodeId, root, binding.accountId, binding.resourceEpoch]);
    if (!this.staged.has(key)) {
      const staging = (async () => {
        for (const [name, content] of Object.entries(sources)) {
          await this.step(context, binding, `stage:${name}`, "write", { path: posix.join(root, name), content }, signal);
        }
      })().catch((e) => { this.staged.delete(key); throw e; });
      this.remember(this.staged, key, staging);
    }
    await this.staged.get(key);
    const nonce = randomUUID();
    const path = posix.join(root, `request-${nonce}.json`);
    await this.step(context, binding, `request:${nonce}`, "write", { path, content: JSON.stringify(input) }, signal);
    const socket = `/tmp/zioon-extension-${key.slice(0, 20)}/host.sock`;
    const result = await this.step(context, binding, `dispatch:${nonce}`, "Bash", {
      command: `node ${quote(posix.join(root, "extension-client.mjs"))} ${quote(socket)} ${quote(path)}; status=$?; rm -f ${quote(path)}; exit "$status"`,
      timeout: 30000, execution_environment: "resource"
    }, signal);
    let stdout = result.content;
    try { const v = JSON.parse(stdout); if (typeof v.stdout === "string") stdout = v.stdout; } catch {}
    const frame = String(stdout).split("\n").find((s) => s.startsWith("ZIOON_HOST_RESULT:"));
    if (!frame) error({ content: "extension_host_result_unknown", failureCode: "execution_outcome_unknown" });
    const value = JSON.parse(frame.slice("ZIOON_HOST_RESULT:".length));
    if (!value.ok) error(value);
    return JSON.parse(value.content);
  }
  async ensure(binding, artifact, context, { refresh = false } = {}) {
    const lease = this.acquireActivity(binding, context);
    try {
      const epoch = await this.resolveResourceEpoch(binding, context);
      if (epoch) binding.resourceEpoch = epoch;
      if (artifact.kind === "mcp" && !await this.hasNativeHost(binding.config.nodeId, context.principal)) {
        await this.prepareMcp(binding, context);
      }
      const description = normalizeHostDescription(await this.transport({ protocolVersion: 1, action: "ensure", binding, artifact }, context));
      const now = Date.now();
      for (const [key, prior] of this.bindings) {
        if (now - prior.touchedAt > 300000 || (prior.binding.accountId === binding.accountId
          && prior.binding.listingId === binding.listingId && prior.binding.config.nodeId === binding.config.nodeId)) {
          this.bindings.delete(key);
        }
      }
      this.remember(this.bindings, hashExtension(binding), { binding, description, touchedAt: now,
        context: { principal: context.principal, policy: context.policy } });
      return refresh ? normalizeHostDescription(await this.transport({
        protocolVersion: 1, action: "refresh", binding, hostEpoch: description.hostEpoch
      }, context)) : description;
    } finally { lease?.dispose?.(); }
  }
  async prepareMcp(binding, context) {
    const sources = await this.source;
    const root = posix.join(binding.config.workspaceRoot, ".zion", "extension-host", `bridge-${hashExtension(sources).slice(0, 12)}`);
    const key = hashExtension([binding.accountId, binding.config.nodeId, root, binding.resourceEpoch]);
    if (!this.dependencies.has(key)) {
      const prepare = (async () => {
        for (const [name, content] of Object.entries(sources)) {
          await this.step(context, binding, `prepare:${name}`, "write", { path: posix.join(root, name), content });
        }
        await this.step(context, binding, "mcp-dependency", "Bash", {
          command: `node -e ${quote(`require.resolve('@modelcontextprotocol/sdk/client/index.js', { paths: [${JSON.stringify(root)}] })`)} > /dev/null 2>&1 || npm install --prefix ${quote(root)} --ignore-scripts --no-audit --no-fund --save-exact @modelcontextprotocol/sdk@1.27.1 > /dev/null 2>&1`,
          timeout: 60000, execution_environment: "resource"
        });
      })().catch((error) => { this.dependencies.delete(key); throw error; });
      this.remember(this.dependencies, key, prepare);
    }
    await this.dependencies.get(key);
  }
  async *invokeStream(binding, description, handler, input, context, method) {
    const unlock = await this.lock(binding, context.signal);
    const id = String(context.invocationId || `extension:${randomUUID()}`);
    const lease = this.acquireActivity(binding, context);
    const controller = new CancellationController();
    const parent = context.signal?.onCancel?.((reason) => controller.cancel(reason));
    if (context.signal?.cancelled) controller.cancel(context.signal.reason);
    const deadline = setTimeout(() => controller.cancel("extension-timeout"),
      handler.execution?.timeoutMs || (handler.kind === "model" ? 600000 : 30000));
    deadline.unref();
    const envelope = { protocolVersion: 1, binding, hostEpoch: description.hostEpoch, invocationId: id };
    const requestContext = Object.fromEntries(["runId", "attemptId", "sessionId", "projectId", "invocationId",
      "request", "turn", "messages", "tools", "usage", "preview", "output", "jobId"]
      .filter((k) => context[k] !== undefined).map((k) => [k, context[k]]));
    let done = false, accepted = false, ack = -1;
    const signal = controller.signal;
    try {
      await this.transport({ ...envelope, action: "invoke", handle: handler.handle, method, input, context: requestContext }, context, { signal });
      accepted = true;
      while (!done) {
        signal.throwIfCancelled();
        lease?.touch?.();
        await context.authorize?.();
        const page = await this.transport({ ...envelope, action: "poll", ack }, context, { signal });
        for (const event of page.events || []) {
          if (event.sequence !== ack + 1) throw new Error("extension_stream_sequence");
          signal.throwIfCancelled();
          ack = event.sequence;
          yield event;
        }
        if (page.done) {
          if (page.notifications?.events?.length) await context.publishEvents?.(page.notifications.events);
          if (Object.keys(page.notifications?.usage || {}).length) context.recordUsage?.(page.notifications.usage);
          if (page.error) error({ content: page.error, failureCode: page.error });
          done = true;
          yield { type: "result", payload: page.resultUndefined ? undefined : page.result };
        }
      }
    } catch (cause) {
      if (signal.reason === "extension-timeout" && !context.signal?.cancelled) {
        error({ content: "extension_timeout", failureCode: handler.execution?.idempotency === "safe"
          || ["context", "controller", "model"].includes(handler.kind) ? "timeout" : "execution_outcome_unknown" });
      }
      if (accepted && (["extension_host_stale", "extension_credentials_changed", "extension_invocation_missing",
        "node_offline", "node_disconnected", "execution_outcome_unknown", "timeout"].includes(cause.code)
        || !cause.code)) {
        error({ content: "execution_outcome_unknown", failureCode: "execution_outcome_unknown" });
      }
      throw cause;
    } finally {
      parent?.dispose?.();
      clearTimeout(deadline);
      if (!done) {
        const cleanup = new CancellationController();
        const timer = setTimeout(() => cleanup.cancel("cleanup-timeout"), 5000);
        try { await this.transport({ ...envelope, action: "cancel" }, context, { signal: cleanup.signal, cleanup: true }); }
        catch {
          // A revoked dispatch grant cannot launch a cleanup shell. Retain
          // activity until the execution-side 30s lease and kill watchdog end.
          if (lease) await new Promise((resolve) => setTimeout(resolve, 33000));
        }
        finally { clearTimeout(timer); }
      }
      lease?.dispose?.();
      unlock();
    }
  }
  async invoke(binding, description, handler, input, context, method) {
    let result;
    for await (const event of this.invokeStream(binding, description, handler, input, context, method)) {
      if (event.type === "result") result = event.payload;
      else throw new Error("unexpected_extension_stream");
    }
    return result;
  }
  async lock(binding, signal) {
    const key = hashExtension(binding);
    const previous = this.serial.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.serial.set(key, tail);
    let listener;
    const cancelled = new Promise((_, reject) => {
      listener = signal?.onCancel?.((reason) => reject(Object.assign(new Error(reason), { code: "cancelled" })));
    });
    try { await Promise.race([previous, cancelled]); signal?.throwIfCancelled?.(); }
    catch (error) { release(); throw error; }
    finally { listener?.dispose?.(); }
    return () => { release(); if (this.serial.get(key) === tail) this.serial.delete(key); };
  }
  async dispose(binding, context) {
    const key = hashExtension(binding);
    const entry = this.bindings.get(key);
    if (!entry) return;
    this.bindings.delete(key);
    const cleanup = new CancellationController();
    const timer = setTimeout(() => cleanup.cancel("dispose-timeout"), 5000);
    try { await this.transport({ protocolVersion: 1, binding, hostEpoch: entry.description.hostEpoch,
      action: "dispose" }, context, { signal: cleanup.signal, cleanup: true }); }
    finally { clearTimeout(timer); }
  }
  async close() {
    const bindings = [...this.bindings.values()];
    this.bindings.clear();
    this.dependencies.clear();
    this.staged.clear();
    await Promise.allSettled(bindings.map(async ({ binding, description, context }) => {
      const cleanup = new CancellationController();
      const timer = setTimeout(() => cleanup.cancel("shutdown-timeout"), 5000);
      try { await this.transport({ protocolVersion: 1, binding, hostEpoch: description.hostEpoch,
        action: "dispose" }, context, { signal: cleanup.signal, cleanup: true }); }
      finally { clearTimeout(timer); }
    }));
  }
}
