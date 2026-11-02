export const TERMINAL_AWARE_TOOL_NAMES = Object.freeze(["tree", "read", "write", "edit", "glob", "grep", "Bash", "terminalExecute"]);
const TERMINAL_AWARE_TOOLS = new Set(TERMINAL_AWARE_TOOL_NAMES);

function isConnectedSession(session) {
  const status = String(session?.connectionStatus || session?.connection_status || "").trim();
  if (status) return status === "connected";
  return session?.active !== false;
}

function summarizeAvailableSessionIds(terminalSessions = []) {
  const sessions = Array.isArray(terminalSessions) ? terminalSessions : [];
  const connected = sessions.filter(isConnectedSession);
  const source = connected.length ? connected : sessions;
  return source
    .map((session) => String(session?.id || "").trim())
    .filter(Boolean)
    .slice(0, 5);
}

function sessionIdHelp(terminalSessions = []) {
  const available = summarizeAvailableSessionIds(terminalSessions);
  if (available.length) {
    return ` Use one of the current terminal session_ids: ${available.join(", ")}.`;
  }
  return ` Use terminal_inventory workspace preferred_session_id, or call terminalManage with action="list" to choose a terminal session.`;
}

export function getTerminalSessionRequirementError(toolName, args, terminalSessions = []) {
  const name = String(toolName || "");
  if (!TERMINAL_AWARE_TOOLS.has(name)) return "";
  const sessionId = String(args?.session_id || "").trim();
  if (!sessionId) {
    return `Missing session_id for ${name}.${sessionIdHelp(terminalSessions)}`;
  }
  const sessions = Array.isArray(terminalSessions) ? terminalSessions : [];
  const knownSessionIds = new Set(sessions.map((session) => String(session?.id || "").trim()).filter(Boolean));
  const lower = sessionId.toLowerCase();
  if (lower === "local" || lower === "ssh") {
    return `Invalid session_id for ${name}: "${sessionId}" is a terminal session type, not a terminal session id.${sessionIdHelp(sessions)}`;
  }
  if (sessionId.startsWith("machine:")) {
    return `Invalid session_id for ${name}: "${sessionId}" is a machine_id. machine_id selects a machine for terminalManage filters; execution and file tools require a concrete terminal session_id.${sessionIdHelp(sessions)}`;
  }
  if (sessionId.startsWith("workspace:")) {
    return `Invalid session_id for ${name}: "${sessionId}" is a workspace_id. workspace_id selects a project for terminalManage filters; execution and file tools require a concrete terminal session_id.${sessionIdHelp(sessions)}`;
  }
  if (knownSessionIds.size && !knownSessionIds.has(sessionId)) {
    return `Unknown session_id for ${name}: "${sessionId}".${sessionIdHelp(sessions)}`;
  }
  return "";
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
