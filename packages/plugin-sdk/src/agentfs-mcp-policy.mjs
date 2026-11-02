// Reviewed execution traits for the pinned agent-fs MCP server. Schemas and
// handlers are discovered from that server, never reimplemented here.
export const AGENTFS_MCP_PREFIX = "mcp__agentfs__";
export const AGENTFS_MCP_READ_TOOLS = Object.freeze([
  "cat", "ls", "stat", "tail", "log", "diff", "grep", "tree", "glob", "find"
]);
export const AGENTFS_MCP_WRITE_TOOLS = Object.freeze([
  "write", "edit", "append", "rm", "cp", "mv", "revert"
]);
export const AGENTFS_MCP_READ_NAMES = Object.freeze(
  AGENTFS_MCP_READ_TOOLS.map((name) => `${AGENTFS_MCP_PREFIX}${name}`)
);
const reads = new Set(AGENTFS_MCP_READ_TOOLS);
const writes = new Set(AGENTFS_MCP_WRITE_TOOLS);
export function agentFsMcpEffect(name) {
  return reads.has(name) ? "read" : writes.has(name) ? "write" : null;
}

export function agentFsMcpPaths(name, args = {}) {
  if (!agentFsMcpEffect(name)) throw new Error("Unsupported agent-fs MCP tool");
  const paths = ["cp", "mv"].includes(name)
    ? [args.from, args.to] : [args.path ?? "/"];
  return paths.map((path) => {
    if (typeof path !== "string" || !path.startsWith("/")
      || path.includes("\\") || path.includes("\0")
      || path.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error("Invalid agent-fs path");
    }
    // Match the upstream's slash normalization before checking grants.
    return `/${path.split("/").filter(Boolean).join("/")}`;
  });
}
