import { isAbsolute, relative, resolve } from "node:path";
import { accountError } from "./accounts/account-policy.mjs";

const FILE_TOOL_NAMES = new Set([
  "read",
  "glob",
  "grep",
  "tree",
  "write",
  "edit"
]);
const WRITE_TOOL_NAMES = new Set(["write", "edit"]);

function pathWithin(pathValue, rootValue) {
  const path = resolve(String(pathValue || ""));
  const root = resolve(String(rootValue || ""));
  const difference = relative(root, path);
  return difference === ""
    || (!isAbsolute(difference)
      && difference !== ".."
      && !difference.startsWith("../")
      && !difference.startsWith("..\\"));
}

export class PluginDataToolRouter {
  constructor({
    delegated,
    dataHost,
    locations,
    pluginIds = []
  } = {}) {
    if (!delegated?.invoke || !dataHost?.invoke) {
      throw new Error("Plugin data tool router requires delegated and data hosts");
    }
    if (!locations?.forPlugin || !locations?.containsPath) {
      throw new Error("Plugin data tool router requires data locations");
    }
    this.delegated = delegated;
    this.dataHost = dataHost;
    this.locations = locations;
    this.pluginIds = [...new Set(pluginIds.map(String).filter(Boolean))];
  }

  get supportedToolNames() {
    return this.delegated.supportedToolNames || [];
  }

  getToolDefinitions() {
    return this.delegated.getToolDefinitions?.() || [];
  }

  async listTools(request = {}) {
    return this.delegated.listTools
      ? await this.delegated.listTools(request)
      : [];
  }

  registeredTargets(...args) {
    return this.delegated.registeredTargets?.(...args) || [];
  }

  isOnline(...args) {
    return this.delegated.isOnline?.(...args) ?? false;
  }

  route(invocation) {
    const name = String(invocation?.toolCall?.name || "");
    if (!FILE_TOOL_NAMES.has(name)) {
      return { host: this.delegated, invocation };
    }
    const path = String(invocation.toolCall?.arguments?.path || "");
    if (!isAbsolute(path) || !this.locations.containsPath(path)) {
      return { host: this.delegated, invocation };
    }
    const access = WRITE_TOOL_NAMES.has(name) ? "write" : "read";
    for (const pluginId of this.pluginIds) {
      const binding = this.locations.forPlugin(pluginId, invocation, { access });
      const matched = pathWithin(path, binding.data.root)
        || (access === "read"
          && binding.readFallbacks?.some((location) =>
            pathWithin(path, location.root)
          ));
      if (!matched) continue;
      const args = invocation.toolCall?.arguments || {};
      const requestedNodeId = String(
        invocation.target?.nodeId || args.node_id || ""
      );
      if (requestedNodeId && requestedNodeId !== binding.data.nodeId) {
        throw accountError(
          403,
          "plugin_data_target_denied",
          "Plugin data must use its bound Node"
        );
      }
      if (args.session_id) {
        throw accountError(
          403,
          "plugin_data_terminal_denied",
          "Plugin data file tools must omit terminal session ids"
        );
      }
      return {
        host: this.dataHost,
        invocation: {
          ...invocation,
          ...(binding.data.nodeId
            ? { target: { nodeId: binding.data.nodeId } }
            : {}),
          toolCall: {
            ...invocation.toolCall,
            arguments: {
              ...args,
              _plugin_data: true
            }
          }
        }
      };
    }
    throw accountError(
      403,
      "plugin_data_scope_denied",
      "Plugin data path is outside the authenticated account scope"
    );
  }

  async invoke(invocation, signal) {
    const resolved = this.route(invocation);
    return await resolved.host.invoke(resolved.invocation, signal);
  }
}
