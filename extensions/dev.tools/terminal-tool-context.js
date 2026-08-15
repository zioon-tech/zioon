export const TERMINAL_AWARE_TOOL_NAMES = Object.freeze(["tree", "read", "write", "edit", "glob", "grep", "Bash"]);
const TERMINAL_AWARE_TOOLS = new Set(TERMINAL_AWARE_TOOL_NAMES);

export function resolveTerminalToolArgs(toolName, args, activeSessionId) {
  if (!TERMINAL_AWARE_TOOLS.has(String(toolName || ""))) return args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  if (args.session_id !== undefined) return args;
  const sessionId = String(activeSessionId || "").trim();
  return sessionId ? { ...args, session_id: sessionId } : args;
}

export function createTerminalToolExecutionContext(args, terminalSessions = []) {
  const sessionId = String(args?.session_id || "").trim();
  if (!sessionId) return null;
  const session = (Array.isArray(terminalSessions) ? terminalSessions : [])
    .find((item) => String(item?.id || "").trim() === sessionId);
  const snapshot = session ? {
    id: sessionId,
    type: String(session.type || "local").trim() || "local",
    cwd: String(session.cwd || session.initial_cwd || "").trim(),
    ssh_host: String(session.ssh_host || session.host || "").trim(),
    ssh_user: String(session.ssh_user || session.user || "").trim(),
    ssh_port: session.ssh_port || session.port || null
  } : { id: sessionId, type: "local" };
  return {
    sourceId: `terminal:${sessionId}`,
    cwd: snapshot.cwd || "",
    terminalSession: snapshot
  };
}
