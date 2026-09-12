import { clearTimeout, setTimeout } from "node:timers";
import {
  DEVICE_PROTOCOL_VERSION,
  normalizeNodeRegistration,
  normalizeToolResult
} from "../../../packages/node-protocol/src/index.mjs";
import {
  isResourceReference,
  parseTerminalReference
} from "../../../packages/node-protocol/src/resource-references.mjs";
import {
  invocationReference,
  scopeServiceResult,
  translateInvocation
} from "./node-service-routing.mjs";

const INTERNAL_CAPABILITY_PREFIX = "zion.internal.";

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function removeQueuedInvocation(node, invocationId) {
  node.commands = node.commands.filter((command) =>
    command.invocationId !== invocationId
  );
}

function projectBindingKey(binding) {
  return `${binding.projectId}\0${binding.nodeId}\0${binding.resourceId}`;
}

function scopedToolDescription(description, policy = {}) {
  const lines = [String(description || "").trim()].filter(Boolean);
  const roots = Array.isArray(policy.fileRoots)
    ? [...new Set(policy.fileRoots.map(String).filter(Boolean))]
    : [];
  const sessionIds = Array.isArray(policy.allowedTerminalSessionIds)
    ? [...new Set(
        policy.allowedTerminalSessionIds.map(String).filter(Boolean)
      )]
    : [];
  if (roots.length) {
    lines.push(`Allowed absolute file roots for this Run: ${roots.join(", ")}`);
  }
  if (sessionIds.length) {
    lines.push(
      `Allowed session_id values for this Run: ${sessionIds.join(", ")}`
    );
  }
  return lines.join("\n");
}

function defaultScheduleTimeout(callback, timeoutMs) {
  const timer = setTimeout(callback, timeoutMs);
  return { dispose: () => clearTimeout(timer) };
}

function routedToolSchema(capability) {
  const schema = capability.inputSchema || { type: "object" };
  if (capability.name.startsWith(INTERNAL_CAPABILITY_PREFIX)) return schema;
  return {
    ...schema,
    properties: {
      ...(schema.properties || {}),
      node_id: {
        type: "string",
        description: "Execution Node ID from terminalInventory. Required when multiple Nodes exist and no global session_id selects the target."
      }
    }
  };
}

export class NodeBroker {
  constructor({
    now = () => Date.now(),
    offlineAfterMs = 60_000,
    presencePersistenceMs = 10_000,
    maxReceipts = 1_000,
    invocationLeaseMs = 120_000,
    scheduleTimeout = defaultScheduleTimeout,
    stateStore = null
  } = {}) {
    if (!Number.isSafeInteger(invocationLeaseMs) || invocationLeaseMs <= 0) {
      throw new Error("Invocation lease duration must be a positive integer");
    }
    this.now = now;
    this.offlineAfterMs = offlineAfterMs;
    this.presencePersistenceMs = presencePersistenceMs;
    this.maxReceipts = maxReceipts;
    this.invocationLeaseMs = invocationLeaseMs;
    this.scheduleTimeout = scheduleTimeout;
    this.stateStore = stateStore;
    this.nodes = new Map();
    this.projectBindings = new Map();
    this.pending = new Map();
    this.receipts = new Map();
    this.closed = false;

    const restored = this.stateStore?.loadState?.({
      receiptLimit: this.maxReceipts
    });
    for (const item of restored?.nodes || []) {
      const registration = normalizeNodeRegistration(item.registration);
      this.nodes.set(registration.nodeId, {
        registration,
        lastSeenAt: Number(item.lastSeenAt) || 0,
        persistedLastSeenAt: Number(item.lastSeenAt) || 0,
        connected: false,
        commands: [],
        waiter: null
      });
    }
    for (const binding of restored?.projectBindings || []) {
      const normalized = {
        projectId: String(binding.projectId),
        nodeId: String(binding.nodeId),
        resourceId: String(binding.resourceId),
        updatedAt: Number(binding.updatedAt) || 0
      };
      this.projectBindings.set(projectBindingKey(normalized), normalized);
    }
    for (const receipt of restored?.receipts || []) {
      this.rememberReceipt(
        String(receipt.invocationId),
        normalizeToolResult(receipt.result)
      );
    }
  }

