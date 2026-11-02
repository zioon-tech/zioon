import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  machineReference,
  parseTerminalReference,
  terminalReference
} from "../../../../packages/node-protocol/src/resource-references.mjs";
import { managedNodeIdentity } from "./managed-node-router.mjs";
import { canonicalSandboxPath } from "../../../../packages/sandbox/src/paths.mjs";

const MAX_CHANNEL_QUEUE_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

function principalAccountId(principal) {
  return String(principal?.userId || principal?.user?.id || "");
}

function noCancellation() {
  return {
    cancelled: false,
    reason: "",
    throwIfCancelled() {},
    onCancel() {
      return { dispose() {} };
    }
  };
}

function canonicalWorkspacePath(value, fallback = "/workspace") {
  const path = String(value || fallback);
  try { canonicalSandboxPath(path); }
  catch {
    throw Object.assign(
      new Error("Terminal cwd must be a canonical absolute path in the sandbox"),
      { statusCode: 400 }
    );
  }
  return path;
}

function sandboxInstanceId(instance) {
  if (!instance?.handle?.sandboxId || !Number.isSafeInteger(Number(instance?.scope?.epoch))) {
    return "";
  }
  return `sandbox:${instance.handle.sandboxId}:${Number(instance.scope.epoch)}`;
}

function terminalError(statusCode, code, message = code) {
  return Object.assign(new Error(message), {
    statusCode,
    code,
    failureCode: code,
    outcomeKnown: true,
    retryable: ["terminal_session_busy"].includes(code)
  });
}

function jsonBody(body) {
  if (!body?.length) return {};
  return JSON.parse(Buffer.from(body).toString("utf8"));
}

export class SandboxTerminalService {
  constructor({
    sandbox,
    provider,
    store,
    authorizeActor,
    withLifecycleGrant,
    now = () => Date.now(),
    channelIdleMs = 45_000,
    maxChannels = 8
  } = {}) {
    if (!sandbox?.invoke || !provider || !store) {
      throw new Error("Sandbox Terminal service requires sandbox, provider, and store");
    }
    if (!authorizeActor || !withLifecycleGrant) {
      throw new Error("Sandbox Terminal service requires account authorization");
    }
    this.sandbox = sandbox;
    this.provider = provider;
    this.store = store;
    this.authorizeActor = authorizeActor;
    this.withLifecycleGrant = withLifecycleGrant;
    this.now = now;
    this.channelIdleMs = channelIdleMs;
    this.maxChannels = maxChannels;
    this.channels = new Map();
    this.sessionLocks = new Set();
    this.invalidation = sandbox.onInstanceInvalidated((event) =>
      this.closeWorkspaceChannels(event.accountId, event.workspaceId)
    );
    this.timer = setInterval(() => this.pruneChannels(), 10_000);
    this.timer.unref();
  }

  identityForPrincipal(principal) {
    const accountId = principalAccountId(principal);
    const binding = this.sandbox.bindingForAccount(accountId);
    if (!binding) throw terminalError(403, "sandbox_account_unbound");
    return {
      accountId,
      binding,
      ...managedNodeIdentity(principal?.spaceId || principal?.space?.id, binding)
    };
  }

  async authorize(runContext = {}) {
    const principal = await this.authorizeActor(runContext);
    return {
      principal,
      ...this.identityForPrincipal(principal)
    };
  }

  async lifecycle(runContext, purpose, operation) {
    return await this.withLifecycleGrant(runContext, async ({
      principal,
      policy
    }) => {
      const id = `sandbox-terminal:${purpose}:${randomUUID()}`;
      const result = await this.sandbox.invoke({
        invocationId: id,
        runId: id,
        attemptId: id,
        principal,
        policy,
        toolCall: {
          id,
          name: "Bash",
          arguments: {
            command: `: zion-${purpose}`,
            timeout: 60_000
          }
        }
      }, runContext.signal || noCancellation(), operation, { purpose });
      if (!result?.ok) {
        throw terminalError(
          result?.failureCode === "sandbox_workspace_busy" ? 409 : 502,
          result?.failureCode || "sandbox_terminal_operation_failed",
          result?.error || result?.content || "Sandbox terminal operation failed"
        );
      }
      try {
        return JSON.parse(result.content);
      } catch {
        throw terminalError(502, "sandbox_terminal_invalid_result");
      }
    });
  }

