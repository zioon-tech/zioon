import {
  buildTerminalInventory,
  DEFAULT_MACHINE_DESCRIPTION,
  normalizeTerminalSession
} from "./terminal-inventory.js";
import {
  runtimeDeviceServiceBaseUrl
} from "../../src/runtime/workbench-runtime-config.ts";

function text(value) {
  return String(value ?? "").trim();
}

export function readTerminalServiceBaseUrl() {
  const runtimeBase = runtimeDeviceServiceBaseUrl("local-tools");
  if (runtimeBase) return runtimeBase;
  const stateValue = window.zion?.state?.get?.("localTools.baseUrl");
  if (typeof stateValue === "string" && stateValue.trim()) {
    return stateValue.trim().replace(/\/$/, "");
  }
  try {
    const stored = localStorage.getItem("zion.localTools.baseUrl")
      || localStorage.getItem("zion.localSearch.baseUrl")
      || "";
    if (stored.trim()) return stored.trim().replace(/\/$/, "");
  } catch {}
  return "http://127.0.0.1:8765";
}

async function request(path, options = {}) {
  const response = await fetch(`${readTerminalServiceBaseUrl()}${path}`, options);
  const raw = await response.text().catch(() => "");
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!response.ok) {
    const detail = text(data?.detail || data?.error || raw);
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return data;
}

function currentMachineProfiles() {
  const profiles = window.zion?.state?.get?.("terminal.machineProfiles");
  return Array.isArray(profiles) ? profiles : [];
}

export function publishTerminalSessions(sessions, machineProfiles = currentMachineProfiles()) {
  const inventory = buildTerminalInventory(sessions, { machineProfiles });
  window.zion?.state?.set?.("terminal.machineProfiles", machineProfiles);
  window.zion?.state?.set?.("terminal.sessions", inventory.sessions);
  window.zion?.state?.set?.("terminal.inventory", {
    version: inventory.version,
    revision: inventory.revision,
    generatedAt: inventory.generatedAt,
    machines: inventory.machines,
    workspaces: inventory.workspaces
  });
  return inventory;
}

function currentSessions() {
  const sessions = window.zion?.state?.get?.("terminal.sessions");
  return Array.isArray(sessions) ? sessions : [];
}

function inventoryNeedsSessionHints(inventory, sessions = []) {
  const workspaces = Array.isArray(inventory?.workspaces) ? inventory.workspaces : [];
  if (!workspaces.length) return false;
  if (!Array.isArray(sessions) || !sessions.length) return false;
  return workspaces.some((workspace) => Number(workspace?.availableSessionCount || 0) > 0 && !text(workspace?.preferredSessionId));
}

export async function listTerminalSessions() {
  const [data, machineProfiles] = await Promise.all([
    request("/sessions", { method: "GET" }),
    listTerminalMachineProfiles().catch(() => currentMachineProfiles())
  ]);
  window.zion?.state?.set?.("terminal.nodes", Array.isArray(data?.nodes) ? data.nodes : []);
  return publishTerminalSessions(
    Array.isArray(data?.sessions) ? data.sessions : [],
    machineProfiles
  ).sessions;
}

export async function ensureTerminalSessions() {
  const sessions = currentSessions();
  const inventory = window.zion?.state?.get?.("terminal.inventory");
  if (sessions.length) {
    if (!Array.isArray(inventory?.machines) || inventoryNeedsSessionHints(inventory, sessions)) {
      return publishTerminalSessions(sessions).sessions;
    }
    return sessions;
  }
  if (Array.isArray(inventory?.machines)) return sessions;
  try {
    return await listTerminalSessions();
  } catch {
    return sessions;
  }
}

export async function listTerminalMachineProfiles() {
  const data = await request("/machines", { method: "GET" });
  const profiles = Array.isArray(data?.machines) ? data.machines : [];
  window.zion?.state?.set?.("terminal.machineProfiles", profiles);
  return profiles;
}

export async function getTerminalMachine(machineId) {
  const id = text(machineId);
  if (!id) throw new Error("Missing machine_id");
  await ensureTerminalSessions();
  const inventory = window.zion?.state?.get?.("terminal.inventory");
  const machine = Array.isArray(inventory?.machines)
    ? inventory.machines.find((item) => item?.id === id)
    : null;
  if (!machine) throw new Error("Machine not found");
  return machine;
}

