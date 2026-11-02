import {
  buildTerminalInventory,
  buildTerminalInventoryContextXml,
  filterTerminalSessions
} from "./terminal-inventory.js";

export const runtimePluginApiVersion = 2;

function insertAfterLeadingSystem(messages, injectedMessage) {
  const list = Array.isArray(messages) ? messages : [];
  let index = 0;
  while (index < list.length && list[index]?.role === "system") index += 1;
  return [
    ...list.slice(0, index),
    injectedMessage,
    ...list.slice(index)
  ];
}

async function responsePayload(response) {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class LocalToolsTerminalInventoryContextProvider {
  id = "dev.terminal-manager.inventory";
  stage = "pre";
  order = 55;

  constructor({
    baseUrl = "http://127.0.0.1:8765",
    service = null,
    fetchImpl = globalThis.fetch,
    now = () => Date.now()
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.service = service;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async contribute(messages, context) {
    const baseMessages = messages.filter((message) => message.contextProviderId !== this.id);
    if (context?.request?.metadata?.includeTerminalContext === false) {
      return baseMessages.length === messages.length ? messages : baseMessages;
    }
    const content = buildTerminalInventoryContextXml();
    return insertAfterLeadingSystem(baseMessages, {
      role: "user", content, contextProviderId: this.id
    });
  }

  async loadInventory({
    signal,
    allowedTerminalSessionIds = [],
    filter = {},
    projectId = "",
    target = null,
    sessionId = "",
    runId = "",
    attemptId = "",
    principal = null
  } = {}) {
    const allowedIds = new Set(allowedTerminalSessionIds || []);
    const runContext = {
      signal,
      projectId,
      sessionId,
      runId,
      attemptId,
      ...(principal ? { principal } : {}),
      ...(target?.nodeId ? { target: { nodeId: String(target.nodeId) } } : {}),
      policy: { allowedTerminalSessionIds }
    };
    const snapshot = this.service?.listInventory
      ? await this.service.listInventory({ runContext })
      : null;
    const [loadedSessions, machineProfiles] = snapshot
      ? [snapshot.sessions, snapshot.machines]
      : this.service
      ? await Promise.all([
          this.service.listSessions({ runContext }),
          this.service.listMachines({ runContext }).catch(() => [])
        ])
      : await Promise.all([
          this.request("/sessions", signal)
            .then((payload) => Array.isArray(payload?.sessions)
              ? payload.sessions
              : []),
          this.request("/machines", signal)
            .then((payload) => Array.isArray(payload?.machines)
              ? payload.machines
              : [])
            .catch(() => [])
        ]);
    const sessions = snapshot ? loadedSessions : loadedSessions.filter((session) => (
      !allowedIds.size || allowedIds.has(String(session?.id || ""))
    ));
    const filteredSessions = filterTerminalSessions(sessions, {
      ...filter,
      now: this.now()
    });
    const scopedInventory = buildTerminalInventory(filteredSessions, {
      now: this.now()
    });
    const allowedMachineIds = new Set(
      scopedInventory.machines.map((machine) => machine.id)
    );
    const scopedMachineProfiles = machineProfiles
      .filter((machine) => !allowedIds.size || allowedMachineIds.has(String(machine?.id || "")));
    return { ...buildTerminalInventory(filteredSessions, {
      now: this.now(),
      machineProfiles: scopedMachineProfiles
    }), nodes: snapshot?.nodes || [] };
  }

  async invokeInventoryTool(args = {}, runContext = {}) {
    const inventory = await this.loadInventory({
      signal: runContext.signal,
      allowedTerminalSessionIds: runContext.policy?.allowedTerminalSessionIds,
      projectId: runContext.projectId,
      sessionId: runContext.sessionId,
      runId: runContext.runId,
      attemptId: runContext.attemptId,
      principal: runContext.principal,
      target: runContext.target,
      filter: {
        machine_id: args.machine_id,
        workspace_id: args.workspace_id,
        status: args.status
      }
    });
    return {
      ok: true,
      content: JSON.stringify(inventory, null, 2)
    };
  }

  async request(path, signal) {
    signal.throwIfCancelled();
    const controller = new globalThis.AbortController();
    const cancellation = signal.onCancel(() => controller.abort());
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      const payload = await responsePayload(response);
      const applicationError = payload && typeof payload === "object"
        ? payload.error
        : "";
      if (!response.ok || applicationError) {
        const detail = String(
          applicationError
          || payload?.detail
          || payload
          || `HTTP ${response.status}`
        );
        throw new Error(`local-tools ${path} failed: ${detail}`);
      }
      return payload;
    } finally {
      cancellation.dispose();
    }
  }
}

function terminalManageToolDefinition() {
  return {
    name: "terminalManage",
    description: "Manage terminal sessions, workspaces, and machine descriptions on the paired Device.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "list",
            "get",
            "close",
            "reactivate",
            "set_cwd",
            "list_machines",
            "get_machine",
            "update_machine"
          ]
        },
        type: { type: "string", enum: ["local", "ssh"] },
        ssh_user: { type: "string" },
        ssh_host: { type: "string" },
        ssh_port: { type: "number" },
        initial_cwd: { type: "string" },
        session_id: { type: "string" },
        node_id: { type: "string", description: "Target Node from terminalInventory, required for create when no machine/workspace selects a unique Node." },
        resource_id: { type: "string", description: "Target resource binding when the Node has multiple resources." },
        cwd: { type: "string" },
        machine_id: { type: "string" },
        name: { type: "string", maxLength: 120 },
        description: { type: "string", maxLength: 500 },
        workspace_id: { type: "string" },
        status: {
          type: "string",
          enum: ["connected", "disconnected", "stale"]
        },
        limit: { type: "number", minimum: 1, maximum: 200 }
      },
      required: ["action"],
      additionalProperties: false
    }
  };
}

