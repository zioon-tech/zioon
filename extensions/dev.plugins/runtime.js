import {
  PLUGINS_MANAGE_RUNTIME_ACTIONS,
  PLUGINS_MANAGE_TOOL_NAME,
  pluginsManageRuntimeToolDefinition
} from "./plugins-runtime-shared.js";

export const runtimePluginApiVersion = 2;

function requirePluginHostService(context) {
  const service = context.config?.pluginHostService;
  if (!service || typeof service !== "object") {
    throw new Error("Runtime Plugin Host service is unavailable");
  }
  return service;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

export function activateRuntimePlugin(context) {
  const service = requirePluginHostService(context);
  const definition = pluginsManageRuntimeToolDefinition();
  const registration = context.tools.registerTool({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execution: { effect: "process" },
    policy: { minimumPreset: "trusted-automation" },
    async invoke(args = {}, runContext = {}) {
      const action = String(args.action || "").trim();
      try {
        if (!PLUGINS_MANAGE_RUNTIME_ACTIONS.includes(action)) {
          return {
            ok: false,
            content: `Unknown action: ${action}`,
            error: `Unknown action: ${action}`
          };
        }
        const nodeId = String(args.node_id || "").trim();
        if (nodeId && runContext.target?.nodeId && nodeId !== runContext.target.nodeId) {
          throw new Error("Plugin Host node_id conflicts with the requested target");
        }
        if (nodeId) {
          runContext = {
            ...runContext,
            target: { ...runContext.target, nodeId }
          };
        }

        if (action === "list") {
          return {
            ok: true,
            content: json(await service.list({
              limit: args.limit,
              offset: args.offset,
              runContext
            }))
          };
        }
        if (action === "search") {
          return {
            ok: true,
            content: json(await service.search({
              query: args.query,
              limit: args.limit,
              runContext
            }))
          };
        }
        if (action === "listDev") {
          return {
            ok: true,
            content: json(await service.listDev({ runContext }))
          };
        }
        if (action === "startDev") {
          return {
            ok: true,
            content: json(await service.startDev({
              path: args.path,
              runContext
            }))
          };
        }
        return {
          ok: true,
          content: json(await service.stopDev({
            devId: args.devId,
            runContext
          }))
        };
      } catch (error) {
        context.log?.(
          "error",
          `${PLUGINS_MANAGE_TOOL_NAME}:${action || "unknown"} failed: `
            + `${error?.message || error}`
        );
        return {
          ok: false,
          content: `pluginsManage error: ${error?.message || String(error)}`,
          error: error?.message || String(error)
        };
      }
    }
  });

  return {
    dispose() {
      registration.dispose();
    }
  };
}
