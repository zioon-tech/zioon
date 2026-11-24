import { Buffer } from "node:buffer";
import {
  isResourceReference,
  machineReference,
  parseMachineReference,
  parseTerminalReference,
  terminalReference
} from "../../../packages/node-protocol/src/resource-references.mjs";

export const DEVICE_SERVICE_TOOL_NAME = "zion.internal.deviceService";

const INTERACTIVE_READ_PATHS = new Set([
  "/sessions", "/machines", "/files/read", "/files/read-jsonl",
  "/files/entries", "/files/glob", "/files/grep"
]);

// An HTTP method alone isn't a sufficient guarantee: e.g. a terminal
// relay GET can drain a buffer. Only these explicit reads are eligible.
export function isInteractiveDeviceRead(invocation) {
  if (invocation.toolCall?.name !== DEVICE_SERVICE_TOOL_NAME) return false;
  const args = invocation.toolCall.arguments || {};
  if (args.service !== "local-tools" || args.method !== "GET" || args.bodyBase64) return false;
  try {
    const url = new URL(args.path, "http://device.invalid");
    return url.origin === "http://device.invalid" && INTERACTIVE_READ_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

export function serviceRoute(invocation) {
  if (invocation.toolCall?.name !== DEVICE_SERVICE_TOOL_NAME) return null;
  const args = invocation.toolCall.arguments || {};
  if (args.service !== "local-tools") return null;
  const url = new URL(args.path || "/", "http://device.invalid");
  const session = url.pathname.match(/^\/sessions\/([^/]+)(\/.*)?$/);
  const machine = url.pathname.match(/^\/machines\/([^/]+)$/);
  const method = String(args.method || "GET").toUpperCase();
  const body = args.bodyBase64 && !["GET", "HEAD"].includes(method)
    ? JSON.parse(Buffer.from(args.bodyBase64, "base64").toString("utf8"))
    : null;
  return {
    url,
    method,
    body,
    sessionId: session ? decodeURIComponent(session[1]) : body?.session_id || url.searchParams.get("session_id") || "",
    sessionSuffix: session?.[2] || "",
    sessionPath: !!session,
    machineId: machine ? decodeURIComponent(machine[1]) : "",
    args
  };
}

export function invocationReference(invocation) {
  const route = serviceRoute(invocation);
  const sessionId = route?.sessionId || String(invocation.toolCall?.arguments?.session_id || "");
  const machineId = route?.machineId || "";
  const terminal = parseTerminalReference(sessionId);
  const machine = parseMachineReference(machineId);
  if ((!terminal && isResourceReference(sessionId)) || (!machine && isResourceReference(machineId))) {
    throw new Error("Unsupported resource reference; refresh terminalInventory");
  }
  return { route, sessionId, terminal, machine };
}

export function translateInvocation(invocation, reference, policy) {
  const args = { ...invocation.toolCall.arguments };
  delete args.node_id;
  if (reference.terminal) {
    if (reference.route) {
      const { url, sessionPath, sessionSuffix, body } = reference.route;
      if (sessionPath) {
        url.pathname = `/sessions/${encodeURIComponent(reference.terminal.sessionId)}${sessionSuffix}`;
      } else if (body?.session_id) {
        args.bodyBase64 = Buffer.from(JSON.stringify({
          ...body,
          session_id: reference.terminal.sessionId
        })).toString("base64");
      } else {
        url.searchParams.set("session_id", reference.terminal.sessionId);
      }
      args.path = `${url.pathname}${url.search}`;
    } else {
      args.session_id = reference.terminal.sessionId;
    }
  }
  if (reference.machine) {
    const { url } = reference.route;
    url.pathname = `/machines/${encodeURIComponent(reference.machine.machineId)}`;
    args.path = `${url.pathname}${url.search}`;
  }
  return {
    ...invocation,
    policy,
    toolCall: { ...invocation.toolCall, arguments: args }
  };
}

export function scopeSession(session, target) {
  if (!session || typeof session !== "object" || !session.id) return session;
  const registration = target.node.registration;
  const id = terminalReference({
    nodeId: registration.nodeId,
    instanceId: registration.instanceId,
    resourceId: target.resource?.resourceId,
    sessionId: session.id
  });
  return {
    ...session,
    id,
    session_id: id,
    nativeSessionId: String(session.id),
    nodeId: registration.nodeId,
    nodeLabel: registration.label || registration.nodeId,
    resourceId: target.resource?.resourceId
  };
}

export function scopeServiceResult(result, invocation, target) {
  const route = serviceRoute(invocation);
  if (!result.ok || !route) return result;
  const path = route.url.pathname;
  if (!/^\/(?:sessions|machines)(?:\/[^/]+(?:\/activate)?)?$/.test(path)) return result;
  let envelope;
  let payload;
  try {
    envelope = JSON.parse(result.content);
    if (envelope.status < 200 || envelope.status >= 300) return result;
    payload = JSON.parse(Buffer.from(envelope.bodyBase64 || "", "base64").toString("utf8"));
  } catch {
    return result;
  }
  const nodeId = target.node.registration.nodeId;
  const scopeMachine = (machine) => machine?.id ? {
    ...machine,
    id: machineReference(nodeId, machine.id),
    nodeId,
    nodeLabel: target.node.registration.label || nodeId
  } : machine;
  if (Array.isArray(payload.sessions)) {
    const allowed = new Set(invocation.policy?.allowedTerminalSessionIds || []);
    payload.sessions = payload.sessions
      .filter((session) => !allowed.size || allowed.has(String(session?.id || "")))
      .map((session) => scopeSession(session, target));
  }
  if (payload.session) payload.session = scopeSession(payload.session, target);
  if (Array.isArray(payload.machines)) payload.machines = payload.machines.map(scopeMachine);
  if (payload.machine) payload.machine = scopeMachine(payload.machine);
  if (payload.id) payload = path.startsWith("/sessions")
    ? scopeSession(payload, target)
    : scopeMachine(payload);
  envelope.bodyBase64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  return { ...result, content: JSON.stringify(envelope) };
}