function runtimeFields(runContext = {}) {
  return {
    signal: runContext.signal,
    allowedTerminalSessionIds: runContext.policy?.allowedTerminalSessionIds,
    projectId: runContext.projectId,
    sessionId: runContext.sessionId,
    runId: runContext.runId,
    attemptId: runContext.attemptId,
    principal: runContext.principal,
    target: runContext.target
  };
}

function limited(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(number)));
}

function allowedSessionIds(runContext = {}) {
  return new Set(
    (Array.isArray(runContext.policy?.allowedTerminalSessionIds)
      ? runContext.policy.allowedTerminalSessionIds
      : [])
      .map(String)
      .filter(Boolean)
  );
}

function requireAllowedSessionId(value, runContext) {
  const sessionId = String(value || "").trim();
  if (!sessionId) throw new Error("terminalManage requires session_id");
  const allowed = allowedSessionIds(runContext);
  if (allowed.size && !allowed.has(sessionId)) {
    throw new Error(`Terminal session is outside the active policy: ${sessionId}`);
  }
  return sessionId;
}

async function invokeTerminalManage({
  args = {},
  runContext = {},
  provider,
  service
}) {
  if (!service) throw new Error("Runtime terminal management service is unavailable");
  const action = String(args.action || "").trim();
  const serviceContext = { runContext };

  if (action === "list") {
    const inventory = await provider.loadInventory({
      ...runtimeFields(runContext),
      filter: {
        machine_id: args.machine_id,
        workspace_id: args.workspace_id,
        status: args.status
      }
    });
    const limit = limited(args.limit, 20, 50);
    const sessions = inventory.sessions.slice(0, limit).map((session) => ({
      session_id: session.id,
      id: session.id,
      session_type: session.type,
      machine_id: session.machineId,
      workspace_id: session.workspaceId,
      node_id: session.nodeId,
      cwd: session.cwd,
      connection_status: session.connectionStatus,
      stale: session.stale,
      last_activity_at: session.lastActivityAt
    }));
    return {
      session_id_field: "Use sessions[].session_id for terminal and file tools.",
      total: inventory.sessions.length,
      returned: sessions.length,
      truncated: inventory.sessions.length > sessions.length,
      sessions
    };
  }
  if (action === "get") {
    const sessionId = requireAllowedSessionId(args.session_id, runContext);
    return {
      session: await service.getSession({
        sessionId,
        ...serviceContext
      })
    };
  }
  if (action === "list_machines") {
    const scoped = allowedSessionIds(runContext).size
      ? await provider.loadInventory(runtimeFields(runContext))
      : null;
    const machines = scoped?.machines
      || await service.listMachines(serviceContext);
    const limit = limited(args.limit, 100, 200);
    return {
      total: machines.length,
      returned: Math.min(machines.length, limit),
      truncated: machines.length > limit,
      machines: machines.slice(0, limit)
    };
  }
  if (action === "get_machine") {
    if (allowedSessionIds(runContext).size) {
      const inventory = await provider.loadInventory(runtimeFields(runContext));
      if (!inventory.machines.some((item) => item.id === args.machine_id)) {
        throw new Error("Machine is outside the active terminal policy");
      }
    }
    return {
      machine: await service.getMachine({
        machineId: args.machine_id,
        ...serviceContext
      })
    };
  }
  if (action === "update_machine") {
    if (allowedSessionIds(runContext).size) {
      const inventory = await provider.loadInventory(runtimeFields(runContext));
      if (!inventory.machines.some((item) => item.id === args.machine_id)) {
        throw new Error("Machine is outside the active terminal policy");
      }
    }
    const current = await service.getMachine({
      machineId: args.machine_id,
      ...serviceContext
    });
    return {
      machine: await service.updateMachine({
        machineId: args.machine_id,
        name: args.name || current?.name,
        description: args.description || current?.description,
        kind: current?.kind,
        ...serviceContext
      })
    };
  }
  if (action === "create") {
    const inventory = await provider.loadInventory(runtimeFields(runContext));
    const machine = inventory.machines.find(
      (item) => item.id === String(args.machine_id || "")
    );
    const workspace = inventory.workspaces.find(
      (item) => item.id === String(args.workspace_id || "")
    );
    if (args.machine_id && !machine) throw new Error("Unknown machine_id; refresh terminalInventory");
    if (args.workspace_id && !workspace) throw new Error("Unknown workspace_id; refresh terminalInventory");
    if (machine && workspace && machine.id !== workspace.machineId) {
      throw new Error("machine_id and workspace_id refer to different machines");
    }
    const targetMachine = machine || inventory.machines.find((item) => item.id === workspace?.machineId);
    if (args.node_id && targetMachine?.nodeId && args.node_id !== targetMachine.nodeId) {
      throw new Error("node_id conflicts with machine/workspace");
    }
    if (
      allowedSessionIds(runContext).size
      && !machine
      && !workspace
    ) {
      throw new Error(
        "terminalManage create requires an allowed machine_id or workspace_id"
      );
    }
    const type = String(targetMachine?.kind || args.type || "local") === "ssh"
      ? "ssh"
      : "local";
    return {
      session: await service.createSession({
        payload: {
          type,
          node_id: targetMachine?.nodeId || args.node_id,
          resource_id: workspace?.resourceId || args.resource_id,
          initial_cwd: workspace?.root || args.initial_cwd || args.cwd,
          ...(type === "ssh"
            ? {
                ssh_host: targetMachine?.connection?.host || args.ssh_host,
                ssh_user: targetMachine?.connection?.user || args.ssh_user,
                ssh_port: Number(
                  targetMachine?.connection?.port || args.ssh_port || 22
                ) || 22
              }
            : {})
        },
        ...serviceContext
      })
    };
  }
  if (action === "close") {
    const sessionId = requireAllowedSessionId(args.session_id, runContext);
    return service.closeSession({
      sessionId,
      ...serviceContext
    });
  }
  if (action === "reactivate") {
    const sessionId = requireAllowedSessionId(args.session_id, runContext);
    return {
      session: await service.reactivateSession({
        sessionId,
        ...serviceContext
      })
    };
  }
  if (action === "set_cwd") {
    const sessionId = requireAllowedSessionId(args.session_id, runContext);
    return service.setSessionCwd({
      sessionId,
      cwd: args.cwd,
      ...serviceContext
    });
  }
  throw new Error(`Unknown terminalManage action: ${action}`);
}