  async workspaceState(identity) {
    return await this.store.workspace(
      identity.accountId,
      identity.binding.workspaceId
    );
  }

  sessionView(identity, terminal) {
    const id = terminalReference({
      nodeId: identity.nodeId,
      instanceId: terminal.instanceId,
      resourceId: identity.resourceId,
      sessionId: terminal.id
    });
    return {
      id,
      session_id: id,
      nativeSessionId: terminal.id,
      type: "local",
      cwd: terminal.cwd,
      initial_cwd: terminal.cwd,
      active: terminal.active !== false,
      created_at: terminal.createdAt,
      updated_at: terminal.lastActivityAt,
      last_activity: terminal.lastActivityAt,
      nodeId: identity.nodeId,
      nodeLabel: "Cloud workspace",
      resourceId: identity.resourceId
    };
  }

  async currentTerminals(identity) {
    const state = await this.workspaceState(identity);
    const instanceId = sandboxInstanceId(state?.instance);
    const rows = await this.store.terminals(
      identity.accountId,
      identity.binding.workspaceId
    );
    if (!instanceId) {
      if (rows.length) {
        await this.store.deleteTerminals(
          identity.accountId,
          identity.binding.workspaceId
        );
      }
      return { state, terminals: [] };
    }
    const terminals = [];
    for (const row of rows) {
      const terminal = row.data;
      if (
        terminal?.instanceId === instanceId
        && terminal?.sandboxId === state.instance.handle.sandboxId
        && Number(terminal?.epoch) === Number(state.instance.scope.epoch)
      ) {
        terminals.push(terminal);
      } else {
        await this.store.deleteTerminal(
          identity.accountId,
          identity.binding.workspaceId,
          row.id
        );
      }
    }
    return { state, terminals };
  }

  async listInventory({ runContext = {} } = {}) {
    const identity = await this.authorize(runContext);
    const workspace = await this.sandbox.workspaceStatus(identity.accountId);
    const { terminals } = workspace.state === "not_created"
      ? { terminals: [] }
      : await this.currentTerminals(identity);
    const status = workspace.state === "not_created" || workspace.state === "paused" ? "ready" : "online";
    return {
      sessions: terminals.map((terminal) =>
        this.sessionView(identity, terminal)
      ),
      machines: [{
        id: machineReference(identity.nodeId, "machine:local"),
        name: "Cloud workspace",
        kind: "local",
        nodeId: identity.nodeId,
        nodeLabel: "Cloud workspace",
        status, managed: true,
        workspaceState: workspace.state,
        description: "Managed isolated workspace with persistent files and personal HOME."
      }],
      nodes: [{
        nodeId: identity.nodeId,
        label: "Cloud workspace",
        resourceId: identity.resourceId,
        status, managed: true,
        workspaceState: workspace.state
      }]
    };
  }

  async resolveSession(sessionId, runContext = {}, { authorize = true } = {}) {
    const identity = authorize
      ? await this.authorize(runContext)
      : this.identityForPrincipal(runContext.principal);
    const reference = parseTerminalReference(sessionId);
    if (
      !reference
      || reference.nodeId !== identity.nodeId
      || reference.resourceId !== identity.resourceId
    ) {
      throw terminalError(404, "terminal_not_managed");
    }
    const { state, terminals } = await this.currentTerminals(identity);
    const terminal = terminals.find((item) => item.id === reference.sessionId);
    if (
      !terminal
      || reference.instanceId !== terminal.instanceId
      || sandboxInstanceId(state?.instance) !== reference.instanceId
    ) {
      throw terminalError(
        409,
        "stale_terminal_reference",
        "Stale terminal reference; refresh terminalInventory. This operation was not dispatched."
      );
    }
    return { identity, reference, terminal, instance: state.instance };
  }

