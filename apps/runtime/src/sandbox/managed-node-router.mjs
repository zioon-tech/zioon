import { createHash } from "node:crypto";
import {
  parseTerminalReference
} from "../../../../packages/node-protocol/src/resource-references.mjs";

const MANAGED_RESOURCE_ID = "workspace:managed";
const LEGACY_NAMES = new Set(["sandboxBash", "sandboxRead", "sandboxWrite"]);
const VIRTUAL_ROOTS = ["/observability", "/skills/run-diagnostics"];

function principalAccountId(principal) {
  return String(principal?.userId || principal?.user?.id || "");
}

function virtualPath(value) {
  const path = String(value || "").replaceAll("\\", "/");
  return VIRTUAL_ROOTS.some((root) =>
    path === root || path.startsWith(`${root}/`)
  );
}

function stableNodeId(spaceId, binding) {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      String(spaceId || ""),
      binding.accountId,
      binding.workspaceId
    ]))
    .digest("hex")
    .slice(0, 24);
  return `managed:${digest}`;
}

export class ManagedNodeToolRouter {
  constructor({ sandbox, device = null } = {}) {
    if (!sandbox?.invoke || !sandbox?.bindingForAccount) {
      throw new Error("Managed Node router requires a sandbox broker");
    }
    this.sandbox = sandbox;
    this.device = device;
    this.terminalService = null;
  }

  get supportedToolNames() {
    return [
      ...new Set([
        ...(this.sandbox.supportedToolNames || []),
        ...(this.device?.supportedToolNames || [])
      ])
    ];
  }

  setTerminalService(service) {
    this.terminalService = service;
  }

  managedTarget(principal) {
    const accountId = principalAccountId(principal);
    const binding = this.sandbox.bindingForAccount(accountId);
    if (!binding) return null;
    return {
      accountId,
      binding,
      nodeId: stableNodeId(
        principal?.spaceId || principal?.space?.id,
        binding
      ),
      resourceId: MANAGED_RESOURCE_ID
    };
  }

  isManagedNode(nodeId, principal) {
    const target = this.managedTarget(principal);
    return !!target && String(nodeId || "") === target.nodeId;
  }

  shouldResolve(invocation) {
    const name = String(invocation.toolCall?.name || "");
    if (
      !this.sandbox.supportedToolNames.includes(name)
      && !LEGACY_NAMES.has(name)
    ) {
      return false;
    }
    const args = invocation.toolCall?.arguments || {};
    if (name === "Bash" && args.execution_environment === "analysis") {
      return false;
    }
    return !virtualPath(args.path);
  }

  resolveInvocation(invocation) {
    if (!this.shouldResolve(invocation)) return invocation;
    const managed = this.managedTarget(invocation.principal);
    const args = invocation.toolCall?.arguments || {};
    const terminal = parseTerminalReference(args.session_id);
    const explicitNodeId = String(
      invocation.target?.nodeId || args.node_id || terminal?.nodeId || ""
    );
    if (!managed) {
      if (explicitNodeId) return invocation;
      throw Object.assign(
        new Error("This account's managed workspace is not provisioned; select an authorized Device or provision the workspace"),
        { statusCode: 403, code: "sandbox_account_unbound" }
      );
    }
    if (explicitNodeId && explicitNodeId !== managed.nodeId) {
      return {
        ...invocation,
        target: {
          ...invocation.target,
          nodeId: explicitNodeId,
          ...(terminal?.instanceId
            ? { instanceId: terminal.instanceId }
            : {}),
          ...(terminal?.resourceId
            ? { resourceId: terminal.resourceId }
            : args.resource_id
              ? { resourceId: String(args.resource_id) }
              : {})
        }
      };
    }
    if (
      terminal
      && (
        terminal.nodeId !== managed.nodeId
        || terminal.resourceId !== managed.resourceId
      )
    ) {
      return invocation;
    }
    return {
      ...invocation,
      target: {
        ...invocation.target,
        nodeId: managed.nodeId,
        resourceId: managed.resourceId,
        ...(terminal?.instanceId
          ? { instanceId: terminal.instanceId }
          : {})
      }
    };
  }

  getToolDefinitions() {
    const definitions = new Map();
    for (const tool of this.sandbox.getToolDefinitions()) {
      definitions.set(tool.name, tool);
    }
    for (const tool of this.device?.getToolDefinitions?.() || []) {
      if (!definitions.has(tool.name)) definitions.set(tool.name, tool);
    }
    return [...definitions.values()];
  }

  async listTools(request = {}) {
    const resolved = this.resolveInvocation(request);
    const managed = this.managedTarget(resolved.principal);
    const nodeId = String(resolved.target?.nodeId || "");
    if (nodeId && (!managed || nodeId !== managed.nodeId)) {
      return this.device?.listTools
        ? await this.device.listTools(request)
        : [];
    }
    // An omitted target selects the account's workspace. Device-only tools
    // require an explicit Device target, just like their execution.
    return await this.sandbox.listTools(request);
  }

  async invoke(input, signal) {
    const invocation = this.resolveInvocation(input);
    const managed = this.managedTarget(invocation.principal);
    if (!managed || invocation.target?.nodeId !== managed.nodeId) {
      if (!this.device?.invoke) {
        throw new Error("The requested Device Node is unavailable");
      }
      return await this.device.invoke(input, signal);
    }
    const args = invocation.toolCall?.arguments || {};
    const terminal = parseTerminalReference(args.session_id);
    if (terminal) {
      await this.terminalService?.validateSessionReference?.(
        args.session_id,
        { principal: invocation.principal, policy: invocation.policy }
      );
    }
    const {
      node_id,
      resource_id,
      session_id,
      execution_environment,
      ...sandboxArgs
    } = args;
    const sandboxInvocation = {
      ...invocation,
      target: undefined,
      toolCall: {
        ...invocation.toolCall,
        arguments: sandboxArgs
      }
    };
    const operation = terminal && invocation.toolCall?.name === "Bash"
      ? (context) => this.terminalService.executeToolCommand({
          ...context,
          sessionId: args.session_id,
          command: args.command,
          timeoutMs: args.timeout || 60_000
        })
      : null;
    return await this.sandbox.invoke(
      sandboxInvocation,
      signal,
      operation,
      {
        nodeId: managed.nodeId,
        resourceId: managed.resourceId,
        ...(terminal ? {
          instanceId: terminal.instanceId,
          sessionId: terminal.sessionId
        } : {})
      }
    );
  }
}

export function managedNodeIdentity(spaceId, binding) {
  return {
    nodeId: stableNodeId(spaceId, binding),
    resourceId: MANAGED_RESOURCE_ID
  };
}
