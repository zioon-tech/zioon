export const PLUGINS_MANAGE_TOOL_NAME = "pluginsManage";

export const PLUGINS_MANAGE_RUNTIME_ACTIONS = Object.freeze([
  "list",
  "search",
  "listDev",
  "startDev",
  "stopDev"
]);

export function pluginsManageRuntimeToolDefinition() {
  return {
    name: PLUGINS_MANAGE_TOOL_NAME,
    description: [
      "Manage the Device-hosted Zion Plugin Host.",
      "Lists or searches available plugin packages and manages plugin development sessions.",
      "Workbench-local enable, disable, install, and uninstall state is not available headlessly."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...PLUGINS_MANAGE_RUNTIME_ACTIONS]
        },
        node_id: {
          type: "string",
          description: "Plugin Host Node from terminalInventory; required when multiple Nodes are registered."
        },
        query: {
          type: "string",
          description: "Search query for the search action."
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 100
        },
        offset: {
          type: "number",
          minimum: 0
        },
        path: {
          type: "string",
          description: "Absolute plugin source directory for startDev."
        },
        devId: {
          type: "string",
          description: "Development session ID for stopDev; omit to stop all sessions."
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  };
}