  async validateSessionReference(sessionId, runContext = {}) {
    return await this.resolveSession(sessionId, runContext, {
      authorize: false
    });
  }

  isManagedSession(sessionId, principal) {
    const reference = parseTerminalReference(sessionId);
    if (!reference) return false;
    try {
      const identity = this.identityForPrincipal(principal);
      return reference.nodeId === identity.nodeId
        && reference.resourceId === identity.resourceId;
    } catch {
      return false;
    }
  }

  isManagedNode(nodeId, principal) {
    try {
      return this.identityForPrincipal(principal).nodeId === String(nodeId || "");
    } catch {
      return false;
    }
  }

  async createSession({ payload = {}, runContext = {} } = {}) {
    const identity = await this.authorize(runContext);
    if (payload.type && payload.type !== "local") {
      throw terminalError(400, "managed_terminal_local_only");
    }
    if (payload.node_id && payload.node_id !== identity.nodeId) {
      throw terminalError(403, "terminal_target_conflict");
    }
    if (payload.resource_id && payload.resource_id !== identity.resourceId) {
      throw terminalError(403, "terminal_target_conflict");
    }
    const cwd = canonicalWorkspacePath(
      payload.initial_cwd || payload.cwd,
      "/workspace"
    );
    const terminal = await this.lifecycle(
      runContext,
      "create",
      async ({ handle, scope, signal, markDispatched }) => {
        signal.throwIfCancelled();
        const connection = await this.provider.openPty(handle, scope, {
          cols: Math.max(1, Number(payload.cols) || 80),
          rows: Math.max(1, Number(payload.rows) || 24),
          cwd,
          onData() {}
        });
        const pid = Number(connection?.pid);
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          try { await connection?.disconnect?.(); } catch {}
          throw new Error("Sandbox PTY returned an invalid pid");
        }
        await connection.disconnect?.();
        const terminalId = `terminal:${randomUUID()}`;
        try {
          signal.throwIfCancelled();
          await markDispatched({
            ...await this.provider.ptyExecution(handle, scope, pid),
            sessionId: terminalId
          });
        } catch (error) {
          await this.provider.ptyKill(handle, scope, pid);
          throw error;
        }
        const timestamp = this.now();
        const record = {
          id: terminalId,
          pid,
          epoch: Number(scope.epoch),
          sandboxId: handle.sandboxId,
          instanceId: sandboxInstanceId({ handle, scope }),
          cwd,
          active: true,
          createdAt: timestamp,
          lastActivityAt: timestamp
        };
        await this.store.saveTerminal(
          identity.accountId,
          identity.binding.workspaceId,
          record
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify(record),
          stderr: ""
        };
      }
    );
    return this.sessionView(identity, terminal);
  }

  async getSession({ sessionId, runContext = {} } = {}) {
    const { identity, terminal } = await this.resolveSession(
      sessionId,
      runContext
    );
    return this.sessionView(identity, terminal);
  }

  assertPinnedSession(context, resolved) {
    if (
      context.handle.sandboxId !== resolved.terminal.sandboxId
      || Number(context.scope.epoch) !== Number(resolved.terminal.epoch)
      || sandboxInstanceId(context) !== resolved.reference.instanceId
    ) {
      throw terminalError(
        409,
        "stale_terminal_reference",
        "The sandbox instance changed before the terminal operation started."
      );
    }
  }

  async closeSession({ sessionId, runContext = {} } = {}) {
    const resolved = await this.resolveSession(sessionId, runContext);
    await this.lifecycle(runContext, "close", async (context) => {
      this.assertPinnedSession(context, resolved);
      await this.closeSessionChannels(
        resolved.identity.accountId,
        resolved.identity.binding.workspaceId,
        resolved.terminal.id
      );
      await this.provider.ptyKill(
        context.handle,
        context.scope,
        resolved.terminal.pid
      );
      await this.store.deleteTerminal(
        resolved.identity.accountId,
        resolved.identity.binding.workspaceId,
        resolved.terminal.id
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ closed: true }),
        stderr: ""
      };
    });
    return { closed: true, session_id: sessionId };
  }

  async reactivateSession({ sessionId, runContext = {} } = {}) {
    const { identity, terminal } = await this.resolveSession(
      sessionId,
      runContext
    );
    return this.sessionView(identity, terminal);
  }

  async setSessionCwd({ sessionId, cwd, runContext = {} } = {}) {
    const nextCwd = canonicalWorkspacePath(cwd);
    await this.executeHttpCommand({
      sessionId,
      command: `cd -- '${nextCwd.replaceAll("'", `'\"'\"'`)}'`,
      timeoutMs: 30_000,
      runContext
    });
    return { updated: true, session_id: sessionId, cwd: nextCwd };
  }

  async executeHttpCommand({
    sessionId,
    command,
    timeoutMs = 60_000,
    runContext = {}
  }) {
    const resolved = await this.resolveSession(sessionId, runContext);
    return await this.lifecycle(runContext, "exec", async (context) => {
      this.assertPinnedSession(context, resolved);
      const output = await this.executeToolCommand({
        ...context,
        sessionId,
        command,
        timeoutMs,
        resolved
      });
      return {
        ...output,
        stdout: JSON.stringify({
          output: output.stdout,
          exit_code: output.exitCode
        })
      };
    });
  }

  async executeToolCommand({
    handle,
    scope,
    sessionId,
    command,
    timeoutMs = 60_000,
    resolved = null,
    signal = noCancellation(),
    markDispatched = async () => {}
  }) {
    const current = resolved || await this.validateSessionReference(
      sessionId,
      {
        principal: {
          userId: scope.accountId,
          spaceId: this.store.spaceId
        }
      }
    );
    this.assertPinnedSession({ handle, scope }, current);
    const lockKey = `${current.identity.accountId}\0${current.terminal.id}`;
    if (this.sessionLocks.has(lockKey)) {
      throw terminalError(
        409,
        "terminal_session_busy",
        "The terminal is executing another model command."
      );
    }
    if (
      typeof command !== "string"
      || !command
      || Buffer.byteLength(command) > 32_000
    ) {
      throw terminalError(400, "invalid_terminal_command");
    }
    this.sessionLocks.add(lockKey);
    const marker = randomUUID().replaceAll("-", "");
    const start = `__ZION_START_${marker}__`;
    const end = `__ZION_END_${marker}__`;
    const encoded = Buffer.from(command).toString("base64");
    let connection;
    let timer;
    let execution;
    let dispatched = false;
    let outputKnown = false;
    let terminalStopped = false;
    let settled = false;
    let buffered = Buffer.alloc(0);
    let finish;
    const completed = new Promise((resolve, reject) => {
      finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
    });
    completed.catch(() => {});
    const subscription = signal.onCancel(() => finish(Object.assign(
      new Error("Terminal command cancelled; execution outcome is unknown"),
      { code: "execution_outcome_unknown" }
    )));
    const onData = (chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      buffered = Buffer.concat([buffered, bytes]);
      if (buffered.length > MAX_COMMAND_OUTPUT_BYTES) {
        finish(new Error("Terminal command output exceeded the size limit"));
        return;
      }
      const text = buffered.toString("utf8");
      const startIndex = text.indexOf(`${start}\r\n`);
      const fallbackStart = text.indexOf(`${start}\n`);
      const contentStart = startIndex >= 0
        ? startIndex + start.length + 2
        : fallbackStart >= 0
          ? fallbackStart + start.length + 1
          : -1;
      if (contentStart < 0) return;
      const suffix = text.slice(contentStart);
      const match = suffix.match(
        new RegExp(`\\r?\\n${end}:(\\d+):([A-Za-z0-9+/=]*)\\r?\\n`)
      );
      if (!match) return;
      const output = suffix.slice(0, match.index).replace(/\r\n/g, "\n");
      let cwd = current.terminal.cwd;
      try {
        cwd = Buffer.from(match[2], "base64")
          .toString("utf8")
          .replace(/\r?\n$/, "") || cwd;
      } catch {}
      try {
        cwd = canonicalWorkspacePath(cwd);
      } catch (error) {
        finish(error);
        return;
      }
      finish(null, {
        exitCode: Number(match[1]),
        stdout: output,
        stderr: "",
        cwd
      });
    };
    try {
      signal.throwIfCancelled();
      connection = await this.provider.openPty(handle, scope, {
        pid: current.terminal.pid,
        onData
      });
      execution = await this.provider.ptyExecution(handle, scope, current.terminal.pid);
      execution.sessionId = current.terminal.id;
      signal.throwIfCancelled();
      await markDispatched(execution);
      dispatched = true;
      await this.provider.ptyInput(
        handle,
        scope,
        current.terminal.pid,
        "stty -echo\n"
      );
      await delay(30);
      signal.throwIfCancelled();
      const script = [
        `printf '\\n${start}\\n'`,
        `eval "$(printf '%s' '${encoded}' | base64 -d)"`,
        "__zion_code=$?",
        `printf '\\n${end}:%s:' \"$__zion_code\"`,
        "pwd | base64 | tr -d '\\n'",
        "printf '\\n'",
        "stty echo"
      ].join("; ");
      timer = setTimeout(() => {
        finish(Object.assign(
          new Error("Terminal command timed out; execution outcome is unknown"),
          { code: "execution_outcome_unknown" }
        ));
      }, Math.max(1, Math.min(60_000, Number(timeoutMs) || 60_000)));
      await this.provider.ptyInput(
        handle,
        scope,
        current.terminal.pid,
        `${script}\n`
      );
      const result = await completed;
      outputKnown = true;
      const updated = {
        ...current.terminal,
        cwd: result.cwd,
        lastActivityAt: this.now()
      };
      await this.store.saveTerminal(
        current.identity.accountId,
        current.identity.binding.workspaceId,
        updated
      );
      return result;
    } finally {
      clearTimeout(timer);
      subscription.dispose();
      if (dispatched && !outputKnown) {
        // Keep the terminal's command fence until targeted cleanup finishes.
        // Other terminal sessions in the same workspace remain independent.
        try {
          if (await this.provider.stopExecution(handle, scope, execution)) {
            terminalStopped = true;
            await this.closeSessionChannels(current.identity.accountId, current.identity.binding.workspaceId, current.terminal.id);
            await this.store.deleteTerminal(current.identity.accountId, current.identity.binding.workspaceId, current.terminal.id);
          }
        } catch {}
      }
      try { await connection?.disconnect?.(); } catch {}
      if (!dispatched || outputKnown || terminalStopped) this.sessionLocks.delete(lockKey);
    }
  }

  pushChannelEvent(channel, event, bytes = 0) {
    if (!this.channels.has(channel.id)) return;
    channel.events.push(event);
    channel.queuedBytes += bytes;
    if (channel.queuedBytes > MAX_CHANNEL_QUEUE_BYTES) {
      channel.events = [{
        type: "error",
        message: "PTY relay output queue exceeded the size limit"
      }];
      channel.queuedBytes = 0;
      channel.closed = true;
      void this.closeChannel(channel.id);
    }
    for (const waiter of [...channel.waiters]) waiter();
    channel.waiters.clear();
  }

  async openChannel(sessionId, input, runContext) {
    if (this.channels.size >= this.maxChannels) {
      throw terminalError(429, "too_many_pty_channels");
    }
    const resolved = await this.resolveSession(sessionId, runContext);
    return await this.lifecycle(runContext, "relay-open", async (context) => {
      this.assertPinnedSession(context, resolved);
      context.signal.throwIfCancelled();
      const id = randomUUID();
      const lease = this.sandbox.acquireActivityLease(
        resolved.identity.accountId,
        resolved.identity.binding.workspaceId
      );
      const channel = {
        id,
        accountId: resolved.identity.accountId,
        workspaceId: resolved.identity.binding.workspaceId,
        terminalId: resolved.terminal.id,
        sessionId,
        handle: context.handle,
        scope: context.scope,
        pid: resolved.terminal.pid,
        events: [],
        queuedBytes: 0,
        waiters: new Set(),
        lease,
        connection: null,
        closed: false,
        lastActivityAt: this.now(),
        lastTouchedAt: 0
      };
      this.channels.set(id, channel);
      const cancellation = context.signal.onCancel(() => { void this.closeChannel(id); });
      try {
        channel.connection = await this.provider.openPty(
          context.handle,
          context.scope,
          {
            pid: resolved.terminal.pid,
            cols: Math.max(1, Number(input.cols) || 80),
            rows: Math.max(1, Number(input.rows) || 24),
            onData: (chunk) => this.pushChannelEvent(channel, {
              type: "data",
              dataBase64: Buffer.from(chunk).toString("base64")
            }, Buffer.byteLength(chunk))
          }
        );
        await this.provider.ptyResize(
          context.handle,
          context.scope,
          resolved.terminal.pid,
          {
            cols: Math.max(1, Number(input.cols) || 80),
            rows: Math.max(1, Number(input.rows) || 24)
          }
        );
        context.signal.throwIfCancelled();
        const waiting = channel.connection.wait?.();
        if (waiting?.then) {
          void waiting.then(
            () => {
              channel.closed = true;
              this.pushChannelEvent(channel, { type: "close" });
            },
            () => {
              channel.closed = true;
              this.pushChannelEvent(channel, {
                type: "error",
                message: "Sandbox PTY connection failed"
              });
            }
          );
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ channelId: id }),
          stderr: ""
        };
      } catch (error) {
        await this.closeChannel(id);
        try { await channel.connection?.disconnect?.(); } catch {}
        throw error;
      } finally { cancellation.dispose(); }
    });
  }

  async touchChannel(channel) {
    const timestamp = this.now();
    channel.lastActivityAt = timestamp;
    channel.lease.touch();
    if (timestamp - channel.lastTouchedAt < 60_000) return;
    await this.provider.touch(
      channel.handle,
      channel.scope,
      this.provider.supportsPause ? 600_000 : this.sandbox.idlePauseMs + 90_000
    );
    channel.lastTouchedAt = timestamp;
  }

  requireChannel(sessionId, channelId) {
    const channel = this.channels.get(String(channelId || ""));
    if (!channel || channel.sessionId !== sessionId) {
      throw terminalError(404, "pty_relay_channel_not_found");
    }
    return channel;
  }

  async channelInput(sessionId, channelId, input, runContext) {
    await this.authorize(runContext);
    const channel = this.requireChannel(sessionId, channelId);
    if (channel.closed) throw terminalError(409, "pty_relay_channel_closed");
    const lockKey = `${channel.accountId}\0${channel.terminalId}`;
    if (this.sessionLocks.has(lockKey)) {
      throw terminalError(
        409,
        "terminal_session_busy",
        "Interactive input is disabled while a model command is running."
      );
    }
    await this.resolveSession(sessionId, runContext, { authorize: false });
    await this.touchChannel(channel);
    if (input.type === "resize") {
      await this.provider.ptyResize(
        channel.handle,
        channel.scope,
        channel.pid,
        {
          cols: Math.max(1, Number(input.cols) || 80),
          rows: Math.max(1, Number(input.rows) || 24)
        }
      );
    } else {
      const data = String(input.data || "");
      if (Buffer.byteLength(data) > 64 * 1024) {
        throw terminalError(413, "pty_input_too_large");
      }
      await this.provider.ptyInput(
        channel.handle,
        channel.scope,
        channel.pid,
        data
      );
    }
  }

  async channelEvents(sessionId, channelId, waitMs, runContext) {
    await this.authorize(runContext);
    const channel = this.requireChannel(sessionId, channelId);
    await this.resolveSession(sessionId, runContext, { authorize: false });
    await this.touchChannel(channel);
    const boundedWait = Math.min(20_000, Math.max(0, Number(waitMs) || 15_000));
    if (!channel.events.length && !channel.closed && boundedWait > 0) {
      await new Promise((resolve) => {
        let timer;
        let cancellation = { dispose() {} };
        const done = () => {
          clearTimeout(timer);
          cancellation.dispose();
          channel.waiters.delete(done);
          resolve();
        };
        timer = setTimeout(done, boundedWait);
        cancellation = runContext.signal?.onCancel?.(done)
          || { dispose() {} };
        channel.waiters.add(done);
      });
    }
    const events = channel.events.splice(0);
    channel.queuedBytes = 0;
    const closed = channel.closed;
    if (closed) await this.closeChannel(channel.id);
    return { events, closed };
  }

  async closeChannel(channelId) {
    const channel = this.channels.get(String(channelId || ""));
    if (!channel) return;
    this.channels.delete(channel.id);
    channel.closed = true;
    for (const waiter of [...channel.waiters]) waiter();
    channel.waiters.clear();
    channel.lease.dispose();
    try { await channel.connection?.disconnect?.(); } catch {}
  }

  async closeSessionChannels(accountId, workspaceId, terminalId) {
    await Promise.all(
      [...this.channels.values()].filter((channel) =>
        channel.accountId === accountId
        && channel.workspaceId === workspaceId
        && channel.terminalId === terminalId
      ).map((channel) => this.closeChannel(channel.id))
    );
  }

  async closeWorkspaceChannels(accountId, workspaceId) {
    await Promise.all(
      [...this.channels.values()].filter((channel) =>
        channel.accountId === accountId
        && channel.workspaceId === workspaceId
      ).map((channel) => this.closeChannel(channel.id))
    );
  }

  pruneChannels() {
    const now = this.now();
    for (const channel of [...this.channels.values()]) {
      if (now - channel.lastActivityAt > this.channelIdleMs) {
        void this.closeChannel(channel.id);
      }
    }
  }

  async handleRequest({
    path,
    method,
    body,
    runContext = {}
  }) {
    const url = new URL(path, "http://managed.invalid");
    if (url.pathname.startsWith("/files/")) {
      const input = method === "GET"
        ? Object.fromEntries(url.searchParams)
        : jsonBody(body);
      const requestedNodeId = String(input.node_id || runContext.target?.nodeId || "");
      if (
        input.node_id && runContext.target?.nodeId
        && input.node_id !== runContext.target.nodeId
      ) {
        throw terminalError(403, "file_target_conflict");
      }
      if (requestedNodeId && !this.isManagedNode(requestedNodeId, runContext.principal)) {
        return null;
      }
      if (input.session_id) {
        if (!this.isManagedSession(input.session_id, runContext.principal)) return null;
        await this.getSession({ sessionId: input.session_id, runContext });
      }
      const identity = this.identityForPrincipal(runContext.principal);
      if (input.resource_id && input.resource_id !== identity.resourceId) {
        throw terminalError(403, "file_target_conflict");
      }
      const operation = url.pathname.slice("/files/".length);
      const names = { read: "read", "read-jsonl": "read", write: "write", entries: "tree", glob: "glob", grep: "grep" };
      const toolName = names[operation];
      if (!toolName || method !== (operation === "write" ? "POST" : "GET")) {
        throw terminalError(405, "managed_file_operation_unavailable");
      }
      if (!String(input.path || "").startsWith("/")) {
        throw terminalError(400, "absolute_file_path_required");
      }
      const { node_id, resource_id, session_id, plugin_data_version, ...args } = input;
      if (["read", "write", "entries", "read-jsonl"].includes(operation)) args._plugin_data = true;
      if (operation === "entries") args._plugin_entries = true;
      return await this.withLifecycleGrant(runContext, async ({ principal, policy }) => {
        const id = `managed-file:${randomUUID()}`;
        const result = await this.sandbox.invoke({
          invocationId: id, runId: id, attemptId: id, principal, policy,
          toolCall: { id, name: toolName, arguments: args }
        }, runContext.signal || noCancellation());
        if (!result?.ok) {
          const message = result?.error || result?.content || "Managed file operation failed";
          throw Object.assign(new Error(message), {
            statusCode: result?.failureCode === "sandbox_workspace_busy" ? 409
              : /no such file|FileNotFoundError/i.test(message) ? 404
              : /file_outside_grant|symlink_denied|lock_path_reserved/i.test(message) ? 403
              : /content_hash_conflict/i.test(message) ? 409 : 502,
            code: result?.failureCode || "managed_file_operation_failed",
            retryable: result?.retryable === true
          });
        }
        const payload = JSON.parse(result.content);
        if (operation === "read-jsonl") {
          const lines = String(payload.content || "").split("\n");
          if (lines.at(-1) === "") lines.pop();
          const limit = Math.max(1, Math.min(1000, Number(input.limit) || 80));
          const start = input.tail
            ? Math.max(0, lines.length - Math.min(limit, Number(input.tail)))
            : Math.max(0, (Number(input.offset) || 1) - 1);
          const end = Math.min(lines.length, start + limit);
          Object.assign(payload, {
            content: lines.slice(start, end).join("\n"),
            start_line: start + 1, end_line: end,
            previous_offset: Math.max(1, start - limit + 1),
            has_previous: start > 0, has_more: end < lines.length
          });
        }
        return { status: 200, body: { ok: true, ...payload, ...(plugin_data_version === "1" ? { plugin_data_version: 1 } : {}) } };
      });
    }
    const match = url.pathname.match(/^\/sessions\/([^/]+)(\/.*)?$/);
    if (!match) return null;
    const sessionId = decodeURIComponent(match[1]);
    if (!this.isManagedSession(sessionId, runContext.principal)) return null;
    const suffix = match[2] || "";
    if (!suffix && method === "GET") {
      return {
        status: 200,
        body: { session: await this.getSession({ sessionId, runContext }) }
      };
    }
    if (!suffix && method === "DELETE") {
      return {
        status: 200,
        body: await this.closeSession({ sessionId, runContext })
      };
    }
    if (suffix === "/activate" && method === "POST") {
      return {
        status: 200,
        body: {
          session: await this.reactivateSession({ sessionId, runContext })
        }
      };
    }
    if (suffix === "/exec" && method === "POST") {
      const input = jsonBody(body);
      const result = await this.executeHttpCommand({
        sessionId,
        command: String(input.command || ""),
        timeoutMs: input.timeout,
        runContext
      });
      return {
        status: 200,
        body: result
      };
    }
    if (suffix === "/pty/webrtc/offer" && method === "POST") {
      return {
        status: 501,
        body: { error: "Managed terminals use the authenticated HTTP relay" }
      };
    }
    const open = suffix === "/pty/relay/open";
    if (open && method === "POST") {
      return {
        status: 201,
        body: await this.openChannel(sessionId, jsonBody(body), runContext)
      };
    }
    const relay = suffix.match(/^\/pty\/relay\/([^/]+)(?:\/(input|events))?$/);
    if (!relay) return null;
    const channelId = decodeURIComponent(relay[1]);
    const action = relay[2] || "close";
    if (action === "input" && method === "POST") {
      await this.channelInput(
        sessionId,
        channelId,
        jsonBody(body),
        runContext
      );
      return { status: 204, body: null };
    }
    if (action === "events" && method === "GET") {
      return {
        status: 200,
        body: await this.channelEvents(
          sessionId,
          channelId,
          url.searchParams.get("waitMs"),
          runContext
        )
      };
    }
    if (action === "close" && method === "DELETE") {
      await this.authorize(runContext);
      this.requireChannel(sessionId, channelId);
      await this.closeChannel(channelId);
      return { status: 204, body: null };
    }
    throw terminalError(405, "method_not_allowed");
  }

  async close() {
    clearInterval(this.timer);
    this.invalidation.dispose();
    await Promise.all(
      [...this.channels.keys()].map((id) => this.closeChannel(id))
    );
  }
}
