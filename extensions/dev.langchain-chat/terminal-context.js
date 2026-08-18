const DEFAULT_SESSION_LIMIT = 16;
const MAX_SESSION_LIMIT = 32;
const MAX_FIELD_CHARS = 600;

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function boundedText(value) {
  return Array.from(String(value ?? "").trim()).slice(0, MAX_FIELD_CHARS).join("");
}

function sessionActivityScore(session) {
  for (const value of [
    session?.last_activity,
    session?.updated_at,
    session?.created_at
  ]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && String(value || "").trim()) return numeric;
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SESSION_LIMIT;
  return Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.floor(numeric)));
}

function uniqueSessions(sessions) {
  const result = [];
  const seen = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session !== "object") continue;
    const id = boundedText(session.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ ...session, id });
  }
  return result;
}

export function selectTerminalContextSessions(activeSessionId, sessions, options = {}) {
  const list = uniqueSessions(sessions);
  const limit = normalizeLimit(options.limit);
  const requestedActiveId = boundedText(activeSessionId);
  let active = list.find((session) => session.id === requestedActiveId) || null;
  let activeSessionInferred = false;

  if (!active && list.length) {
    const activeCandidates = list.filter((session) => session.active === true);
    const candidates = activeCandidates.length ? activeCandidates : list;
    active = candidates
      .slice()
      .sort((a, b) => sessionActivityScore(b) - sessionActivityScore(a))[0] || null;
    activeSessionInferred = Boolean(active);
  }

  const ordered = list
    .filter((session) => session !== active)
    .sort((a, b) => sessionActivityScore(b) - sessionActivityScore(a));
  if (active) ordered.unshift(active);
  const selected = ordered.slice(0, limit);

  return {
    activeSessionId: active?.id || "",
    activeSessionInferred,
    sessions: selected,
    totalCount: list.length,
    omittedCount: Math.max(0, list.length - selected.length)
  };
}

function appendElement(lines, indent, name, value) {
  const text = boundedText(value);
  if (!text) return;
  lines.push(`${indent}<${name}>${escapeXml(text)}</${name}>`);
}

function buildSessionXml(session, activeSessionId) {
  const attrs = [
    `id="${escapeXml(session.id)}"`,
    session.id === activeSessionId ? 'active="true"' : "",
    session?.type ? `type="${escapeXml(boundedText(session.type))}"` : "",
    session?.status ? `status="${escapeXml(boundedText(session.status))}"` : "",
    session?.exit_code != null ? `exit_code="${escapeXml(boundedText(session.exit_code))}"` : "",
    session?.pid != null ? `pid="${escapeXml(boundedText(session.pid))}"` : ""
  ].filter(Boolean).join(" ");
  const lines = [`    <session ${attrs}>`];
  appendElement(lines, "      ", "name", session.name);
  appendElement(lines, "      ", "cwd", session.cwd);
  appendElement(lines, "      ", "initial_cwd", session.initial_cwd);
  appendElement(lines, "      ", "ssh_host", session.ssh_host || session.host);
  appendElement(lines, "      ", "ssh_user", session.ssh_user || session.user);
  appendElement(lines, "      ", "ssh_port", session.ssh_port || session.port);
  appendElement(lines, "      ", "command", session.command);
  appendElement(lines, "      ", "last_activity", session.last_activity);
  lines.push("    </session>");
  return lines.join("\n");
}

export function buildTerminalSessionsContextXml(activeSessionId, sessions, options = {}) {
  const selected = selectTerminalContextSessions(activeSessionId, sessions, options);
  const active = selected.sessions.find(
    (session) => session.id === selected.activeSessionId
  ) || null;
  const lines = [
    `<terminal_context total_count="${selected.totalCount}" included_count="${selected.sessions.length}" omitted_count="${selected.omittedCount}">`,
    "  <instructions>",
    "    This is a bounded terminal session inventory.",
    "    Prefer the selected session when it matches the user's intended machine and cwd.",
    "    If the intended session is omitted, call terminalManage with action=list before choosing a session_id.",
    "    Do not assume command output unless it appears in recent terminal output context or the conversation.",
    "  </instructions>",
    `  <active_session_id inferred="${selected.activeSessionInferred ? "true" : "false"}">${escapeXml(selected.activeSessionId)}</active_session_id>`
  ];
  if (active) {
    lines.push("  <active_session>");
    appendElement(lines, "    ", "id", active.id);
    appendElement(lines, "    ", "type", active.type);
    appendElement(lines, "    ", "name", active.name);
    appendElement(lines, "    ", "status", active.status);
    appendElement(lines, "    ", "cwd", active.cwd);
    appendElement(lines, "    ", "initial_cwd", active.initial_cwd);
    appendElement(lines, "    ", "ssh_host", active.ssh_host || active.host);
    appendElement(lines, "    ", "ssh_user", active.ssh_user || active.user);
    appendElement(lines, "    ", "ssh_port", active.ssh_port || active.port);
    lines.push("  </active_session>");
  } else {
    lines.push("  <active_session></active_session>");
  }
  lines.push(`  <sessions count="${selected.sessions.length}">`);
  for (const session of selected.sessions) {
    lines.push(buildSessionXml(session, selected.activeSessionId));
  }
  lines.push("  </sessions>", "</terminal_context>");
  return lines.join("\n");
}