export function activateRuntimePlugin(context) {
  const terminalManagementService =
    context?.config?.terminalManagementService || null;
  const provider = new LocalToolsTerminalInventoryContextProvider({
    baseUrl: context?.config?.baseUrl,
    service: terminalManagementService
  });
  if (
    context?.apiVersion >= 2
    && context?.context?.registerProvider
    && context?.tools?.registerTool
  ) {
    const providerRegistration = context.context.registerProvider(provider);
    const inventoryToolRegistration = context.tools.registerTool({
      name: "terminalInventory",
      description: "Query current terminal sessions, workspaces, machines, and Nodes when routing or availability is needed. Live state is not embedded in automatic context.",
      execution: { effect: "read" },
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Optional machine_id filter."
          },
          workspace_id: {
            type: "string",
            description: "Optional workspace_id filter."
          },
          status: {
            type: "string",
            enum: ["connected", "disconnected", "stale"],
            description: "Optional connection status filter."
          }
        },
        additionalProperties: false
      },
      policy: {
        minimumPreset: "read-only"
      },
      invoke: (args, runContext) =>
        provider.invokeInventoryTool(args, runContext)
    });
    const manageDefinition = terminalManageToolDefinition();
    const manageToolRegistration = context.tools.registerTool({
      ...manageDefinition,
      execution: { effect: "process" },
      policy: {
        minimumPreset: "trusted-automation"
      },
      async invoke(args, runContext) {
        try {
          return {
            ok: true,
            content: JSON.stringify(await invokeTerminalManage({
              args,
              runContext,
              provider,
              service: terminalManagementService
            }), null, 2)
          };
        } catch (error) {
          return {
            ok: false,
            content: `terminalManage error: ${error?.message || String(error)}`,
            error: error?.message || String(error)
          };
        }
      }
    });
    return {
      dispose() {
        providerRegistration.dispose();
        manageToolRegistration.dispose();
        inventoryToolRegistration.dispose();
      }
    };
  }
  return {
    contextProviders: [
      provider
    ]
  };
}
