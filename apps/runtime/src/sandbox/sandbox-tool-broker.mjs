import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeToolExecution } from "../../../../packages/plugin-sdk/src/tool-execution.mjs";
import { fingerprint } from "../../../../packages/sandbox/src/provider.mjs";
import { canonicalSandboxPath, sandboxPathWithinRoots } from "../../../../packages/sandbox/src/paths.mjs";
import {
  LOCAL_TOOLS_TOOL_DEFINITIONS,
  LOCAL_TOOLS_BASH_DEFAULT_TIMEOUT_MS,
  LOCAL_TOOLS_BASH_MAX_TIMEOUT_MS
} from "../../../../packages/local-tools-client/src/index.mjs";
import { workspaceFileCommand } from "./workspace-file-command.mjs";
import { unknownToolOutcomeResult } from "../tool-invocation-lifecycle.mjs";

export const LEGACY_SANDBOX_TOOL_DEFINITIONS = [
  {
    name: "sandboxBash", description: "Execute a command in the account's reusable isolated cloud workspace. The VM and background processes persist across calls until idle pause or release. Interrupted execution requires inspection before retry.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 1, maximum: 60000 } }, required: ["command"], additionalProperties: false },
    // Platform deadline includes creation/resume plus the command's own timeout.
    execution: normalizeToolExecution({ effect: "process", timeoutMs: 180000, maxTimeoutMs: 180000 })
  },
  {
    name: "sandboxRead", description: "Read a bounded UTF-8 file in the account sandbox.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execution: normalizeToolExecution({ effect: "read", timeoutMs: 120000, maxTimeoutMs: 120000 })
  },
  {
    name: "sandboxWrite", description: "Write and fsync a UTF-8 file in the account sandbox.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    execution: normalizeToolExecution({ effect: "write", timeoutMs: 120000, maxTimeoutMs: 120000 })
  }
].map((item) => ({ ...item, hostKinds: ["sandbox"] }));
const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "tree"]);
const ALIASES = { sandboxBash: "Bash", sandboxRead: "read", sandboxWrite: "write" };
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const PREPARE_WORKSPACE = Symbol("prepare-workspace");
export const SANDBOX_TOOL_DEFINITIONS = LOCAL_TOOLS_TOOL_DEFINITIONS
  .filter((tool) => FILE_TOOLS.has(tool.name) || tool.name === "Bash")
  .map((tool) => ({
    ...tool, hostKinds: ["managed-node"],
    description: `${tool.description} The default target is this account's managed cloud workspace; node_id can select an authorized Node. No host fallback.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        node_id: { type: "string", description: "Node ID from terminalInventory. Omit for the current cloud workspace." }
      }
    },
    execution: normalizeToolExecution({
      // The command deadline is enforced by the host. Allow provisioning and
      // result delivery to finish even for the longest supported command.
      effect: tool.execution.effect,
      timeoutMs: tool.name === "Bash" ? LOCAL_TOOLS_BASH_MAX_TIMEOUT_MS + 120000 : 120000,
      maxTimeoutMs: tool.name === "Bash" ? LOCAL_TOOLS_BASH_MAX_TIMEOUT_MS + 120000 : 120000
    })
  }));

function denied(code) {
  const error = new Error(code);
  error.failureCode = "policy_denied";
  return error;
}

export function validateSandboxBindings(bindings, { allowEmpty = false } = {}) {
  if (!Array.isArray(bindings) || (!allowEmpty && !bindings.length)) throw new Error("Sandbox account bindings are required");
  const accounts = new Set();
  const mounts = new Set();
  for (const item of bindings) {
    if (!item.accountId || !item.workspaceId || accounts.has(item.accountId)) throw new Error("Sandbox account binding must be unique");
    const storage = JSON.parse(item.storageMetadata?.["fc.sandbox.storage.agenticfs"] || "{}");
    const mount = storage.mountPoints;
    if (!Array.isArray(mount) || mount.length !== 1 || mount[0].mountDir !== "/workspace"
      || !mount[0].serverAddr || mounts.has(mount[0].serverAddr)
      || !item.storageMetadata?.["fc.sandbox.auth.role"] || !item.storageNetwork) {
      throw new Error("Each sandbox account requires a distinct, scoped persistent mount");
    }
    accounts.add(item.accountId);
    mounts.add(mount[0].serverAddr);
  }
  return bindings;
}

export class SandboxToolBroker {
  constructor({
    provider, store, bindings, authorizeInvocation, idlePauseMs = 120000,
    idleDestroyMs = 1800000, maintenanceIntervalMs = 15000, now = () => Date.now(),
    onError = () => {}, allowEmptyBindings = false
  }) {
    if (!authorizeInvocation) throw new Error("Sandbox tools require account authorization");
    if (!Number.isSafeInteger(idlePauseMs) || idlePauseMs < 30000 || idlePauseMs > 300000
      || !Number.isSafeInteger(idleDestroyMs) || idleDestroyMs < idlePauseMs
      || !Number.isSafeInteger(maintenanceIntervalMs) || maintenanceIntervalMs < 1000) {
      throw new Error("Invalid sandbox lifecycle intervals");
    }
    this.provider = provider;
    this.store = store;
    this.bindings = validateSandboxBindings(bindings, { allowEmpty: allowEmptyBindings });
    this.authorizeInvocation = authorizeInvocation;
    this.supportedToolNames = SANDBOX_TOOL_DEFINITIONS.map((item) => item.name);
    this.idlePauseMs = idlePauseMs;
    this.idleDestroyMs = idleDestroyMs;
    this.maintenanceIntervalMs = maintenanceIntervalMs;
    this.now = now;
    this.onError = onError;
    this.pending = new Map();
    this.activityLeases = new Map();
    this.invalidationListeners = new Set();
    this.closing = false;
  }
  getToolDefinitions() { return [...SANDBOX_TOOL_DEFINITIONS]; }
  bindingForAccount(accountId) {
    return this.bindings.find((item) => item.accountId === accountId) || null;
  }
  onInstanceInvalidated(listener) {
    this.invalidationListeners.add(listener);
    return { dispose: () => this.invalidationListeners.delete(listener) };
  }
  async invalidate(binding, reason) {
    for (const listener of [...this.invalidationListeners]) {
      await listener({
        accountId: binding.accountId,
        workspaceId: binding.workspaceId,
        reason
      });
    }
    await this.store.deleteTerminals?.(binding.accountId, binding.workspaceId);
  }
  acquireActivityLease(accountId, workspaceId) {
    const key = `${accountId}\0${workspaceId}`;
    const lease = { touchedAt: this.now(), disposed: false };
    const leases = this.activityLeases.get(key) || new Set();
    leases.add(lease);
    this.activityLeases.set(key, leases);
    return {
      touch: () => { if (!lease.disposed) lease.touchedAt = this.now(); },
      dispose: () => {
        if (lease.disposed) return;
        lease.disposed = true;
        leases.delete(lease);
        if (!leases.size) this.activityLeases.delete(key);
      }
    };
  }
  hasActivityLease(accountId, workspaceId) {
    return (this.activityLeases.get(`${accountId}\0${workspaceId}`)?.size || 0) > 0;
  }
  async listTools(request) {
    const binding = this.bindings.find((item) => item.accountId === request.principal?.userId);
    return binding ? SANDBOX_TOOL_DEFINITIONS.filter((item) => request.policy?.allowedTools?.includes(item.name)) : [];
  }
  async workspaceStatus(accountId) {
    const binding = this.bindings.find((item) => item.accountId === accountId);
    if (!binding) throw denied("sandbox_account_unbound");
    // Read the invocation aggregate without competing for lifecycle ownership.
    const snapshot = await this.store.workspace(accountId, binding.workspaceId);
    const instance = snapshot?.instance;
    let state = snapshot?.active ? "executing" : "not_created";
    if (instance && !snapshot?.active) {
      const info = await this.provider.inspect(instance.handle, instance.scope);
      state = info.state === "destroyed" ? "not_created" : info.state;
    }
    // Cloud inspection can race a new invocation or release. Never publish an
    // old instance's result as the state of its replacement.
    const current = await this.store.workspace(accountId, binding.workspaceId);
    const changed = current?.instance?.handle.sandboxId !== instance?.handle.sandboxId
      || Number(current?.epoch || 0) !== Number(snapshot?.epoch || 0);
    if (current?.active) state = "executing";
    else if (changed || snapshot?.active) state = current?.instance?.state || "not_created";
    return {
      workspaceId: binding.workspaceId,
      sandboxId: state === "not_created" ? null : current?.instance?.handle.sandboxId || current?.active?.handle?.sandboxId || null,
      state, epoch: Number(current?.epoch || 0),
      lastUsedAt: Number(current?.last_used_at || 0),
      idlePauseMs: this.idlePauseMs, idleDestroyMs: this.idleDestroyMs,
      activeInvocationCount: Number(current?.active_count || 0),
      ...(current?.active ? { activeInvocationId: current.active.invocationId, activeToolName: current.active.toolName } : {})
    };
  }
  async controlWorkspace(accountId, action) {
    const binding = this.bindings.find((item) => item.accountId === accountId);
    if (!binding || !["pause", "release"].includes(action)) throw denied("sandbox_workspace_control_denied");
    if (
      action === "pause"
      && this.hasActivityLease(binding.accountId, binding.workspaceId)
    ) {
      const error = new Error("Close active terminal connections before pausing the workspace");
      error.statusCode = 409;
      error.failureCode = "sandbox_workspace_busy";
      throw error;
    }
    return this.store.withWorkspace(accountId, binding.workspaceId, async (tx) => {
      await this.recover(tx);
      await this.recoverOperations(tx, { required: true });
      if (
        action === "pause"
        && this.hasActivityLease(binding.accountId, binding.workspaceId)
      ) {
        const error = new Error("Close active terminal connections before pausing the workspace");
        error.statusCode = 409;
        error.failureCode = "sandbox_workspace_busy";
        throw error;
      }
      const instance = tx.state.instance;
      if (!instance) return { state: "not_created", workspaceId: binding.workspaceId };
      const info = await this.provider.inspect(instance.handle, instance.scope);
      if (action === "release" || info.state === "destroyed" || !this.provider.supportsPause) {
        await this.invalidate(binding, action === "release" ? "workspace-released" : "workspace-destroyed");
        await this.terminate(instance.handle, instance.scope);
        await tx.instance(null);
        return { state: "destroyed", workspaceId: binding.workspaceId };
      }
      if (info.state === "running") await this.provider.pause(instance.handle, instance.scope);
      if ((await this.provider.inspect(instance.handle, instance.scope)).state !== "paused") throw new Error("Sandbox pause not confirmed");
      await tx.instance({ ...instance, state: "paused" });
      return { state: "paused", sandboxId: instance.handle.sandboxId, workspaceId: binding.workspaceId };
    });
  }
  async terminate(handle, scope) {
    await this.provider.destroy(handle, scope);
    if ((await this.provider.inspect(handle, scope)).state !== "destroyed") throw new Error("Sandbox termination unconfirmed");
  }
  async recover(tx) {
    const active = tx.state.active;
    if (!active) return;
    const handles = active.handle ? [active.handle] : await this.provider.findCreated(active.scope, active.requestKey);
    // Empty list is not proof that a timed-out create never reached the cloud.
    if (!handles.length) throw new Error("Sandbox creation outcome remains unknown; operator reconciliation required");
    await this.invalidate({
      accountId: tx.state.account_id,
      workspaceId: tx.state.workspace_id
    }, "runtime-recovery");
    for (const handle of handles) await this.terminate(handle, active.scope);
    await tx.instance(null);
    const previous = await tx.get(active.invocationId);
    await tx.finish(active.invocationId, previous?.result || unknownToolOutcomeResult({
      invocationId: active.invocationId, toolCall: { name: active.toolName }
    }, "runtime-recovery"));
  }
  async recoverOperations(tx, { required = false } = {}) {
    for (const row of await tx.activeOperations()) {
      const recovered = await tx.claimOperation(row.invocation_id, async () => {
        // Reload after claiming: the previous owner may just have committed.
        const latest = await tx.get(row.invocation_id);
        if (!latest?.active) return;
        const active = latest.active;
        let stopped = !active.dispatched;
        if (!stopped) {
          try { stopped = await this.provider.stopExecution(active.handle, active.scope, active.execution); }
          catch (error) { this.onError(error); }
        }
        await tx.finish(row.invocation_id, latest.result || unknownToolOutcomeResult({
          invocationId: row.invocation_id, toolCall: { name: active.toolName }
        }, "runtime-recovery"), { clear: stopped });
        if (stopped && active.execution?.kind === "pty" && active.execution.sessionId) {
          await this.store.deleteTerminal(tx.state.account_id, tx.state.workspace_id, active.execution.sessionId);
        }
        // A live independent invocation can proceed concurrently. Once an
        // orphan has been claimed, its unresolved process must fence new work.
        if (!stopped) throw Object.assign(new Error("Sandbox 正在恢复上一条命令，请稍后重试。"), {
          code: "sandbox_recovery_pending", outcomeKnown: true,
          toolDispatchState: "not_sent", retryable: true, statusCode: 503
        });
      });
      if (required && !recovered) throw Object.assign(new Error("Sandbox 仍有命令正在执行，请稍后重试。"), {
        code: "sandbox_workspace_busy", outcomeKnown: true,
        toolDispatchState: "not_sent", retryable: true, statusCode: 409
      });
    }
  }
  async prepareWorkspace(binding, invocation, signal, bindingHash) {
    return this.store.withWorkspace(binding.accountId, binding.workspaceId, async (tx) => {
      await this.recover(tx);
      await this.recoverOperations(tx, { required: true });
      signal.throwIfCancelled();
      // Recovery may have completed this invocation's durable unknown receipt.
      // Return to the execution claim to validate/replay it before provisioning.
      if ((await tx.get(invocation.invocationId))?.result) return;
      let instance = tx.state.instance;
      let info = instance && await this.provider.inspect(instance.handle, instance.scope);
      if (info?.state === "destroyed") {
        await this.invalidate(binding, "provider-destroyed");
        await tx.instance(null);
        instance = null;
      }
      if (instance?.ready && info?.state === "running") return;
      const scope = instance?.scope || {
        accountId: binding.accountId, workspaceId: binding.workspaceId,
        attemptId: `instance:${randomUUID()}`, epoch: Number(tx.state.epoch) + 1
      };
      const requestKey = instance?.handle.requestKey || createHash("sha256").update(invocation.invocationId).digest("hex");
      const active = {
        scope, requestKey, invocationId: `sandbox-prepare:${randomUUID()}`,
        toolName: "workspacePrepare", ...(instance ? { handle: instance.handle } : {})
      };
      await tx.begin(active, fingerprint({ scope, requestKey }));
      let handle = instance?.handle;
      let interrupt;
      const cancelled = new Promise((_, reject) => { interrupt = () => reject(new Error("Sandbox initialization cancelled")); });
      const subscription = signal.onCancel(interrupt);
      // Observe cancellation even if create is still awaiting its cloud ACK.
      cancelled.catch(() => {});
      try {
        if (!handle) {
          handle = await this.provider.create(scope, requestKey, {
            ...binding, autoPause: this.provider.supportsPause,
            timeoutMs: this.provider.supportsPause ? 600000 : this.idlePauseMs + 90000
          });
          await tx.handle(handle);
          await tx.instance({ handle, scope, state: "running", ready: false });
        } else if (info.state === "paused") await this.provider.resume(handle, scope);
        signal.throwIfCancelled();
        await Promise.race([this.provider.prepareEnvironment(handle, scope), cancelled]);
        await tx.assertOwned();
        await tx.instance({ handle, scope, state: "running", ready: true,
          resourceEpoch: `resource:${randomUUID()}` });
        await tx.used(this.now());
        await tx.finish(active.invocationId, { ok: true, content: "Workspace ready" });
      } catch (error) {
        let stopped = false;
        if (handle) {
          try {
            await this.invalidate(binding, "workspace-initialization-failed");
            await this.terminate(handle, scope);
            await tx.instance(null);
            stopped = true;
          } catch {}
        }
        const result = unknownToolOutcomeResult(invocation, signal.reason || "sandbox-initialization-error");
        await tx.finish(active.invocationId, result, { clear: stopped });
        return result;
      } finally { subscription.dispose(); }
    }, bindingHash);
  }
  async prepareExtensionHost(context, signal) {
    const invocation = await this.authorizeInvocation({
      ...context, target: undefined, invocationId: `host-resource:${randomUUID()}`,
      toolCall: { id: "host-resource", name: "Bash", arguments: { command: "true", timeout: 1000 } }
    });
    if (invocation.principal?.spaceId !== this.store.spaceId
      || invocation.policy.preset !== "trusted-automation"
      || !invocation.policy.allowedTools.includes("Bash")
      || invocation.policy.allowedCommandPrefixes?.length) throw denied("sandbox_host_denied");
    const binding = this.bindingForAccount(invocation.principal.userId);
    if (!binding) throw denied("sandbox_account_unbound");
    const hash = fingerprint({ storageMetadata: binding.storageMetadata, storageNetwork: binding.storageNetwork });
    const result = await this.prepareWorkspace(binding, invocation, signal, hash);
    if (result?.ok === false) throw Object.assign(new Error(result.content), { code: result.failureCode });
    const state = await this.store.workspace(binding.accountId, binding.workspaceId);
    return state.instance.resourceEpoch || `resource:${state.instance.handle.sandboxId}:${state.epoch}`;
  }
  start() {
    this.timer = setInterval(() => {
      if (!this.maintenance) {
        this.maintenance = this.sweep().catch(this.onError).finally(() => { this.maintenance = null; });
      }
    }, this.maintenanceIntervalMs);
    this.timer.unref();
  }
  async sweep({ pauseAll = false, destroyAll = false } = {}) {
    for (const row of await this.store.workspaces()) {
      if (!pauseAll && !destroyAll && !row.active) {
        const idle = this.now() - Number(row.last_used_at);
        if (this.hasActivityLease(row.account_id, row.workspace_id)
          || idle < this.idlePauseMs
          || (row.instance?.state === "paused" && idle < this.idleDestroyMs)) continue;
      }
      try { await this.store.withWorkspace(row.account_id, row.workspace_id, async (tx) => {
        await this.recover(tx);
        await this.recoverOperations(tx, { required: true });
        const instance = tx.state.instance;
        if (!instance) return;
        if (this.hasActivityLease(row.account_id, row.workspace_id)) return;
        const idle = this.now() - Number(tx.state.last_used_at);
        if (!pauseAll && !destroyAll && (idle < this.idlePauseMs
          || (instance.state === "paused" && idle < this.idleDestroyMs))) return;
        const info = await this.provider.inspect(instance.handle, instance.scope);
        if (info.state === "destroyed") {
          await this.invalidate({
            accountId: row.account_id,
            workspaceId: row.workspace_id
          }, "provider-destroyed");
          await tx.instance(null);
        } else if (destroyAll || idle >= this.idleDestroyMs
          || (!this.provider.supportsPause && (pauseAll || idle >= this.idlePauseMs))) {
          await this.invalidate({
            accountId: row.account_id,
            workspaceId: row.workspace_id
          }, destroyAll ? "runtime-shutdown" : "workspace-recycled");
          await this.terminate(instance.handle, instance.scope);
          await tx.instance(null);
        } else if (pauseAll || idle >= this.idlePauseMs) {
          if (info.state === "running") await this.provider.pause(instance.handle, instance.scope);
          const paused = await this.provider.inspect(instance.handle, instance.scope);
          if (paused.state !== "paused") throw new Error("Sandbox pause not confirmed");
          await tx.instance({ ...instance, state: "paused" });
        }
      }); } catch (error) {
        if (pauseAll || destroyAll) throw error;
        this.onError(error);
      }
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const cancel of this.pending.values()) cancel();
    await Promise.allSettled([...this.pending.keys()]);
    await this.maintenance;
    await this.sweep({ pauseAll: true });
  }
  async invoke(input, signal, operation = null, requestBinding = null) {
    if (this.closing) throw new Error("Sandbox broker is stopping");
    const controller = new AbortController();
    let reason;
    const listeners = new Set();
    const cancel = (value) => {
      if (controller.signal.aborted) return;
      reason = String(value);
      controller.abort();
      for (const listener of listeners) {
        try { listener(reason); } catch {}
      }
    };
    const linked = {
      get cancelled() { return controller.signal.aborted; },
      get reason() { return reason; },
      throwIfCancelled() { if (controller.signal.aborted) throw new Error(`Sandbox cancelled: ${reason}`); },
      onCancel(listener) {
        if (controller.signal.aborted) listener(reason);
        else listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    };
    const parent = signal.onCancel(cancel);
    const completion = this.invokeAuthorized(input, linked, operation, requestBinding);
    this.pending.set(completion, () => cancel("runtime-shutdown"));
    try { return await completion; }
    finally { parent.dispose(); this.pending.delete(completion); }
  }
  async invokeAuthorized(input, signal, operation = null, requestBinding = null) {
    const invocation = await this.authorizeInvocation(input);
    const requestedName = invocation.toolCall?.name;
    const name = ALIASES[requestedName] || requestedName;
    const args = invocation.toolCall?.arguments || {};
    if (!this.supportedToolNames.includes(name) || !invocation.policy.allowedTools.includes(requestedName)) throw denied("sandbox_tool_denied");
    if (invocation.principal?.spaceId !== this.store.spaceId) throw denied("sandbox_space_mismatch");
    if (invocation.target || args.node_id || args.resource_id || args.session_id) throw denied("sandbox_device_target_denied");
    const binding = this.bindings.find((item) => item.accountId === invocation.principal?.userId);
    if (!binding) throw denied("sandbox_account_unbound");
    if (name === "Bash" && invocation.policy.preset !== "trusted-automation") throw denied("sandbox_command_denied");
    if ((name === "write" || name === "edit")
      && !["workspace-write", "trusted-automation"].includes(invocation.policy.preset)) throw denied("sandbox_write_denied");
    if (name === "Bash" && invocation.policy.allowedCommandPrefixes?.length) throw denied("sandbox_command_policy_restricted");
    if (name === "Bash" && (typeof args.command !== "string" || !args.command
      || Buffer.byteLength(args.command) > 32000 || (args.timeout != null && (!Number.isInteger(args.timeout) || args.timeout < 1 || args.timeout > LOCAL_TOOLS_BASH_MAX_TIMEOUT_MS)))) {
      throw new Error("Invalid sandbox command or timeout");
    }
    if (FILE_TOOLS.has(name) && args.path == null && ["glob", "grep", "tree"].includes(name)) args.path = "/workspace";
    if (FILE_TOOLS.has(name)) {
      try { canonicalSandboxPath(args.path); }
      catch { throw denied("sandbox_invalid_path"); }
      if (!sandboxPathWithinRoots(args.path, invocation.policy.fileRoots)) throw denied("sandbox_path_outside_grant");
    }
    if (name === "write" && (
      typeof args.content !== "string"
      || Buffer.byteLength(args.content) > MAX_FILE_BYTES
    )) {
      throw new Error("Invalid sandbox content");
    }
    if (name === "edit" && (typeof args.old_string !== "string" || !args.old_string
      || typeof args.new_string !== "string"
      || Buffer.byteLength(args.new_string) > MAX_FILE_BYTES)) {
      throw new Error("Invalid edit strings");
    }
    for (const field of ["offset", "limit", "max_depth"]) {
      if (args[field] != null && (!Number.isSafeInteger(args[field]) || args[field] < 0 || args[field] > 100000)) throw new Error(`Invalid ${field}`);
    }
    signal.throwIfCancelled();
    const hash = fingerprint({
      runId: invocation.runId,
      accountId: binding.accountId,
      workspaceId: binding.workspaceId,
      name,
      args,
      ...(requestBinding ? { requestBinding } : {})
    });
    const bindingHash = fingerprint({ storageMetadata: binding.storageMetadata, storageNetwork: binding.storageNetwork });
    for (;;) {
      signal.throwIfCancelled();
      const result = await this.store.withExecution(binding.accountId, binding.workspaceId, invocation.invocationId, async (tx) => {
      if (tx.state.active) return PREPARE_WORKSPACE;
      await this.recoverOperations(tx);
      const existing = await tx.get(invocation.invocationId);
      if (existing) {
        if (existing.request_hash !== hash || existing.account_id !== binding.accountId || existing.workspace_id !== binding.workspaceId) throw denied("sandbox_invocation_conflict");
        return existing.result;
      }
      if (["Bash", "write", "edit"].includes(name) && await tx.findUnknown(hash)) {
        return unknownToolOutcomeResult(invocation, "duplicate-operation-after-unknown-outcome");
      }
      const instance = tx.state.instance;
      if (!instance?.ready || (await this.provider.inspect(instance.handle, instance.scope)).state !== "running") return PREPARE_WORKSPACE;
      const { scope, handle } = instance;
      const execution = { id: randomUUID() };
      const active = {
        scope, handle, execution, invocationId: invocation.invocationId,
        toolName: name, dispatched: false
      };
      await tx.begin(active, hash);
      let result;
      let stopped = false;
      let cancelExecution;
      const cancelled = new Promise((resolve) => { cancelExecution = resolve; });
      const executionSignal = {
        get cancelled() { return signal.cancelled || ownershipLost; },
        get reason() { return signal.reason || (ownershipLost ? "sandbox-ownership-lost" : ""); },
        throwIfCancelled() {
          signal.throwIfCancelled();
          if (ownershipLost) throw new Error("Sandbox ownership lost");
        },
        onCancel(listener) {
          const subscription = signal.onCancel(listener);
          ownershipListeners.add(listener);
          return { dispose() { subscription.dispose(); ownershipListeners.delete(listener); } };
        }
      };
      let ownershipLost = false;
      const ownershipListeners = new Set();
      const subscription = signal.onCancel(() => cancelExecution(null));
      let ownershipProbe;
      let heartbeat;
      try {
        await this.provider.touch(handle, scope, this.provider.supportsPause ? 600000 : this.idlePauseMs + 90000);
        await tx.assertOwned();
        heartbeat = setInterval(() => {
          if (!ownershipProbe) {
            ownershipProbe = Promise.resolve().then(() => tx.assertOwned())
              .catch(() => {
                ownershipLost = true;
                cancelExecution(null);
                for (const listener of ownershipListeners) {
                  try { listener("sandbox-ownership-lost"); } catch {}
                }
              }).finally(() => { ownershipProbe = null; });
          }
        }, 2000);
        heartbeat.unref();
        executionSignal.throwIfCancelled();
        // Revocation during creation/resume still applies before dispatch.
        const currentAuthorization = await this.authorizeInvocation(invocation);
        if (FILE_TOOLS.has(name) && !sandboxPathWithinRoots(args.path, currentAuthorization.policy.fileRoots)) {
          throw Object.assign(denied("sandbox_path_outside_grant"), { outcomeKnown: true });
        }
        if (name === "Bash" && (currentAuthorization.policy.preset !== "trusted-automation"
          || currentAuthorization.policy.allowedCommandPrefixes?.length)) {
          throw Object.assign(denied("sandbox_command_denied"), { outcomeKnown: true });
        }
        if (["write", "edit"].includes(name)
          && !["workspace-write", "trusted-automation"].includes(currentAuthorization.policy.preset)) {
          throw Object.assign(denied("sandbox_write_denied"), { outcomeKnown: true });
        }
        let command = "";
        if (!operation) {
          if (name === "Bash") {
            const encoded = Buffer.from(args.command).toString("base64");
            command = `cd /workspace && eval "$(printf '%s' '${encoded}' | base64 -d)"`;
          } else {
            const fileRoots = currentAuthorization.policy.fileRoots;
            command = workspaceFileCommand(name, args, { fileRoots });
            if (Buffer.byteLength(command) > 32_000) {
              const payloadPath = `/tmp/zion-workspace-${randomUUID()}.json`;
              await this.provider.writeTemporary(
                handle,
                scope,
                payloadPath,
                JSON.stringify({ ...args, name, fileRoots })
              );
              command = workspaceFileCommand(name, {}, { payloadPath, fileRoots });
            }
          }
        }
        executionSignal.throwIfCancelled();
        if (!operation) {
          active.dispatched = true;
          await tx.execution(execution);
        }
        const dispatched = operation
            ? operation({ handle, scope, tx, signal: executionSignal, invocation, binding,
                markDispatched: async (identity) => {
                  active.dispatched = true;
                  await tx.execution(identity);
                }
              })
            : this.provider.exec(handle, scope, {
                command,
                execution,
                signal: executionSignal,
                onStarted: (identity) => tx.execution(identity),
                timeoutMs: args.timeout || (name === "Bash" ? LOCAL_TOOLS_BASH_DEFAULT_TIMEOUT_MS : 60000),
                internal: name !== "Bash",
                maxOutputBytes: args._plugin_data
                  ? MAX_FILE_BYTES + 512 * 1024
                  : 1024 * 1024
              });
        // PTY callbacks observe the linked signal themselves and must finish
        // their bounded startup before ownership is released.
        const output = operation ? await dispatched : await Promise.race([dispatched, cancelled]);
        if (!output) throw new Error("cancelled");
        let content = output.stdout || output.stderr || "Done";
        if (requestedName === "sandboxRead" && output.exitCode === 0) {
          try { content = JSON.parse(output.stdout).content; } catch {}
        }
        result = executionSignal.cancelled ? unknownToolOutcomeResult(invocation, executionSignal.reason) : {
          ok: output.exitCode === 0, content,
          executionTarget: { workspaceId: binding.workspaceId, sandboxId: handle.sandboxId, epoch: scope.epoch },
          ...(output.exitCode !== 0 ? { error: output.stderr, failureCode: "tool_error", retryable: false } : {})
        };
      } catch (error) {
        if (error?.outcomeKnown === true || !active.dispatched) {
          result = {
            ok: false,
            content: error.message,
            error: error.message,
            failureCode: String(error.failureCode || error.code || "tool_error"),
            retryable: error.retryable === true,
            ...(!active.dispatched || error.toolDispatchState === "not_sent"
              ? { toolDispatchState: "not_sent" } : {})
          };
        } else {
          const code = /^[a-z_]{1,80}$/.test(String(error?.code || ""))
            ? error.code
            : "sandbox-transport-or-storage-error";
          result = unknownToolOutcomeResult(invocation, executionSignal.reason || code);
        }
      } finally {
        clearInterval(heartbeat);
        subscription.dispose();
        await ownershipProbe;
        if (result?.failureCode === "execution_outcome_unknown") {
          stopped = !active.dispatched;
          if (!stopped) {
            try { stopped = await this.provider.stopExecution(handle, scope, active.execution); }
            catch (error) { this.onError(error); }
          }
          if (stopped && active.execution?.kind === "pty" && active.execution.sessionId) {
            await this.store.deleteTerminal(binding.accountId, binding.workspaceId, active.execution.sessionId);
          }
        }
      }
      await tx.used(this.now());
      await tx.finish(invocation.invocationId, result, {
        clear: result?.failureCode !== "execution_outcome_unknown" || stopped
      });
      return result;
      }, bindingHash, signal);
      if (result === PREPARE_WORKSPACE) {
        const prepared = await this.prepareWorkspace(binding, invocation, signal, bindingHash);
        if (prepared?.failureCode && prepared.failureCode !== "sandbox_workspace_busy") return prepared;
      } else if (result?.failureCode !== "sandbox_workspace_busy") {
        return result;
      }
      // Cold create/resume is brief lifecycle coordination, never a global
      // rejection of a second session's ordinary execution.
      await delay(25);
    }
  }
}
