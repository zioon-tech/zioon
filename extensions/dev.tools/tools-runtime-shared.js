export const TOOLS_MANAGE_TOOL_NAME = "toolsManage";
export const TOOLS_MANAGE_ACTIONS = [
  "list",
  "get",
  "enable",
  "disable",
  "set_enabled",
  "sync"
];

const WORKSPACE_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "memoryManage",
  "agentsManage",
  "identityManage",
  "projectAutomationManage",
  "sessionCreate",
  "sessionUpdate",
  "sessionDelete"
]);

const TRUSTED_AUTOMATION_TOOLS = new Set([
  "Bash",
  "sendMail",
  "todoWrite",
  "mcpCall",
  "extensionsCall",
  "schedulerManage",
  "modelsManage",
  "toolsManage",
  "pluginsManage",
  "terminalManage",
  "mailManage"
]);

export function toolsManageToolDefinition() {
  return {
    name: TOOLS_MANAGE_TOOL_NAME,
    description: "Manage Runtime InteractionProfile tool enablement. list/get inspect Runtime capability tools; enable/disable/set_enabled update the selected Runtime profile.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: TOOLS_MANAGE_ACTIONS,
          description: "Management action"
        },
        name: {
          type: "string",
          description: "Tool name for get/enable/disable"
        },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Tool names for enable/disable/set_enabled"
        },
        interaction_profile_id: {
          type: "string",
          description: "Runtime InteractionProfile id. Defaults to interactive.default."
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  };
}

export function uniqueToolNames(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  ));
}

export function namesFromToolArgs(args = {}) {
  return uniqueToolNames([
    ...(typeof args.name === "string" ? [args.name] : []),
    ...(Array.isArray(args.names) ? args.names : [])
  ]);
}

export function inferToolPolicyPatch(enabledNames = [], currentPolicy = {}) {
  const allowedTools = uniqueToolNames(enabledNames);
  const trusted = allowedTools.some((name) => TRUSTED_AUTOMATION_TOOLS.has(name));
  const workspaceWrite = allowedTools.some((name) => WORKSPACE_WRITE_TOOLS.has(name));
  return {
    preset: trusted
      ? "trusted-automation"
      : workspaceWrite
        ? "workspace-write"
        : "read-only",
    allowedTools,
    allowedRecipients: allowedTools.includes("sendMail")
      ? (
          Array.isArray(currentPolicy.allowedRecipients)
            ? currentPolicy.allowedRecipients.map(String).filter(Boolean)
            : ["*"]
        )
      : [],
    maxMailPerRun: allowedTools.includes("sendMail")
      ? Math.max(1, Number(currentPolicy.maxMailPerRun || 10))
      : 0
  };
}

export function summarizeTool(tool = {}, enabledSet = new Set()) {
  const name = String(tool.name || tool?.function?.name || "").trim();
  if (!name) return null;
  return {
    name,
    description: String(tool.description || tool?.function?.description || ""),
    enabled: enabledSet.has(name),
    inputSchema: tool.inputSchema || tool?.function?.parameters || null,
    hostKinds: Array.isArray(tool.hostKinds) ? tool.hostKinds.map(String) : [],
    ...(tool.pluginId ? { pluginId: String(tool.pluginId) } : {}),
    ...(tool.owner ? { owner: tool.owner } : {}),
    ...(tool.availability ? { availability: tool.availability } : {}),
    ...(tool.policy ? { policy: tool.policy } : {})
  };
}