  registerNode(input) {
    if (this.closed) throw statusError(503, "Node Broker is closed");
    const registration = normalizeNodeRegistration(input);
    const previous = this.nodes.get(registration.nodeId);
    const reconnected = !!previous
      && (
        !previous.connected
        || previous.registration.instanceId !== registration.instanceId
      );
    const node = previous || {
      connected: false,
      persistedLastSeenAt: 0,
      commands: [],
      waiter: null
    };
    const observedAt = this.now();

    this.stateStore?.registerNode?.(registration, observedAt);

    if (reconnected) {
      this.resolveWaiter(node, null);
      for (const pending of this.pending.values()) {
        if (
          pending.nodeId === registration.nodeId
          && previous.registration.instanceId !== registration.instanceId
          && (
            pending.referenceBound
            || !["read", "glob", "grep", "tree"].includes(pending.command.invocation.toolCall.name)
          )
        ) {
          this.pending.delete(pending.invocationId);
          removeQueuedInvocation(node, pending.invocationId);
          pending.cancellation.dispose();
          pending.lease.dispose();
          pending.reject(statusError(409,
            "Node instance changed; refresh terminalInventory. The previous operation may have executed; do not blindly retry."
          ));
          continue;
        }
        if (
          pending.nodeId === registration.nodeId
          && pending.state === "delivered"
        ) {
          pending.state = "queued";
          removeQueuedInvocation(node, pending.invocationId);
          node.commands.push(pending.command);
        }
      }
    }

    node.registration = registration;
    node.lastSeenAt = observedAt;
    node.persistedLastSeenAt = observedAt;
    node.connected = true;
    this.nodes.set(registration.nodeId, node);
    this.syncProjectBindings(registration, observedAt);
    this.flushWaiter(node);
    return this.nodeSummary(node);
  }

  heartbeat(nodeId, instanceId) {
    const node = this.requireConnection(nodeId, instanceId);
    this.observeNode(node);
    return this.nodeSummary(node);
  }

  disconnectNode(nodeId, instanceId) {
    const node = this.nodes.get(String(nodeId));
    if (
      !node
      || (
        instanceId
        && node.registration.instanceId !== String(instanceId)
      )
    ) {
      return false;
    }
    this.resolveWaiter(node, null);
    node.connected = false;
    return true;
  }

