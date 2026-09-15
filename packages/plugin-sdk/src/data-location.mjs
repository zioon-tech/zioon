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
  return Object.freeze({ nodeId, root });
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
