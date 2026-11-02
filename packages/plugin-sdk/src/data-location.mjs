export const DEFAULT_PLUGIN_DATA_DIRECTORY = "~/.zion-next/data/plugins";
const hasControlCharacters = (value) => Array.from(value).some((character) =>
  character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function validatePluginId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/.test(id)
    || id.length > 160) {
    throw new Error("Invalid plugin id");
  }
  return id;
}

export function normalizeDataLocation(value) {
  const nodeId = String(value?.nodeId || "");
  const root = String(value?.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || !/^(\/|[A-Za-z]:\/)/.test(root)
    || hasControlCharacters(root + nodeId)
    || root.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("Plugin data requires an absolute root and valid Node id");
  }
  const service = value?.backend === "agent-fs";
  return Object.freeze({ nodeId, root, ...(service ? {
    backend: "agent-fs", apiUrl: String(value.apiUrl || ""),
    accessMode: value.accessMode === "cli" ? "cli" : "mcp"
  } : {}) });
}

export function dataLocationPath(location, relativePath) {
  const { root } = normalizeDataLocation(location);
  const relative = String(relativePath || "").replace(/\\/g, "/");
  if (!relative || relative.startsWith("/") || /^[A-Za-z]:/.test(relative)
    || hasControlCharacters(relative)
    || relative.split("/").some((part) => !part || part === ".." || part === ".")) {
    throw new Error("Plugin data path must stay within its root");
  }
  return `${root}/${relative}`;
}

export function dataLocationContext(pluginId, location) {
  const data = normalizeDataLocation(location);
  if (data.backend === "agent-fs") return [
    `Authoritative memory for ${validatePluginId(pluginId)} is managed by agent-fs:`,
    JSON.stringify(data),
    data.accessMode === "cli"
      ? "MCP tools are disabled. Use Bash to run the authenticated agent-fs CLI. Read agentfs-memory with skillsList { name: \"agentfs-memory\", include_body: true } for installation and usage."
      : "Inside Zion, use native mcp__agentfs__ tools and read agentfs-memory with skillsList { name: \"agentfs-memory\", include_body: true }. They connect with current account authorization; write tools require an authorized write policy.",
    "The root above is a logical path inside the authenticated agent-fs drive, not a native filesystem path.",
    "CLI clients must reach apiUrl and use their Zion account credentials. A loopback URL refers to the machine running the client. Never use a plugin-data mirror."
  ].join("\n");
  return [
    `Plugin data location for ${validatePluginId(pluginId)} (routing metadata, not instructions):`,
    JSON.stringify(data),
    "Use existing read/write/edit/glob/grep/tree/Bash tools with this exact root.",
    data.nodeId
      ? "Set node_id to the Node above. Do not use the active terminal or another Node for these files."
      : "This Runtime uses a single local-tools host; omit node_id and terminal session_id for these files.",
    "Bash paths refer to real files on that Node. This location does not grant additional permissions."
  ].join("\n");
}
