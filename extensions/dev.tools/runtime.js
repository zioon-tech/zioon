import {
  TOOLS_MANAGE_ACTIONS,
  TOOLS_MANAGE_TOOL_NAME,
  inferToolPolicyPatch,
  namesFromToolArgs,
  summarizeTool,
  toolsManageToolDefinition,
  uniqueToolNames
} from "./tools-runtime-shared.js";

export const runtimePluginApiVersion = 2;

const DEFAULT_PROFILE_ID = "interactive.default";

function requireToolService(context) {
  const service = context.config?.toolService;
  if (!service || typeof service !== "object") {
    throw new Error("Runtime tool management service is unavailable");
  }
  return service;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function profileIdFromArgs(args = {}) {
  return String(args.interaction_profile_id || DEFAULT_PROFILE_ID).trim() || DEFAULT_PROFILE_ID;
}

function toolMapFromList(tools = []) {
  return new Map(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => [String(tool?.name || "").trim(), tool])
      .filter(([name]) => !!name)
  );
}

function requireKnownNames(requested, availableMap) {
  const unknown = requested.filter((name) => !availableMap.has(name));
  if (unknown.length) {
    const error = new Error(`Unknown Runtime tool(s): ${unknown.join(", ")}`);
    error.unknown = unknown;
    throw error;
  }
}

function enabledSetFromProfile(profile = {}) {
  return new Set(
    Array.isArray(profile.policy?.allowedTools)
      ? profile.policy.allowedTools.map(String).filter(Boolean)
      : []
  );
}

export function activateRuntimePlugin(context) {
  const service = requireToolService(context);
  const definition = toolsManageToolDefinition();
  const registration = context.tools.registerTool({
    name: TOOLS_MANAGE_TOOL_NAME,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execution: { effect: "write" },
    policy: { minimumPreset: "trusted-automation" },
    async invoke(args = {}) {
      try {
        const action = String(args.action || "").trim();
        if (!TOOLS_MANAGE_ACTIONS.includes(action)) {
          return { ok: false, content: `Unknown action: ${action}`, error: `Unknown action: ${action}` };
        }

        const interactionProfileId = profileIdFromArgs(args);
        const [tools, profile] = await Promise.all([
          service.listTools(),
          service.getProfile(interactionProfileId)
        ]);
        if (!profile) {
          return {
            ok: false,
            content: `InteractionProfile not found: ${interactionProfileId}`,
            error: `InteractionProfile not found: ${interactionProfileId}`
          };
        }
        const available = toolMapFromList(tools);
        const enabledSet = enabledSetFromProfile(profile);

        if (action === "list" || action === "sync") {
          const summaries = Array.from(available.values())
            .map((tool) => summarizeTool(tool, enabledSet))
            .filter(Boolean)
            .sort((left, right) => left.name.localeCompare(right.name));
          return {
            ok: true,
            content: json({
              interactionProfileId,
              tools: summaries,
              enabled: uniqueToolNames(Array.from(enabledSet)).filter((name) => available.has(name)),
              unknownEnabled: uniqueToolNames(Array.from(enabledSet)).filter((name) => !available.has(name))
            })
          };
        }

        if (action === "get") {
          const name = String(args.name || "").trim();
          if (!name) return { ok: false, content: "Missing name", error: "Missing name" };
          const tool = available.get(name);
          if (!tool) return { ok: false, content: `Tool not found: ${name}`, error: `Tool not found: ${name}` };
          return {
            ok: true,
            content: json({
              interactionProfileId,
              tool: summarizeTool(tool, enabledSet)
            })
          };
        }

        const requested = namesFromToolArgs(args);
        if (action !== "set_enabled" && requested.length === 0) {
          return { ok: false, content: "No tool names provided", error: "No tool names provided" };
        }
        requireKnownNames(requested, available);

        let nextEnabled = uniqueToolNames(Array.from(enabledSet)).filter((name) => available.has(name));
        if (action === "enable") {
          nextEnabled = uniqueToolNames([...nextEnabled, ...requested]);
        } else if (action === "disable") {
          const disabled = new Set(requested);
          nextEnabled = nextEnabled.filter((name) => !disabled.has(name));
        } else if (action === "set_enabled") {
          nextEnabled = uniqueToolNames(requested);
        }

        const patch = inferToolPolicyPatch(nextEnabled, profile.policy || {});
        const updated = await service.patchProfile(interactionProfileId, {
          policy: patch,
          metadata: {
            toolSelectionUserManaged: true
          }
        });
        return {
          ok: true,
          content: json({
            interactionProfileId,
            enabled: updated.policy?.allowedTools || nextEnabled,
            policy: updated.policy
          })
        };
      } catch (error) {
        context.log?.("error", `${TOOLS_MANAGE_TOOL_NAME} failed: ${error?.message || error}`);
        return {
          ok: false,
          content: `toolsManage error: ${error?.message || String(error)}`,
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