export async function updateTerminalMachine(machineId, updates = {}) {
  const id = text(machineId);
  if (!id) throw new Error("Missing machine_id");
  const current = await getTerminalMachine(id);
  const description = text(updates.description) || DEFAULT_MACHINE_DESCRIPTION;
  const data = await request(`/machines/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: text(updates.name) || current.name || id,
      kind: current.kind,
      description: Array.from(description).slice(0, 500).join("")
    })
  });
  if (!data?.machine) throw new Error("Invalid machine response");
  const profiles = currentMachineProfiles().filter((profile) => profile?.id !== id);
  profiles.push(data.machine);
  publishTerminalSessions(currentSessions(), profiles);
  return getTerminalMachine(id);
}

export function resolveTerminalCreatePayload(args = {}) {
  const inventory = window.zion?.state?.get?.("terminal.inventory");
  const machineId = text(args.machine_id || args.machineId);
  const workspaceId = text(args.workspace_id || args.workspaceId);
  let machine = Array.isArray(inventory?.machines)
    ? inventory.machines.find((item) => item.id === machineId)
    : null;
  const workspace = Array.isArray(inventory?.workspaces)
    ? inventory.workspaces.find((item) => item.id === workspaceId)
    : null;
  if (machineId && !machine) throw new Error("Unknown machine_id");
  if (workspaceId && !workspace) throw new Error("Unknown workspace_id");
  if (machine && workspace && machine.id !== workspace.machineId) {
    throw new Error("machine_id and workspace_id refer to different machines");
  }
  machine ||= inventory?.machines?.find((item) => item.id === workspace?.machineId);
  if (args.node_id && machine?.nodeId && args.node_id !== machine.nodeId) {
    throw new Error("node_id conflicts with machine/workspace");
  }

  const type = text(machine?.kind || args.type || "local") === "ssh" ? "ssh" : "local";
  const payload = {
    type,
    ...((machine?.nodeId || args.node_id) ? { node_id: machine?.nodeId || args.node_id } : {}),
    ...((workspace?.resourceId || args.resource_id) ? { resource_id: workspace?.resourceId || args.resource_id } : {}),
    initial_cwd: text(workspace?.root || args.initial_cwd || args.cwd) || undefined
  };
  if (type === "ssh") {
    payload.ssh_host = text(machine?.connection?.host || args.ssh_host) || undefined;
    payload.ssh_user = text(machine?.connection?.user || args.ssh_user) || undefined;
    payload.ssh_port = Number(machine?.connection?.port || args.ssh_port || 22) || 22;
  }
  return payload;
}

export async function createTerminalSession(args = {}) {
  const data = await request("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(resolveTerminalCreatePayload(args))
  });
  const session = normalizeTerminalSession(data?.session);
  if (!session) return null;
  const next = currentSessions().filter((item) => item?.id !== session.id);
  next.push(session);
  publishTerminalSessions(next);
  window.zion?.state?.set?.("terminal.activeSessionId", session.id);
  return session;
}

export async function getTerminalSession(sessionId) {
  const id = text(sessionId);
  if (!id) throw new Error("Missing session_id");
  const data = await request(`/sessions/${encodeURIComponent(id)}`, { method: "GET" });
  return normalizeTerminalSession(data?.session || data);
}

export async function closeTerminalSession(sessionId) {
  const id = text(sessionId);
  if (!id) throw new Error("Missing session_id");
  await request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  const next = currentSessions().filter((session) => session?.id !== id);
  publishTerminalSessions(next);
  if (window.zion?.state?.get?.("terminal.activeSessionId") === id) {
    window.zion?.state?.set?.("terminal.activeSessionId", next[0]?.id || null);
  }
  return true;
}

export async function reactivateTerminalSession(sessionId) {
  const id = text(sessionId);
  if (!id) throw new Error("Missing session_id");
  const data = await request(`/sessions/${encodeURIComponent(id)}/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  const session = normalizeTerminalSession(data?.session);
  if (!session) return null;
  const next = currentSessions().filter((item) => item?.id !== id);
  next.push(session);
  publishTerminalSessions(next);
  return session;
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;
}

export async function setTerminalSessionCwd(sessionId, cwd) {
  const id = text(sessionId);
  const nextCwd = text(cwd);
  if (!id) throw new Error("Missing session_id");
  if (!nextCwd) throw new Error("Missing cwd");
  await request(`/sessions/${encodeURIComponent(id)}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: `cd -- ${shellQuote(nextCwd)}` })
  });
  const next = currentSessions().map((session) => (
    session?.id === id ? { ...session, cwd: nextCwd } : session
  ));
  publishTerminalSessions(next);
  return true;
}
