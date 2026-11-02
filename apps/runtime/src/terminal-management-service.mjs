import { createDeviceServiceClient } from "./device-service-client.mjs";
import { CancellationController } from "../../../packages/runtime/dist/index.js";
import { DEVICE_SERVICE_TOOL_NAME } from "./node-service-routing.mjs";
import {
  machineReference,
  parseMachineReference
} from "../../../packages/node-protocol/src/resource-references.mjs";
import { buildTerminalInventory } from "../../../extensions/dev.terminal-manager/terminal-inventory.js";

function text(value) {
  return String(value ?? "").trim();
}

function requireValue(value, name) {
  const result = text(value);
  if (!result) throw new Error(`terminalManage requires ${name}`);
  return result;
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;
}

export function createTerminalManagementService({
  baseUrl = "http://127.0.0.1:8765",
  nodeBroker = null,
  managedSandbox = null,
  fetchImpl = globalThis.fetch,
  inventoryTimeoutMs = 3000
} = {}) {
  const { request } = createDeviceServiceClient({
    service: "local-tools",
    baseUrl,
    nodeBroker,
    fetchImpl
  });

  async function listDeviceInventory({ runContext = {} } = {}) {
    if (!nodeBroker?.registeredTargets) {
      if (managedSandbox) return { sessions: [], machines: [], nodes: [] };
      const [sessions, machines] = await Promise.all([
        request("/sessions", { runContext }),
        request("/machines", { runContext }).catch(() => null)
      ]);
      return {
        sessions: Array.isArray(sessions?.sessions) ? sessions.sessions : [],
        machines: Array.isArray(machines?.machines) ? machines.machines : [],
        nodes: []
      };
    }
    let targets = nodeBroker.registeredTargets(runContext.projectId, DEVICE_SERVICE_TOOL_NAME)
      .filter(({ node, resource }) =>
        (!runContext.target?.nodeId || node.registration.nodeId === runContext.target.nodeId)
        && (!runContext.target?.resourceId || resource?.resourceId === runContext.target.resourceId)
      )
      .filter((target) => {
        try {
          nodeBroker.policyForTarget(runContext.policy, target, runContext.projectId);
          return true;
        } catch {
          return false;
        }
      });
    if (nodeBroker.authorizeExecutionTarget) {
      const authorized = [];
      for (const target of targets) {
        try {
          await nodeBroker.authorizeExecutionTarget(runContext, target);
          authorized.push(target);
        } catch (error) {
          if (error?.code !== "platform_node_execution_denied") throw error;
        }
      }
      targets = authorized;
    }
    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        const { registration } = target.node;
        const summary = {
          nodeId: registration.nodeId,
          label: registration.label || registration.nodeId,
          resourceId: target.resource?.resourceId,
          status: nodeBroker.isOnline(target.node) ? "online" : "offline"
        };
        const localMachine = {
          id: machineReference(registration.nodeId, "machine:local"),
          name: summary.label,
          kind: "local",
          nodeId: registration.nodeId,
          nodeLabel: summary.label
        };
        const result = { sessions: [], machines: [localMachine], node: summary };
        results.push(result);
        if (summary.status === "offline") continue;
        const controller = new CancellationController();
        const cancel = runContext.signal?.onCancel((reason) => controller.cancel(reason));
        const timer = setTimeout(() => controller.cancel("terminal-inventory-timeout"), inventoryTimeoutMs);
        const context = {
          ...runContext,
          signal: controller.signal,
          target: {
            nodeId: registration.nodeId,
            instanceId: registration.instanceId,
            resourceId: target.resource?.resourceId
          }
        };
        try {
          const [sessions, machines] = await Promise.all([
            request("/sessions", { runContext: context }),
            request("/machines", { runContext: context }).catch(() => null)
          ]);
          result.sessions = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
          result.machines = Array.isArray(machines?.machines) ? machines.machines : [];
          if (!result.machines.some((machine) => machine.id === localMachine.id)) {
            result.machines.push(localMachine);
          }
        } catch (error) {
          summary.status = "unavailable";
          summary.error = error?.message || String(error);
        } finally {
          clearTimeout(timer);
          cancel?.dispose();
          controller.cancel("inventory-complete");
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
    runContext.signal?.throwIfCancelled();
    const unique = (items) => [...new Map(items.map((item) => [item.id, item])).values()];
    return {
      sessions: unique(results.flatMap((result) => result.sessions)),
      machines: unique(results.flatMap((result) => result.machines)),
      nodes: results.map((result) => result.node)
    };
  }

  async function listInventory({ runContext = {} } = {}) {
    const requestedNodeId = String(runContext.target?.nodeId || "");
    const managedSelected = managedSandbox && (
      !requestedNodeId
      || managedSandbox.isManagedNode(requestedNodeId, runContext.principal)
    );
    const deviceSelected = !requestedNodeId || !managedSelected;
    const [managed, device] = await Promise.all([
      managedSelected
        ? managedSandbox.listInventory({ runContext })
        : { sessions: [], machines: [], nodes: [] },
      deviceSelected
        ? listDeviceInventory({ runContext })
        : { sessions: [], machines: [], nodes: [] }
    ]);
    const unique = (items) => [
      ...new Map(items.map((item) => [item.id, item])).values()
    ];
    return {
      sessions: unique([...managed.sessions, ...device.sessions]),
      machines: unique([...managed.machines, ...device.machines]),
      nodes: [
        ...managed.nodes,
        ...device.nodes.filter((item) =>
          !managed.nodes.some((managedNode) =>
            managedNode.nodeId === item.nodeId
          )
        )
      ]
    };
  }

  return Object.freeze({
    listInventory,
    async listSessions(options = {}) {
      return (await listInventory(options)).sessions;
    },
    async listMachines({ runContext = {} } = {}) {
      return (await listInventory({ runContext })).machines;
    },

    async getSession({ sessionId, runContext = {} } = {}) {
      const id = requireValue(sessionId, "session_id");
      if (managedSandbox?.isManagedSession(id, runContext.principal)) {
        return await managedSandbox.getSession({
          sessionId: id,
          runContext
        });
      }
      const payload = await request(
        `/sessions/${encodeURIComponent(id)}`,
        { runContext }
      );
      return payload?.session || payload;
    },

    async createSession({ payload, runContext = {} } = {}) {
      if (runContext.policy?.allowedTerminalSessionIds?.length) {
        throw new Error("Creating a terminal would expand the active session allowlist; use an Owner-approved unrestricted management request");
      }
      const { node_id, resource_id, ...body } = payload || {};
      if (
        (node_id && runContext.target?.nodeId && node_id !== runContext.target.nodeId)
        || (resource_id && runContext.target?.resourceId && resource_id !== runContext.target.resourceId)
      ) {
        throw new Error("Terminal creation target conflicts with the request");
      }
      const requestedNodeId = String(
        node_id || runContext.target?.nodeId || ""
      );
      if (
        managedSandbox
        && (
          !requestedNodeId
          || managedSandbox.isManagedNode(
            requestedNodeId,
            runContext.principal
          )
        )
      ) {
        return await managedSandbox.createSession({
          payload,
          runContext
        });
      }
      const response = await request("/sessions", {
        method: "POST",
        body,
        runContext: {
          ...runContext,
          ...((node_id || resource_id) ? {
            target: {
              ...runContext.target,
              ...(node_id ? { nodeId: node_id } : {}),
              ...(resource_id ? { resourceId: resource_id } : {})
            }
          } : {})
        }
      });
      return response?.session || response;
    },

    async closeSession({ sessionId, runContext = {} } = {}) {
      const id = requireValue(sessionId, "session_id");
      if (managedSandbox?.isManagedSession(id, runContext.principal)) {
        return await managedSandbox.closeSession({
          sessionId: id,
          runContext
        });
      }
      await request(`/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        runContext
      });
      return { closed: true, session_id: id };
    },

    async reactivateSession({ sessionId, runContext = {} } = {}) {
      const id = requireValue(sessionId, "session_id");
      if (managedSandbox?.isManagedSession(id, runContext.principal)) {
        return await managedSandbox.reactivateSession({
          sessionId: id,
          runContext
        });
      }
      const payload = await request(
        `/sessions/${encodeURIComponent(id)}/activate`,
        {
          method: "POST",
          body: {},
          runContext
        }
      );
      return payload?.session || payload;
    },

    async setSessionCwd({ sessionId, cwd, runContext = {} } = {}) {
      const id = requireValue(sessionId, "session_id");
      const nextCwd = requireValue(cwd, "cwd");
      if (managedSandbox?.isManagedSession(id, runContext.principal)) {
        return await managedSandbox.setSessionCwd({
          sessionId: id,
          cwd: nextCwd,
          runContext
        });
      }
      await request(`/sessions/${encodeURIComponent(id)}/exec`, {
        method: "POST",
        body: { command: `cd -- ${shellQuote(nextCwd)}` },
        runContext
      });
      return { updated: true, session_id: id, cwd: nextCwd };
    },

    async getMachine({ machineId, runContext = {} } = {}) {
      const id = requireValue(machineId, "machine_id");
      const reference = parseMachineReference(id);
      if (
        reference
        && managedSandbox?.isManagedNode(
          reference.nodeId,
          runContext.principal
        )
      ) {
        const inventory = await managedSandbox.listInventory({ runContext });
        const machine = inventory.machines.find((item) => item.id === id);
        if (!machine) throw new Error("Managed machine not found");
        return machine;
      }
      try {
        const payload = await request(
          `/machines/${encodeURIComponent(id)}`,
          { runContext }
        );
        return payload?.machine || payload;
      } catch (error) {
        if (error?.statusCode !== 404) throw error;
        const inventory = await listInventory({ runContext });
        const machine = buildTerminalInventory(inventory.sessions, {
          machineProfiles: inventory.machines
        }).machines.find((item) => item.id === id);
        if (!machine) throw error;
        return machine;
      }
    },

    async updateMachine({
      machineId,
      name,
      description,
      kind,
      runContext = {}
    } = {}) {
      const id = requireValue(machineId, "machine_id");
      const reference = parseMachineReference(id);
      if (
        reference
        && managedSandbox?.isManagedNode(
          reference.nodeId,
          runContext.principal
        )
      ) {
        throw new Error("Managed machine metadata is controlled by Runtime");
      }
      const payload = await request(
        `/machines/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: {
            ...(text(name) ? { name: text(name) } : {}),
            ...(text(description) ? { description: text(description) } : {}),
            ...(text(kind) ? { kind: text(kind) } : {})
          },
          runContext
        }
      );
      return payload?.machine || payload;
    },

    async handleRequest(input = {}) {
      return await managedSandbox?.handleRequest?.(input) || null;
    }
  });
}
