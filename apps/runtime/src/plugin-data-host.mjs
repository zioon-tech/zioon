const PLUGIN_DATA_HOSTS = new Set(["auto", "runtime", "node", "managed"]);

export function resolvePluginDataHost({
  host = "auto",
  nodeId = "",
  toolMode = "local"
} = {}) {
  const mode = String(host || "auto").trim().toLowerCase();
  const targetNodeId = String(nodeId || "").trim();
  const runtimeToolMode = String(toolMode || "local").trim().toLowerCase();
  if (!PLUGIN_DATA_HOSTS.has(mode)) {
    throw new Error("Plugin data host must be auto, runtime, node, or managed");
  }
  if (["runtime", "managed"].includes(mode) && targetNodeId) {
    throw new Error(`${mode === "managed" ? "Managed" : "Runtime"}-hosted plugin data must not declare ZION_PLUGIN_DATA_NODE_ID`);
  }
  if (mode === "node") {
    if (!targetNodeId) {
      throw new Error("Node-hosted plugin data requires ZION_PLUGIN_DATA_NODE_ID");
    }
    if (!["node", "sandbox"].includes(runtimeToolMode)) {
      throw new Error("Node-hosted plugin data requires node or sandbox tool mode");
    }
  }
  if (mode === "managed" && runtimeToolMode !== "sandbox") {
    throw new Error("Managed plugin data requires sandbox tool mode");
  }
  const localFiles = !["node", "managed"].includes(mode);
  const locationNodeId = ["runtime", "managed"].includes(mode)
    ? ""
    : targetNodeId;
  return Object.freeze({
    mode,
    localFiles,
    locationNodeId,
    requireNode: mode === "node"
      || (mode === "auto" && runtimeToolMode === "node"),
    ambiguousLegacyRouting: mode === "auto" && Boolean(targetNodeId),
    ...(mode === "managed" ? {
      managed: true,
      accountVolume: true
    } : {})
  });
}