  async nextCommand(nodeId, instanceId, waitMs = 0) {
    const node = this.requireConnection(nodeId, instanceId);
    this.observeNode(node);
    const immediate = this.takeCommand(node);
    if (immediate || waitMs <= 0) return immediate;

    this.resolveWaiter(node, null);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (node.waiter?.resolve === resolve) node.waiter = null;
        resolve(null);
      }, Math.max(1, waitMs));
      node.waiter = { resolve, timer, instanceId };
    });
  }

  completeInvocation(nodeId, instanceId, invocationId, input) {
    this.requireConnection(nodeId, instanceId);
    const existing = this.findReceipt(invocationId);
    if (existing) {
      return { accepted: true, duplicate: true, result: existing };
    }

    const pending = this.pending.get(invocationId);
    if (!pending || pending.nodeId !== nodeId) {
      throw statusError(404, `Invocation not found: ${invocationId}`);
    }

    let result;
    try {
      result = scopeServiceResult(
        normalizeToolResult(input),
        pending.command.invocation,
        { node: pending.node, resource: pending.resource }
      );
    } catch (error) {
      result = { ok: false, content: "Invalid Device resource response", error: String(error?.message || error) };
    }
    let duplicate = false;
    if (this.stateStore?.saveReceipt) {
      const receipt = this.stateStore.saveReceipt({
        invocationId,
        nodeId,
        result,
        completedAt: this.now()
      });
      result = normalizeToolResult(receipt.result);
      duplicate = receipt.duplicate === true;
    }
    pending.cancellation.dispose();
    pending.lease.dispose();
    this.pending.delete(invocationId);
    this.rememberReceipt(invocationId, result);
    pending.resolve(result);
    return { accepted: true, duplicate, result };
  }

  async listTools(request = {}) {
    const allowed = new Set(request.policy?.allowedTools || []);
    const tools = new Map();
    const requestedNodeId = String(request.target?.nodeId || "");
    const registered = this.registeredTargets(request.projectId)
      .filter(({ node }) =>
        !requestedNodeId || node.registration.nodeId === requestedNodeId
      );
    if (requestedNodeId && !registered.length) {
      throw statusError(404, "Node is not registered for this project");
    }
    if (
      requestedNodeId
      && !registered.some(({ node }) => this.isOnline(node))
    ) {
      throw statusError(503, `Node ${requestedNodeId} is offline`);
    }
    for (const target of registered.filter(({ node }) => this.isOnline(node))) {
      for (const capability of target.node.registration.capabilities) {
        if (!allowed.has(capability.name) || tools.has(capability.name)) continue;
        tools.set(capability.name, {
          name: capability.name,
          description: scopedToolDescription(
            capability.description,
            request.policy
          ),
          inputSchema: routedToolSchema(capability),
          hostKinds: [capability.hostKind]
        });
      }
    }
    return [...tools.values()];
  }

  get supportedToolNames() {
    return this.getToolDefinitions().map((tool) => tool.name);
  }

  getToolDefinitions() {
    const tools = new Map();
    for (const { node } of this.availableTargets()) {
      for (const capability of node.registration.capabilities) {
        if (capability.name.startsWith(INTERNAL_CAPABILITY_PREFIX)) continue;
        if (tools.has(capability.name)) continue;
        tools.set(capability.name, {
          name: capability.name,
          description: capability.description,
          inputSchema: routedToolSchema(capability),
          hostKinds: [capability.hostKind],
          risk: capability.risk
        });
      }
    }
    return [...tools.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }

  async invoke(invocation, signal) {
    if (this.closed) throw new Error("Node Broker is closed");
    signal.throwIfCancelled();
    const receipt = this.findReceipt(invocation.invocationId);
    if (receipt) return receipt;
    const duplicate = this.pending.get(invocation.invocationId);
    if (duplicate) return await duplicate.completion;

    const toolName = String(invocation.toolCall?.name || "");
    if (!invocation.policy?.allowedTools?.includes(toolName)) {
      throw new Error("tool is not allowed by capability policy");
    }
    let reference = invocationReference(invocation);
    if (!reference.terminal && !reference.machine && !reference.sessionId) {
      const allowedReferences = (
        invocation.policy?.allowedTerminalSessionIds || []
      ).map((value) => ({
        value: String(value),
        terminal: parseTerminalReference(value)
      })).filter((item) => item.terminal);
      if (allowedReferences.length === 1) {
        reference = {
          ...reference,
          sessionId: allowedReferences[0].value,
          terminal: allowedReferences[0].terminal
        };
      }
    }
    const argumentNodeId = String(invocation.toolCall?.arguments?.node_id || "");
    if (argumentNodeId && invocation.target?.nodeId && argumentNodeId !== invocation.target.nodeId) {
      throw statusError(403, "node_id conflicts with the requested target");
    }
    const explicit = {
      ...(invocation.target || {}),
      ...(argumentNodeId ? { nodeId: argumentNodeId } : {})
    };
    const referencedTarget = reference.terminal || reference.machine;
    if (
      referencedTarget
      && ["nodeId", "resourceId", "instanceId"].some((key) =>
        explicit[key] && referencedTarget[key] && explicit[key] !== referencedTarget[key]
      )
    ) {
      throw statusError(403, "Resource reference conflicts with the requested target");
    }
    if (
      !referencedTarget
      && !explicit.nodeId
      && !explicit.resourceId
      && this.registeredTargets(invocation.projectId).length > 1
    ) {
      throw statusError(409, "Ambiguous Node/resource target; use a global session_id from terminalInventory");
    }
    const target = this.selectTarget(invocation.projectId, toolName, {
      ...explicit,
      ...(referencedTarget ? {
        nodeId: referencedTarget.nodeId,
        ...(reference.terminal ? {
          instanceId: reference.terminal.instanceId,
          resourceId: reference.terminal.resourceId
        } : {})
      } : {})
    });
    if (!target) {
      throw new Error(
        invocation.projectId
          ? `No online Node provides ${toolName} for project ${invocation.projectId}`
          : `No online Node provides ${toolName}`
      );
    }
    const policy = this.policyForTarget(invocation.policy, target, invocation.projectId);
    const nativeSessionId = reference.terminal?.sessionId || reference.sessionId;
    if (
      nativeSessionId
      && policy.allowedTerminalSessionIds?.length
      && !policy.allowedTerminalSessionIds.includes(nativeSessionId)
    ) {
      throw statusError(403, "Terminal session is outside the active Run policy");
    }
    const routedInvocation = translateInvocation(invocation, reference, policy);

    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const command = {
      schemaVersion: DEVICE_PROTOCOL_VERSION,
      type: "tool.invoke",
      invocationId: invocation.invocationId,
      resourceId: target.resource?.resourceId,
      leaseExpiresAt: this.now() + this.invocationLeaseMs,
      invocation: routedInvocation
    };
    const pending = {
      invocationId: invocation.invocationId,
      nodeId: target.node.registration.nodeId,
      node: target.node,
      resource: target.resource,
      referenceBound: !!reference.terminal || !!explicit.instanceId,
      state: "queued",
      command,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      cancellation: { dispose() {} },
      lease: { dispose() {} }
    };
    this.pending.set(invocation.invocationId, pending);
    pending.cancellation = signal.onCancel((reason) => {
      const active = this.pending.get(invocation.invocationId);
      if (!active) return;
      this.pending.delete(invocation.invocationId);
      removeQueuedInvocation(active.node, invocation.invocationId);
      if (active.state === "delivered") {
        this.enqueueCommand(active.node, {
          schemaVersion: DEVICE_PROTOCOL_VERSION,
          type: "tool.cancel",
          invocationId: invocation.invocationId,
          reason
        });
      }
      active.cancellation.dispose();
      active.lease.dispose();
      active.reject(new Error(`Tool invocation cancelled: ${reason}`));
    });
    pending.lease = this.scheduleTimeout(
      () => this.expireInvocation(invocation.invocationId),
      this.invocationLeaseMs
    );
    this.enqueueCommand(target.node, command);
    return await completion;
  }

  snapshot() {
    return {
      nodes: [...this.nodes.values()]
        .map((node) => this.nodeSummary(node))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      projectBindings: [...this.projectBindings.values()]
        .map((binding) => ({ ...binding }))
        .sort((left, right) =>
          projectBindingKey(left).localeCompare(projectBindingKey(right))
        ),
      pendingInvocations: this.pending.size,
      receiptCount: this.receipts.size,
      durableReceiptCount:
        this.stateStore?.countReceipts?.() ?? this.receipts.size
    };
  }

  close(reason = "node-broker-shutdown") {
    if (this.closed) return;
    this.closed = true;
    for (const node of this.nodes.values()) {
      this.resolveWaiter(node, null);
      node.connected = false;
    }
    for (const pending of this.pending.values()) {
      pending.cancellation.dispose();
      pending.lease.dispose();
      pending.reject(new Error(`Tool invocation cancelled: ${reason}`));
    }
    this.pending.clear();
  }

  selectTarget(projectId, toolName, requested = {}) {
    const targets = this.registeredTargets(projectId, toolName)
      .filter(({ node, resource }) =>
        (!requested.nodeId || node.registration.nodeId === requested.nodeId)
        && (!requested.resourceId || resource?.resourceId === requested.resourceId)
      );
    if (!targets.length) {
      if (requested.nodeId || requested.resourceId) {
        throw statusError(404, "Node/resource is not registered for this project and capability");
      }
      return null;
    }
    if (targets.length !== 1) {
      throw statusError(409,
        "Ambiguous Node/resource target. Use a global session_id from terminalInventory or select a node_id."
      );
    }
    const target = targets[0];
    if (requested.instanceId && requested.instanceId !== target.node.registration.instanceId) {
      throw statusError(409, "Stale terminal reference; refresh terminalInventory");
    }
    if (!this.isOnline(target.node)) {
      throw statusError(503,
        `Node ${target.node.registration.nodeId} is offline; its resources cannot be used on another Node`
      );
    }
    return target;
  }

  policyForTarget(policy = {}, target, projectId) {
    const requested = Array.isArray(policy.allowedTerminalSessionIds)
      ? policy.allowedTerminalSessionIds.map(String).filter(Boolean)
      : [];
    if (!requested.length) return { ...policy };
    const nativeIds = [];
    for (const value of requested) {
      const ref = parseTerminalReference(value);
      if (ref) {
        if (
          ref.nodeId === target.node.registration.nodeId
          && ref.instanceId === target.node.registration.instanceId
          && ref.resourceId === target.resource?.resourceId
        ) nativeIds.push(ref.sessionId);
      } else if (!isResourceReference(value)) {
        // Native allowlists must never broaden to every Node with the same ID.
        const candidates = this.registeredTargets(projectId);
        if (candidates.length === 1 && candidates[0].node === target.node) nativeIds.push(value);
      }
    }
    if (!nativeIds.length) {
      throw statusError(403, "Node/resource is outside the active terminal policy");
    }
    return { ...policy, allowedTerminalSessionIds: [...new Set(nativeIds)] };
  }

  registeredTargets(projectId, toolName) {
    const targets = projectId
      ? [...this.projectBindings.values()]
        .filter((binding) => binding.projectId === projectId)
        .map((binding) => {
          const node = this.nodes.get(binding.nodeId);
          const resource = node?.registration.resources.find(
            (item) =>
              item.resourceId === binding.resourceId
              && item.projectId === projectId
          );
          return { node, resource };
        })
      : [...this.nodes.values()].flatMap((node) =>
          node.registration.resources.length
            ? node.registration.resources.map((resource) => ({ node, resource }))
            : [{ node, resource: undefined }]
        );
    return targets
      .filter(({ node }) => node)
      .filter(({ node, resource }) =>
        (!projectId || resource)
        && (!toolName || node.registration.capabilities.some(
          (capability) => capability.name === toolName
        ))
      )
      .sort((left, right) =>
        left.node.registration.nodeId.localeCompare(
          right.node.registration.nodeId
        )
      );
  }

  availableTargets(projectId, toolName) {
    return this.registeredTargets(projectId, toolName)
      .filter(({ node }) => this.isOnline(node));
  }

  requireConnection(nodeId, instanceId) {
    const node = this.nodes.get(String(nodeId));
    if (!node) throw statusError(404, `Node not registered: ${nodeId}`);
    if (!node.connected) {
      throw statusError(409, `Node must register after Runtime restart: ${nodeId}`);
    }
    if (node.registration.instanceId !== String(instanceId || "")) {
      throw statusError(409, `Node instance is stale: ${nodeId}`);
    }
    return node;
  }

  isOnline(node) {
    return node.connected === true
      && !this.closed
      && this.now() - node.lastSeenAt <= this.offlineAfterMs;
  }

  observeNode(node) {
    const observedAt = this.now();
    node.lastSeenAt = observedAt;
    if (
      this.stateStore?.touchNode
      && observedAt - node.persistedLastSeenAt >= this.presencePersistenceMs
    ) {
      this.stateStore.touchNode(node.registration.nodeId, observedAt);
      node.persistedLastSeenAt = observedAt;
    }
  }

  nodeSummary(node) {
    return {
      protocolVersion: node.registration.protocolVersion,
      nodeId: node.registration.nodeId,
      instanceId: node.registration.instanceId,
      label: node.registration.label,
      platform: node.registration.platform,
      status: this.isOnline(node) ? "online" : "offline",
      lastSeenAt: node.lastSeenAt,
      capabilities: node.registration.capabilities.map((item) => ({
        name: item.name,
        version: item.version,
        risk: item.risk,
        hostKind: item.hostKind
      })),
      resources: node.registration.resources.map((item) => ({ ...item }))
    };
  }

  enqueueCommand(node, command) {
    node.commands.push(command);
    this.flushWaiter(node);
  }

  flushWaiter(node) {
    if (!node.waiter || node.waiter.instanceId !== node.registration.instanceId) {
      return;
    }
    const command = this.takeCommand(node);
    if (!command) return;
    this.resolveWaiter(node, command);
  }

  takeCommand(node) {
    const command = node.commands.shift() || null;
    if (command?.type === "tool.invoke") {
      const pending = this.pending.get(command.invocationId);
      if (pending) pending.state = "delivered";
    }
    return command;
  }

  resolveWaiter(node, command) {
    if (!node.waiter) return;
    const { resolve, timer } = node.waiter;
    node.waiter = null;
    clearTimeout(timer);
    resolve(command);
  }

  rememberReceipt(invocationId, result) {
    this.receipts.set(invocationId, result);
    while (this.receipts.size > this.maxReceipts) {
      this.receipts.delete(this.receipts.keys().next().value);
    }
  }

  findReceipt(invocationId) {
    const cached = this.receipts.get(invocationId);
    if (cached) return cached;
    const persisted = this.stateStore?.getReceipt?.(invocationId);
    if (!persisted) return null;
    const result = normalizeToolResult(persisted.result);
    this.rememberReceipt(invocationId, result);
    return result;
  }

  syncProjectBindings(registration, observedAt) {
    for (const [key, binding] of this.projectBindings) {
      if (binding.nodeId === registration.nodeId) {
        this.projectBindings.delete(key);
      }
    }
    for (const resource of registration.resources) {
      if (!resource.projectId) continue;
      const binding = {
        projectId: resource.projectId,
        nodeId: registration.nodeId,
        resourceId: resource.resourceId,
        updatedAt: observedAt
      };
      this.projectBindings.set(projectBindingKey(binding), binding);
    }
  }

  expireInvocation(invocationId) {
    const pending = this.pending.get(invocationId);
    if (!pending) return;
    this.pending.delete(invocationId);
    removeQueuedInvocation(pending.node, invocationId);
    if (pending.state === "delivered") {
      this.enqueueCommand(pending.node, {
        schemaVersion: DEVICE_PROTOCOL_VERSION,
        type: "tool.cancel",
        invocationId,
        reason: "invocation-lease-expired"
      });
    }
    pending.cancellation.dispose();
    pending.lease.dispose();
    pending.reject(new Error(`Tool invocation lease expired: ${invocationId}`));
  }
}
