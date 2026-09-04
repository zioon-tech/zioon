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
    fetchImpl = globalThis.fetch,
    now = () => Date.now()
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async contribute(messages, context) {
    if (context?.request?.metadata?.includeTerminalContext === false) {
      return messages;
    }
    const preferredSessionIds =
      context?.request?.policy?.allowedTerminalSessionIds;
    const inventory = await this.loadInventory({
      signal: context.signal,
      allowedTerminalSessionIds: preferredSessionIds
    });
    if (!inventory.sessions.length) return messages;
    const content = buildTerminalInventoryContextXml(inventory, {
      preferredSessionIds
    });
    return insertAfterLeadingSystem(messages, { role: "user", content });
  }

  async loadInventory({
    signal,
    allowedTerminalSessionIds = [],
    filter = {}
  } = {}) {
    const allowedIds = new Set(allowedTerminalSessionIds || []);
    const [sessionPayload, machinePayload] = await Promise.all([
      this.request("/sessions", signal),
      this.request("/machines", signal).catch(() => ({ machines: [] }))
    ]);
    const sessions = (Array.isArray(sessionPayload?.sessions)
      ? sessionPayload.sessions
      : []
    ).filter((session) => (
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
    const machineProfiles = (Array.isArray(machinePayload?.machines)
      ? machinePayload.machines
      : []
    ).filter((machine) => allowedMachineIds.has(String(machine?.id || "")));
    return buildTerminalInventory(filteredSessions, {
      now: this.now(),
      machineProfiles
    });
  }

  async invokeInventoryTool(args = {}, runContext = {}) {
    const inventory = await this.loadInventory({
      signal: runContext.signal,
      allowedTerminalSessionIds: runContext.policy?.allowedTerminalSessionIds,
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

export function activateRuntimePlugin(context) {
  const provider = new LocalToolsTerminalInventoryContextProvider({
    baseUrl: context?.config?.baseUrl
  });
  if (
    context?.apiVersion >= 2
    && context?.context?.registerProvider
    && context?.tools?.registerTool
  ) {
    const providerRegistration = context.context.registerProvider(provider);
    const toolRegistration = context.tools.registerTool({
      name: "terminalInventory",
      description: "List terminal sessions, workspaces, and machine hints from the local tool host.",
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
    return {
      dispose() {
        providerRegistration.dispose();
        toolRegistration.dispose();
      }
    };
  }
  return {
    contextProviders: [
      provider
    ]
  };
}
